'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const safe = value => ['number', 'bigint'].includes(typeof value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const multiply = (a, b) => safe(BigInt(a) * BigInt(b));
const empty = (id, scope, label) => ({ id, scope, label, totalBytes: null, usedBytes: null, availableBytes: null, inodesTotal: null, inodesFree: null, observedAt: null, stale: true, errorCode: 'NOT_OBSERVED', categories: [], detailsTruncated: false });
function filesystem(stat) {
  const keys = ['blocks', 'bfree', 'bavail', 'bsize', 'files', 'ffree'];
  if (keys.some(k => safe(stat[k]) === null) || Number(stat.bsize) < 1 || BigInt(stat.bfree) > BigInt(stat.blocks) || BigInt(stat.bavail) > BigInt(stat.bfree) || BigInt(stat.ffree) > BigInt(stat.files)) throw Error('INVALID_FILESYSTEM_SAMPLE');
  const value = { totalBytes: multiply(stat.blocks, stat.bsize), usedBytes: multiply(BigInt(stat.blocks) - BigInt(stat.bfree), stat.bsize), availableBytes: multiply(stat.bavail, stat.bsize), inodesTotal: safe(stat.files), inodesFree: safe(stat.ffree) };
  if (Object.values(value).some(v => v === null)) throw Error('FILESYSTEM_SAMPLE_OVERFLOW');
  return value;
}

/** Metadata-only inventory of explicitly configured categories. Never reads
 * file contents, follows links, enters another filesystem, or lists raw paths.
 * All categories share an inode set so hardlinks/nested roots count once. */
async function scanCategories(roots, { io = fs, now = Date.now, maxEntries = 20000, maxDurationMs = 1500 } = {}) {
  const start = now(), seen = new Set(), categories = [], limits = { maxEntries, maxDurationMs }; let entries = 0, truncated = false;
  for (const { id, label, directory } of roots) {
    const row = { id, label, bytes: 0, files: 0, partial: false, shared: false }; categories.push(row);
    let realRoot, device;
    try { const stat = await io.lstat(directory); if (stat.isSymbolicLink()) throw Error(); realRoot = await io.realpath(directory); device = stat.dev; } catch (e) { row.bytes = null; row.files = null; row.partial = true; continue; }
    async function visit(file) {
      if (entries >= maxEntries || now() - start >= maxDurationMs) { truncated = row.partial = true; return; }
      entries++;
      if (entries % 64 === 0) await new Promise(resolve => setImmediate(resolve));
      let stat;
      try { stat = await io.lstat(file); } catch { row.partial = true; return; }
      if (stat.isSymbolicLink() || stat.dev !== device || !stat.isFile() && !stat.isDirectory()) return;
      const key = stat.dev + ':' + stat.ino;
      if (seen.has(key)) { row.shared = true; return; }
      seen.add(key);
      // st_blocks measures allocated storage (including sparse files), not
      // virtual image size. Windows fixtures may not expose st_blocks.
      const bytes = Number.isSafeInteger(stat.blocks) && stat.blocks >= 0 ? stat.blocks * 512 : stat.size;
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(row.bytes + bytes)) { row.partial = true; return; }
      row.bytes += bytes; row.files++;
      if (!stat.isDirectory()) return;
      let handle;
      try {
        const canonical = await io.realpath(file);
        if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) { row.partial = true; return; }
        handle = await io.opendir(file);
        for await (const child of handle) {
          if (entries >= maxEntries || now() - start >= maxDurationMs) { truncated = row.partial = true; break; }
          await visit(path.join(file, child.name));
        }
      } catch { row.partial = true; }
    }
    await visit(realRoot);
  }
  return { categories: categories.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)), observedAt: now(), detailsTruncated: truncated || categories.some(r => r.partial), entries, limits };
}

function guestVolume(observation, now, staleMs) {
  const result = empty('docker-guest', 'docker-guest', 'Managed Docker guest');
  const worker = observation?.worker, at = safe(worker?.diskCheckedAt);
  if (!worker) return { ...result, errorCode: 'GUEST_UNAVAILABLE' };
  const totalBytes = safe(worker.totalBytes), availableBytes = safe(worker.freeBytes);
  return { ...result, totalBytes, usedBytes: safe(worker.usedBytes), availableBytes, inodesTotal: safe(worker.totalInodes), inodesFree: safe(worker.freeInodes),
    observedAt: at, stale: worker.phase !== 'ready' || at === null || now < at || now - at > staleMs || !safe(observation.at) || now - observation.at > staleMs,
    errorCode: worker.phase === 'ready' ? at === null ? 'NOT_OBSERVED' : null : 'GUEST_' + (worker.phase === 'asleep' ? 'ASLEEP' : 'UNAVAILABLE'),
    // No virtual per-image sizes are mixed into host allocated-byte totals.
    categories: Array.isArray(worker.storageCategories) ? worker.storageCategories.filter(r => ['images', 'containers', 'volumes', 'cache'].includes(r?.id)).map(r => ({ id: r.id, label: r.id, bytes: safe(r.bytes), partial: r.partial !== false, shared: r.shared === true })) : [],
    inventoryObservedAt: safe(worker.storageCheckedAt), inventoryStale: safe(worker.storageCheckedAt) === null || now - worker.storageCheckedAt > 600000,
    detailsTruncated: !Array.isArray(worker.storageCategories) };
}

function defaultRoots(root) {
  return [
    ['models', 'Model files', path.join(path.dirname(root), 'strata')],
    ['projects', 'Projects', path.join(root, 'workspaces')],
    ['logs', 'Logs', path.join(path.dirname(root), 'logs')],
    ['logs-runtime', 'Runtime logs', path.join(root, 'logs')],
    ['cache', 'Shared caches', path.join(root, 'home', '.cache')],
    ['tools', 'Prepared tool runtime', path.join(root, 'dev')],
    ['docker-storage', 'Docker guest backing storage', path.join(root, 'docker-worker')],
  ].map(([id, label, directory]) => ({ id, label, directory }));
}

function createStorageMonitor({ root = '/data/harness', capacityPath = '/data', roots = defaultRoots(root), readGuest = async () => null, io = fs, now = Date.now, sampleTtlMs = 10000, inventoryTtlMs = 300000, staleMs = 30000, maxEntries = 20000, maxDurationMs = 1500 } = {}) {
  if (!path.isAbsolute(capacityPath) || !Array.isArray(roots) || roots.length > 16 || roots.some(r => !path.isAbsolute(r.directory) || !/^[a-z][a-z0-9-]{0,40}$/.test(r.id))) throw Error('INVALID_STORAGE_CONFIGURATION');
  if (![sampleTtlMs, inventoryTtlMs, staleMs, maxEntries, maxDurationMs].every(n => Number.isSafeInteger(n) && n > 0) || maxEntries > 100000 || maxDurationMs > 10000) throw Error('INVALID_STORAGE_LIMITS');
  let host = empty('gpu-data', 'gpu-runtime', 'GPU runtime disk'), guest = null, inventoryAt = null, sampleAt = null, sampling = null, scanning = null, closed = false;
  function refresh() {
    if (closed) return;
    const at = now();
    if (!sampling && (sampleAt === null || at - sampleAt >= sampleTtlMs)) {
      sampleAt = at;
      sampling = Promise.allSettled([io.statfs(capacityPath, { bigint: true }), readGuest()]).then(([local, remote]) => {
        if (local.status === 'fulfilled') try { host = { ...host, ...filesystem(local.value), observedAt: now(), stale: false, errorCode: null }; } catch { host = { ...host, stale: true, errorCode: 'HOST_CAPACITY_UNKNOWN' }; }
        else host = { ...host, stale: true, errorCode: 'HOST_CAPACITY_UNKNOWN' };
        if (remote.status === 'fulfilled') guest = remote.value;
      }).finally(() => { sampling = null; });
    }
    if (!scanning && (inventoryAt === null || at - inventoryAt >= inventoryTtlMs)) {
      inventoryAt = at;
      scanning = scanCategories(roots, { io, now, maxEntries, maxDurationMs }).then(result => { host = { ...host, categories: result.categories, inventoryObservedAt: result.observedAt, inventoryLimits: result.limits, detailsTruncated: result.detailsTruncated }; }).catch(() => { host = { ...host, detailsTruncated: true }; }).finally(() => { scanning = null; });
    }
  }
  function snapshot() {
    refresh(); const at = now(), volumes = [{ ...host, stale: host.stale || host.observedAt === null || at - host.observedAt > staleMs, inventoryStale: !host.inventoryObservedAt || at - host.inventoryObservedAt > inventoryTtlMs * 2 }, guestVolume(guest, at, staleMs)];
    return { version: 1, observedAt: at, stale: volumes.some(v => v.stale), scanning: Boolean(scanning), volumes };
  }
  return { snapshot, settled: async () => { await Promise.all([sampling, scanning]); }, close: async () => { closed = true; await Promise.all([sampling, scanning]); } };
}
module.exports = { filesystem, scanCategories, guestVolume, createStorageMonitor, defaultRoots };
