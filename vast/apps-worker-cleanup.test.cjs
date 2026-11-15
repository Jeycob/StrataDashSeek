'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ensureWorkerCapacity } = require('./apps-worker-cleanup.cjs');
const MIB = 1024 ** 2, MIN = 512 * MIB;
function fixture(samples = [{ bytes: MIN, inodes: 16384 }], overrides = {}) {
  const calls = [], logs = []; let reads = 0;
  const job = { id: 'owned-job' }, worker = {
    freeInodes: 1, freeBytes: 9999999999,
    async diskFree() { const s = samples[Math.min(reads++, samples.length - 1)]; if (s.error) throw s.error; this.freeInodes = s.inodes; this.freeBytes = s.bytes; return s.bytes; },
    status: () => ({ phase: 'ready', controlIsolation: { verified: true } }),
    ready() { throw Error('MUST NOT WAKE'); }, ensure() { throw Error('MUST NOT WAKE'); },
  };
  const manager = { worker, busy: job.id, cfg: { cliEnabled: true }, cli: { async call(args, options) { calls.push({ args, options }); options.onOutput('Cache reclaimed\n'); return { stdout: 'Cache reclaimed\n' }; } }, log(j, text) { assert.equal(j, job); logs.push(text); }, ...overrides };
  return { manager, job, worker, calls, logs, reads: () => reads, run: options => ensureWorkerCapacity(manager, job, options) };
}

test('skips absent managed VM without CLI, measurement or wake', async () => {
  assert.deepEqual(await ensureWorkerCapacity({}, { id: 'x' }), { skipped: true, reason: 'no-managed-worker', pruned: false });
});

test('fresh space at exact thresholds needs no cleanup; stale cached bytes do not substitute for measurement', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(f.reads(), 1); assert.equal(f.calls.length, 0); assert.equal(result.pruned, false);
  assert.deepEqual(result.before, { freeBytes: MIN, freeInodes: 16384 }); assert.equal(result.after, result.before);
  assert.match(f.logs.join(''), /requiredBytes=536870912, requiredInodes=16384/);
});

test('low bytes prunes only unused builder cache with exact managed CLI args, timeout and fresh after measurement', async () => {
  const f = fixture([{ bytes: MIN - 1, inodes: 20000 }, { bytes: MIN, inodes: 20000 }]), result = await f.run();
  assert.equal(result.pruned, true); assert.equal(f.reads(), 2); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ['builder', 'prune', '--all', '--force', '--keep-storage', '0B']);
  assert.equal(f.calls[0].options.timeout, 120000); assert.equal(typeof f.calls[0].options.onOutput, 'function');
  assert.equal(result.before.freeBytes, MIN - 1); assert.equal(result.after.freeBytes, MIN);
  assert.match(f.logs.join(''), /Cache reclaimed/); assert.match(f.logs.join(''), /after unused build-cache cleanup/);
  assert.equal(f.calls.flatMap(c => c.args).some(a => ['system', 'image', 'container', 'volume', 'rm'].includes(a)), false);
});

test('inode exhaustion independently triggers cleanup, with bytes and inodes both enforced afterward', async () => {
  const f = fixture([{ bytes: MIN * 2, inodes: 16383 }, { bytes: MIN * 2, inodes: 16384 }]);
  assert.equal((await f.run()).pruned, true); assert.equal(f.calls.length, 1);
  const stillLow = fixture([{ bytes: MIN * 2, inodes: 1 }, { bytes: MIN * 2, inodes: 16383 }]);
  await assert.rejects(stillLow.run(), /insufficient free inodes after/); assert.equal(stillLow.reads(), 2);
});

test('unknown inode counts remain explicitly unknown and do not pretend to be measured', async () => {
  for (const inodes of [undefined, null, NaN, Infinity, -1, '20000']) {
    const f = fixture([{ bytes: MIN, inodes }]), result = await f.run();
    assert.equal(result.before.freeInodes, null); assert.equal(f.calls.length, 0); assert.match(f.logs.join(''), /freeInodes=unknown/);
  }
  const f = fixture([{ bytes: 0 }, { bytes: MIN }]); const result = await f.run();
  assert.equal(result.after.freeInodes, null); assert.equal(result.pruned, true);
});

test('unknown or invalid byte measurement fails closed without any prune', async () => {
  for (const bytes of [undefined, null, NaN, Infinity, -1, '600000000', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture([{ bytes, inodes: 20000 }]); await assert.rejects(f.run(), /free bytes are unknown/); assert.equal(f.calls.length, 0);
  }
  const failed = fixture([{ error: Error('df failed') }]); await assert.rejects(failed.run(), /free space could not be verified/); assert.equal(failed.calls.length, 0);
});

test('insufficient capacity never prunes without exact active job ownership and managed CLI', async () => {
  for (const modify of [f => { f.manager.busy = 'other-job'; }, f => { f.manager.busy = null; }, f => { f.job.id = undefined; f.manager.busy = undefined; }, f => { f.manager.cfg.cliEnabled = false; }, f => { f.manager.cfg.cliEnabled = 'true'; }, f => { f.manager.cli = null; }]) {
    const f = fixture([{ bytes: 0, inodes: 0 }]); modify(f); await assert.rejects(f.run(), /cleanup refused/); assert.equal(f.calls.length, 0);
  }
});

test('asleep, starting, error or unverified worker never receives cleanup or wake calls', async () => {
  for (const status of [{ phase: 'asleep', controlIsolation: { verified: true } }, { phase: 'starting', controlIsolation: { verified: true } }, { phase: 'error', controlIsolation: { verified: true } }, { phase: 'ready', controlIsolation: { verified: false } }, { phase: 'ready' }, undefined]) {
    const f = fixture([{ bytes: 0, inodes: 0 }]); f.worker.status = () => status;
    await assert.rejects(f.run(), /cleanup refused/); assert.equal(f.calls.length, 0); assert.equal(f.reads(), 1);
  }
  const f = fixture([{ bytes: 0 }]); f.worker.status = () => { throw Error('not available'); };
  await assert.rejects(f.run(), /isolation status could not be verified/); assert.equal(f.calls.length, 0);
});

test('ownership and isolation are checked after asynchronous measurement, immediately before prune', async () => {
  const f = fixture([{ bytes: 0, inodes: 1 }]), measure = f.worker.diskFree;
  f.worker.diskFree = async function () { const value = await measure.call(this); f.manager.busy = 'new-job'; return value; };
  await assert.rejects(f.run(), /does not own/); assert.equal(f.calls.length, 0);
});

test('prune failure propagates a precise capacity blocker without retry, broad cleanup or false success', async () => {
  const f = fixture([{ bytes: 1, inodes: 0 }]); f.manager.cli.call = async (args, options) => { f.calls.push({ args, options }); throw Error('CLI failed'); };
  await assert.rejects(f.run(), /cleanup failed; insufficient free bytes and insufficient free inodes/);
  assert.equal(f.calls.length, 1); assert.equal(f.reads(), 1); assert.match(f.logs.join(''), /remains blocked/);
});

test('prune success is insufficient without fresh adequate bytes, including measurement failure', async () => {
  for (const after of [{ bytes: MIN - 1, inodes: 20000 }, { bytes: undefined }, { error: Error('df after failed') }]) {
    const f = fixture([{ bytes: 1, inodes: 20000 }, after]); await assert.rejects(f.run(), /insufficient free bytes after|free bytes are unknown|free space could not be verified/);
    assert.equal(f.calls.length, 1); assert.equal(f.reads(), 2);
  }
});

test('custom positive thresholds are respected; invalid thresholds fail before any worker or CLI call', async () => {
  const f = fixture([{ bytes: 99, inodes: 1 }, { bytes: 100, inodes: 2 }]);
  const result = await f.run({ minFreeBytes: 100, minFreeInodes: 2 }); assert.equal(result.minFreeBytes, 100); assert.equal(result.minFreeInodes, 2);
  for (const options of [{ minFreeBytes: -1 }, { minFreeInodes: -1 }, { minFreeBytes: NaN }, { minFreeInodes: Infinity }, { minFreeBytes: 1.5 }, { minFreeInodes: '0' }]) {
    const bad = fixture(); await assert.rejects(bad.run(options), TypeError); assert.equal(bad.reads(), 0); assert.equal(bad.calls.length, 0);
  }
});
