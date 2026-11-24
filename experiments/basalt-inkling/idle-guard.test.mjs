import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdleGuard, parseBasaltMetrics } from './idle-guard.mjs';
import { observeNative } from './idle-native.mjs';
import { installAdmission } from './idle-admission.mjs';
import { createNativeControl } from './idle-native-control.mjs';
import { randomUUID } from 'node:crypto';

const label = 'model_name="inkling-2-mini"';
const metrics = [
  '# TYPE basalt_requests_running gauge', 'basalt_requests_running{' + label + '} 0',
  '# TYPE basalt_requests_waiting gauge', 'basalt_requests_waiting{' + label + '} 0',
  '# TYPE basalt_requests_finished_total counter', 'basalt_requests_finished_total{' + label + ',finished_reason="length"} 36',
  'basalt_requests_finished_total{finished_reason="stop",' + label + '} 5',
  '# TYPE basalt_generation_tokens_total counter', 'basalt_generation_tokens_total{' + label + '} 323130',
].join('\n');

test('Basalt uses all finish reasons and both gauges; missing or ambiguous signals hold', () => {
  assert.deepEqual(parseBasaltMetrics(metrics), { completed: 41, tokens: 323130, busy: false });
  assert.equal(parseBasaltMetrics(metrics.replace('gauge\nbasalt_requests_waiting{' + label + '} 0',
    'gauge\nbasalt_requests_waiting{' + label + '} 1')).busy, true);
  const noCompletions = metrics.split('\n').filter(line => !line.startsWith('basalt_requests_finished_total{')).join('\n');
  assert.equal(parseBasaltMetrics(noCompletions.replace('323130', '0')).completed, 0);
  for (const bad of [noCompletions, noCompletions.replace('323130', '0').replace('# TYPE basalt_requests_finished_total counter', ''),
    metrics.replace('323130', 'NaN'), metrics.replace('323130', '-1'), metrics.replace(label, 'model_name="other"'),
    metrics + '\nbasalt_requests_running{' + label + '} 0']) assert.throws(() => parseBasaltMetrics(bad));
});

function fixture() {
  let time = 0, broken = false, grants = 0, commits = 0, reopened = 0, onFence = () => {}, onStop = () => {};
  const value = { generation: 'instance/boot/native/engine', native: { epoch: 'native-a', revision: 0, busy: false },
    engine: { completed: 0, tokens: 0, busy: false } };
  const guard = createIdleGuard({ now: () => time, observe: async () => {
    if (broken) throw Error('Unavailable');
    return structuredClone(value);
  }, tryFence: async generation => {
    assert.equal(generation, value.generation);
    grants++; onFence();
    return { async commitStop() { commits++; onStop(); }, async reopen() { reopened++; } };
  } });
  return { value, guard, counts: () => ({ grants, commits, reopened }), setBroken(v) { broken = v; },
    onFence(fn) { onFence = fn; }, onStop(fn) { onStop = fn; },
    async tick(delta = 5000) { time += delta; return guard.tick(); },
    async wait(n) { for (let i = 0; i < n; i++) assert.equal(await this.tick(), 'countdown'); } };
}

test('requires 300 continuous seconds on this boot with stable event and token counters', async () => {
  const f = fixture();
  assert.equal(await f.tick(0), 'countdown');
  await f.wait(59);
  // A request starts and finishes between scrapes; idle GPUs alone miss it.
  f.value.engine.completed++; assert.equal(await f.tick(), 'countdown');
  await f.wait(59);
  f.value.native.revision++; assert.equal(await f.tick(), 'countdown');
  await f.wait(59);
  f.value.generation = 'other boot and service incarnations'; assert.equal(await f.tick(), 'countdown');
  await f.wait(59);
  assert.equal(await f.tick(), 'stop-submitted');
  assert.equal(await f.tick(), 'stop-outcome-pending');
  assert.deepEqual(f.counts(), { grants: 1, commits: 1, reopened: 0 });
});

test('busy, failed, missing and interrupted observations reset the countdown', async () => {
  const f = fixture();
  await f.wait(60);
  f.value.native.busy = true; assert.equal(await f.tick(), 'busy'); f.value.native.busy = false;
  await f.wait(60);
  f.setBroken(true); assert.equal(await f.tick(), 'unknown'); f.setBroken(false);
  await f.wait(60);
  delete f.value.native.revision; assert.equal(await f.tick(), 'unknown'); f.value.native.revision = 3;
  await f.wait(60);
  assert.equal(await f.tick(16000), 'countdown'); await f.wait(59);
  assert.equal(await f.tick(), 'stop-submitted');
});

test('work during drain reopens admission; ambiguous stop stays latched with the lease held', async () => {
  const f = fixture();
  f.onFence(() => { f.value.native.revision++; });
  await f.wait(60);
  assert.equal(await f.tick(), 'changed-during-drain');
  assert.deepEqual(f.counts(), { grants: 1, commits: 0, reopened: 1 });
  f.onFence(() => {}); f.onStop(() => { throw Error('provider acknowledgement lost'); });
  await f.wait(60);
  assert.equal(await f.tick(), 'stop-outcome-pending');
  assert.equal(await f.tick(), 'stop-outcome-pending');
  assert.deepEqual(f.counts(), { grants: 2, commits: 1, reopened: 1 });
});

test('passive cold inbox, parked live work, global tools and unowned jobs keep the lab awake', async () => {
  const cold = { id: 'cold', createdAt: 1, cwd: '/lab' }, live = { id: 'live', createdAt: 2, cwd: '/lab' };
  let at = -1, pending = 0, pty = false, jobs = [], coldReads = 0;
  const agent = { id: live.id, status: 'idle', phase: { kind: 'idle' }, inbox: { nextTurn: [], nextStep: [] } };
  const handlers = new Map();
  const ctx = {
    on: (key, fn) => handlers.set(key, fn), agents: { list: () => [agent] },
    terminals: { hasOwnerActivity: () => pty },
    jobs: { events: { subscribe(filter) { assert.deepEqual(filter, { owners: 'all' }); } }, list: () => jobs },
    sessionQuery: { listSessions: async () => [cold, live].map(header => ({ header })),
      async readSession(id) {
        assert.equal(id, cold.id);
        coldReads++;
        return { session: { ...cold }, events: Array.from({ length: at + 1 }, (_, seq) => ({ seq })), inheritedEventCount: 0 };
      } },
    sessionController: { async state(request) {
      assert.deepEqual(Object.keys(request), ['sessionId']);
      const active = request.sessionId === live.id;
      return { active, running: false, cursor: at, queue: active ? [] : null, pendingInput: [] };
    } },
    sessionProjections: { restore(checkpoint, events, baseSeq, session, inheritedEventCount) {
      assert.deepEqual(checkpoint, {});
      assert.deepEqual(session, cold);
      assert.equal(baseSeq, 0);
      assert.equal(inheritedEventCount, 0);
      const seq = events.at(-1)?.seq ?? -1;
      const inbox = { 'next-turn': Array(pending).fill({}), 'next-step': [] };
      return { snapshot: { asOfSeq: seq, values: { inbox } }, checkpoint: { inbox: { seq, ver: 1, val: inbox } } };
    } },
  };
  const activity = observeNative(ctx), read = () => activity.read(AbortSignal.timeout(1000));
  assert.equal((await read()).busy, false);
  at++; pending = 1; assert.equal((await read()).busy, true);
  at++; pending = 0; assert.equal((await read()).busy, false);
  const revision = (await read()).revision; assert.equal(coldReads, 3);
  agent.phase.kind = 'maintenance'; assert.equal((await read()).busy, true); agent.phase.kind = 'idle';
  agent.inbox.nextStep.push({}); assert.equal((await read()).busy, true); agent.inbox.nextStep.pop();
  jobs = [{ id: 'job', status: 'stopping' }]; assert.equal((await read()).busy, true); jobs = [];
  pty = true; assert.equal((await read()).busy, true); pty = false;
  let release;
  const tool = handlers.get('tools/execute')({}, () => new Promise(resolve => { release = resolve; }));
  assert.equal((await read()).busy, true); release(); await tool;
  const after = await read(); assert.equal(after.busy, false); assert.ok(after.revision > revision);
});

test('physical dispatch awaiting its first event holds the lease; work during asynchronous drain never freezes', async () => {
  let release, duringSnapshot = () => {};
  const ctx = {
    on() {}, effect() {}, agents: { create() {}, resume() {}, list: () => [] }, jobs: { start() {} }, tools: { execute() {} },
    typertGateway: { async dispatchRpc() { await new Promise(resolve => { release = resolve; }); }, openWireStream() {},
      getPendingRemoteEvents: () => [], invoke() {}, stream() {} },
  };
  const ingress = { accepting: false, initialized: false, inFlight: 0, revision: 0, intact: () => true };
  const admission = installAdmission(ctx, ingress);
  const pending = ctx.typertGateway.dispatchRpc('session/prompt', {});
  assert.equal(admission.close(), false);
  release(); await pending;
  const epoch = randomUUID();
  let revision = 0, stopped = 0, response;
  const activity = { epoch, revision: () => revision, async flush() {}, async read() {
    const captured = revision;
    await Promise.resolve();
    duringSnapshot();
    return { epoch, revision: captured, busy: false };
  } };
  const control = createNativeControl(activity, admission, () => { stopped++; });
  const issue = async (op, args) => {
    await control.request({ rid: randomUUID(), op, ...args }, value => { response = value; });
    return response;
  };
  const lease = randomUUID();
  const initial = await issue('status');
  duringSnapshot = () => { revision++; };
  assert.equal((await issue('freeze', { epoch, revision: initial.revision, lease })).ok, false);
  assert.equal(admission.open(), true); assert.equal(stopped, 0);
  duringSnapshot = () => {};
  const latest = await issue('status');
  assert.equal((await issue('freeze', { epoch, revision: latest.revision, lease })).ok, true);
  assert.equal(stopped, 1); assert.equal(admission.open(), false);
  assert.equal((await ctx.typertGateway.dispatchRpc('session/prompt', {})).ok, false);
  assert.equal((await issue('thaw', { lease: randomUUID() })).ok, false);
  assert.equal((await issue('thaw', { lease })).ok, true);
  assert.equal(admission.open(), true);
});
