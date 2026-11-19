import test from 'node:test';
import assert from 'node:assert/strict';
import { needsFirstCheck, changedApplicationCode, guideFirstCheck, needsStageBudgetWarning, warnStageBudget, QUALITY_CONTRACT_EXAMPLE, BROWSER_PLAN_EXAMPLE } from './verification-guidance.mjs';
import { RepairBudget } from './policy.mjs';
import { validateContract } from '../quality/core.mjs';
import { validatePlan } from '../quality/browser.mjs';

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
  const text = messages.get('FIRST_FUNCTIONAL_CHECK'); assert.match(text, /verify_project/); assert.match(text, /cleanup before assertions/); assert(!text.includes('eshop')); assert(text.length < 2400);
  assert.doesNotThrow(()=>validateContract(QUALITY_CONTRACT_EXAMPLE));assert.doesNotThrow(()=>validatePlan(BROWSER_PLAN_EXAMPLE));
  assert.match(text,/\.harness\/quality\//);assert.match(text,/sources lists only existing/);assert.match(text,/no waitMs/);
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

test('legacy stage advisory is emitted once and cannot reinstate a fixed step gate', async () => {
  const manager = fixture(), record = {}, budget = new RepairBudget({ stage: 4, steps: 49, checks: { test: { bestScore: 0 } } });
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, budget, 60), false);
  budget.step(60); const before = JSON.stringify(budget);
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, budget, 60), true);
  assert.equal(JSON.stringify(budget), before);
  const message = manager.pendingDiagnostics.get('one').get('STAGE_BUDGET_WARNING');
  assert.match(message, /10 steps remain in stage 4 \(50\/60\)/); assert.match(message, /quality\/README.md/); assert.ok(message.length < 1000);
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, budget, 60), false);
  for (let i = 0; i < 11; i++) budget.step(60);
  assert.equal(budget.blocked, null); assert.equal(budget.steps, 61); assert.equal(budget.stage, 4);
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, budget, 60), false);
});

test('a later stage can be warned after an earlier warning and persisted inspection', async () => {
  const manager = fixture(), record = { stageBudgetWarningStage: 2, stageBudgetWarningInspection: { stage: 2, step: 58 } };
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, { stage: 3, steps: 50 }, 60), true);
  assert.equal(record.stageBudgetWarningStage, 3);
  assert.equal(needsStageBudgetWarning({}, { stage: 1, steps: 7 }, 10), false);
  assert.equal(needsStageBudgetWarning({}, { stage: 1, steps: 8 }, 10), true);
  assert.equal(needsStageBudgetWarning({}, { stage: 1, steps: 89 }, 100), false);
  assert.equal(needsStageBudgetWarning({}, { stage: 1, steps: 90 }, 100), true);
});

test('stage warnings skip unchanged work, legacy sessions and unavailable optional tracking', async () => {
  const manager = fixture([{ path: 'README.md' }]), record = {}, budget = { stage: 2, steps: 50 };
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, budget, 60), false);
  budget.steps = 51; await warnStageBudget(manager, { id: 'one' }, record, budget, 60); assert.equal(manager.scans(), 1);
  assert.equal(await warnStageBudget(manager, { id: 'one' }, { legacy: true }, budget, 60), false);
  assert.equal(await warnStageBudget(manager, { id: 'one' }, {}, { ...budget, blocked: { code: 'STAGE_BUDGET' } }, 60), false);
  manager.changes.list = async () => { throw Error('optional tracker unavailable'); };
  assert.equal(await warnStageBudget(manager, { id: 'one' }, {}, budget, 60), false);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(warnStageBudget(manager, { id: 'one' }, {}, budget, 60, controller.signal), /cancelled/);
  assert.equal(manager.pendingDiagnostics.size, 0);
});

test('stage warning never displaces pending failures or races a completed milestone', async () => {
  const manager = fixture(), budget = { stage: 2, steps: 50 };
  const existing = new Map(Array.from({ length: 4 }, (_, i) => ['error-' + i, 'Existing error ' + i]));
  manager.pendingDiagnostics.set('one', existing);
  assert.equal(await warnStageBudget(manager, { id: 'one' }, {}, budget, 60), false);
  assert.deepEqual(manager.pendingDiagnostics.get('one'), existing);
  manager.pendingDiagnostics.clear();
  manager.changes.list = async () => { budget.stage++; budget.steps = 0; return { files: [{ path: 'app.js' }] }; };
  assert.equal(await warnStageBudget(manager, { id: 'one' }, {}, budget, 60), false);
  assert.equal(manager.pendingDiagnostics.size, 0);
});

test('read-only executing sessions do not receive advice to expand verification work', async () => {
  const manager = fixture(), parent = { id: 'parent' }, child = { id: 'read-only-child' }, record = {};
  manager.ctx.sandboxPolicy = { resolve: ({ session }) => ({ mode: session === child ? 'read-only' : 'workspace-write' }) };
  assert.equal(await warnStageBudget(manager, { id: 'one', session: parent }, record, { stage: 2, steps: 50 }, 60, undefined, child), false);
  assert.equal(manager.scans(), 0); assert.equal(manager.pendingDiagnostics.size, 0);
  manager.ctx.sandboxPolicy.resolve = () => { throw Error('optional policy lookup failed'); };
  assert.equal(await warnStageBudget(manager, { id: 'one' }, record, { stage: 2, steps: 50 }, 60), false);
  assert.equal(manager.scans(), 0);
});
