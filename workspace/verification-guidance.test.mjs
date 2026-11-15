import test from 'node:test';
import assert from 'node:assert/strict';
import { needsFirstCheck, changedApplicationCode, guideFirstCheck } from './verification-guidance.mjs';

test('guidance waits for changed application code and leaves questions, prose and completed checks alone', () => {
  assert.equal(needsFirstCheck({}, { steps: 7, checks: {} }), false);
  for (const record of [{ legacy: true }, { firstCheckGuided: true }, { firstCheckInspectedAtStep: 7 }]) assert.equal(needsFirstCheck(record, { steps: 8, checks: {} }), false);
  assert.equal(needsFirstCheck({}, { steps: 8, checks: { test: {} } }), false);
  assert.equal(needsFirstCheck({}, { steps: 8, checks: {}, blocked: { code: 'STAGE_BUDGET' } }), false);
  assert.equal(needsFirstCheck({}, { steps: 8, checks: {} }), true);
  assert.equal(needsFirstCheck({}, { steps: 8, checks: { build: { bestScore: 0 } } }), true);
  assert.equal(changedApplicationCode([{ path: 'README.md' }, { path: 'docs/plan.txt' }]), false);
  for (const path of ['src/app.mjs', 'src/main.py', 'App.csproj', 'src/lib.rs', 'go.mod', 'index.html', 'package.json']) assert.equal(changedApplicationCode([{ path }]), true);
});

function fixture(files = [{ path: 'src/app.mjs' }]) {
  let scans = 0;
  return { pendingDiagnostics: new Map(), ctx: { logger: { warn() {} } }, changes: { list: async () => { scans++; return { files }; } }, scans: () => scans };
}
test('one bounded stage message covers shell and file saves without modifying source, arguments or budget', async () => {
  const manager = fixture(), agent = { id: 'one' }, record = {}, budget = { steps: 8, checks: {}, stalled: 0 }, before = JSON.stringify(budget);
  manager.pendingDiagnostics.set('one', new Map([['EDIT_CONTEXT_STALE', 'Keep the existing diagnostic']]));
  assert.equal(await guideFirstCheck(manager, agent, record, budget), true);
  assert.equal(await guideFirstCheck(manager, agent, record, budget), false);
  assert.equal(manager.scans(), 1); assert.equal(JSON.stringify(budget), before);
  const messages = manager.pendingDiagnostics.get('one'); assert.equal(messages.get('EDIT_CONTEXT_STALE'), 'Keep the existing diagnostic');
  const text = messages.get('FIRST_FUNCTIONAL_CHECK'); assert.match(text, /verify_project/); assert.match(text, /cleanup before assertions/); assert(!text.includes('eshop')); assert(text.length < 1600);
});

test('unchanged or prose-only work is inspected at most once every four steps and does not get a message', async () => {
  const manager = fixture([{ path: 'README.md' }]), record = {}, budget = { steps: 8, checks: {} };
  assert.equal(await guideFirstCheck(manager, { id: 'one' }, record, budget), false);
  budget.steps = 11; await guideFirstCheck(manager, { id: 'one' }, record, budget); assert.equal(manager.scans(), 1);
  budget.steps = 12; await guideFirstCheck(manager, { id: 'one' }, record, budget); assert.equal(manager.scans(), 2); assert.equal(manager.pendingDiagnostics.size, 0);
});

test('concurrent verification, unavailable tracking and cancellation never create a stale message or a false failure', async () => {
  const manager = fixture(), record = {}, budget = { steps: 8, checks: {} };
  manager.changes.list = async () => { budget.checks.test = { bestScore: 0 }; return { files: [{ path: 'app.py' }] }; };
  assert.equal(await guideFirstCheck(manager, { id: 'one' }, record, budget), false); assert.equal(manager.pendingDiagnostics.size, 0);
  manager.changes.list = async () => { throw Error('unavailable'); };
  assert.equal(await guideFirstCheck(manager, { id: 'one' }, {}, { steps: 8, checks: {} }), false);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(guideFirstCheck(manager, { id: 'one' }, {}, { steps: 8, checks: {} }, controller.signal), /cancelled/);
});
