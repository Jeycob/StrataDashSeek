import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceManifest, saveCheckpoint, hash } from './storage.mjs';
import { previewCheckpointRestore, restoreCheckpointTransaction, recoverCheckpointRestore, checkpointRecoveryStatus } from './checkpoint-restore.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-transaction-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project'), checkpointRoot = path.join(temp, 'checkpoints'), stateRoot = path.join(temp, 'restore');
  await fs.mkdir(root); await fs.mkdir(checkpointRoot);
  const write = async (name, text) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  const capture = async () => { const manifest = await sourceManifest(root); return { manifest, path: await saveCheckpoint(root, path.join(checkpointRoot, 'best'), manifest, { minFreeBytes: 0 }) }; };
  const options = { checkpointRoot, stateRoot, minFreeBytes: 0 };
  return { root, checkpointRoot, stateRoot, write, capture, options };
}
test('large snapshot source later shrunk is preserved; exclusions are explicit and not deletions', async t => {
  const f = await fixture(t); await f.write('large.txt', Buffer.alloc(1024 ** 2 + 1, 65)); await f.write('app.js', 'original'); await f.write('secrets/session-secret', 'PRIVATE_FIXTURE');
  const saved = await f.capture(); assert.equal(saved.manifest.inventory['large.txt'].reason, 'per-file-limit');
  assert.equal(Object.hasOwn(saved.manifest.files, 'large.txt'), false); assert.equal(Object.hasOwn(saved.manifest.files, 'secrets/session-secret'), false);
  await f.write('large.txt', 'small now'); await f.write('app.js', 'changed'); await f.write('new.js', 'new');
  const preview = await previewCheckpointRestore(f.root, saved.path, { expectedHash: saved.manifest.sha256 });
  assert.deepEqual(preview.deletes, ['new.js']); assert.ok(preview.preservedPaths.includes('large.txt'));
  const result = await restoreCheckpointTransaction(f.root, saved.path, f.options); assert.equal(result.restored, true);
  assert.equal(await fs.readFile(path.join(f.root, 'large.txt'), 'utf8'), 'small now');
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(f.root, 'new.js')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.root, 'secrets/session-secret'), 'utf8'), 'PRIVATE_FIXTURE');
});
test('corrupt second payload is rejected before first source mutation or beforeRestore publication', async t => {
  const f = await fixture(t); await f.write('a', 'first original'); await f.write('b', 'second original'); const saved = await f.capture();
  await f.write('a', 'first current'); await f.write('b', 'second current'); await fs.writeFile(path.join(saved.path, 'files/b'), 'corrupt');
  await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, f.options), { code: 'CHECKPOINT_INVALID' });
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'first current');
  assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'second current');
  assert.equal((await checkpointRecoveryStatus(f.stateRoot)).status, 'none');
});
test('legacy checkpoints overlay known files and preserve unknown current files', async t => {
  const f = await fixture(t); await f.write('a', 'original'); const saved = await f.capture();
  const files = saved.manifest.files; await fs.writeFile(path.join(saved.path, 'checkpoint-manifest.json'), JSON.stringify({ files }));
  await f.write('a', 'current'); await f.write('unknown', 'must survive');
  const result = await restoreCheckpointTransaction(f.root, saved.path, { ...f.options, expectedHash: hash(JSON.stringify(Object.entries(files).sort())) });
  assert.equal(result.legacyOverlayOnly, true); assert.equal(await fs.readFile(path.join(f.root, 'unknown'), 'utf8'), 'must survive');
});
test('current oversized data cannot be overwritten without a complete safety backup', async t => {
  const f = await fixture(t); await f.write('a', 'original'); const saved = await f.capture(); await f.write('a', Buffer.alloc(1024 ** 2 + 1));
  await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, f.options), { code: 'RESTORE_PROTECTED_SOURCE' });
  assert.equal((await fs.stat(path.join(f.root, 'a'))).size, 1024 ** 2 + 1);
});
test('disk reserve failure leaves sources untouched and no pending recovery', async t => {
  const f = await fixture(t); await f.write('a', 'original'); const saved = await f.capture(); await f.write('a', 'current');
  await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, { ...f.options, statfs: async () => ({ bavail: 0, bsize: 1 }) }), { code: 'CHECKPOINT_DISK_RESERVE' });
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'current');
});
for (const phase of ['validated', 'staged-file', 'staged', 'backup-created', 'prepared', 'committing', 'write-temp-synced', 'committed-file', 'before-complete']) {
  test(`cancel at ${phase} never reports success and restores original working sources`, async t => {
    const f = await fixture(t); await f.write('a', 'old-a'); await f.write('b', 'old-b'); const saved = await f.capture();
    await f.write('a', 'work-a'); await f.write('b', 'work-b'); await f.write('extra', 'retained'); const controller = new AbortController();
    await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, { ...f.options, signal: controller.signal, onPhase: async current => { if (current === phase) controller.abort(); } }));
    assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'work-a'); assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'work-b');
    assert.equal(await fs.readFile(path.join(f.root, 'extra'), 'utf8'), 'retained');
    assert.equal((await checkpointRecoveryStatus(f.stateRoot)).pending, false);
  });
}
for (const phase of ['staged-file', 'staged', 'backup-created', 'prepared', 'committing', 'write-temp-synced', 'committed-file', 'before-complete']) {
  test(`injected ENOSPC at ${phase} leaves no successful partial restore`, async t => {
    const f = await fixture(t); await f.write('a', 'old-a'); await f.write('b', 'old-b'); const saved = await f.capture(); await f.write('a', 'work-a'); await f.write('b', 'work-b'); let fired = false;
    await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, { ...f.options, onPhase: async current => { if (current === phase && !fired) { fired = true; throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' }); } } }), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'work-a'); assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'work-b'); assert.equal((await checkpointRecoveryStatus(f.stateRoot)).pending, false);
  });
}
test('hard-linked source is excluded without reading or backing up its target', async t => {
  const f = await fixture(t); await f.write('secrets/session-secret', 'SYNTHETIC_PRIVATE'); await fs.link(path.join(f.root, 'secrets/session-secret'), path.join(f.root, 'innocent.js'));
  const saved = await f.capture(); assert.equal(saved.manifest.inventory['innocent.js'].reason, 'hard-link'); assert.equal(Object.hasOwn(saved.manifest.files, 'innocent.js'), false);
  await assert.rejects(fs.stat(path.join(saved.path, 'files/innocent.js')), { code: 'ENOENT' });
});
test('preview names an oversized protected target rather than hiding the unsafe overwrite', async t => {
  const f = await fixture(t); await f.write('a', 'old'); const saved = await f.capture(); await f.write('a', Buffer.alloc(1024 ** 2 + 1));
  const plan = await previewCheckpointRestore(f.root, saved.path); assert.equal(plan.canRestore, false); assert.deepEqual(plan.protectedFiles, [{ path: 'a', reason: 'per-file-limit' }]);
});
test('I/O failure after a committed file rolls back; rollback I/O failure is explicit and recoverable', async t => {
  const f = await fixture(t); await f.write('a', 'old-a'); await f.write('b', 'old-b'); const saved = await f.capture(); await f.write('a', 'work-a'); await f.write('b', 'work-b');
  let commitFailed = false, rollbackFailed = false;
  await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, { ...f.options, onPhase: async phase => {
    if (phase === 'committed-file' && !commitFailed) { commitFailed = true; throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' }); }
    if (phase === 'rollback-file' && !rollbackFailed) { rollbackFailed = true; throw Object.assign(Error('fixture recovery I/O failure'), { code: 'ENOSPC' }); }
  } }), { code: 'RESTORE_RECOVERY_REQUIRED' });
  assert.equal((await checkpointRecoveryStatus(f.stateRoot)).pending, true);
  await recoverCheckpointRestore(f.root, f.options);
  assert.equal((await checkpointRecoveryStatus(f.stateRoot)).status, 'rolled-back');
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'work-a'); assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'work-b');
});
test('concurrent restore is refused while first holds its lease', async t => {
  const f = await fixture(t); await f.write('a', 'old'); const saved = await f.capture(); await f.write('a', 'work');
  let resume, entered; const waiting = new Promise(r => { entered = r; }), gate = new Promise(r => { resume = r; });
  const first = restoreCheckpointTransaction(f.root, saved.path, { ...f.options, onPhase: async phase => { if (phase === 'prepared') { entered(); await gate; } } });
  await waiting; await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, f.options), { code: 'LOCK_BUSY' }); resume(); await first;
});
test('beforeRestore is a usable checkpoint and stale preview cannot apply to changed sources', async t => {
  const f = await fixture(t); await f.write('a', 'old'); const saved = await f.capture(); await f.write('a', 'work'); await f.write('extra', 'work-extra');
  const plan = await previewCheckpointRestore(f.root, saved.path); await f.write('a', 'new work');
  await assert.rejects(restoreCheckpointTransaction(f.root, saved.path, { ...f.options, expectedSourceHash: plan.sourceHash }), { code: 'RESTORE_SOURCE_CHANGED' });
  const result = await restoreCheckpointTransaction(f.root, saved.path, f.options);
  await restoreCheckpointTransaction(f.root, result.beforeRestore.path, { ...f.options, expectedHash: result.beforeRestore.sha256 });
  assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'new work'); assert.equal(await fs.readFile(path.join(f.root, 'extra'), 'utf8'), 'work-extra');
});
