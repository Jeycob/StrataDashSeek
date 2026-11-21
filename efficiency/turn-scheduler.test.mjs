import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTurnScheduler} from './turn-scheduler.mjs';

const A = {id: 'A', header: {}};
const B = {id: 'B', header: {}};
const C = {id: 'C', header: {}};

function fixture(t) {
  const agents = new Map([A, B, C].map(session => [session.id, {session}]));
  const scheduler = createTurnScheduler(agents, () => {});
  t.after(() => scheduler.close());
  return scheduler;
}

test('an unopened turn cannot block its own maintenance or a cloud turn switching to local', async t => {
  const scheduler = fixture(t);
  await scheduler.join(scheduler.start(B, 1, true, 'earlier-task'));
  scheduler.reserveInbox(A, 'later-task');
  assert.deepEqual(scheduler.snapshot().waiting, []);

  const prerequisite = scheduler.holdStream(A, A.id, 'same-agent-prerequisite');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.snapshot().owner, B.id);
  assert.deepEqual(scheduler.snapshot().waiting.map(ticket => ticket.rootId), [A.id]);
  scheduler.end(B.id, 1);
  const stream = await prerequisite;
  stream.assertLive();
  stream.release();

  await scheduler.join(scheduler.start(A, 1, true, 'later-task'));
  assert.equal(scheduler.snapshot().owner, A.id);
});

test('same-agent maintenance releases an unconsumed handoff and queues behind an earlier root', async t => {
  const scheduler = fixture(t);
  await scheduler.join(scheduler.start(A, 1, true, 'original'));
  const handoff = scheduler.continuationLease({sessionId: A.id, turn: 1, messageId: 'original'});
  assert(handoff);
  const earlier = scheduler.start(B, 1, true, 'earlier');
  scheduler.end(A.id, 1);

  // Unrelated meta work and a cancelled same-session call leave the hold intact.
  const controller = new AbortController();
  const unrelated = scheduler.holdStream(C, C.id, 'unrelated-meta', controller.signal);
  controller.abort();
  await assert.rejects(unrelated, {name: 'AbortError'});
  await assert.rejects(scheduler.holdStream(A, A.id, 'cancelled', controller.signal), {name: 'AbortError'});
  assert.equal(scheduler.snapshot().owner, A.id);
  assert.equal(handoff.bind('later-continuation'), true);

  const prerequisite = scheduler.holdStream(A, A.id, 'same-agent-maintenance');
  await scheduler.join(earlier);
  assert.equal(scheduler.snapshot().owner, B.id);
  assert.equal(handoff.bind('later-continuation'), false);
  scheduler.end(B.id, 1);
  const stream = await prerequisite;
  stream.release();
});
