import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './manager.mjs';
import { ProjectLocks, saveCheckpoint, sourceManifest } from './storage.mjs';
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-restore-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), state = path.join(base, 'state'); await fs.mkdir(root); await fs.mkdir(path.join(state, 'checkpoints/one'), { recursive: true });
  await fs.writeFile(path.join(root, 'app.js'), 'original'); const manifest = await sourceManifest(root), checkpoint = await saveCheckpoint(root, path.join(state, 'checkpoints/one/best'), manifest, { minFreeBytes: 0 });
  await fs.writeFile(path.join(root, 'app.js'), 'working');
  const session = { id: 'one', header: { cwd: root } }, agent = { id: 'one', status: 'idle', session };
  const manager = Object.create(WorkspaceManager.prototype); manager.root = state;
  manager.data = { sessions: { one: { root, checkpoints: { test: { path: checkpoint, sha256: manifest.sha256 } } } } };
  manager.locks = new ProjectLocks(path.join(state, 'leases')); manager.running = new Map(); manager.resultWork = new Map(); manager.save = async () => {};
  let mode = 'workspace-write'; manager.ctx = { sessions: { get: () => session }, agents: { get: () => agent }, sandboxPolicy: { resolve: () => ({ mode }) }, waterfall: async () => [] };
  return { root, state, manager, session, setMode: value => { mode = value; } };
}
test('read-only session can preview but cannot restore; status read does not mutate sources', async t => {
  const f = await fixture(t); f.setMode('read-only');
  const preview = await f.manager.previewCheckpointRestore('one', 'test'); assert.equal(preview.canRestore, true); assert.deepEqual(preview.writes, ['app.js']);
  assert.equal((await f.manager.checkpointRecovery('one')).status, 'none');
  await assert.rejects(f.manager.restoreCheckpoint('one', 'test'), { code: 'READ_ONLY' });
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'working');
});
test('session/root change during lease acquisition is refused and lease released', async t => {
  const f = await fixture(t), other = path.join(f.state, 'other'); await fs.mkdir(other);
  const acquire = f.manager.locks.acquire.bind(f.manager.locks);
  f.manager.locks.acquire = async (...args) => { const result = await acquire(...args); f.manager.data.sessions.one.root = other; return result; };
  await assert.rejects(f.manager.restoreCheckpoint('one', 'test'), { code: 'PROJECT_CHANGED' });
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'working'); assert.equal((await f.manager.locks.records()).length, 0);
});
test('pending invalid journal is visible to review but never automatically treated as recovered', async t => {
  const f = await fixture(t), directory = path.join(f.state, 'restores/one'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'transaction.json'), contents = JSON.stringify({ status: 'committed' }); await fs.writeFile(file, contents);
  const review = await f.manager.review('one'); assert.equal(review.sourceHash, null); assert.equal(review.restoreRecovery.pending, true);
  assert.equal(await fs.readFile(file, 'utf8'), contents);
  await assert.rejects(f.manager.recoverCheckpoint('one'), { code: 'RESTORE_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'working');
});
