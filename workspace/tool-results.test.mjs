import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './manager.mjs';
import { RepairBudget } from './policy.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-results-'));
  t.after(async () => { assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'tool-results-')); await fs.rm(directory, { recursive: true, force: true }); });
  const agent = { id: 'one', session: { id: 'one', header: { cwd: directory } } };
  const manager = new WorkspaceManager({ workspaceRegistry: { list: () => [] }, logger: { warn() {} } }, { stateRoot: path.join(directory, 'state') });
  manager.data = { sessions: { one: { root: directory } }, workspaces: {}, trash: {} };
  manager.budgets.set('one', new RepairBudget());
  const exec = (name, command) => ({ name, arguments: { command }, agent, signal: new AbortController().signal });
  const result = (text, value = {}, isError = true) => ({ isError, value, content: [{ type: 'text', text }] });
  return { manager, agent, exec, result };
}

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
