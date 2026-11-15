import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { relativeFile, validateSettings, RepairBudget, errorFingerprint } from './policy.mjs';
import { ProjectLocks, sourceManifest, saveCheckpoint, canonicalInside } from './storage.mjs';
test('workspace settings validate ranges and unavailable models', () => {
  assert.equal(validateSettings({}).reasoningEffort, 'medium');
  for (const x of [{ maxTokens: 65536 }, { noProgressLimit: 4 }, { temperature: NaN }, { language: 'de' }, { apiKey: 'no' }, { baseCommit: 'HEAD' }]) assert.throws(() => validateSettings(x));
  assert.throws(() => validateSettings({}, []));
});
test('three failed repairs pause even when files change; a lower failure score improves', () => {
  const b = new RepairBudget();
  for (let i = 0; i < 3; i++) b.observe({ kind: 'test', exitCode: 1, text: '3 failed', manifestHash: String(i) });
  assert.equal(b.blocked.code, 'REPAIR_NO_PROGRESS'); assert.equal(b.step(60), false);
  assert.throws(() => b.resume('retry')); b.resume('Replace the broken parser with a simpler implementation.');
  b.observe({ kind: 'test', exitCode: 1, text: '2 failed' }); assert.equal(b.stalled, 0);
  b.observe({ kind: 'test', exitCode: 0, text: 'all passed' }); assert.equal(b.steps, 0); assert.equal(b.blocked, null);
});

test('a passed check does not prevent recognizing progress in subsequent failed checks', () => {
  const budget = new RepairBudget();
  budget.observe({ kind: 'test', exitCode: 0, text: '# tests 4\n# pass 4\n# fail 0' });
  const stage = budget.stage;
  for (const failed of [5, 4, 3, 2]) {
    budget.observe({ kind: 'test', exitCode: 1, text: `# tests 10\n# pass ${10 - failed}\n# fail ${failed}` });
    assert.equal(budget.blocked, null, `decreasing failure count ${failed} is progress`);
  }
  assert.equal(budget.stage, stage, 'partial progress never passes a stage');
  assert.equal(budget.checks.test.bestScore, 2);
  assert.equal(budget.stalled, 0);
});

test('a new failure series after a pass retains repeated-error and stage limits', () => {
  const budget = new RepairBudget();
  budget.observe({ kind: 'test', exitCode: 0, text: '# tests 4\n# pass 4\n# fail 0' });
  for (let i = 0; i < 3; i++) {
    budget.step(60);
    budget.observe({ kind: 'test', exitCode: 1, text: '# tests 10\n# pass 5\n# fail 5', manifestHash: String(i) });
  }
  assert.equal(budget.blocked?.code, 'REPAIR_NO_PROGRESS'); assert.equal(budget.steps, 3);
  const limited = new RepairBudget(); limited.observe({ kind: 'test', exitCode: 0, text: 'passed' });
  for (let i = 0; i < 10; i++) limited.step(10);
  assert.equal(limited.step(10), false); assert.equal(limited.blocked.code, 'STAGE_BUDGET');
});

test('persisted zero minima recover comparisons without resuming a blocked run', () => {
  const saved = { stage: 2, steps: 7, stalled: 2, errors: {}, checks: { test: { bestScore: 0, lastScore: 5 } } };
  const budget = new RepairBudget(JSON.parse(JSON.stringify(saved)));
  budget.observe({ kind: 'test', exitCode: 1, text: '# tests 10\n# pass 6\n# fail 4' });
  assert.equal(budget.steps, 7); assert.equal(budget.stalled, 0); assert.equal(budget.checks.test.bestScore, 4);
  budget.observe({ kind: 'test', exitCode: 1, text: '# tests 10\n# pass 7\n# fail 3' });
  assert.equal(budget.blocked, null); assert.equal(budget.stalled, 0);
  const blocked = new RepairBudget({ ...saved, blocked: { code: 'REPAIR_NO_PROGRESS' } });
  blocked.observe({ kind: 'test', exitCode: 0, text: 'passed' });
  assert.equal(blocked.blocked.code, 'REPAIR_NO_PROGRESS'); assert.equal(blocked.stage, 2);
});
test('stage step budget is enforced even without recognizable checks', () => { const b = new RepairBudget(); for (let i = 0; i < 10; i++) assert.equal(b.step(10), true); assert.equal(b.step(10), false); });
test('setup errors are not combined into failed repairs before implementation', () => {
  const b = new RepairBudget(); b.step(60);
  b.observe({ isError: true, text: 'Use project_exec instead of bash' });
  b.observe({ isError: true, text: 'Use project_exec instead of bash' });
  b.observe({ exitCode: 1, text: 'Documentation search: permission denied' });
  assert.equal(b.blocked, null); assert.equal(b.stalled, 0); assert.equal(b.steps, 1); assert.deepEqual(b.checks, {});
});
test('a repeated tool failure still pauses and a verified stage starts a fresh error budget', () => {
  const b = new RepairBudget(); for (let i = 0; i < 2; i++) b.observe({ isError: true, text: 'same failed tool' });
  b.observe({ kind: 'test', exitCode: 0, text: 'passed' });
  for (let i = 0; i < 2; i++) b.observe({ isError: true, text: 'same failed tool' });
  assert.equal(b.blocked, null); b.observe({ isError: true, text: 'same failed tool' }); assert.equal(b.blocked.code, 'REPEATED_TOOL_ERROR');
});
test('same error ignores timings and generated absolute paths', () => assert.equal(errorFingerprint('/tmp/a.js error in 20ms'), errorFingerprint('/tmp/b.js error in 99ms')));

test('recognized test setup, invocation, stale edits and timeouts do not consume failed verification repairs', () => {
  const budget = new RepairBudget(); budget.step(60);
  for (const observation of [
    { kind: 'test', exitCode: 1, text: 'Cannot find module /project/test\n# tests 1\n# fail 1' },
    { kind: 'test', exitCode: 1, text: 'ERR_INVALID_ARG_TYPE: third argument must be object' },
    { kind: 'test', isError: true, text: 'old_string not found' },
    { kind: 'test', timedOut: true, text: 'check did not settle' },
  ]) budget.observe(observation);
  assert.equal(budget.stalled, 0); assert.deepEqual(budget.checks, {}); assert.equal(budget.blocked, null);
  assert.equal(budget.steps, 1);
  budget.observe({ kind: 'test', exitCode: 1, text: 'AssertionError [ERR_ASSERTION]: expected 2' });
  assert.equal(budget.stalled, 1); assert.ok(budget.checks.test);
});

test('repeated setup failures still pause separately and cannot bypass the stage budget', () => {
  const budget = new RepairBudget();
  for (let i = 0; i < 3; i++) budget.observe({ kind: 'test', exitCode: 1, text: 'Cannot find module /project/test' });
  assert.equal(budget.blocked.code, 'REPEATED_TOOL_ERROR'); assert.equal(budget.stalled, 0); assert.deepEqual(budget.checks, {});
  const distinct = new RepairBudget();
  for (let i = 0; i < 10; i++) { distinct.step(10); distinct.observe({ kind: 'test', exitCode: 1, text: 'missing script: unique-' + i }); }
  assert.equal(distinct.blocked, null); distinct.step(10); assert.equal(distinct.blocked.code, 'STAGE_BUDGET');
});

test('zero tests, missing status and masked assertion failures cannot reset a verification stage', () => {
  for (const observation of [
    { kind: 'test', exitCode: 0, text: '# tests 0\n# pass 0' },
    { kind: 'test', exitCode: null, text: 'still running' },
    { kind: 'test', exitCode: 0, text: 'AssertionError [ERR_ASSERTION]\n# tests 1\n# fail 1' },
  ]) {
    const budget = new RepairBudget(); budget.step(60); budget.observe(observation);
    assert.equal(budget.stage, 1); assert.equal(budget.steps, 1);
    if (budget.checks.test) assert.ok(budget.checks.test.lastScore > 0);
  }
});

test('cancellation is not an attempted repair or a completed verification', () => {
  const budget = new RepairBudget();
  for (let i = 0; i < 5; i++) budget.observe({ kind: 'test', aborted: true });
  assert.equal(budget.blocked, null); assert.equal(budget.stalled, 0); assert.equal(budget.stage, 1); assert.deepEqual(budget.checks, {});
});
test('file paths reject absolute, traversal and VCS writes', () => { for (const p of ['../x', '/etc/passwd', 'a/../../b', '.git/config', 'a\\b', './x']) assert.throws(() => relativeFile(p)); assert.equal(relativeFile('src/app.cs'), 'src/app.cs'); });
test('leases serialize competing runs, allow siblings and block overlapping roots', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-leases-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'projects'); await fs.mkdir(path.join(root, 'one'), { recursive: true }); await fs.mkdir(path.join(root, 'two'));
  const a = new ProjectLocks(path.join(dir, 'locks')), b = new ProjectLocks(path.join(dir, 'locks'));
  await a.acquire(path.join(root, 'one'), 'A'); await assert.rejects(b.acquire(path.join(root, 'one'), 'B'), /Another run/); await assert.rejects(b.acquire(root, 'B'), /Another run/);
  await b.acquire(path.join(root, 'two'), 'B'); await a.release('A'); await a.acquire(path.join(root, 'one'), 'C');
});
test('checkpoints preserve text, skip dependencies and refuse symlink escapes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-checkpoint-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); await fs.mkdir(path.join(root, 'node_modules'), { recursive: true }); await fs.writeFile(path.join(root, 'hello.cs'), 'Hello'); await fs.writeFile(path.join(root, 'node_modules', 'ignored'), 'ignored');
  const manifest = await sourceManifest(root); assert.deepEqual(Object.keys(manifest.files), ['hello.cs']); const saved = await saveCheckpoint(root, path.join(dir, 'checkpoint'), manifest); assert.equal(await fs.readFile(path.join(saved, 'files', 'hello.cs'), 'utf8'), 'Hello');
  if (process.platform !== 'win32') { await fs.symlink(dir, path.join(root, 'escape')); await assert.rejects(canonicalInside(root, 'escape/secret', true), /Symbolic/); }
});
