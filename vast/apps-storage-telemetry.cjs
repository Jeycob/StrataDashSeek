'use strict';
const safe = value => Number.isSafeInteger(value) && value >= 0;
function categoriesFromDiskUsage(value) {
  const row = (id, bytes, partial = false, shared = false) => ({ id, bytes: safe(bytes) ? bytes : null, partial: partial || !safe(bytes), shared });
  const sum = (rows, size) => Array.isArray(rows) && rows.length <= 1000 && rows.every(r => safe(size(r))) ? rows.reduce((n, r) => n + size(r), 0) : null;
  return [row('images', value?.LayersSize, false, true), row('containers', sum(value?.Containers, r => r.SizeRw)), row('volumes', sum(value?.Volumes, r => r.UsageData?.Size)), row('cache', sum(value?.BuildCache, r => r.Size), true, true)];
}
// Read-only, same Apps controller exclusion. Never ready/ensure/touch, never
// changes the idle clock. Cache shared BuildKit bytes are explicitly partial.
async function refreshStorage(manager, { now = Date.now, ttlMs = 300000 } = {}) {
  const worker = manager.worker, at = now();
  if (!manager.cfg.enabled || !worker || worker.phase !== 'ready' || worker.status().controlIsolation?.verified !== true || manager.busy || manager.ticking || manager.previewRequests || manager.serviceClosing || manager.sleepToken?.() || at - (manager.storageAttemptAt ?? -Infinity) < ttlMs) return;
  manager.storageAttemptAt = at; manager.busy = 'storage-inventory';
  try {
    await worker.diskFree();
    const result = await manager.engine.json('GET', '/system/df', { timeout: 4000, maxBytes: 2 * 1024 ** 2 });
    worker.storageCategories = categoriesFromDiskUsage(result); worker.storageCheckedAt = now();
  } catch { /* Preserve previous observation with its original timestamp. */ }
  finally { manager.busy = null; manager.heartbeat?.(); }
}
module.exports = { categoriesFromDiskUsage, refreshStorage };
