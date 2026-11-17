import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectCommandRunner } from './project-tool.mjs';
import { WorkspaceManager } from './manager.mjs';
import projectRuntime from '../development/project-run.cjs';

async function fixture(t, mode = 'workspace-write') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-shell-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'managed-shell-')); await fs.rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'project'), other = path.join(directory, 'other');
  await fs.mkdir(root); await fs.mkdir(other); await fs.mkdir(path.join(root, '.harness'));
  await fs.writeFile(path.join(root, '.harness/project.json'), JSON.stringify({ ports: [21000, 21001, 21002, 21003], databasePath: path.join(root, '.harness/data/app.sqlite') }));
  const agent = { id: 'one', session: { id: 'one' } }, execution = { agent, signal: new AbortController().signal };
  const manager = { ownerAgent: value => value?.owner ?? value, data: { sessions: { one: { root, gitWritableRoots: [other] }, two: { root: other } } } };
  const calls = [], ctx = { sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: directory, additionalWritableRoots: [directory] }) }, shellEnv: { collect: () => ({ DSH_PROJECT_ROOT: '/untrusted-stale-root' }) }, shell: { sandboxMode: 'workspace-write', resolve(request) { calls.push(request); return request; }, async execute(spec) { return { async result() { return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: spec.sandboxPolicy.mode, denied: false } }; } }; } } };
  return { directory, root, other, agent, execution, manager, ctx, calls, run: createProjectCommandRunner(ctx, manager, {}, hostExecutionBinding()) };
}
const args = { command: 'printf "%s" "hello; $(not-executed-by-wrapper)"', description: 'Inspect the assigned project' };

test('commands get the project cwd, trusted environment and an explicit project fence even in full-access sessions', async t => {
  const f = await fixture(t, 'danger-full-access'), value = await f.run(args, f.execution), spec = f.calls[0];
  assert.equal(value.cwd, f.root); assert.equal(spec.workdir, f.root);
  assert.deepEqual(spec.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: f.root, additionalWritableRoots: [f.other] });
  assert.equal(spec.dshEnv.DSH_PROJECT_ROOT, f.root); assert.equal(spec.dshEnv.DSH_PROJECT_READ_ONLY, '0');
  assert.equal(spec.signal, f.execution.signal); assert.equal(spec.onExpiry, 'kill');
  assert.match(spec.command, /project-run\.cjs' '--' 'bash' '-o' 'pipefail' '-c'/);
  assert.ok(spec.command.endsWith("'" + args.command + "'"));
});

test('a first read-only command does not create caches or grant writable roots', async t => {
  const f = await fixture(t, 'read-only'); await f.run({ command: 'pwd', description: 'Read project path' }, f.execution);
  const spec = f.calls[0]; assert.equal(spec.sandboxPolicy.mode, 'read-only'); assert.deepEqual(spec.sandboxPolicy.additionalWritableRoots, []);
  const before = await fs.readdir(path.join(f.root, '.harness'));
  const env = projectRuntime.projectEnvironment(f.root, spec.dshEnv);
  assert.equal(env.API_PORT, '21001'); assert.equal(env.HOME, path.join(f.root, '.harness/home'));
  assert.deepEqual(await fs.readdir(path.join(f.root, '.harness')), before);
});

test('separate projects and child agents keep their own owner environment', async t => {
  const f = await fixture(t), two = { id: 'two', session: { id: 'two' } }, child = { id: 'child', owner: f.agent, session: { id: 'child' } };
  await f.run({ command: 'pwd', description: 'Inspect first project' }, { ...f.execution, agent: child });
  await f.run({ command: 'pwd', description: 'Inspect second project' }, { ...f.execution, agent: two });
  assert.deepEqual(f.calls.map(x => x.workdir), [f.root, f.other]); assert.deepEqual(f.calls.map(x => x.dshEnv.DSH_PROJECT_ROOT), [f.root, f.other]);
});

test('absolute, relative and symlink directory escapes fail before command execution', async t => {
  const f = await fixture(t); await fs.symlink(f.other, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const workdir of [f.other, '../other', 'escape']) await assert.rejects(f.run({ ...args, workdir }, f.execution), error => error.code === 'OUTSIDE_PROJECT');
  assert.equal(f.calls.length, 0);
});

test('invalid or wider arguments and missing confinement never run a command', async t => {
  const f = await fixture(t);
  for (const value of [null, [], { ...args, run_in_background: 'true' }, { ...args, sandbox_permissions: 'danger-full-access' }, { ...args, timeoutMs: Infinity }, { ...args, timeoutMs: 0 }, { ...args, command: '' }]) await assert.rejects(f.run(value, f.execution));
  f.ctx.shell.sandboxMode = undefined; await assert.rejects(f.run(args, f.execution), error => error.code === 'NO_PROJECT_SANDBOX');
  assert.equal(f.calls.length, 0);
});

test('exit codes and timeouts are retained, while caller cancellation is drained before returning', async t => {
  const f = await fixture(t), controller = new AbortController(); let quiesced = false;
  f.ctx.shell.execute = async spec => ({ result: async () => ({ exitCode: 7, signal: null, timedOut: true, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: '', truncated: false }, stderr: { text: 'failure', truncated: false } }) });
  const failed = await f.run({ ...args, timeoutMs: 999999 }, f.execution); assert.equal(failed.result.exitCode, 7); assert.equal(failed.result.timedOut, true); assert.equal(failed.spec.timeoutMs, 120000);
  f.ctx.shell.execute = async () => ({ result: async () => { controller.abort(Error('cancelled by owner')); await new Promise(resolve => setTimeout(resolve, 5)); quiesced = true; return { aborted: true }; } });
  await assert.rejects(f.run(args, { ...f.execution, signal: controller.signal }), /cancelled by owner/); assert.equal(quiesced, true);
  const before = f.calls.length; await assert.rejects(f.run(args, { ...f.execution, signal: controller.signal }), /cancelled by owner/); assert.equal(f.calls.length, before);
});

test('the trusted managed-shell marker never overrides Trash, repair stops or outside paths', () => {
  const manager = new WorkspaceManager({}, {}, hostExecutionBinding()); manager.data = { sessions: { one: { root: path.resolve('project') } }, trash: {} };
  const exec = { name: 'bash', agent: { id: 'one' }, arguments: { command: 'pwd' }, managedProjectShell: true };
  assert.equal(manager.toolGuard(exec), undefined);
  assert.ok(manager.toolGuard({ ...exec, managedProjectShell: false }));
  assert.ok(manager.toolGuard({ ...exec, managedProjectShell: false, arguments: { managedProjectShell: true } }));
  assert.ok(manager.toolGuard({ ...exec, arguments: { workdir: path.resolve('other') } }));
  manager.data.trash.one = {}; assert.equal(manager.toolGuard(exec).info.code, 'SESSION_IN_TRASH'); delete manager.data.trash.one;
  manager.budgets.set('one', { blocked: { code: 'REPAIR_NO_PROGRESS', message: 'Review a different strategy' } }); assert.equal(manager.toolGuard(exec).info.code, 'REPAIR_NO_PROGRESS');
});

test('literal verification adaptations preserve admitted arguments, project policy and native status', async t => {
  const f = await fixture(t), original = Object.freeze({ command: 'cd server && node --test --test-timeout=6000 test/ 2>&1 | tail -70', description: 'Run API tests' });
  const value = await f.run(original, f.execution), spec = f.calls[0];
  assert.equal(original.command, 'cd server && node --test --test-timeout=6000 test/ 2>&1 | tail -70');
  assert.match(spec.command, /test-command\.cjs/); assert(!spec.command.includes('tail -70'));
  assert(spec.command.includes('cd server &&')); assert.equal(spec.sandboxPolicy.workspaceRoot, f.root);
  assert.match(value.result.stdout.text, /terminal tail filter removed/); assert.match(value.result.stdout.text, /compatibility helper used/);
  assert.equal(value.result.exitCode, 0);
  await f.run({ command: 'cd server && npm test 2>&1 | tail -60', description: 'Run npm lifecycle' }, f.execution);
  assert(!f.calls[1].command.includes('test-command.cjs')); assert(!f.calls[1].command.includes('tail -60'));
  assert(f.calls[1].command.includes('cd server && npm test'));
  const displayed = await f.run({ command: 'node --test tests/acceptance.test.mjs 2>&1 | grep -vE "^ℹ (suites|duration)" | head -70', description: 'Read the actual verification result' }, f.execution);
  assert(!displayed.spec.command.includes('head -70')); assert(!displayed.spec.command.includes('grep -vE'));
  assert.match(displayed.result.stdout.text, /terminal display filters removed/);
  const statusArgs = Object.freeze({ command: 'node --test tests/rules.test.mjs 2>&1 | tail -20; echo rulesexit=${PIPESTATUS[0]}', description: 'Keep the verifier status' });
  const status = await f.run(statusArgs, f.execution);
  assert(status.spec.command.includes('test-command.cjs')); assert(!status.spec.command.includes('rulesexit=')); assert(!status.spec.command.includes('tail -20'));
  assert.match(status.result.stdout.text, /terminal status echo and display filters removed/);
  assert.equal(statusArgs.command, 'node --test tests/rules.test.mjs 2>&1 | tail -20; echo rulesexit=${PIPESTATUS[0]}');
  const positiveArgs = Object.freeze({ command: 'node --test tests/api.test.mjs 2>&1 | grep -E "^(✔|✖|ℹ)"', description: 'Keep complete test diagnostics' });
  f.ctx.shell.execute = async () => ({ result: async () => ({ exitCode: 17, signal: null, timedOut: false, aborted: false,
    stdout: { text: '# tests 1\n# pass 0\n# fail 1\nfull assertion detail', truncated: false }, stderr: { text: '', truncated: false } }) });
  const positive = await f.run(positiveArgs, f.execution);
  assert(!positive.spec.command.includes('grep -E')); assert(positive.spec.command.includes('test-command.cjs'));
  assert.equal(positive.result.exitCode, 17); assert.match(positive.result.stdout.text, /full assertion detail/);
  assert.equal(positiveArgs.command, 'node --test tests/api.test.mjs 2>&1 | grep -E "^(✔|✖|ℹ)"');
});

test('arbitrary compound commands and JavaScript source are never rewritten', async t => {
  const f = await fixture(t);
  for (const command of ['node -e "e.transform(\'const a=1\',\'{}\',{loader:\'js\'})"', 'npm test && echo ok 2>&1 | tail -60', 'cd "$OTHER" && node --test test/', 'node --test test/*.mjs']) {
    const value = await f.run({ command, description: 'Keep exact shell semantics' }, f.execution);
    assert(value.spec.command.endsWith("'" + command.replaceAll("'", "'\\''") + "'"));
    assert.equal(value.result.stdout.text, 'ok');
  }
});
