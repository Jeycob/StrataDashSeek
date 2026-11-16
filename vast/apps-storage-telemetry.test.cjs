'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { categoriesFromDiskUsage, refreshStorage } = require('./apps-storage-telemetry.cjs');
test('guest capacity publishes measured total/used bytes and total/free inodes from one nonce', async () => {
  const { DockerVM } = require('./apps-vm.cjs');
  const vm = { buffer: '', serial: { destroyed: false, write(command) { const nonce = command.match(/HARNESS_TOTAL_([a-f0-9]{16})/)[1]; vm.buffer = ['TOTAL=1000', 'USED=700', 'FREE=250', 'ITOTAL=400', 'INODES=100'].map(item => { const [key, value] = item.split('='); return 'HARNESS_' + key + '_' + nonce + '=' + value; }).join('\n'); } } };
  assert.equal(await DockerVM.prototype.diskFree.call(vm), 250 * 1024); assert.equal(vm.totalBytes, 1000 * 1024); assert.equal(vm.usedBytes, 700 * 1024); assert.equal(vm.totalInodes, 400); assert.equal(vm.freeInodes, 100);
});
test('image layers counted once, container writable layers and volumes separate, shared build cache nonadditive', () => {
  const rows = categoriesFromDiskUsage({ LayersSize: 500, Images: [{ Size: 500 }, { Size: 500 }], Containers: [{ SizeRw: 20 }, { SizeRw: 30 }], Volumes: [{ UsageData: { Size: 100 } }], BuildCache: [{ Size: 40 }] });
  assert.equal(rows[0].bytes, 500); assert.equal(rows[0].shared, true); assert.equal(rows[1].bytes, 50); assert.equal(rows[2].bytes, 100); assert.equal(rows[3].partial, true);
  assert.equal(categoriesFromDiskUsage({})[0].bytes, null);
});
test('guest storage refresh uses exclusion and TTL, never wakes or touches idle usage', async () => {
  let reads = 0, heartbeats = 0;
  const worker = { phase: 'ready', status: () => ({ controlIsolation: { verified: true } }), diskFree: async () => { reads++; }, ensure: () => assert.fail('wake forbidden'), touch: () => assert.fail('idle touch forbidden') };
  const m = { cfg: { enabled: true }, worker, busy: null, engine: { json: async () => { assert.equal(m.busy, 'storage-inventory'); return { LayersSize: 100 }; } }, heartbeat: () => heartbeats++ };
  await refreshStorage(m, { now: () => 1000 }); await refreshStorage(m, { now: () => 1001 });
  assert.equal(reads, 1); assert.equal(heartbeats, 1); assert.equal(m.busy, null); assert.equal(worker.storageCheckedAt, 1000);
  m.busy = 'user-build'; await refreshStorage(m, { now: () => 999999 }); assert.equal(reads, 1); assert.equal(m.busy, 'user-build');
  m.busy = null; worker.phase = 'asleep'; await refreshStorage(m, { now: () => 999999 }); assert.equal(reads, 1);
});
