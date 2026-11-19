import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RepairBudget } from './policy.mjs';
import { beginUserRequest } from './turn-budget.mjs';
import { WorkspaceManager } from './manager.mjs';

const human = id => ({ role: 'user', source: { kind: 'user' }, id });
function fixture() {
  const record = { budgetRequest: { turn: 3, messageId: 'first' }, lastStep: 'owner:3:60', other: { retained: true } };
  const budget = new RepairBudget({ stage: 4, steps: 59, stalled: 2, errors: { fingerprint: 2 }, checks: { test: { bestScore: 4, lastScore: 4 } } });
  return { record, budget };
}

test('fresh human request renews only steps, preserving all verification and failure state', () => {
  const { record, budget } = fixture(), errors = budget.errors, checks = budget.checks, other = record.other;
  assert.equal(beginUserRequest(record, budget, { turn: 4, messages: [human('first'), human('second')] }), true);
  assert.equal(budget.steps, 0); assert.equal(budget.stage, 4); assert.equal(budget.stalled, 2);
  assert.equal(budget.errors, errors); assert.equal(budget.checks, checks); assert.equal(budget.blocked, null);
  assert.equal(record.other, other); assert.equal(record.lastStep, 'owner:3:60');
  assert.deepEqual(record.budgetRequest, { turn: 4, messageId: 'second' });
  assert.equal(budget.step(60), true); assert.equal(budget.steps, 1);
});

test('first observation and migration seed identity without resetting usage', () => {
  for (const previous of [undefined, null, {}, { turn: -1, messageId: 'old' }, { turn: 1, messageId: '' }]) {
    const record = { budgetRequest: previous }, budget = new RepairBudget({ steps: 60 });
    assert.equal(beginUserRequest(record, budget, { turn: 4, messages: [human('first')] }), false);
    assert.equal(budget.steps, 60); assert.deepEqual(record.budgetRequest, { turn: 4, messageId: 'first' });
  }
});

test('same turn, changed ID in same turn, provider retry and older turn never reset', () => {
  for (const [turn, id] of [[3, 'first'], [3, 'second'], [2, 'second'], [1, 'first']]) {
    const { record, budget } = fixture(), before = structuredClone({ record, budget });
    assert.equal(beginUserRequest(record, budget, { turn, messages: [human(id)] }), false);
    assert.deepEqual({ record, budget: { ...budget } }, before);
  }
  const { record, budget } = fixture();
  assert.equal(beginUserRequest(record, budget, { turn: 4, messages: [human('second')] }), true);
  budget.step(60);
  assert.equal(beginUserRequest(record, budget, { turn: 4, messages: [human('second')] }), false);
  assert.equal(budget.steps, 1);
});

test('internal follow-up with same latest human ID advances high-water turn without reset', () => {
  const { record, budget } = fixture();
  const messages = [human('first'), { role: 'user', id: 'runtime', source: { kind: 'workspace-runtime' } }, { role: 'tool', id: 'tool', source: { kind: 'user' } }];
  assert.equal(beginUserRequest(record, budget, { turn: 7, messages }), false);
  assert.equal(budget.steps, 59); assert.deepEqual(record.budgetRequest, { turn: 7, messageId: 'first' });
  assert.equal(beginUserRequest(record, budget, { turn: 6, messages: [human('second')] }), false);
  assert.equal(budget.steps, 59);
});

test('only latest real human message supplies identity, not internal/tool/assistant records', () => {
  const { record, budget } = fixture();
  const messages = [human('second'), { role: 'assistant', id: 'assistant', source: { kind: 'user' } }, { role: 'user', id: 'notice', source: { kind: 'job-notification' } }];
  assert.equal(beginUserRequest(record, budget, { turn: 4, messages }), true);
  assert.equal(record.budgetRequest.messageId, 'second');
});

test('invalid request metadata and missing latest human ID fail closed without mutation', () => {
  const inputs = [undefined, null, [], {}, { turn: 0, messages: [human('second')] }, { turn: 4.5, messages: [human('second')] },
    { turn: '4', messages: [human('second')] }, { turn: Infinity, messages: [human('second')] },
    { turn: Number.MAX_SAFE_INTEGER + 1, messages: [human('second')] }, { turn: 4, messages: {} }, { turn: 4, messages: [] },
    { turn: 4, messages: [null, { role: 'user', id: 'second' }] },
    { turn: 4, messages: [human('second'), human('   ')] }, { turn: 4, messages: [human('second'), human(23)] },
    { turn: 4, messages: [{ role: 'tool', source: { kind: 'user' }, id: 'second' }] }];
  for (const input of inputs) {
    const { record, budget } = fixture(), before = structuredClone({ record, budget });
    assert.equal(beginUserRequest(record, budget, input), false);
    assert.deepEqual({ record, budget: { ...budget } }, before);
  }
});

test('existing block never auto-resumes or clears consumed steps on new human request', () => {
  for (const code of ['STAGE_BUDGET', 'REPEATED_TOOL_ERROR', 'REPAIR_NO_PROGRESS']) {
    const { record, budget } = fixture(); budget.blocked = { code, message: 'Owner review required' };
    const before = structuredClone(budget), block = budget.blocked;
    assert.equal(beginUserRequest(record, budget, { turn: 4, messages: [human('second')] }), false);
    assert.deepEqual({ ...budget }, before); assert.equal(budget.blocked, block);
    assert.deepEqual(record.budgetRequest, { turn: 4, messageId: 'second' });
    assert.equal(budget.step(60), false); assert.equal(budget.steps, 59);
  }
});

function managedFixture() {
  const { record, budget } = fixture(); record.firstCheckGuided = true; record.stageBudgetWarningStage = budget.stage;
  const owner = { id: 'owner', session: { id: 'owner', header: {} } }, child = { id: 'child', session: { id: 'child', header: {} } };
  const manager = new WorkspaceManager({sandboxPolicy:{resolve:()=>({mode:'read-only'})}}, {}, hostExecutionBinding()); manager.ownerAgent = () => owner;
  manager.data = { sessions: { owner: record }, trash: {} }; manager.ensureProject = async () => record;
  manager.locks.acquire = async () => {}; manager.save = async () => {};
  manager.settings = () => ({ maxStageSteps: 60, maxAutomaticChecks: 0 }); manager.budgets.set(owner.id, budget);
  return { manager, record, budget, owner, child, input: { turn: 4, step: 1, signal: new AbortController().signal, messages: [human('second')] } };
}
test('manager scopes an owner request before charging its first step and charges provider retries once', async () => {
  const f = managedFixture(); await f.manager.preStep({ ...f.input, agent: f.owner });
  assert.equal(f.budget.steps, 1); assert.equal(f.budget.stage, 4); assert.equal(f.record.stageBudgetWarningStage, undefined);
  await f.manager.preStep({ ...f.input, agent: f.owner }); assert.equal(f.budget.steps, 1);
  await f.manager.preStep({ ...f.input, step: 2, agent: f.owner }); assert.equal(f.budget.steps, 2);
});
test('manager child requests cannot renew the owner budget', async () => {
  const f = managedFixture(); await f.manager.preStep({ ...f.input, agent: f.child });
  assert.equal(f.budget.steps, 60); assert.equal(f.record.budgetRequest.messageId, 'first');
  await f.manager.preStep({ ...f.input, step: 2, agent: f.child });assert.equal(f.budget.steps,61);assert.equal(f.budget.automatic.taskSteps,61);assert.equal(f.budget.blocked,null);assert.equal(f.record.budgetRequest.messageId,'first');
});
test('a fresh owner request starts a new repair streak while retaining prior verification evidence', async () => {
  const f = managedFixture(), checks = f.budget.checks;
  f.budget.stalled = 3; f.budget.errors = { 'prior-failure': 3 };
  f.budget.blocked = { code: 'REPAIR_NO_PROGRESS', message: 'Review required' };
  await f.manager.preStep({ ...f.input, agent: f.owner });
  assert.equal(f.budget.blocked, null); assert.equal(f.budget.steps, 1); assert.equal(f.budget.automatic.taskSteps, 1);
  assert.equal(f.budget.stalled, 0); assert.deepEqual(f.budget.errors, {}); assert.equal(f.budget.checks, checks); assert.equal(f.budget.checks.test.bestScore, 4); assert.equal(f.budget.stage, 4);
  const failure = { kind: 'test', exitCode: 1, text: 'AssertionError: projectile remains after impact' };
  f.budget.observe(failure);
  assert.equal(f.budget.blocked, null, 'the first repair cannot inherit an exhausted prior streak');
  await f.manager.preStep({ ...f.input, step: 2, agent: f.owner });
  assert.equal(f.budget.stalled, 1, 'same human identity cannot renew the repair streak again');
  f.budget.observe(failure); assert.equal(f.budget.blocked, null);
  f.budget.observe(failure); assert.equal(f.budget.blocked, null); assert.equal(f.budget.automatic.repairAllowance.deadline, 122, 'new repeated failures receive one finite autonomous repair allowance');
  assert.equal(f.budget.stage, 4);
});
