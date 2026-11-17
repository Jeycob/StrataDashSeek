import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkpointOperation } from './checkpoint-api.mjs';
import { WorkspaceManager } from './manager.mjs';
import { bindProjectExecution } from './execution-mode.mjs';
import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import { ProjectLocks, saveCheckpoint, sourceManifest } from './storage.mjs';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-api-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), state = path.join(base, 'state');
  await fs.mkdir(root); await fs.mkdir(path.join(state, 'checkpoints/one'), { recursive: true });
  await fs.writeFile(path.join(root, 'app.js'), 'saved');
  const manifest = await sourceManifest(root), saved = await saveCheckpoint(root, path.join(state, 'checkpoints/one/best'), manifest, { minFreeBytes: 0 });
  await fs.writeFile(path.join(root, 'app.js'), 'working');
  const session = { id: 'one', header: { cwd: root } }, agent = { id: 'one', session, status: 'idle' };
  const manager = Object.create(WorkspaceManager.prototype);
  Object.defineProperty(manager, 'execution', { value: bindProjectExecution(hostExecutionBinding()), enumerable: true });
  Object.assign(manager, { root: state, data: { sessions: { one: { root, checkpoints: { best: { path: saved, sha256: manifest.sha256 } } } } }, locks: new ProjectLocks(path.join(state, 'leases')), running: new Map(), resultWork: new Map(), save: async () => {} });
  let mode = 'workspace-write';
  manager.ctx = { sessions: { get: () => session }, agents: { get: () => agent }, sandboxPolicy: { resolve: () => ({ mode }) }, waterfall: async () => [] };
  const call = (op, extra = {}, signal) => checkpointOperation(manager, { op, sessionId: 'one', key: 'best', ...extra }, signal);
  return { manager, root, state, call, setMode: value => { mode = value; } };
}

test('API refuses missing/stale preview and untrusted paths before a source mutation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('checkpoint-restore'), { code: 'RESTORE_PREVIEW_REQUIRED', status: 409 });
  await assert.rejects(f.call('checkpoint-preview', { key: '../../other' }), { code: 'CHECKPOINT_NOT_FOUND' });
  await assert.rejects(f.call('checkpoint-recovery', { sessionId: '../one' }), { code: 'INVALID_SESSION' });
  const { value: preview } = await f.call('checkpoint-preview', { root: '/ignored', checkpoint: '/ignored' });
  await fs.writeFile(path.join(f.root, 'app.js'), 'newer');
  await assert.rejects(f.call('checkpoint-restore', { expectedSourceHash: preview.sourceHash }), { code: 'RESTORE_SOURCE_CHANGED' });
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'newer');
});

test('API applies the exact preview and can preview/restore the retained previous version', async t => {
  const f = await fixture(t), { value: preview } = await f.call('checkpoint-preview');
  const { value: restored } = await f.call('checkpoint-restore', { expectedSourceHash: preview.sourceHash });
  assert.equal(restored.restored, true); assert.equal(restored.recovery.status, 'committed');
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'saved');
  const { value: before } = await f.call('checkpoint-preview', { key: 'beforeRestore' });
  await f.call('checkpoint-restore', { key: 'beforeRestore', expectedSourceHash: before.sourceHash });
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'working');
  assert.equal((await f.call('checkpoint-recovery')).value.pending, false);
});

test('read-only and aborted requests cannot use recovery/restore as a write bypass', async t => {
  const f = await fixture(t); f.setMode('read-only');
  const { value: preview } = await f.call('checkpoint-preview');
  await assert.rejects(f.call('checkpoint-restore', { expectedSourceHash: preview.sourceHash }), { code: 'READ_ONLY' });
  await assert.rejects(f.call('checkpoint-recover'), { code: 'READ_ONLY' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.call('checkpoint-preview', {}, controller.signal), { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(f.root, 'app.js'), 'utf8'), 'working');
  assert.equal(await checkpointOperation(f.manager, { op: 'other' }), null);
});
