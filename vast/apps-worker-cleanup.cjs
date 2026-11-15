'use strict';

const MIB = 1024 ** 2;
const PRUNE_ARGS = Object.freeze(['builder', 'prune', '--all', '--force', '--keep-storage', '0B']);
const measured = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Only the managed job owner may prune UNUSED build cache. No images,
// containers, volumes, project files or databases are removed by this helper.
async function ensureWorkerCapacity(manager, job, { minFreeBytes = 512 * MIB, minFreeInodes = 16384 } = {}) {
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0 || !Number.isSafeInteger(minFreeInodes) || minFreeInodes < 0) throw new TypeError('Invalid Docker worker capacity thresholds');
  const worker = manager?.worker;
  if (!worker) return { skipped: true, reason: 'no-managed-worker', pruned: false };
  const log = text => manager.log(job, text);
  const thresholds = { minFreeBytes, minFreeInodes };
  const describe = sample => `freeBytes=${sample.freeBytes ?? 'unknown'}, freeInodes=${sample.freeInodes ?? 'unknown'}; requiredBytes=${minFreeBytes}, requiredInodes=${minFreeInodes}`;
  async function sample(stage) {
    let bytes;
    try { bytes = await worker.diskFree(); }
    catch (cause) {
      log(`Docker worker ${stage}: capacity measurement failed; freeBytes=unknown, freeInodes=unknown.\n`);
      throw new Error('Docker worker free space could not be verified; refusing to bypass the capacity guard', { cause });
    }
    const result = { freeBytes: measured(bytes), freeInodes: measured(worker.freeInodes) };
    log(`Docker worker ${stage}: ${describe(result)}.\n`);
    if (result.freeBytes === null) throw new Error('Docker worker free bytes are unknown; refusing to bypass the capacity guard');
    return result;
  }
  const low = s => s.freeBytes < minFreeBytes || s.freeInodes !== null && s.freeInodes < minFreeInodes;
  const blockers = s => [s.freeBytes < minFreeBytes ? 'insufficient free bytes' : null, s.freeInodes !== null && s.freeInodes < minFreeInodes ? 'insufficient free inodes' : null].filter(Boolean).join(' and ');
  function authorizePrune() {
    if (!job || typeof job.id !== 'string' || !job.id || manager.busy !== job.id) return 'current job does not own the Apps operation';
    if (manager.cfg?.cliEnabled !== true || typeof manager.cli?.call !== 'function') return 'managed Docker CLI is not enabled';
    let status; try { status = worker.status(); } catch { return 'worker isolation status could not be verified'; }
    if (status?.phase !== 'ready') return 'managed worker is not ready; this guard never wakes it';
    if (status.controlIsolation?.verified !== true) return 'managed worker control isolation is not verified';
    return null;
  }
  const before = await sample('before capacity check');
  if (!low(before)) return { skipped: false, pruned: false, ...thresholds, before, after: before };
  const denied = authorizePrune();
  if (denied) {
    log(`Docker worker cleanup blocked: ${denied}; ${blockers(before)}.\n`);
    throw new Error(`Docker worker ${blockers(before)}; unused build-cache cleanup refused: ${denied}`);
  }
  log('Docker worker capacity is low; pruning UNUSED build cache only. Images, containers, volumes and application data are preserved.\n');
  try {
    await manager.cli.call([...PRUNE_ARGS], { timeout: 120000, onOutput: text => manager.log(job, text) });
  } catch (cause) {
    log('Docker worker unused build-cache cleanup failed; deployment remains blocked by the capacity guard.\n');
    throw new Error(`Docker worker unused build-cache cleanup failed; ${blockers(before)}; capacity guard remains enforced`, { cause });
  }
  // A completed prune is not evidence of recovered capacity. Measure again.
  const after = await sample('after unused build-cache cleanup');
  if (low(after)) {
    log(`Docker worker remains blocked: ${blockers(after)} after unused build-cache cleanup.\n`);
    throw new Error(`Docker worker ${blockers(after)} after unused build-cache cleanup (${describe(after)}); images, containers and volumes were not removed`);
  }
  return { skipped: false, pruned: true, ...thresholds, before, after };
}

module.exports = { ensureWorkerCapacity };
