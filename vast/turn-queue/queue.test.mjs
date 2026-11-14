import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TurnQueue } from './queue.mjs';
import { apply, rootOf, persistStatus } from './plugin.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (id, turn = 1, rootId = id, signal) => ({ rootId, sessionId: id, turn, signal });

test('Windows replacement denial falls back to a current diagnostic snapshot', () => {
  const writes = [], removed = [], state = { owner: null, waiting: [] };
  const io = { writeFileSync(file, json) { writes.push({ file, state: JSON.parse(json) }); },
    renameSync() { throw Object.assign(Error('Sharing violation'), { code: 'EPERM' }); },
    unlinkSync(file) { removed.push(file); } };
  persistStatus('state.json', state, io);
  assert.equal(writes.length, 2); assert.equal(writes[1].file, 'state.json');
  assert.deepEqual(writes[1].state, state); assert.equal(removed.length, 1);
});

test('FIFO owns a complete turn, not a single model step', async () => {
  const q = new TurnQueue();
  await q.enter(request('A'));
  let b = false, c = false;
  const pb = q.enter(request('B')).then(() => { b = true; });
  const pc = q.enter(request('C')).then(() => { c = true; });
  await q.enter(request('A')); // Another tool/compaction/model step, same owner.
  await tick(); assert.equal(b, false); assert.equal(c, false);
  q.end('A', 1); await pb; assert.equal(b, true); assert.equal(c, false);
  q.end('B', 1); await pc; assert.equal(q.owner, 'C');
});
test('child inherits ownership; parent waiting for child cannot deadlock', async () => {
  const q = new TurnQueue(); await q.enter(request('A'));
  const other = q.enter(request('B'));
  await q.enter(request('child', 1, 'A'));
  q.end('A', 1); await tick(); assert.equal(q.owner, 'A');
  q.end('child', 1); await other; assert.equal(q.owner, 'B');
});
test('cancelled waiter is removed without changing the active owner', async () => {
  const q = new TurnQueue(); await q.enter(request('A'));
  const controller = new AbortController(), p = q.enter(request('B', 1, 'B', controller.signal));
  controller.abort(new Error('cancel')); await assert.rejects(p, /cancel/);
  assert.equal(q.waiting.length, 0); assert.equal(q.owner, 'A');
});
test('already aborted request never joins the queue', async () => {
  const q = new TurnQueue(), c = new AbortController(); c.abort();
  await assert.rejects(q.enter(request('A', 1, 'A', c.signal))); assert.equal(q.owner, null);
});
test('abort of owner does not release while its model request is still unwinding', async () => {
  const q = new TurnQueue(), c = new AbortController(); await q.enter(request('A', 1, 'A', c.signal));
  let ready = false; const p = q.enter(request('B')).then(() => { ready = true; });
  c.abort(); await tick(); assert.equal(ready, false);
  q.end('A', 1); await p; assert.equal(ready, true);
});
test('later turn from the same chat goes behind an already queued chat', async () => {
  const q = new TurnQueue(); await q.enter(request('A')); const b = q.enter(request('B'));
  q.end('A', 1); const a2 = q.enter(request('A', 2)); await b;
  assert.equal(q.owner, 'B'); q.end('B'); await a2; assert.equal(q.owner, 'A');
});
test('release is turn-specific and duplicate end events are harmless', async () => {
  const q = new TurnQueue(); await q.enter(request('A', 2)); q.end('A', 1);
  assert.equal(q.owner, 'A'); q.end('A', 2); q.end('A', 2); assert.equal(q.owner, null);
});
test('repeated pre-step calls use the same receipt without accumulating listeners', async () => {
  const q = new TurnQueue(); const first = await q.enter(request('A'));
  for (let i = 0; i < 100; i++) assert.equal(await q.enter(request('A')), first);
  assert.equal(q.active.size, 1); assert.equal(q.waiting.length, 0);
});
test('diagnostic failure does not break ownership or scheduling', async () => {
  const q = new TurnQueue(() => { throw new Error('disk unavailable'); });
  await q.enter(request('A')); const b = q.enter(request('B')); q.end('A'); await b;
  assert.equal(q.owner, 'B');
});
test('dispose rejects all waiters and new work, and clears state', async () => {
  const q = new TurnQueue(); await q.enter(request('A')); const b = q.enter(request('B'));
  q.close(); await assert.rejects(b, /unloaded/); await assert.rejects(q.enter(request('C')), /closed/);
  assert.equal(q.active.size, 0); assert.equal(q.waiting.length, 0);
});
test('persisted diagnostic state does not retain an owner after the final turn ends', async () => {
  let latest; const q = new TurnQueue((_event, state) => { latest = state; });
  await q.enter(request('A')); q.end('A');
  assert.equal(latest.owner, null); assert.deepEqual(latest.active, []);
});

test('every released notification has a settled owner snapshot', async () => {
  const seen = [], q = new TurnQueue((event, state) => { if (event === 'released') seen.push(state); });
  await q.enter(request('A')); const pending = q.enter(request('B'));
  q.end('A'); await pending; q.end('B');
  assert.equal(seen[0].owner, 'B'); assert.equal(seen[0].active.length, 1);
  assert.equal(seen[1].owner, null); assert.equal(seen[1].active.length, 0);
});

test('an unavailable logger cannot prevent the final status file update', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-test-'));
  const file = path.join(dir, 'state.json'), hooks = new Map(), dispose = [];
  const ctx = { agents: new Map(), logger: { info() { throw Error('No event logger'); } },
    on(name, fn) { const list = hooks.get(name) || []; list.push(fn); hooks.set(name, list); },
    effect(fn) { dispose.push(fn()); } };
  try {
    apply(ctx, { statusPath: file });
    const agent = { id: 'A', session: { id: 'A', header: {} } };
    await hooks.get('agent/pre-step')[0]({ agent, turn: 1, signal: new AbortController().signal,
      modelSelection: { provider: 'strata1' } }, () => undefined);
    hooks.get('session/event')[0](agent.session, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, null);
  } finally {
    dispose.forEach(fn => fn());
    // Only this test's fixed files and unique empty temp directory are removed.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
test('FIFO remains ordered with fifty unrelated chats and cancelled waiters', async () => {
  const q = new TurnQueue(), order = []; await q.enter(request('head'));
  const all = Array.from({ length: 50 }, (_, i) => q.enter(request(String(i))).then(() => {
    order.push(i); q.end(String(i));
  }));
  q.end('head'); await Promise.all(all); assert.deepEqual(order, Array.from({ length: 50 }, (_, i) => i));
});
test('root ancestry is followed and cycles cannot hang scheduling', () => {
  const root = { id: 'R', session: { header: {} } };
  const child = { id: 'C', session: { header: { origin: 'subagent', parentSession: 'R' } } };
  assert.equal(rootOf(child, new Map([['R', root]])), 'R');
  root.session.header = { origin: 'subagent', parentSession: 'C' };
  assert.equal(rootOf(child, new Map([['R', root], ['C', child]])), 'R');
});
test('plugin gates before automatic compaction and passes unconfigured providers through', async () => {
  const hooks = new Map(), teardown = [];
  const ctx = { agents: new Map(), logger: { info() {} },
    on(name, fn, options) { const list = hooks.get(name) || []; options?.prepend ? list.unshift(fn) : list.push(fn); hooks.set(name, list); },
    effect(fn) { teardown.push(fn()); } };
  let called = 0; ctx.on('agent/pre-step', async (_input, next) => { called++; return next(); });
  apply(ctx);
  const run = async input => { const list = hooks.get('agent/pre-step'); let i = 0; const next = () => list[i++]?.(input, next) ?? Promise.resolve('ok'); return next(); };
  const a = { id: 'A', session: { id: 'A', header: {} } }, b = { id: 'B', session: { id: 'B', header: {} } };
  const input = agent => ({ agent, turn: 1, signal: new AbortController().signal, modelSelection: { provider: 'strata1' } });
  await run(input(a)); const pending = run(input(b)); await tick(); assert.equal(called, 1);
  for (const hook of hooks.get('session/event')) hook(a.session, { type: 'turn/end', data: { turn: 1 } });
  await pending; assert.equal(called, 2);
  await run({ ...input(a), modelSelection: { provider: 'other' } }); assert.equal(called, 3);
  teardown.forEach(fn => fn());
});

function fixture() {
  const hooks = new Map(), teardown = [];
  const ctx = { agents: new Map(), logger: { info() {} },
    on(name, fn, options) { const list = hooks.get(name) || []; options?.prepend ? list.unshift(fn) : list.push(fn); hooks.set(name, list); },
    effect(fn) { teardown.push(fn()); } };
  apply(ctx);
  const dispatch = (event, input, last = () => Promise.resolve('ok')) => {
    const list = hooks.get(event) || []; let i = 0;
    const next = () => i < list.length ? Reflect.apply(list[i++], ctx.llm, [input, next]) : last();
    return next();
  };
  ctx.llm = { stream: options => dispatch('llm/stream', options, () => ctx.adapter(options)) };
  ctx.adapter = async function* () { yield 'summary'; };
  const agent = id => { const a = { id, session: { id, header: {} } }; ctx.agents.set(id, a); return a; };
  return { ctx, dispatch, agent, enter: a => dispatch('agent/pre-step', { agent: a, turn: 1,
    signal: new AbortController().signal, modelSelection: { provider: 'strata1' } }),
    end: a => (hooks.get('session/event') || []).forEach(fn => fn(a.session, { type: 'turn/end', data: { turn: 1 } })),
    close: () => teardown.forEach(fn => fn()) };
}
async function* one(value) { yield value; }
test('manual compaction from another session waits behind the active root turn', async () => {
  const f = fixture(), a = f.agent('A'); f.agent('B'); await f.enter(a);
  let called = false;
  f.ctx.adapter = () => { called = true; return one('summary'); };
  const stream = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'B' }, () => { called = true; return one('summary'); });
  const pending = stream.next(); await tick(); assert.equal(called, false);
  f.end(a); assert.equal((await pending).value, 'summary'); await stream.return(); f.close();
});

test('compaction gets a real text budget without changing ordinary reasoning', async () => {
  const f = fixture(); let actual;
  f.ctx.adapter = options => { actual = options; return one('summary'); };
  const request = { provider: 'strata1', sessionId: 'A', purpose: 'compaction',
    maxTokens: 3072, reasoningEffort: 'medium' };
  const stream = f.dispatch('llm/stream', request, () => { throw Error('Original adapter must not dispatch'); });
  assert.equal((await stream.next()).value, 'summary'); await stream.return();
  assert.equal(actual.reasoningEffort, 'off'); assert.equal(actual.maxTokens, 8192);
  assert.equal(actual.messages.length, 1);
  assert.match(actual.messages[0].content[0].text, /1000 words/);
  assert.equal(request.reasoningEffort, 'medium'); assert.equal(request.maxTokens, 3072);
  let normal;
  const ordinary = f.dispatch('llm/stream', { provider: 'strata1', reasoningEffort: 'medium' },
    () => { normal = true; return one('normal'); });
  assert.equal((await ordinary.next()).value, 'normal'); await ordinary.return();
  assert.equal(normal, true); f.close();
});
test('same-root LLM calls serialize across the full streamed iterator lifetime', async () => {
  const f = fixture(), a = f.agent('A'); await f.enter(a); let second = false;
  const first = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'A' }, () => one('first'));
  assert.equal((await first.next()).value, 'first');
  const next = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'A' }, () => { second = true; return one('second'); });
  const pending = next.next(); await tick(); assert.equal(second, false);
  await first.return(); assert.equal((await pending).value, 'second'); await next.return(); f.end(a); f.close();
});
test('early consumer return and adapter failure release all stream leases', async () => {
  const f = fixture(); f.agent('A');
  const broken = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'A' }, () => { throw new Error('adapter failed'); });
  await assert.rejects(broken.next(), /adapter failed/);
  const next = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'B' }, () => one('ok'));
  assert.equal((await next.next()).value, 'ok'); await next.return(); f.close();
});
test('constructing an unconsumed stream does not claim any scheduling ownership', async () => {
  const f = fixture();
  f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'A' }, () => one('unused'));
  const b = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'B' }, () => one('ok'));
  assert.equal((await b.next()).value, 'ok'); await b.return(); f.close();
});
test('a cancelled auxiliary stream never dispatches its adapter', async () => {
  const f = fixture(), a = f.agent('A'), c = new AbortController(); await f.enter(a);
  const b = f.dispatch('llm/stream', { provider: 'strata1', sessionId: 'B', signal: c.signal }, () => { throw new Error('must not dispatch'); });
  const pending = b.next(); c.abort(new Error('cancelled while queued'));
  await assert.rejects(pending, /cancelled while queued/); f.end(a); f.close();
});
test('nested agent-owned auxiliary requests without sessionId inherit the current root', async () => {
  const f = fixture(), a = f.agent('A'); await f.enter(a); f.ctx.agents.currentInitiator = () => a;
  const stream = f.dispatch('llm/stream', { provider: 'strata1' }, () => one('auxiliary'));
  assert.equal((await stream.next()).value, 'auxiliary'); await stream.return(); f.end(a); f.close();
});
test('resumed oversized requests are capped without changing model or effort', async () => {
  const f = fixture();
  const original = { provider: 'strata1', model: 'iq3_s', reasoningEffort: 'medium', maxTokens: 65536 };
  assert.deepEqual(await f.dispatch('agent/request', {}, () => original), { ...original, maxTokens: 32768 });
  const other = { ...original, provider: 'other' };
  assert.equal(await f.dispatch('agent/request', {}, () => other), other); f.close();
});
