import { WorkbenchError } from './policy.mjs';
import { retainHeavyToolLease } from '../efficiency/heavy-tool-lease.mjs';

export const DEFAULT_PROJECT_JOB_LIFETIME_MS = 300000;
export const MAX_PROJECT_JOB_LIFETIME_MS = 600000;
export const projectJobLifetime = timeoutMs => Math.min(MAX_PROJECT_JOB_LIFETIME_MS, Math.max(1000, timeoutMs ?? DEFAULT_PROJECT_JOB_LIFETIME_MS));
export const projectBackgroundSchema = { type: 'object', properties: { kind: { type: 'string', const: 'background' }, jobId: { type: 'string' }, cwd: { type: 'string' } }, required: ['kind', 'jobId', 'cwd'], additionalProperties: false };
export function renderProjectBackground(args, value) {
  return [{ type: 'text', text: `Started background job ${value.jobId}. Maximum lifetime: ${projectJobLifetime(args.timeoutMs)}ms. Read status/logs with job_output ${JSON.stringify({ job_id: value.jobId, wait: true, timeout_ms: 30000 })} or job_list. A wait timeout leaves this same job running: inspect job.status and retain its ID; do not start a duplicate. Stop this owned job with job_kill. Process completion requires job.status=completed and an observed exit code 0 in job.detail or the returned final result text; use verify_project for source-bound verification. Do not use nohup, setsid or process-name kills.` }];
}

// Only SDK-owned handles are retained. Never discover/adopt arbitrary PIDs or
// use a process name as an authority to signal another program.
export function createProjectProcessStarter(ctx, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const active = new Map(); let disposed = false;
  async function dispose() {
    if (disposed && active.size === 0) return;
    disposed = true;
    const entries = [...active.values()];
    for (const entry of entries) {
      try { entry.jobs.kill(entry.id, entry.owner, 'project executor disposed'); }
      catch { entry.cancel('project executor disposed'); }
    }
    await Promise.all(entries.map(entry => entry.done));
  }
  ctx.effect?.(() => dispose, 'managed project background processes');

  async function start({ cwd, spec, adaptations = [] }, execution, args) {
    execution.signal.throwIfAborted();
    if (disposed) throw new WorkbenchError('PROJECT_EXECUTOR_DISPOSED', 'Project command execution is shutting down.');
    const owner = execution.agent?.id;
    if (!owner) throw new WorkbenchError('PROJECT_JOB_OWNER_REQUIRED', 'Background commands require their executing conversation.');
    const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : ctx.jobs;
    if (!jobs || typeof jobs.start !== 'function') throw new WorkbenchError('PROJECT_JOBS_UNAVAILABLE', 'Background commands require the SDK job registry and job_output/job_kill controller. Use a bounded foreground command until they are available.', 503);
    const lifetimeMs = projectJobLifetime(args.timeoutMs);
    const releaseAdmission = retainHeavyToolLease(execution);
    const controller = new AbortController(); let process, id, timer, done, settled = false, stopReason;
    const cancel = reason => {
      if (settled || controller.signal.aborted) return;
      stopReason = reason ?? 'project job cancelled';
      controller.abort(stopReason);
      process?.kill();
    };
    const abortBeforeCommit = () => cancel('tool call aborted before background ownership was committed');
    execution.signal.addEventListener('abort', abortBeforeCommit, { once: true });
    try {
      execution.signal.throwIfAborted();
      id = jobs.start({
        kind: 'bash', owner, label: args.description.replace(/\s+/gu, ' ').slice(0, 240),
        toolCall: { callId: execution.callId, rootCallId: execution.rootCallId ?? execution.callId }, outputLimitBytes: 16000,
        output: ['stdout', 'stderr'].map(channel => ({ channel, read(fromByte) {
          return process === undefined ? { text: '', nextOffset: fromByte, lossy: false } : process.observed[channel].readFrom(fromByte);
        } })),
        run(handle) {
          // Defer spawning until synchronous registry admission/commit completes.
          // Cancellation while admission runs then prevents even shell.execute.
          done = Promise.resolve().then(async () => {
            try {
              controller.signal.throwIfAborted();
              for (const adaptation of adaptations) handle.append(adaptation + '\n', { channel: 'stdout' });
              process = await ctx.shell.execute({ ...spec, onExpiry: 'none', timeoutMs: lifetimeMs, signal: controller.signal });
              if (controller.signal.aborted) process.kill();
              await process.done;
              const result = { exitCode: process.exitCode, signal: process.signal ?? null, lifetimeMs, lifetimeExpired: stopReason?.startsWith('project job lifetime limit') ?? false,
                ...(process.sandbox ? { sandbox: { mode: process.sandbox.mode, denied: Boolean(process.sandbox.denied), runnerFailed: Boolean(process.sandbox.runnerFailed) } } : {}) };
              const sandboxNote = process.sandbox?.runnerFailed ? '; sandbox runner failed before command execution' : process.sandbox?.denied ? '; sandbox denied file access' : '';
              return process.sandbox?.runnerFailed ? { status: 'failed', detail: 'sandbox runner failed before command execution', result } : process.status === 'killed'
                ? { status: 'killed', detail: (stopReason ?? (process.signal ? 'signal: ' + process.signal : 'killed before exit')) + sandboxNote, result }
                : { status: 'completed', detail: 'exit code: ' + process.exitCode + sandboxNote, result };
            } catch (error) {
              // A failed preparation must release any handle it published.
              if (process) { process.kill(); await process.done; }
              return { status: controller.signal.aborted ? 'killed' : 'failed', detail: stopReason ?? (error instanceof Error ? error.message : String(error)) };
            } finally {
              settled = true; if (timer !== undefined) clearTimer(timer);
              if (id !== undefined) active.delete(id);
              releaseAdmission();
            }
          });
          return { done, cancel };
        },
      });
    } catch (error) {
      cancel('background registration did not commit');
      if (done) await done;
      releaseAdmission();
      throw error;
    } finally { execution.signal.removeEventListener('abort', abortBeforeCommit); }
    if (execution.signal.aborted) {
      try { jobs.kill(id, owner, 'tool call aborted before background acknowledgement'); }
      catch { cancel('tool call aborted before background acknowledgement'); }
      await done; execution.signal.throwIfAborted();
    }
    const entry = { id, owner, jobs, done, cancel }; active.set(id, entry);
    timer = setTimer(() => {
      if (settled) return;
      const reason = 'project job lifetime limit reached after ' + lifetimeMs + 'ms';
      try { jobs.kill(id, owner, reason); } catch { cancel(reason); }
    }, lifetimeMs);
    timer?.unref?.();
    return { kind: 'background', jobId: id, cwd };
  }
  return { start, dispose };
}
