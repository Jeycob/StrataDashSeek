import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './manager.mjs';
import { RepairBudget } from './policy.mjs';
import { sourceManifest } from './storage.mjs';
import { prepareAutomaticRequest } from './automatic-review.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-results-'));
  t.after(async () => { assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'tool-results-')); await fs.rm(directory, { recursive: true, force: true }); });
  const agent = { id: 'one', session: { id: 'one', header: { cwd: directory } } };
  const manager = new WorkspaceManager({ workspaceRegistry: { list: () => [] }, agents: { get: id => id === 'one' ? agent : undefined }, logger: { warn() {} } }, { stateRoot: path.join(directory, 'state') }, hostExecutionBinding());
  manager.data = { sessions: { one: { root: directory } }, workspaces: {}, trash: {} };
  manager.budgets.set('one', new RepairBudget());
  const exec = (name, command) => ({ name, arguments: { command }, agent, signal: new AbortController().signal });
  const result = (text, value = {}, isError = true) => ({ isError, value, content: [{ type: 'text', text }] });
  return { manager, agent, exec, result };
}

test('verify_project enters the same final-result budget exactly once and rejects setup without failed repairs', async t => {
  const { manager: m, exec, result } = await fixture(t);
  await m.reportVerification({ sessionId: 'one', kind: 'all', exitCode: 0, checksPassed: 2, checksTotal: 2 });
  assert.equal(m.budgets.get('one').stage, 1); assert.equal(m.data.sessions.one.lastVerification.accepted, false);
  const report = { passed: true, complete: true, stale: false, sourceHash: (await sourceManifest(m.data.sessions.one.root)).sha256, checks: [{ passed: true, checksPassed: 2, checksTotal: 2, category: 'success', diagnosticCode: 'OK' }] };
  m.observeToolResult({ ...exec('verify_project'), arguments: { kind: 'all' } }, result(JSON.stringify(report), report, false));
  await m.drainToolResults('one'); assert.equal(m.budgets.get('one').stage, 2); assert.equal(m.data.sessions.one.lastVerification.accepted, true);
  const config = { passed: false, complete: false, code: 'INVALID_CONTRACT', checks: [] };
  m.observeToolResult({ ...exec('verify_project'), arguments: {} }, result(JSON.stringify(config), config, false));
  await m.drainToolResults('one'); assert.equal(m.budgets.get('one').stalled, 0); assert.equal(m.data.sessions.one.lastDiagnostic.category, 'configuration');
});
test('a single-check retry cannot replace ordinary verification or change its repair budget', async t => {
  const {manager:m, exec, result} = await fixture(t);
  const {one:record} = m.data.sessions;
  const budget = m.budgets.get('one');
  await m.reportVerification({sessionId:'one',kind:'test',exitCode:0,checksPassed:5,checksTotal:5});
  record.lastVerification.accepted = true;
  const before = structuredClone(record.lastVerification);
  const sourceHash = (await sourceManifest(record.root)).sha256;
  const report = {passed:true,complete:false,stale:false,sourceHash,checkId:'third',
    checks:[{id:'third',kind:'test',passed:true,checksPassed:1,checksTotal:1}]};
  await m.reportVerification({sessionId:'one',kind:'test',checkId:'third',exitCode:0,checksPassed:1,checksTotal:1});
  m.observeToolResult({...exec('verify_project'),arguments:{kind:'test',checkId:'third'}},result(JSON.stringify(report),report,false));
  await m.drainToolResults('one');
  assert.deepEqual(record.lastVerification,before);
  assert.deepEqual(budget.checks,{});
  assert.equal(budget.stage,1);
  assert.equal(record.checkpoints,undefined);
});
test('automatic result deduplication requires a real nonempty matching call ID',async t=>{
  const {manager:m,exec,result}=await fixture(t),budget=m.budgets.get('one');
  prepareAutomaticRequest(m.data.sessions.one,budget,{owner:true,turn:1,messages:[{id:'original-human',role:'user',source:{kind:'user'}}]},60);
  const config={passed:false,complete:false,code:'INVALID_CONTRACT',checks:[]},outcome=result(JSON.stringify(config),config,false);
  const failures=()=>Object.values(budget.errors).reduce((sum,count)=>sum+count,0);
  m.observeToolResult({...exec('verify_project'),arguments:{kind:'all'}},outcome);await m.drainToolResults('one');
  assert.equal(failures(),1);assert.equal(m.data.sessions.one.lastDiagnostic.category,'configuration');
  budget.automatic.accountedCallId='';
  m.observeToolResult({...exec('verify_project'),arguments:{kind:'all'},callId:''},outcome);await m.drainToolResults('one');
  assert.equal(failures(),2);assert.equal(budget.blocked,null);
  budget.automatic.accountedCallId='previously-accounted-call';
  m.observeToolResult({...exec('verify_project'),arguments:{kind:'all'},callId:'previously-accounted-call'},outcome);await m.drainToolResults('one');
  assert.equal(failures(),2,'only the actual previously accounted identity is deduplicated');
  m.observeToolResult({...exec('verify_project'),arguments:{kind:'all'},callId:'different-call'},outcome);await m.drainToolResults('one');
  assert.equal(failures(),3);assert.equal(budget.blocked.code,'REPEATED_TOOL_ERROR');assert.equal(budget.stalled,0);assert.equal(budget.stage,1);assert.equal(budget.automatic.proofSerial,0);assert.equal(budget.automatic.taskSteps,0);assert.equal(budget.automatic.checks,0);
});

test('a background acknowledgement cannot pass or fail a verification stage', async t => {
  const { manager: m, exec, result } = await fixture(t);
  m.observeToolResult(exec('bash', 'node --test test/'), result('Background job registered', { kind: 'background', jobId: 'bash-fixture', cwd: '/project' }, false));
  await m.drainToolResults('one');
  assert.equal(m.budgets.get('one').stage, 1); assert.deepEqual(m.budgets.get('one').checks, {}); assert.equal(m.pendingDiagnostics.size, 0);
});

test('structured failures count actual failed assertions and improvement rather than treating every result as one error', async t => {
  const { manager: m, exec, result } = await fixture(t);
  for (const failures of [3, 2]) {
    const value = { passed: false, checks: [{ passed: false, checksTotal: 5, checksPassed: 5 - failures, category: 'verification', diagnosticCode: 'ASSERTION_FAILURE' }] };
    m.observeToolResult({ ...exec('verify_project'), arguments: { kind: 'all' } }, result(JSON.stringify(value), value, false));
    await m.drainToolResults('one');
  }
  assert.equal(m.budgets.get('one').checks.all.bestScore, 2); assert.equal(m.budgets.get('one').stalled, 0);
});

test('all tool names receive bounded recovery, unrelated launch/edit/timeout failures do not consume repair attempts', async t => {
  const { manager: m, exec, result } = await fixture(t);
  m.observeToolResult(exec('edit'), result("Error: old_string was not found in '/private/source'"));
  m.observeToolResult(exec('a_future_skill_tool'), result('ERR_INVALID_ARG_TYPE: second argument must be an object'));
  m.observeToolResult(exec('bash', 'npm test'), result('Cannot find module /private/test', { exitCode: 1 }));
  m.observeToolResult(exec('project_exec', 'node --test test/'), result('[timed out after 110000ms]', { exitCode: 128, timedOut: true }));
  await m.drainToolResults('one');
  const budget = m.budgets.get('one');
  assert.equal(budget.stalled, 0); assert.equal(budget.blocked, null); assert.deepEqual(budget.checks, {});
  const context = [...m.pendingDiagnostics.get('one').values()].join('\n');
  for (const code of ['EDIT_CONTEXT_STALE', 'INVALID_INVOCATION', 'SETUP_FAILURE', 'EXECUTION_TIMEOUT']) assert(context.includes(code));
  assert(!context.includes('/private')); assert(context.length < 9600); assert.equal(m.resultWork.size, 0);
});

test('successful reads cannot parse source as a failed check and real assertions still pause repeated repairs', async t => {
  const { manager: m, exec, result } = await fixture(t);
  m.observeToolResult(exec('read'), result('ERR_ASSERTION\n# fail 99', {}, false));
  await m.drainToolResults('one'); assert.equal(m.pendingDiagnostics.size, 0);
  for (let i = 0; i < 3; i++) m.observeToolResult(exec('bash', 'npm test'), result('ERR_ASSERTION\n# tests 1\n# pass 0\n# fail 1', { exitCode: 1 }, false));
  await m.drainToolResults('one');
  assert.equal(m.budgets.get('one').blocked.code, 'REPAIR_NO_PROGRESS');
  assert.equal(m.data.sessions.one.lastDiagnostic.category, 'verification');
});

test('queue drains before a new step; final cancellation remains unverified and bookkeeping cannot change a tool result', async t => {
  const { manager: m, exec, result } = await fixture(t);
  const cancelled = result('AbortError: owner cancelled', { exitCode: null, aborted: true });
  Object.freeze(cancelled); m.observeToolResult(exec('bash', 'npm test'), cancelled);
  await m.drainToolResults('one'); assert.equal(m.pendingDiagnostics.size, 0); assert.equal(m.budgets.get('one').stage, 1);
  const original = result('old_string was not found'); Object.freeze(original);
  m.save = async () => { throw Error('fixture write unavailable'); };
  m.observeToolResult(exec('edit'), original); await m.drainToolResults('one');
  assert.equal(original.isError, true); assert.equal(original.content[0].text, 'old_string was not found');
});
