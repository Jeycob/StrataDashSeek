import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
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
import { FairGate } from '../efficiency/gate.mjs';
import { bindHeavyToolLease } from '../efficiency/heavy-tool-lease.mjs';
import {createHash} from 'node:crypto';
import {createProjectExecutionMode} from './execution-mode-service.mjs';
import custodyProtocol from '../development/project-custody.cjs';
import {custodyReader} from './project-custody.mjs';
function hostMode(){const policy={version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)},policySha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'),snapshot={...policy,policySha256,sourceCommit:'a'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'};return createProjectExecutionMode({snapshot,assertUnchanged:()=>snapshot}).service;}

let modules;
function sdk() {
  return modules ??= (async () => {
    const cli = process.env.HARNESS_NATIVE_CLI ?? path.join(process.env.HOMEAI_RUNTIME ?? '/data/harness/runtime', 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const base = path.resolve(path.dirname(cli), '../..');
    const load = name => import(pathToFileURL(path.join(base, name, 'lib/index.js')));
    const [cordis, prompt, tools, pipeline, scope, jobs, jobTools, bash, sessions] = await Promise.all([
      load('cordis'), load('dsh-system-prompt'), load('dsh-tools'),
      import(pathToFileURL(path.join(base, 'dsh-tools/lib/pipeline.js'))), load('dsh-scope'),
      load('dsh-jobs-local'), load('dsh-tool-jobs'), load('dsh-tool-bash'), load('dsh-session'),
    ]);
    return { ...cordis, SystemPrompt: prompt.default, Tools: tools.default, ...pipeline, ...scope,
      LocalJobs: jobs.default, applyJobTools: jobTools.apply, applyBash: bash.apply, Sessions: sessions.default };
  })();
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function eventually(check) {
  const until = performance.now() + 1000;
  while (!check()) { if (performance.now() >= until) assert.fail('SDK state did not settle within the bounded wait'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const args = Object.freeze({ command: 'node preview.mjs', description: 'Start the assigned project preview', run_in_background: true });

async function fixture(t, { controller = true, admission = false, custody = false, liveSessions = false, completionDelivery = 'quiet' } = {}) {
  const S = await sdk(), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-project-jobs-'));
  const root = path.join(directory, 'project'); await fs.mkdir(root);
  const ctx = new S.Context(); new S.SystemPrompt(ctx, {}); new S.Tools(ctx);
  ctx.provide('projectExecutionMode',hostMode());
  const agents = new Map(), scopes = [], events = [], notices = [], wakes = [], injections = [], settlements = [], calls = [], processes = [], timers = new Set();
  if (liveSessions) { new S.Sessions(ctx); ctx.on('session/event', (session, event) => events.push(event), { global: true }); }
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
  ctx.provide('workingDirectory', { ensure: async () => root }); ctx.provide('shellEnv', { collect: () => ({ DSH_APP_PORT: '21000' }) });
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session.mode ?? 'danger-full-access', workspaceRoot: directory }) });
  ctx.provide('shell', { sandboxMode: 'workspace-write', resolve: spec => ({ stdoutMaxBytes: 4096, ...spec }), async execute(spec) {
    calls.push(spec); let release;
    const process = { status: 'running', exitCode: null, signal: null, kills: 0, holdShutdown: false,
      sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
      done: new Promise(resolve => { release = resolve; }),
      observed: Object.fromEntries(['stdout', 'stderr'].map(channel => [channel, { readFrom(from) {
        const value = channel === 'stdout' ? (custody?custodyProtocol.frame(JSON.parse(spec.stdin),{pid:1234,ppid:12,pgrp:12,startTicks:'987654',pidNamespace:'pid:[12345]'}).toString():'')+'preview-ready\n' : '';
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
  if (controller) S.applyJobTools(ctx, { completionDelivery, waitTimeoutMs: 100, maxWaitTimeoutMs: 1000, inlineOutputBytes: 2048 });
  ctx.jobs.events.subscribe({ owners: 'scope' }, event => { if (event.type === 'settled') settlements.push(event); });
  S.applyBash(ctx, { enableRunInBackground: false }); const native = ctx.tools.get('bash');
  const manager = { existing: new Set(), data: { installedAt: 1000, sessions: {} }, ownerAgent: agent => agent?.owner ?? agent };
  const processTimers = { setTimer(fn, ms) { const token = { fn, ms, unref() {} }; timers.add(token); return token; }, clearTimer(token) { timers.delete(token); } };
  const run = createProjectCommandRunner(ctx, manager, { processTimers }, hostExecutionBinding());
  const managed = createManagedShell(ctx, manager, run, hostExecutionBinding()); registerProjectTool(ctx, manager, run, hostExecutionBinding());
  if (admission) await applyEfficiency(ctx, { stateDirectory: path.join(directory, 'efficiency'), engineMetrics: false });
  const pipeline = new S.ToolExecutionPipeline(ctx);
  ctx.tools.setExecutor({ describe: defs => ({ schemas: defs.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
    execute: input => S.executeToolBatch(input, pipeline, () => 1) });
  function agent(id, { owner, mode } = {}) {
    const value = { id, owner, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
      session: liveSessions ? ctx.sessions.create(id, { meta: { cwd: root, createdAt: 2000 } }) : { id, mode, header: { createdAt: 2000 }, append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event; } },
      inject: message => { notices.push(message); injections.push(message); }, followup: message => { notices.push(message); wakes.push(message); } };
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
  return { ...S, ctx, root, directory, manager, native, managed, run, agent, call, processes, calls, timers, events, notices, wakes, injections, settlements };
}

test('expected handed-off preview expiry is collected after a completed turn in either cleanup order', async t => {
  for (const first of ['process timer', 'broker cleanup']) await t.test(first, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = await fixture(t, { custody: true, liveSessions: true, completionDelivery: 'wakeup' }), owner = f.agent('preview-owner');
    owner.session.append('turn/start', { turn: 1 });
    const result = await f.run.startWithCustody(args, { agent: owner, callId: 'preview', signal: new AbortController().signal });
    const capture = await f.run.custodyFor(result.jobId, owner.id), timer = [...f.timers][0], process = f.processes[0];
    f.run.releasePreviewAdmission(capture);
    owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    process.holdShutdown = true; t.mock.timers.setTime(capture.expiresAt);
    let closing;
    if (first === 'process timer') { timer.fn(); closing = f.run.stopOwned(result.jobId, owner.id); }
    else { closing = f.run.stopOwned(result.jobId, owner.id); timer.fn(); }
    await tick(); assert.equal(process.kills, 1); assert.equal(f.settlements.length, 0);
    process.releaseKill(); await closing; await capture.done;
    await eventually(() => f.settlements.length === 1); await tick();
    assert.equal(f.settlements[0].awaited, true);
    assert.equal(f.wakes.length, 0); assert.equal(f.injections.length, 0);
    assert.equal(f.ctx.jobs.get(result.jobId, owner.id).status, 'killed');
    const retained = f.ctx.jobs.read(result.jobId, owner.id);
    assert.equal(retained.result.lifetimeExpired, true); assert.match(JSON.stringify(retained.chunks), /preview-ready/);
    assert(f.events.some(event => event.type === 'job/settled'), 'SDK history must retain the expiry');
    assert.equal(process.kills, 1); assert.equal(f.timers.size, 0);
  });
});

test('only a confirmed handed-off preview expiry after its own latest completed turn avoids SDK notices', async t => {
  for (const scenario of ['ordinary build', 'unpublished preview', 'earlier completed turn', 'failed turn', 'new active turn', 'turn starts during settlement', 'input arrives during settlement', 'queued input', 'different session', 'nonzero exit', 'sandbox failure', 'sandbox denial', 'early close', 'explicit wait']) await t.test(scenario, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = await fixture(t, { custody: true, liveSessions: true, completionDelivery: 'wakeup' }), owner = f.agent('owner');
    owner.session.append('turn/start', { turn: 1 });
    if (scenario === 'earlier completed turn') owner.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const execution = { agent: owner, callId: 'preview', signal: new AbortController().signal };
    const result = scenario === 'ordinary build' ? await f.run(args, execution) : await f.run.startWithCustody(args, execution);
    await tick();
    const capture = scenario === 'ordinary build' ? null : await f.run.custodyFor(result.jobId, owner.id);
    if (capture && scenario !== 'unpublished preview') f.run.releasePreviewAdmission(capture);
    if (scenario === 'different session') {
      const other = f.agent('other'); other.session.append('turn/start', { turn: 1 }); other.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    } else if (scenario !== 'earlier completed turn') owner.session.append('turn/end', { turn: 1, reason: scenario === 'failed turn' ? { kind: 'error', error: { code: 'UNKNOWN', message: 'synthetic turn failure' } } : { kind: 'completed' } });
    if (scenario === 'new active turn') { owner.session.append('turn/start', { turn: 2 }); owner.status = 'running'; }
    if (scenario === 'turn starts during settlement' || scenario === 'input arrives during settlement') {
      const wait = f.ctx.jobs.wait.bind(f.ctx.jobs);
      f.ctx.jobs.wait = (...values) => {
        const pending = wait(...values);
        if (scenario === 'turn starts during settlement') { owner.session.append('turn/start', { turn: 2 }); owner.status = 'running'; }
        else {
          const message = { id: 'late-input', role: 'user', content: [{ type: 'text', text: 'Next request' }] };
          owner.inbox.nextTurn.push(message); owner.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
        }
        return pending;
      };
    }
    if (scenario === 'queued input') owner.inbox.nextTurn.push({ id: 'next-request' });
    const process = f.processes[0], timer = [...f.timers][0];
    const waiting = scenario === 'explicit wait' ? f.ctx.jobs.wait(result.jobId, 1000, owner.id) : null;
    if (scenario === 'nonzero exit') process.finish(7);
    else if (scenario === 'early close') await f.run.stopOwned(result.jobId, owner.id);
    else {
      if (scenario === 'sandbox failure') process.sandbox.runnerFailed = true;
      if (scenario === 'sandbox denial') process.sandbox.denied = true;
      t.mock.timers.setTime((capture?.expiresAt ?? Date.now() + timer.ms)); timer.fn();
    }
    await eventually(() => f.settlements.length === 1);
    if (waiting) {
      assert.equal((await waiting).status, 'killed'); assert.equal(f.settlements[0].awaited, true); assert.equal(f.notices.length, 0);
    } else {
      await eventually(() => f.notices.length === 1); assert.equal(f.settlements[0].awaited, false);
      assert.equal(f.wakes.length, owner.status === 'running' ? 0 : 1);
      assert.equal(f.injections.length, owner.status === 'running' ? 1 : 0);
    }
  });
});

test('actual pinned SDK partial UTF8 app suffix cannot invalidate a complete ASCII custody prefix',async()=>{
 const cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js');
 const {OutputCollector}=await import(pathToFileURL(path.resolve(path.dirname(cli),'../../dsh-subprocess-local/lib/output.js')));
 const control={version:1,nonce:'a'.repeat(64),generation:'b'.repeat(32)},frame=custodyProtocol.frame(control,{pid:1234,ppid:12,pgrp:12,startTicks:'987654',pidNamespace:'pid:[12345]'});
 for(const split of [0,Math.floor(frame.length/2)]){
  const stdout=new OutputCollector(4096,'custody UTF8 fixture');let finish;
  const process={observed:{stdout},done:new Promise(resolve=>{finish=resolve;})};
  stdout.push(split?frame.subarray(0,split):Buffer.concat([frame,Buffer.from([0xc4])]));
  const reader=custodyReader(process,control,{timeoutMs:500});
  if(split)stdout.push(Buffer.concat([frame.subarray(split),Buffer.from([0xc4])]));
  try{
   assert.equal((await reader.ready).pid,1234);
   assert.deepEqual(reader.stdout.readFrom(0),{text:'\ufffd',nextOffset:1,lossy:false});
   stdout.push(Buffer.from([0x8d]));
   assert.deepEqual(reader.stdout.readFrom(0),{text:'č',nextOffset:2,lossy:false});
   const raw=stdout.readFrom(frame.length+1);
   assert.deepEqual(reader.stdout.readFrom(1),{text:raw.text,nextOffset:raw.nextOffset-frame.length,lossy:raw.lossy});
  }finally{finish();}
 }
});

test('actual pinned SDK jobs pump only filtered app output for a trusted custody start',async t=>{
 const f=await fixture(t,{custody:true}),owner=f.agent('custody-owner');
 const result=await f.run.startWithCustody(args,{agent:owner,callId:'custody-internal',signal:new AbortController().signal});
 const capture=await f.run.custodyFor(result.jobId,owner.id);assert.equal(capture.identity.pid,1234);assert.equal(f.ctx.jobs.get(result.jobId,owner.id).owner,owner.id);
 let output='';await eventually(()=>{output+=JSON.stringify(f.ctx.jobs.read(result.jobId,owner.id).chunks);return output.includes('preview-ready');});
 assert(!output.includes('HOMEAI_CUSTODY'));assert(!output.includes(capture.identity.generation));
 f.ctx.jobs.kill(result.jobId,owner.id);await capture.done;assert.throws(capture.assertCurrent,{code:'PROJECT_CUSTODY_EXPIRED'});
});

test('preview admission release requires private current custody and never releases another holder on cleanup',async t=>{
 const f=await fixture(t,{custody:true}),owner=f.agent('preview-owner'),gate=new FairGate();
 const execution={agent:owner,callId:'preview-admission',signal:new AbortController().signal};
 const releaseCall=bindHeavyToolLease(execution,await gate.acquire({rootId:owner.id}));t.after(releaseCall);
 const result=await f.run.startWithCustody(args,execution),capture=await f.run.custodyFor(result.jobId,owner.id);
 releaseCall();assert.equal(gate.snapshot().active.length,1);
 assert.throws(()=>f.run.releasePreviewAdmission({...capture}),{code:'PROJECT_CUSTODY_UNAVAILABLE'});
 assert.equal(gate.snapshot().active.length,1);
 f.run.releasePreviewAdmission(capture);assert.equal(gate.snapshot().active.length,0);
 assert.equal(f.processes[0].status,'running');assert.equal(f.timers.size,1);capture.assertCurrent();
 const next=await gate.acquire({rootId:'next-build'});t.after(next.release);
 f.run.releasePreviewAdmission(capture);assert.equal(gate.snapshot().owner,'next-build');
 f.ctx.jobs.kill(result.jobId,owner.id);await capture.done;
 assert.equal(f.processes[0].kills,1);assert.equal(f.timers.size,0);assert.equal(gate.snapshot().owner,'next-build');
 assert.throws(()=>f.run.releasePreviewAdmission(capture),{code:'PROJECT_CUSTODY_EXPIRED'});
 assert.equal(gate.snapshot().owner,'next-build');
});

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

test('pinned SDK registry lookup from a plugin context resolves exact scoped owner and controller', async t => {
  const f = await fixture(t), owner = f.agent('scoped-owner'); let starter;
  await f.ctx.plugin({ name: 'project-process-registry-fixture', inject: ['shell'], apply(ctx) { starter = createProjectProcessStarter(ctx); } }).await();
  const result = await starter.start({ cwd: f.root, spec: { sandboxPolicy: { mode: 'workspace-write' } } }, { agent: owner, callId: 'scoped-registry', signal: new AbortController().signal }, args);
  await tick(); assert.equal(f.ctx.jobs.get(result.jobId, owner.id).owner, owner.id);
  assert.equal(f.processes.length, 1); f.processes[0].finish();
  assert.equal((await f.ctx.jobs.wait(result.jobId, 1000, owner.id)).status, 'completed'); await starter.dispose();
});

test('spawn and registry failure release retained admission and permit the next project', async t => {
  const f = await fixture(t, { admission: true }), owner = f.agent('failure-owner'), next = f.agent('next-owner');
  const execute = f.ctx.shell.execute; f.ctx.shell.execute = async () => { throw Error('synthetic spawn failure'); };
  const failed = await f.call(owner); assert.equal(failed.isError, false); await tick();
  assert.equal((await f.ctx.jobs.wait(failed.value.jobId, 1000, owner.id)).status, 'failed');
  f.ctx.shell.execute = execute;
  const admitted = await f.call(next); assert.equal(admitted.isError, false); await tick(); f.processes[0].finish();
  await f.ctx.jobs.wait(admitted.value.jobId, 1000, next.id);
  const gate = new FairGate(), execution = { agent: owner, signal: new AbortController().signal }, permit = await gate.acquire({ rootId: owner.id });
  const release = bindHeavyToolLease(execution, permit), starter = createProjectProcessStarter({ get: () => ({ start() { throw Error('synthetic registry failure'); } }) });
  await assert.rejects(starter.start({ cwd: f.root, spec: {} }, execution, args), /synthetic registry failure/);
  release(); assert.equal(gate.snapshot().active.length, 0); await starter.dispose();
});

test('heavy admission stays held while executor disposal waits for actual command quiescence', async t => {
  const f = await fixture(t, { admission: true }), owner = f.agent('dispose-owner'), next = f.agent('waiting-owner');
  const first = await f.call(owner); assert.equal(first.isError, false); await tick();
  const process = f.processes[0]; process.holdShutdown = true;
  let acknowledged = false; const waiting = f.call(next).then(value => { acknowledged = true; return value; }); await tick();
  const dispose = f.run.dispose(); await tick(); assert.equal(process.kills, 1); assert.equal(acknowledged, false);
  process.releaseKill(); await dispose; const result = await waiting;
  assert.equal(result.isError, true); assert.match(JSON.stringify(result), /PROJECT_EXECUTOR_DISPOSED|shutting down/); assert.equal(f.processes.length, 1);
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
