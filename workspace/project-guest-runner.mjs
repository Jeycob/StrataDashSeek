import crypto from 'node:crypto';
import path from 'node:path';
import { WorkbenchError, within } from './policy.mjs';
import { projectCommandParameters } from './project-tool.mjs';
import { createProjectProcessStarter, projectJobLifetime } from './project-process.mjs';
import { normalizeVerificationCommand } from './tool-recovery.mjs';
import { retainHeavyToolLease } from '../efficiency/heavy-tool-lease.mjs';
const fail = code => new WorkbenchError(code, code, 409);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
const id16 = /^[a-f0-9]{16}$/, id32 = /^[a-f0-9]{32}$/;
function outputBuffer() {
  let text = '', start = 0, end = 0;
  return { append(value) { const buffer = Buffer.from(text + value); end += Buffer.byteLength(value); const kept = buffer.subarray(Math.max(0, buffer.length - 1024 * 1024)); text = kept.toString(); start = end - Buffer.byteLength(text); }, snapshot(value) {
    if (value === text) return;
    if (value.startsWith(text)) this.append(value.slice(text.length));
    else this.append((text ? '\n[earlier log lines rolled out of the Docker tail]\n' : '') + value);
  }, readFrom(offset) { const buffer = Buffer.from(text), at = Math.max(start, Math.min(end, offset)); return { text: buffer.subarray(at - start).toString(), nextOffset: end, lossy: offset < start }; }, value() { return { text, truncated: start > 0 }; } };
}

// Adapter for SDK-owned process/job handles. The only command execution is the
// authenticated Apps executor. All authority/stop tokens stay in this closure.
export function createGuestProjectCommandRunner(ctx, manager, { appsConfig, callApps, pollMs = 1000, wait = pause } = {}) {
  const active = new Set(); let disposed = false;
  const rpc = (route, data, options = {}) => callApps(route, data, { ...appsConfig, timeoutMs: 5000, ...options });
  async function execute(spec) {
    if (disposed) throw fail('PROJECT_RUNTIME_DISPOSED');
    spec.signal?.throwIfAborted();
    const generation = crypto.randomBytes(16).toString('hex');
    const admission = await manager.withProjectRuntimeAuthority({ sessionId: spec.sessionId, accessSessionId: spec.accessSessionId, op: 'execute', kind: 'executor', generation }, token => rpc('/project-runtime', { op: 'execute', kind: 'executor', sessionId: spec.sessionId, generation, token, command: spec.command }, { signal: spec.signal, timeoutMs: 125000 }));
    if (admission?.version !== 1 || admission.state !== 'running' || admission.sessionId !== spec.sessionId || admission.generation !== generation || !id16.test(admission.jobId || '') || !id32.test(admission.operationId || '') || !/^[A-Za-z0-9_-]{43}$/.test(admission.stopToken || '')) throw fail('PROJECT_RUNTIME_ADMISSION_UNVERIFIED');
    const stdout = outputBuffer(), stderr = outputBuffer();
    const process = { status: 'running', exitCode: null, signal: null, sandbox: { mode: spec.readOnly ? 'read-only' : 'workspace-write', denied: false, enforcement: 'guest-container' }, observed: { stdout, stderr } };
    let stopped = false, stopPending, resultResolve, resultReject, warned = false, timer;
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; }); result.catch(() => {});
    async function stop() {
      if (stopped) return; if (stopPending) return stopPending;
      stopPending = (async () => {
        const reply = await rpc('/project-runtime', { op: 'stop', sessionId: spec.sessionId, generation, stopToken: admission.stopToken }, { timeoutMs: 30000 });
        if (reply?.version !== 1 || reply.state !== 'stopped' || reply.sessionId !== spec.sessionId || reply.generation !== generation || reply.operationId !== admission.operationId) throw fail('PROJECT_RUNTIME_STOP_UNVERIFIED');
        stopped = true; process.status = 'killed'; process.signal = 'SIGTERM';
      })();
      try { await stopPending; } finally { stopPending = undefined; }
    }
    const cancel = () => { process.aborted = true; void stop().catch(() => { stderr.append('[PROJECT_RUNTIME_RECONCILIATION_REQUIRED: stop is unconfirmed]\n'); }); };
    process.kill = cancel;
    process.result = () => result;
    const route = name => '/' + name + '?id=' + admission.jobId + '&_contextProjectId=' + crypto.createHash('sha256').update(spec.projectRoot).digest('hex').slice(0, 16);
    process.done = (async () => {
      try {
        while (!stopped) {
          try {
            const value = await rpc(route('job-status')), log = await rpc(route('job-log'));
            if (typeof log?.text === 'string') stdout.snapshot(log.text);
            const job = value?.job;
            if (value?.version !== 1 || job?.id !== admission.jobId || job.action !== 'project-executor') throw fail('PROJECT_RUNTIME_JOB_IDENTITY_UNVERIFIED');
            if (job.terminal && ['passed', 'failed'].includes(job.status) && Number.isInteger(job.exitCode) && job.exitCode >= 0 && job.exitCode <= 255) { process.exitCode = job.exitCode; process.status = 'exited'; stopped = true; break; }
            if (job.terminal) {
              // A terminal controller record does not itself prove that every
              // container stopped. Obtain the generation-bound stop witness.
              await stop();
            }
          } catch {
            if (!warned) { warned = true; stderr.append('[PROJECT_RUNTIME_RECONCILIATION_REQUIRED: waiting for a verified exit or stop]\n'); resultReject(fail('PROJECT_RUNTIME_RECONCILIATION_REQUIRED')); }
            // Keep the SDK process and heavy lease alive until an observed
            // exit/stop. Never invent exit 0 from a timeout or lost response.
          }
          if (!stopped) await wait(pollMs);
        }
        resultResolve({ exitCode: process.exitCode, signal: process.signal, timedOut: Boolean(process.timedOut), aborted: Boolean(process.aborted), timeoutMs: spec.timeoutMs, stdout: stdout.value(), stderr: stderr.value(), sandbox: process.sandbox });
      } finally { clearTimeout(timer); spec.signal?.removeEventListener('abort', cancel); active.delete(process); }
    })();
    active.add(process);
    spec.signal?.addEventListener('abort', cancel, { once: true });
    if (spec.signal?.aborted) cancel();
    timer = setTimeout(() => { process.timedOut = true; void stop().catch(() => { stderr.append('[PROJECT_RUNTIME_RECONCILIATION_REQUIRED: lifetime stop is unconfirmed]\n'); }); }, spec.timeoutMs); timer.unref?.();
    return process;
  }
  const processes = createProjectProcessStarter(ctx, { execute });
  async function prepare(args, execution) {
    if (!appsConfig?.projectRuntime?.enabled || typeof callApps !== 'function' || typeof manager.withProjectRuntimeAuthority !== 'function') throw fail('PROJECT_RUNTIME_ISOLATION_UNAVAILABLE');
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(projectCommandParameters.properties, key)) || typeof args.command !== 'string' || !args.command.trim() || args.command.length > 65536 || args.command.includes('\0') || typeof args.description !== 'string' || !args.description.trim() || args.workdir !== undefined && typeof args.workdir !== 'string' || args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) || args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw fail('PROJECT_RUNTIME_COMMAND_INVALID');
    const owner = manager.ownerAgent(execution.agent), project = manager.data.sessions[owner?.id];
    if (!project || project.legacy || project.nativeWorktree || project.independentRepository !== true) throw fail('PROJECT_RUNTIME_NOT_ISOLATED');
    const cwd = path.resolve(project.root, args.workdir ?? '.');
    if (!within(project.root, cwd)) throw fail('PROJECT_RUNTIME_OUTSIDE_PROJECT');
    const relative = path.relative(project.root, cwd).split(path.sep).join('/'), guestCwd = '/workspace' + (relative ? '/' + relative : '');
    const ownerMode = ctx.sandboxPolicy?.resolve({ session: owner.session })?.mode, accessMode = ctx.sandboxPolicy?.resolve({ session: execution.agent.session })?.mode;
    if (![ownerMode, accessMode].every(mode => ['read-only', 'workspace-write', 'danger-full-access'].includes(mode))) throw fail('PROJECT_RUNTIME_POLICY_UNAVAILABLE');
    const normalized = normalizeVerificationCommand(args.command), command = 'cd -- ' + quote(guestCwd) + ' && ' + normalized.command;
    if (command.length > 65536) throw fail('PROJECT_RUNTIME_COMMAND_INVALID');
    return { cwd, adaptations: normalized.changed ? ['[Harness: verification display filters removed; the verifier retains its real exit status.]'] : [], spec: { command, projectRoot: project.root, sessionId: owner.id, accessSessionId: execution.agent.id, readOnly: ownerMode === 'read-only' || accessMode === 'read-only', timeoutMs: args.run_in_background ? projectJobLifetime(args.timeoutMs) : Math.min(120000, Math.max(1000, args.timeoutMs ?? 60000)), signal: execution.signal } };
  }
  const run = async (args, execution) => {
    const prepared = await prepare(args, execution); execution.signal.throwIfAborted();
    if (args.run_in_background) return { ...prepared, background: await processes.start(prepared, execution, args) };
    const release = retainHeavyToolLease(execution); let process;
    try { process = await execute(prepared.spec); void process.done.finally(release); const result = await process.result(); execution.signal.throwIfAborted(); return { ...prepared, result }; }
    catch (error) { if (!process) release(); throw error; }
  };
  run.dispose = async () => { disposed = true; for (const process of active) process.kill(); await processes.dispose(); await Promise.all([...active].map(process => process.done)); };
  ctx.effect?.(() => run.dispose, 'isolated guest project executor');
  return run;
}
