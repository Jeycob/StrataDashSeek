import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceManager } from './manager.mjs';
import { bindProjectExecution } from './execution-mode.mjs';
import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import { RepairBudget } from './policy.mjs';
import { operationFingerprint } from './policy.mjs';
import path from 'node:path';

function fixture() {
  const manager = Object.create(WorkspaceManager.prototype), budget = new RepairBudget({ stage: 3, steps: 22 });
  Object.defineProperty(manager, 'execution', { value: bindProjectExecution(hostExecutionBinding()), enumerable: true });
  manager.data = { sessions: { one: { budget, root: path.resolve('project') } }, trash: {} };
  manager.budgets = new Map([['one', budget]]); manager.pendingDiagnostics = new Map();
  manager.ctx = { logger: { warn() {} } }; manager.resultWork = new Map();
  manager.save = async () => { throw Error('Untrusted verification must not save a checkpoint'); };
  manager.settings = () => ({ noProgressLimit: 3 });
  return { manager, budget };
}

test('masked verifier status produces actionable feedback without a pass or failed-repair charge', async () => {
  for (const name of ['bash', 'project_exec']) {
    const { manager, budget } = fixture(), before = JSON.stringify(budget);
    await manager.toolResult({ name, agent: { id: 'one' }, managedProjectShell: true,
      arguments: { command: 'node --test tests/rules.test.mjs 2>&1 | tail -20; printf "status=%s" "$?"', description: 'PRIVATE_DESCRIPTION' } },
    { value: { exitCode: 0 }, content: [{ type: 'text', text: 'PRIVATE_LOG\nAssertionError [ERR_ASSERTION]: failed expectation\nstatus=1' }] });
    assert.equal(JSON.stringify(budget), before);
    const message = manager.pendingDiagnostics.get('one').get('VERIFICATION_STATUS_UNAVAILABLE');
    assert.match(message, /direct foreground command/); assert.match(message, /verify_project/);
    assert.equal(message.includes('PRIVATE_'), false); assert.ok(message.length < 1000);
    assert.equal(manager.data.sessions.one.lastDiagnostic.code, 'VERIFICATION_STATUS_UNAVAILABLE');
  }
});

test('final tool results separate stale targets and only a completed edit resolves its own errors', async () => {
  const { manager, budget } = fixture(); manager.save = async () => {};
  const exec = (name, file) => ({ name, agent: { id: 'one' }, arguments: { file_path: file } });
  const failed = file => ({ isError: true, content: [{ type: 'text', text: `Error: old_string was not found in '/project/${file}'` }] });
  const success = { value: {}, content: [{ type: 'text', text: 'Applied edit' }] };
  for (const file of ['a.js', 'b.js', 'c.js']) await manager.toolResult(exec('edit', file), failed(file));
  assert.equal(budget.blocked, null); assert.deepEqual(Object.values(budget.errors), [1, 1, 1]);
  await manager.toolResult(exec('read', 'a.js'), success);
  assert.deepEqual(Object.values(budget.errors), [1, 1, 1]);
  await manager.toolResult(exec('edit', 'b.js'), success);
  assert.deepEqual(Object.values(budget.errors), [1, 1]);
  await manager.toolResult(exec('edit', 'a.js'), failed('a.js'));
  await manager.toolResult(exec('edit', 'a.js'), failed('a.js'));
  assert.equal(budget.blocked.code, 'REPEATED_TOOL_ERROR');
  assert.equal(budget.stage, 3); assert.equal(budget.steps, 22); assert.equal(budget.stalled, 0);
});

test('background acknowledgements, unknown command completion and unsuccessful jobs never resolve an operation', async () => {
  for (const sample of [
    { name: 'bash', value: { kind: 'background', jobId: 'owned-job' } },
    { name: 'bash', value: { kind: 'foreground' } },
    { name: 'job_output', value: { status: 'running' } },
    { name: 'job_output', value: { status: 'completed', result: { exitCode: 1 } } },
  ]) {
    const { manager, budget } = fixture(); manager.save = async () => {};
    const operationScope = operationFingerprint({ name: 'bash', arguments: { command: 'grep missing file' } }, manager.data.sessions.one.root);
    for (let i = 0; i < 2; i++) budget.observe({ operationScope, exitCode: 1, text: 'lookup did not succeed' });
    const before = JSON.stringify(budget.errors);
    await manager.toolResult({ name: sample.name, operationScope, agent: { id: 'one' }, arguments: { command: 'grep missing file' } },
      { value: sample.value, content: [{ type: 'text', text: 'operation status' }] });
    assert.equal(JSON.stringify(budget.errors), before, sample.name + ':' + sample.value.status);
    assert.equal(budget.stage, 3); assert.equal(budget.steps, 22);
  }
});

test('admission captures each call target before concurrent results are queued', async () => {
  const { manager, budget } = fixture(); manager.save = async () => {};
  const make = (callId, file) => ({ name: 'edit', callId, agent: { id: 'one' }, arguments: Object.freeze({ file_path: file }) });
  const first = make('first', 'a.js'), second = make('second', 'b.js');
  assert.equal(manager.toolGuard(first), undefined); assert.equal(manager.toolGuard(second), undefined);
  const failed = { isError: true, content: [{ type: 'text', text: 'old_string not found' }] };
  manager.observeToolResult({ ...second, arguments: { file_path: 'wrong.js' } }, failed);
  manager.observeToolResult({ ...first, arguments: { file_path: 'wrong.js' } }, failed);
  await manager.drainToolResults('one'); assert.deepEqual(Object.values(budget.errors), [1, 1]);
  const fixed = make('fixed', 'a.js'); manager.toolGuard(fixed);
  manager.observeToolResult({ ...fixed, arguments: { file_path: 'b.js' } }, { value: {}, content: [{ type: 'text', text: 'Applied edit' }] });
  await manager.drainToolResults('one'); assert.deepEqual(Object.values(budget.errors), [1]);
  assert.equal(first.arguments.file_path, 'a.js'); assert.equal(second.arguments.file_path, 'b.js');
  assert.equal(manager.operationScopes.size, 0);
});

test('a build followed by a status echo cannot silently appear to pass its milestone', async () => {
  const { manager, budget } = fixture(), before = JSON.stringify(budget);
  await manager.toolResult({ name: 'bash', agent: { id: 'one' }, managedProjectShell: true,
    arguments: { command: 'cd client && npm run build 2>&1 | tail -15; echo buildexit=$?; echo extra' } },
  { value: { exitCode: 0 }, content: [{ type: 'text', text: 'built in 1.08s\nbuildexit=0' }] });
  assert.equal(JSON.stringify(budget), before);
  assert.equal(manager.pendingDiagnostics.get('one').size, 1);
});

test('ordinary non-verification commands do not receive an extra verification warning', async () => {
  const { manager, budget } = fixture(), before = JSON.stringify(budget);
  await manager.toolResult({ name: 'bash', agent: { id: 'one' }, managedProjectShell: true,
    arguments: { command: 'curl -sS http://127.0.0.1:3000/; echo done' } },
  { value: { exitCode: 0 }, content: [{ type: 'text', text: 'HTTP response\ndone' }] });
  assert.equal(JSON.stringify(budget), before); assert.equal(manager.pendingDiagnostics.size, 0);
});

test('compacted display text cannot discard native test totals or hide genuine repair progress', async () => {
  for (const name of ['bash','project_exec']) {
    const {manager,budget}=fixture(); manager.save=async()=>{}; manager.pruneCheckpoints=async()=>{};
    for (const failures of [12,10,3]) {
      const output=`# tests 19\n# pass ${19-failures}\n# fail ${failures}\n`;
      const value={exitCode:1,stdout:name==='bash'?{text:output,truncated:false,spillPath:'PRIVATE_UNUSED_SPILL_PATH'}:output,stderr:name==='bash'?{text:''}:''};
      await manager.toolResult({name,managedProjectShell:true,agent:{id:'one'},arguments:{command:'npm test'}},
        {value,content:[{type:'text',text:'Tool status: exitCode=1\nAssertionError: diagnostic excerpt; totals omitted'}]});
      assert.equal(budget.checks.test.lastScore,failures); assert.equal(budget.checks.test.bestScore,failures);
      assert.equal(budget.blocked,null);
    }
    assert.equal(budget.stalled,0); assert.equal(budget.stage,3);
    assert(!JSON.stringify(budget).includes('PRIVATE_UNUSED_SPILL_PATH'));
  }
});

test('text that names test commands inside code editors or ordinary output never earns a test stage', async () => {
  for (const command of [
    `node -e "const p={scripts:{}};p.scripts.test='node --test tests/unit.test.mjs';console.log(p.scripts)"`,
    'echo npm test', 'grep "node --test" package.json', 'cat tests/unit.test.mjs',
  ]) {
    const {manager,budget}=fixture(),before=JSON.stringify(budget);
    await manager.toolResult({name:'bash',managedProjectShell:true,agent:{id:'one'},arguments:{command}},
      {value:{exitCode:0},content:[{type:'text',text:'node --test tests/unit.test.mjs'}]});
    assert.equal(JSON.stringify(budget),before,command);
    assert.equal(manager.pendingDiagnostics.size,0);
  }
});

test('quoted verifier patterns, redirections and AND chains retain their completed result', async () => {
  for (const command of [
    "node --test --test-name-pattern 'a|b' tests/rules.test.mjs",
    'cd client && npm run build 2>&1',
    'npm test; # trailing comment only\n',
  ]) {
    const { manager, budget } = fixture(); manager.save = async () => {}; manager.pruneCheckpoints = async () => {};
    await manager.toolResult({ name: 'bash', agent: { id: 'one' }, managedProjectShell: true, arguments: { command } },
      { value: { exitCode: 0 }, content: [{ type: 'text', text: 'completed' }] });
    assert.equal(manager.pendingDiagnostics.size, 0, command);
    assert.equal(budget.blocked, null, command);
    assert.ok(Object.values(budget.checks).some(check => check.lastScore === 0), command);
  }
});
