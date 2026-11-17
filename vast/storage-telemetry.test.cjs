'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { filesystem, scanCategories, guestVolume, createStorageMonitor } = require('./storage-telemetry.cjs');
const stat = { blocks: 1000n, bfree: 400n, bavail: 300n, bsize: 4096n, files: 200n, ffree: 100n };

test('capacity separates reserved free blocks from available bytes and rejects unknown/overflow', () => {
  assert.deepEqual(filesystem(stat), { totalBytes: 4096000, usedBytes: 2457600, availableBytes: 1228800, inodesTotal: 200, inodesFree: 100 });
  assert.throws(() => filesystem({ ...stat, files: null }));
  assert.throws(() => filesystem({ ...stat, bfree: 1001n }));
  assert.throws(() => filesystem({ ...stat, blocks: BigInt(Number.MAX_SAFE_INTEGER) }));
});

test('metadata inventory deduplicates hardlinks and nested roots, never returns file names or contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-fixture-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'nested')); await fs.writeFile(path.join(root, 'private-name'), 'secret-fixture-payload'); await fs.link(path.join(root, 'private-name'), path.join(root, 'nested', 'hardlink'));
  const result = await scanCategories([{ id: 'projects', label: 'Projects', directory: root }, { id: 'cache', label: 'Cache', directory: path.join(root, 'nested') }]);
  assert.equal(result.categories.reduce((n, r) => n + r.files, 0), 3);
  assert.ok(result.categories.some(r => r.shared)); assert.doesNotMatch(JSON.stringify(result), /private-name|hardlink|secret-fixture/);
  assert.equal(result.detailsTruncated, false);
});

test('bounded inventory reports partial instead of presenting capped totals as complete', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-cap-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(root, 'file' + i), 'x');
  const result = await scanCategories([{ id: 'projects', label: 'Projects', directory: root }], { maxEntries: 3 });
  assert.equal(result.entries, 3); assert.equal(result.detailsTruncated, true); assert.equal(result.categories[0].partial, true);
});

test('symlinks and another device are excluded without content reads', async () => {
  let calls = 0;
  const io = { lstat: async () => ({ dev: 1, ino: 1, isSymbolicLink: () => true }), realpath: async () => { calls++; }, readFile: async () => { throw Error('Content must never be read'); } };
  const result = await scanCategories([{ id: 'projects', label: 'Projects', directory: '/safe' }], { io });
  assert.equal(calls, 0); assert.equal(result.categories[0].bytes, null); assert.equal(result.categories[0].partial, true);
});

test('snapshot is nonblocking and coalesces samples/scans; sleeping guest stays stale without a wake', async () => {
  let clock = 1000, samples = 0, scans = 0, guests = 0;
  const io = { statfs: async () => { samples++; return stat; }, lstat: async () => { scans++; throw Object.assign(Error(), { code: 'ENOENT' }); } };
  const monitor = createStorageMonitor({ capacityPath: path.resolve('fixture'), roots: [{ id: 'models', label: 'Models', directory: path.resolve('absent') }], io, now: () => clock,
    readGuest: async () => { guests++; return { enabled: true, at: clock, worker: { phase: 'asleep', freeBytes: 300, freeInodes: 20, diskCheckedAt: 999 } }; } });
  for (let i = 0; i < 50; i++) assert.equal(monitor.snapshot().scanning, true);
  await monitor.settled(); const result = monitor.snapshot();
  assert.equal(samples, 1); assert.equal(scans, 1); assert.equal(guests, 1); assert.equal(result.volumes[0].stale, false);
  const guest = result.volumes[1]; assert.equal(guest.stale, true); assert.equal(guest.totalBytes, null); assert.equal(guest.usedBytes, null); assert.equal(guest.errorCode, 'GUEST_ASLEEP');
  clock += 11000; monitor.snapshot(); await monitor.settled(); assert.equal(samples, 2); assert.equal(scans, 1);
  await monitor.close();
});

test('unknown guest values are null and old heartbeat cannot become fresh census', () => {
  assert.equal(guestVolume(null, 1000, 100).availableBytes, null);
  const guest = guestVolume({ at: 100, worker: { phase: 'ready', diskCheckedAt: 999, totalBytes: 1000, usedBytes: 700, freeBytes: 250, totalInodes: 100, freeInodes: 20 } }, 1000, 100);
  assert.equal(guest.stale, true); assert.equal(guest.inodesFree, 20); assert.equal(guest.detailsTruncated, true);
});

test('guest rejects impossible capacity and future heartbeat/inventory timestamps', () => {
  const observation = { enabled: true, at: 1000, worker: { phase: 'ready', diskCheckedAt: 1000, totalBytes: 100, usedBytes: 50, freeBytes: 50, totalInodes: 10, freeInodes: 5, storageCheckedAt: 1000 } };
  assert.equal(guestVolume(observation, 1000, 30000).stale, false);
  for (const patch of [{ freeBytes: 200 }, { usedBytes: 101 }, { usedBytes: 51 }, { freeInodes: 20 }]) {
    const result = guestVolume({ ...observation, worker: { ...observation.worker, ...patch } }, 1000, 30000);
    assert.equal(result.stale, true); assert.equal(result.errorCode, 'GUEST_CAPACITY_INVALID');
  }
  assert.equal(guestVolume({ ...observation, at: 1000000 }, 1000, 30000).stale, true);
  assert.equal(guestVolume({ ...observation, worker: { ...observation.worker, storageCheckedAt: 1000000 } }, 1000, 30000).inventoryStale, true);
});

test('disabled and old-format persisted ready snapshots are retained but never fresh', () => {
  const observation = { at: 1000, worker: { phase: 'ready', diskCheckedAt: 1000, totalBytes: 100, usedBytes: 50, freeBytes: 50, totalInodes: 10, freeInodes: 5, storageCheckedAt: 1000, storageCategories: [{ id: 'images', bytes: 20, partial: false, shared: true }] } };
  for (const [enabled, code] of [[false, 'GUEST_DISABLED'], [undefined, 'GUEST_STATE_UNKNOWN']]) {
    const value = guestVolume({ ...observation, enabled }, 1000, 30000);
    assert.equal(value.stale, true); assert.equal(value.inventoryStale, true); assert.equal(value.errorCode, code);
    assert.equal(value.availableBytes, 50); assert.equal(value.observedAt, 1000); assert.equal(value.categories[0].bytes, 20);
  }
});

test('cached host values and timestamps survive failure as stale instead of zero', async () => {
  let clock = 1000, failed = false;
  const monitor = createStorageMonitor({ roots: [], capacityPath: path.resolve('fixture'), sampleTtlMs: 10, now: () => clock, io: { statfs: async () => { if (failed) throw Error('unavailable'); return stat; } } });
  monitor.snapshot(); await monitor.settled(); const before = monitor.snapshot().volumes[0];
  failed = true; clock += 11; monitor.snapshot(); await monitor.settled(); const after = monitor.snapshot().volumes[0];
  assert.equal(after.stale, true); assert.equal(after.availableBytes, before.availableBytes); assert.equal(after.observedAt, before.observedAt); assert.equal(after.errorCode, 'HOST_CAPACITY_UNKNOWN');
  await monitor.close();
});
