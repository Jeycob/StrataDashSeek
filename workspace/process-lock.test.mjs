import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireProcessLock, ownerState, processIdentity } from './process-lock.mjs';
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'process-lease-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return path.join(directory, 'operation.lock'); }
test('process start and boot identity distinguish live owner, reused PID, dead and unknown', async () => {
  const record = { pid: 123, identity: 'start-A:boot-A' };
  assert.equal(await ownerState(record, async () => 'start-A:boot-A'), 'live');
  assert.equal(await ownerState(record, async () => 'start-B:boot-A'), 'dead');
  assert.equal(await ownerState(record, async () => 'start-A:boot-B'), 'dead');
  assert.equal(await ownerState(record, async () => null), 'dead');
  assert.equal(await ownerState(record, async () => undefined), 'unknown');
  assert.equal(await ownerState({ pid: 123, identity: 'live' }, async () => 'actual'), 'unknown');
});
test('live lock is not stolen; release is idempotent and permits the next operation', async t => {
  const file = await fixture(t), first = await acquireProcessLock(file);
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
  await first.release(); await first.release(); const next = await acquireProcessLock(file); await next.release();
});
test('legacy empty or malformed lock requires evidence, never age-based deletion', async t => {
  const file = await fixture(t); await fs.writeFile(file, ''); await fs.utimes(file, 0, 0);
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(file, 'utf8'), '');
  await fs.writeFile(file, '{invalid'); await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_RECOVERY_REQUIRED' });
});
test('valid live legacy metadata is protected', async t => {
  const file = await fixture(t), owner = { pid: process.pid, identity: await processIdentity() }; await fs.writeFile(file, JSON.stringify(owner));
  await assert.rejects(acquireProcessLock(file, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
  assert.equal(JSON.parse(await fs.readFile(file)).identity, owner.identity);
});
test('hard-linked lock cannot truncate or delete another file', async t => {
  const file = await fixture(t), original = file + '.source'; await fs.writeFile(original, 'protected source');
  await fs.link(original, file);
  await assert.rejects(acquireProcessLock(file), { code: 'LOCK_PATH_UNSAFE' });
  assert.equal(await fs.readFile(original, 'utf8'), 'protected source');
});
