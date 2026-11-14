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
test('stage step budget is enforced even without recognizable checks', () => { const b = new RepairBudget(); for (let i = 0; i < 10; i++) assert.equal(b.step(10), true); assert.equal(b.step(10), false); });
test('same error ignores timings and generated absolute paths', () => assert.equal(errorFingerprint('/tmp/a.js error in 20ms'), errorFingerprint('/tmp/b.js error in 99ms')));
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
  const manifest = await sourceManifest(root); assert.deepEqual(Object.keys(manifest.files), ['hello.cs']); const saved = await saveCheckpoint(root, path.join(dir, 'checkpoint'), manifest); assert.equal(await fs.readFile(path.join(saved, 'hello.cs'), 'utf8'), 'Hello');
  if (process.platform !== 'win32') { await fs.symlink(dir, path.join(root, 'escape')); await assert.rejects(canonicalInside(root, 'escape/secret', true), /Symbolic/); }
});
