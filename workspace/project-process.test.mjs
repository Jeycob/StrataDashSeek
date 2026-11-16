import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectCommandRunner, registerProjectTool } from './project-tool.mjs';
import { createManagedShell } from './managed-shell.mjs';
import { createProjectProcessStarter } from './project-process.mjs';
import { apply as applyEfficiency } from '../efficiency/plugin.mjs';

let modules;
function sdk() {
  return modules ??= (async () => {
    const cli = process.env.HARNESS_NATIVE_CLI ?? path.join(process.env.HOMEAI_RUNTIME ?? '/data/harness/runtime', 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const base = path.resolve(path.dirname(cli), '../..');
    const load = name => import(pathToFileURL(path.join(base, name, 'lib/index.js')));
    const [cordis, prompt, tools, pipeline, scope, jobs, jobTools, bash] = await Promise.all([
      load('cordis'), load('dsh-system-prompt'), load('dsh-tools'),
      import(pathToFileURL(path.join(base, 'dsh-tools/lib/pipeline.js'))), load('dsh-scope'),
      load('dsh-jobs-local'), load('dsh-tool-jobs'), load('dsh-tool-bash'),
    ]);
    return { ...cordis, SystemPrompt: prompt.default, Tools: tools.default, ...pipeline, ...scope,
      LocalJobs: jobs.default, applyJobTools: jobTools.apply, applyBash: bash.apply };
  })();
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function eventually(check) {
  const until = Date.now() + 1000;
  while (!check()) { if (Date.now() >= until) assert.fail('SDK state did not settle within the bounded wait'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const args = Object.freeze({ command: 'node preview.mjs', description: 'Start the assigned project preview', run_in_background: true });

async function fixture(t, { controller = true, admission = false } = {}) {
  const S = await sdk(), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-project-jobs-'));
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  const ctx = new S.Context(); new S.SystemPrompt(ctx, {}); new S.Tools(ctx);
  const agents = new Map(), scopes = [], events = [], notices = [], calls = [], processes = [], timers = new Set();
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
  ctx.provide('workingDirectory', { ensure: async () => root }); ctx.provide('shellEnv', { collect: () => ({ DSH_APP_PORT: '21000' }) });
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode ?? 'danger-full-access', workspaceRoot: directory }) });
  ctx.provide('shell', { sandboxMode: 'workspace-write', resolve: spec => ({ stdoutMaxBytes: 4096, ...spec }), async execute(spec) {
    calls.push(spec); let release;
    const process = { status: 'running', exitCode: null, signal: null, kills: 0, holdShutdown: false,
      sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
      done: new Promise(resolve => { release = resolve; }),
      observed: Object.fromEntries(['stdout', 'stderr'].map(channel => [channel, { readFrom(from) {
        const value = channel === 'stdout' ? 'preview-ready\n' : '';
        return { text: Buffer.from(value).subarray(from).toString('utf8'), nextOffset: Buffer.byteLength(value), lossy: false };
      } }])),
      finish(code = 0) { if (this.status !== 'running') return; this.status = 'completed'; this.exitCode = code; release(); },
      releaseKill() { if (this.status !== 'running') return; this.status = 'killed'; this.signal = 'SIGTERM'; release(); },
      kill() { if (this.status !== 'running' || this.kills) return false; this.kills++; if (!this.holdShutdown) this.releaseKill(); return true; },
      result() { throw Error('Background jobs must use the owned live handle, not a foreground wait'); },
    };
    spec.signal.addEventListener('abort', () => process.kill(), { once: true });
    processes.push(process); return process;
  } });
  new S.LocalJobs(ctx, { maxConcurrentJobsPerOwner: 4, retainBytes: 65536, settledRetainBytes: 16384, pumpPollMs: 2 });
  if (controller) S.applyJobTools(ctx, { completionDelivery: 'quiet', waitTimeoutMs: 100, maxWaitTimeoutMs: 1000, inlineOutputBytes: 2048 });
  S.applyBash(ctx, { enableRunInBackground: false }); const native = ctx.tools.get('bash');
  const manager = { existing: new Set(), data: { installedAt: 1000, sessions: {} }, ownerAgent: agent => agent?.owner ?? agent };
  const processTimers = { setTimer(fn, ms) { const token = { fn, ms, unref() {} }; timers.add(token); return token; }, clearTimer(token) { timers.delete(token); } };
  const run = createProjectCommandRunner(ctx, manager, { processTimers });
  const managed = createManagedShell(ctx, manager, run); registerProjectTool(ctx, manager, run);
  if (admission) await applyEfficiency(ctx, { stateDirectory: path.join(directory, 'efficiency'), engineMetrics: false });
  const pipeline = new S.ToolExecutionPipeline(ctx);
  ctx.tools.setExecutor({ describe: defs => ({ schemas: defs.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
    execute: input => S.executeToolBatch(input, pipeline, () => 1) });
  function agent(id, { owner, mode } = {}) {
    const value = { id, owner, status: 'idle', inbox: { nextStep: [] },
      session: { id, mode, header: { createdAt: 2000 }, append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event; } },
      inject: message => notices.push(message), followup: message => notices.push(message) };
    const scope = S.createScope(ctx, value); value.ctx = scope.ctx; value.scope = scope;
    scopes.push(scope); agents.set(id, value); if (!owner) manager.data.sessions[id] = { root, gitWritableRoots: [path.join(directory, 'git-metadata')] };
    managed.install(value); return value;
  }
  let callId = 0;
  async function call(agent, name = 'bash', value = args, signal = new AbortController().signal) {
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal });
    try {
      const result = await ctx.tools.execute({ agent, signal, toolSet, calls: [{ id: 'owned-call-' + (++callId), name, arguments: JSON.stringify(value) }] });
      return result.results[0].result;
    } finally { toolSet.dispose(); }
  }
  t.after(async () => {
    for (const process of processes) { process.holdShutdown = false; if (process.kills) process.releaseKill(); }
    await run.dispose(); managed.dispose();
    for (const scope of scopes) await scope.dispose(); await ctx.fiber.dispose();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'owned-project-jobs-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { ...S, ctx, root, directory, manager, native, managed, run, agent, call, processes, calls, timers, events, notices };
}

test('two SDK projects share heavy admission for managed bash and project_exec through background process settlement', async t => {
  const f = await fixture(t, { admission: true }), a = f.agent('heavy-a'), b = f.agent('heavy-b');
  const command = { command: 'npm run build', description: 'Build synthetic project', run_in_background: true };
  const first = await f.call(a, 'bash', command); assert.equal(first.isError, false, JSON.stringify(first)); await tick();
  let acknowledged = false;
  const second = f.call(b, 'project_exec', command).then(result => { acknowledged = true; return result; });
  await tick(); assert.equal(acknowledged, false); assert.equal(f.processes.length, 1);
  // Job inspection remains usable while another project is queued.
  const output = await f.call(a, 'job_output', { job_id: first.value.jobId });
  assert.equal(output.isError, false, JSON.stringify(output));
  const process = f.processes[0]; process.holdShutdown = true;
  const kill = await f.call(a, 'job_kill', { job_id: first.value.jobId, reason: 'synthetic build cancellation' });
  assert.equal(kill.isError, false); await tick(); assert.equal(acknowledged, false); assert.equal(f.processes.length, 1);
  // Sending a signal is not settlement; only actual process.done frees B.
  process.releaseKill();
  const next = await second; assert.equal(next.isError, false, JSON.stringify(next)); await tick(); assert.equal(f.processes.length, 2);
  f.processes[1].finish(); await eventually(() => f.ctx.jobs.get(next.value.jobId, b.id).status === 'completed');
});

test('cancelled heavy waiter never spawns; lightweight SDK tools remain responsive', async t => {
  const f = await fixture(t, { admission: true }), a = f.agent('owner-a'), b = f.agent('owner-b');
  const first = await f.call(a, 'project_exec', { command: 'node compile.mjs', description: 'Compile project', run_in_background: true });
  assert.equal(first.isError, false); await tick();
  const controller = new AbortController();
  const waiting = f.call(b, 'bash', { command: 'npm test', description: 'Test project', run_in_background: true }, controller.signal);
  await tick(); controller.abort(); const aborted = await waiting; assert.equal(aborted.isError, true); assert.equal(f.processes.length, 1);
  f.ctx.tools.register({ name: 'fixture_read', description: 'Read a small fixture', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'read' }] }, isConcurrencySafe: () => true, execute: async () => ({ read: true }) });
  assert.equal((await f.call(b, 'fixture_read', {})).value.read, true);
  f.processes[0].finish();
});

test('real SDK managed bash returns canonical background acknowledgement and native job tools collect logs and stop only its job', async t => {
  const f = await fixture(t), owner = f.agent('one');
  const original = f.ctx.tools.get('bash', owner);
  assert.equal(original.output.schema, f.native.output.schema);
  const result = await f.call(owner); await tick();
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(Object.keys(result.value).sort(), ['cwd', 'jobId', 'kind']);
  assert.equal(result.value.kind, 'background'); assert.equal(result.value.cwd, f.root); assert.equal(result.meta.cwd, f.root);
  assert.match(result.content[0].text, /300000ms/); assert.match(result.content[0].text, /job_kill/);
  const id = result.value.jobId; assert.equal(f.ctx.jobs.get(id, owner.id).owner, owner.id);
  assert.equal([...f.timers][0].ms, 300000); assert.equal(f.calls[0].timeoutMs, 300000);
  await eventually(() => f.ctx.jobs.get(id, owner.id).output.total > 0);
  const output = await f.call(owner, 'job_output', { job_id: id });
  assert.equal(output.isError, false, JSON.stringify(output)); assert.match(JSON.stringify(output), /preview-ready/);
  const stopped = await f.call(owner, 'job_kill', { job_id: id, reason: 'preview no longer needed' });
  assert.equal(stopped.isError, false, JSON.stringify(stopped));
  assert.equal((await f.ctx.jobs.wait(id, 1000, owner.id)).status, 'killed');
  assert.equal(f.processes[0].kills, 1); assert.equal(f.timers.size, 0);
  assert.ok(f.events.some(event => event.type === 'job/registered' && event.data.toolCall.callId));
});

test('background child keeps its own job owner and read-only policy while using its root project fence', async t => {
  const f = await fixture(t), owner = f.agent('root'), child = f.agent('child', { owner, mode: 'read-only' }), other = f.agent('other');
  const result = await f.call(child); await tick(); assert.equal(result.isError, false, JSON.stringify(result));
  const id = result.value.jobId, spec = f.calls[0];
  assert.equal(f.ctx.jobs.get(id, child.id).owner, child.id);
  for (const agent of [owner, other]) {
    assert.throws(() => f.ctx.jobs.get(id, agent.id), { code: 'JOB_FOREIGN_SESSION' });
    const denied = await f.call(agent, 'job_kill', { job_id: id }); assert.equal(denied.isError, true);
  }
  assert.equal(f.processes[0].status, 'running'); assert.equal(spec.sandboxPolicy.mode, 'read-only');
  assert.equal(spec.sandboxPolicy.workspaceRoot, f.root); assert.deepEqual(spec.sandboxPolicy.additionalWritableRoots, []);
  assert.equal(spec.dshEnv.DSH_PROJECT_READ_ONLY, '1'); assert.equal(spec.dshEnv.DSH_PROJECT_ROOT, f.root);
  assert.match(spec.command, /project-run\.cjs/); assert.equal(spec.onExpiry, 'none');
  f.ctx.jobs.kill(id, child.id); await f.ctx.jobs.wait(id, 1000, child.id);
});

test('project_exec shares explicit SDK background ownership and foreground alias never uses native unconfined body', async t => {
  const f = await fixture(t), owner = f.agent('one');
  const result = await f.call(owner, 'project_exec'); await tick();
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.kind, 'background');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].command, /project-run\.cjs/);
  assert.equal(f.calls[0].sandboxPolicy.mode, 'workspace-write');
  f.ctx.jobs.kill(result.value.jobId, owner.id); await f.ctx.jobs.wait(result.value.jobId, 1000, owner.id);
});

test('missing native job controller fails closed before shell execution', async t => {
  const f = await fixture(t, { controller: false }), owner = f.agent('one');
  const result = await f.call(owner);
  assert.equal(result.isError, true); assert.match(JSON.stringify(result), /JOB_CONTROLLER_UNAVAILABLE|no job controller/);
  assert.equal(f.calls.length, 0); assert.equal(f.ctx.jobs.list(owner.id).length, 0);
});

test('pre-dispatch cancellation and cancellation during admission prevent spawning any process', async t => {
  const f = await fixture(t), owner = f.agent('one'), controller = new AbortController(); controller.abort();
  const result = await f.call(owner, 'bash', args, controller.signal);
  assert.equal(result.isError, true); assert.equal(f.calls.length, 0);
  const during = new AbortController(), jobs = f.ctx.jobs;
  const starter = createProjectProcessStarter({ shell: f.ctx.shell, get: () => ({
    start(spec) { during.abort(Error('cancelled during admission')); return jobs.start(spec); }, kill: (...values) => jobs.kill(...values),
  }) });
  t.after(() => starter.dispose());
  await assert.rejects(starter.start({ cwd: f.root, spec: {} }, { agent: owner, callId: 'cancel-admission', signal: during.signal }, args), /cancelled during admission/);
  assert.equal(f.calls.length, 0);
});

test('a committed job outlives its tool signal but its bounded lifetime cancels and drains it', async t => {
  const f = await fixture(t), owner = f.agent('one'), signal = new AbortController();
  const result = await f.call(owner, 'bash', { ...args, timeoutMs: 99999999 }, signal.signal); await tick();
  assert.equal(result.isError, false, JSON.stringify(result)); const id = result.value.jobId;
  signal.abort(); await tick(); assert.equal(f.processes[0].status, 'running');
  const timer = [...f.timers][0]; assert.equal(timer.ms, 600000); timer.fn();
  const settled = await f.ctx.jobs.wait(id, 1000, owner.id);
  assert.equal(settled.status, 'killed'); assert.match(settled.detail, /lifetime limit/);
  assert.equal(f.processes[0].kills, 1); assert.equal(f.timers.size, 0);
  const read = f.ctx.jobs.read(id, owner.id); assert.equal(read.result.lifetimeExpired, true);
});

test('owner teardown waits for actual process release instead of merely requesting a kill', async t => {
  const f = await fixture(t), owner = f.agent('one'), result = await f.call(owner); await tick();
  const process = f.processes[0]; process.holdShutdown = true; let disposed = false;
  const pending = owner.scope.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(process.kills, 1); assert.equal(disposed, false);
  process.releaseKill(); await pending;
  assert.equal(disposed, true); assert.equal(f.timers.size, 0);
  assert.throws(() => f.ctx.jobs.get(result.value.jobId, owner.id), { code: 'JOB_NOT_FOUND' });
});

test('executor teardown drains its own handles and cannot start more work', async t => {
  const f = await fixture(t), owner = f.agent('one'); await f.call(owner); await tick();
  const process = f.processes[0]; process.holdShutdown = true; let disposed = false;
  const pending = f.run.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(process.kills, 1); assert.equal(disposed, false);
  process.releaseKill(); await pending; assert.equal(disposed, true);
  await assert.rejects(f.run(args, { agent: owner, callId: 'late-call', signal: new AbortController().signal }), { code: 'PROJECT_EXECUTOR_DISPOSED' });
});

test('nonzero background exit remains an observed nonzero result rather than a verification pass', async t => {
  const f = await fixture(t), owner = f.agent('one'), result = await f.call(owner); await tick();
  f.processes[0].finish(7);
  const settled = await f.ctx.jobs.wait(result.value.jobId, 1000, owner.id);
  assert.equal(settled.status, 'completed'); assert.match(settled.detail, /exit code: 7/);
  assert.equal(f.ctx.jobs.read(result.value.jobId, owner.id).result.exitCode, 7); assert.equal(f.timers.size, 0);
});

test('a registry and an exact live conversation owner are required; unowned fallback never runs', async t => {
  const f = await fixture(t), owner = f.agent('one'); let executed = false;
  const starter = createProjectProcessStarter({ get: () => undefined, shell: { execute() { executed = true; } } });
  await assert.rejects(starter.start({ cwd: f.root, spec: {} }, { agent: owner, signal: new AbortController().signal }, args), { code: 'PROJECT_JOBS_UNAVAILABLE' });
  await assert.rejects(starter.start({ cwd: f.root, spec: {} }, { signal: new AbortController().signal }, args), { code: 'PROJECT_JOB_OWNER_REQUIRED' });
  assert.equal(executed, false); await starter.dispose();
});

test('cancellation during asynchronous shell preparation drains the eventual handle', async t => {
  const f = await fixture(t), owner = f.agent('one'), normalExecute = f.ctx.shell.execute.bind(f.ctx.shell);
  let publish, preparing;
  f.ctx.shell.execute = async spec => { preparing = spec; return new Promise(resolve => { publish = resolve; }); };
  const result = await f.call(owner); await tick(); assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(preparing); assert.equal(f.calls.length, 0);
  let disposed = false; const pending = f.run.dispose().then(() => { disposed = true; });
  await tick(); assert.equal(disposed, false); assert.equal(preparing.signal.aborted, true);
  const process = await normalExecute(preparing); publish(process);
  await pending; assert.equal(process.kills, 1); assert.equal(process.status, 'killed'); assert.equal(f.timers.size, 0);
});

test('sandbox preparation failure is reported as a failed job rather than an exit-zero command', async t => {
  const f = await fixture(t), owner = f.agent('one'), result = await f.call(owner); await tick();
  f.processes[0].sandbox.runnerFailed = true; f.processes[0].finish(0);
  const settled = await f.ctx.jobs.wait(result.value.jobId, 1000, owner.id);
  assert.equal(settled.status, 'failed'); assert.match(settled.detail, /sandbox runner failed/);
  assert.equal(f.ctx.jobs.read(result.value.jobId, owner.id).result.sandbox.runnerFailed, true);
});
