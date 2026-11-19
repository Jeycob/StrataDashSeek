import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunActivity } from './run-activity.mjs';

function fixture() {
  const since = Date.now() - 42000;
  const gate = {version:1, sessionId:'owner', enabled:true, model:{phase:'idle'}, heavyTools:{phase:'waiting', since, command:'private'}};
  const check = {phase:'checking', activeCallId:'call', operation:{callId:'call', startedAt:since, root:'private'}};
  const project = {header:{}};
  const manager = {
    data:{trash:{},sessions:{owner:{budget:{automatic:check}}}},
    checked:action => action(), projectFor:async () => project,
    ctx:{waterfall:async (name, args) => {
      assert.equal(name, 'efficiency/session-status');
      assert.deepEqual(args, {sessionId:'owner'});
      return gate;
    }}
  };
  return {gate, check, project, manager};
}

test('only active owner phases and server-measured seconds reach the browser', async () => {
  const {manager} = fixture();
  const result = await readRunActivity(manager, 'owner');
  assert.equal(result.sessionId, 'owner');
  assert.deepEqual(result.phases.map(row => row.phase), ['heavyTools.waiting','verifying']);
  for (const row of result.phases) {
    assert.deepEqual(Object.keys(row).sort(), ['elapsedSeconds','phase']);
    assert.ok(row.elapsedSeconds >= 42);
  }
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('missing scheduler, disabled scheduling, foreign snapshots and historical checks yield no phase', async () => {
  const {manager,check,gate} = fixture();
  check.terminalAcknowledged = true;
  gate.sessionId = 'other';
  assert.deepEqual((await readRunActivity(manager, 'owner')).phases, []);
  gate.sessionId = 'owner';
  gate.enabled = false;
  assert.deepEqual((await readRunActivity(manager, 'owner')).phases, []);
  manager.ctx.waterfall = () => undefined;
  assert.deepEqual((await readRunActivity(manager, 'owner')).phases, []);
});

test('child and trashed conversations cannot expose owner activity', async () => {
  const {manager,project} = fixture();
  manager.ctx.waterfall = () => assert.fail('scheduler accessed without a root owner');
  project.header.origin = 'subagent';
  await assert.rejects(readRunActivity(manager, 'owner'), {code:'SESSION_NOT_FOUND'});
  project.header.origin = 'user';
  manager.data.trash.owner = {};
  await assert.rejects(readRunActivity(manager, 'owner'), {code:'SESSION_NOT_FOUND'});
});
