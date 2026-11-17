'use strict';
// Resource management is an extension of ArchivedDockerCleanup, using its
// capture authority, controller exclusion, reference graph and durable journal.
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { writeArchive } = require('./apps-resource-archive.cjs');
const {assertAppsExecution}=require('./apps-execution-mode.cjs');
const TOKEN = /^[a-f0-9]{32}$/, CID = /^[a-f0-9]{64}$/, IMAGE = /^sha256:[a-f0-9]{64}$/, PID = /^[a-f0-9]{16}$/;
const fail = (code, status = 409) => Object.assign(Error(code), { code, status });
const pending = operation => operation && ['queued', 'running', 'reconciliation_required'].includes(operation.state);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = row => row.kind + ':' + row.id;
function state(cleanup) { return cleanup.data.resources ??= { version: 1, snapshots: {}, plans: {}, requests: {} }; }
function syncOperation(cleanup, receipt) { Object.assign(cleanup.data.operation, receipt, { id: receipt.operationId, resourceId: receipt.id }); }
function context(input) {
  if (input.scope === 'global' && input.projectId === undefined && input.sessionId === undefined) return { scope: 'global', projectId: null, sessionId: null };
  if (input.scope !== 'project' || !PID.test(input.projectId || '') || typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) throw fail('RESOURCE_CONTEXT_REQUIRED', 403);
  return { scope: 'project', projectId: input.projectId, sessionId: input.sessionId };
}
function owns(row, ctx) { return ctx.scope === 'global' || row.projectIds.includes(ctx.projectId) && row.sessionIds.includes(ctx.sessionId); }
function authorizeReceipt(receipt, ctx) { if (ctx.scope !== 'global' && (receipt.context.projectId !== ctx.projectId || receipt.context.sessionId !== ctx.sessionId)) throw fail('RESOURCE_CONTEXT_MISMATCH', 403); }
function available(cleanup) { const [status, reason] = cleanup.availability(); return status === 'ready' ? 'ready' : reason === 'DOCKER_ASLEEP' ? 'sleeping' : !cleanup.manager.cfg.enabled ? 'disabled' : 'unavailable'; }
function actions(row, ctx, snapshot) {
  if (snapshot.availability !== 'ready' || row.reasonCodes.some(code => ['OWNER_UNKNOWN', 'REFERENCE_UNKNOWN', 'INFLIGHT_REFERENCE', 'SESSION_ACTIVE'].includes(code))) return [];
  const result = [], shared = row.reasonCodes.includes('OWNER_SHARED'), container = snapshot.containers?.find(c => c.Id === row.id);
  if (row.eligible && !row.afterContainerIds.length) result.push('delete');
  if (row.kind === 'container' && container?.State?.Running === true && !shared) result.push('stop');
  if ((!shared || ctx.scope === 'global') && (row.kind === 'image' || container?.State?.Running === false && !container?.State?.Paused && !container?.State?.Restarting)) result.push('export');
  return result;
}
function item(row, ctx, snapshot) {
  const container = snapshot.containers?.find(c => c.Id === row.id), allowed = actions(row, ctx, snapshot);
  return { kind: row.kind, id: row.id, name: row.displayName, state: row.kind === 'image' ? 'available' : container?.State?.Status ?? 'unknown', sizeBytes: row.sizeBytes, sizeKind: row.kind === 'image' ? 'virtual-image' : 'unknown',
    projectIds: ctx.scope === 'global' ? row.projectIds : [ctx.projectId], sessionIds: ctx.scope === 'global' ? row.sessionIds : [ctx.sessionId], shared: row.reasonCodes.includes('OWNER_SHARED'), protected: !allowed.includes('delete'), reasons: row.reasonCodes, actions: allowed };
}
function planView(plan) { const { planId, planHash, expiresAt, action, kind, id, blocked, reasons, warning, format } = plan; return { planId, planHash, expiresAt, action, kind, id, blocked, reasons, warning, ...(format ? { format } : {}), includesVolumes: false, includesRestoreConfig: false }; }
function operationView(cleanup, receipt) {
  const operation = receipt.action === 'delete' ? cleanup.data.receipts[receipt.planId] ?? receipt : receipt;
  const exportValue = receipt.export && { format: receipt.export.format, includesVolumes: false, includesRestoreConfig: false, bytes: receipt.export.bytes, expiresAt: receipt.export.expiresAt };
  return { operationId: receipt.operationId, planId: receipt.planId, state: operation?.state ?? 'queued', ...(receipt.jobId ? { jobId: receipt.jobId } : {}), errorCode: operation?.errorCode ?? null, ...(exportValue ? { export: exportValue } : {}), ...(operation?.results ? { results: operation.results } : {}) };
}
async function locked(cleanup, action) {
  const m = cleanup.manager;
  assertAppsExecution(m);
  if (m.busy || m.ticking || m.previewRequests || m.serviceClosing || m.sleepToken?.()) throw fail('RESOURCE_BUSY');
  m.busy = 'docker-resources'; try { m.heartbeat?.(); return await action(); } finally { m.busy = null; m.heartbeat?.(); }
}
async function snapshot(cleanup, token, paging = false) {
  assertAppsExecution(cleanup.manager);
  const data = state(cleanup), cached = data.snapshots[data.latest];
  if (cached && (paging || Date.now() - cached.observedAt < 10000)) return { ...cached, availability: cached.availability === 'ready' ? available(cleanup) : cached.availability };
  const captured = await cleanup.capture(token);
  assertAppsExecution(cleanup.manager);
  if (captured.availability === 'ready') {
    const value = { ...captured, observedAt: Date.now(), inventoryId: hash([captured.binding, Date.now(), crypto.randomBytes(8).toString('hex')]) };
    data.snapshots = { [value.inventoryId]: value }; data.latest = value.inventoryId; cleanup.save(); return value;
  }
  const old = data.snapshots[data.latest], current = available(cleanup);
  const failed = { ...(old ?? { rows: [], containers: [], inventoryId: null, observedAt: null }), availability: current === 'ready' ? 'unavailable' : current, binding: null, reasonCode: captured.reasonCode };
  // A reachable/configured daemon is not evidence of a complete census. Keep
  // the prior observation explicitly stale after a failed refresh, including
  // subsequent requests for its remaining pages.
  if (old) { data.snapshots[data.latest] = failed; cleanup.save(); }
  return failed;
}
function requireTarget(input) { if (!['container', 'image'].includes(input.kind) || !(input.kind === 'container' ? CID : IMAGE).test(input.id || '') || !['stop', 'delete', 'export'].includes(input.action) || !TOKEN.test(input.operationId || '')) throw fail('RESOURCE_REQUEST_INVALID', 400); }
function initMethods(Controller) {
  Controller.prototype.resources = async function(input) {
    assertAppsExecution(this.manager);
    const ctx = context(input), data = state(this); this.authority(input.token);
    if (input.operationId && input.op === 'inventory') {
      const receipt = data.requests[input.operationId]; if (!receipt) throw fail('RESOURCE_OPERATION_NOT_FOUND', 404); authorizeReceipt(receipt, ctx);
      if (receipt.action === 'delete') { if (this.data.receipts[receipt.planId]) await this.handle({ op: 'reconcile', token: input.token, planId: receipt.planId }); else { receipt.state = 'failed'; receipt.errorCode = 'RESOURCE_SUBMISSION_INTERRUPTED'; this.save(); } }
      else if (pending(receipt) && this.manager.busy !== receipt.jobId) await reconcile(this, receipt, input.token);
      return { version: 1, context: ctx, operation: operationView(this, receipt) };
    }
    if (input.op === 'inventory') return locked(this, async () => {
      await sweepExports(this);
      const s = await snapshot(this, input.token, Boolean(input.cursor)), kind = input.kind ?? 'all', q = typeof input.q === 'string' ? input.q.slice(0, 80).toLowerCase() : '', limit = input.limit === undefined ? 50 : Number(input.limit);
      if (!['all', 'image', 'container'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('RESOURCE_REQUEST_INVALID', 400);
      const fingerprint = hash([s.inventoryId, ctx, kind, q, input.state ?? 'all']); let offset = 0;
      if (input.cursor) { let cursor; try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); } catch { throw fail('RESOURCE_CURSOR_INVALID', 400); } if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw fail('RESOURCE_CURSOR_STALE'); offset = cursor.offset; }
      const rows = s.rows.filter(r => owns(r, ctx) && (kind === 'all' || r.kind === kind)).map(r => item(r, ctx, s)).filter(r => (!q || (r.name + ' ' + r.id).toLowerCase().includes(q)) && (!input.state || input.state === 'all' || r.state === input.state));
      return { version: 1, context: ctx, availability: s.availability, observedAt: s.observedAt, stale: s.availability !== 'ready' || Date.now() - s.observedAt > 30000, inventoryId: s.inventoryId, items: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? Buffer.from(JSON.stringify({ fingerprint, offset: offset + limit })).toString('base64url') : null, totalKnown: rows.length, operation: null };
    });
    if (input.op !== 'action') throw fail('RESOURCE_REQUEST_INVALID', 400); requireTarget(input);
    if (!['preview', 'apply'].includes(input.phase)) throw fail('RESOURCE_REQUEST_INVALID', 400);
    const previous = data.requests[input.operationId];
    if (previous) { authorizeReceipt(previous, ctx); if (previous.action !== input.action || previous.kind !== input.kind || previous.id !== input.id || input.phase === 'apply' && (previous.planId !== input.planId || previous.planHash !== input.planHash)) throw fail('RESOURCE_OPERATION_CONFLICT'); return { version: 1, context: ctx, operation: operationView(this, previous) }; }
    if (Object.keys(data.requests).length >= 512) throw fail('RESOURCE_RECEIPT_CAPACITY');
    if (input.phase === 'preview') return locked(this, async () => {
      if (pending(this.data.operation)) throw fail('CLEANUP_RECONCILIATION_REQUIRED');
      const existing = data.snapshots[input.inventoryId]; if (!existing || Date.now() - existing.observedAt > 300000) throw fail('RESOURCE_INVENTORY_STALE');
      const fresh = await this.capture(input.token), row = fresh.rows?.find(r => key(r) === key(input));
      assertAppsExecution(this.manager);
      if (!row || !owns(row, ctx)) throw fail('RESOURCE_CONTEXT_MISMATCH', 403);
      const allowed = actions(row, ctx, fresh).includes(input.action), plan = { planId: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + 300000, createdAt: Date.now(), action: input.action, kind: input.kind, id: input.id, context: ctx, binding: fresh.binding, ownerSessionIds: row.sessionIds,
        blocked: !allowed, reasons: allowed ? [] : [...row.reasonCodes, 'RESOURCE_ACTION_PROTECTED'], warning: input.action === 'delete' && input.kind === 'container' ? 'Deletes the container writable filesystem. Volumes are retained; published and recovery generations are protected.' : input.action === 'delete' ? 'Deletes this unused image; no volumes are deleted.' : input.action === 'export' ? (input.kind === 'image' ? 'Archive contains image layers and image metadata. Volumes and full application restore configuration are not included.' : 'Archive contains the container filesystem only. Volumes and container restore configuration are not included.') : 'Stops this exact container; no other process is stopped.', ...(input.action === 'export' ? { format: input.kind === 'image' ? 'docker-image-archive' : 'container-filesystem' } : {}) };
      plan.planHash = hash(plan); data.plans[plan.planId] = plan;
      // Delete plans use exactly the existing cleanup controller's schema and
      // apply path. Nothing here calls generic Docker DELETE.
      if (input.action === 'delete' && allowed) { const p = { id: plan.planId, createdAt: plan.createdAt, expiresAt: plan.expiresAt, rows: fresh.rows, selection: [{ kind: input.kind, id: input.id }], availability: fresh.availability, binding: fresh.binding, automatic: false }; p.hash = require('./apps-archived-cleanup.cjs').hash(p); plan.planHash = p.hash; this.data.plans[p.id] = p; }
      cleanupPlans(data); this.save(); return { version: 1, context: ctx, plan: planView(plan), operation: null };
    });
    const plan = data.plans[input.planId]; if (!plan || plan.planHash !== input.planHash || plan.expiresAt <= Date.now() || plan.blocked || plan.action !== input.action || plan.kind !== input.kind || plan.id !== input.id || hash(plan.context) !== hash(ctx)) throw fail('RESOURCE_PLAN_STALE');
    const grant = this.authority(input.token); if (plan.ownerSessionIds.some(id => !grant.reservedIds?.includes(id))) throw fail('CLEANUP_AUTHORITY_REQUIRED', 403);
    if (plan.action === 'delete') {
      const receipt = { operationId: input.operationId, planId: plan.planId, planHash: plan.planHash, context: ctx, action: plan.action, kind: plan.kind, id: plan.id }; data.requests[input.operationId] = receipt; this.save();
      try { await this.handle({ op: 'apply', token: input.token, planId: plan.planId, planHash: plan.planHash, selections: [{ kind: plan.kind, id: plan.id }], trigger: 'manual' }); }
      catch (e) { if (!this.data.receipts[plan.planId]) { delete data.requests[input.operationId]; this.save(); } throw e; }
      return { version: 1, context: ctx, operation: operationView(this, receipt) };
    }
    return locked(this, async () => {
      if (pending(this.data.operation)) throw fail('CLEANUP_RECONCILIATION_REQUIRED');
      const fresh = await this.capture(input.token), row = fresh.rows?.find(r => key(r) === key(plan));
      assertAppsExecution(this.manager);
      if (fresh.binding !== plan.binding || !row || !owns(row, ctx) || !actions(row, ctx, fresh).includes(plan.action)) throw fail('RESOURCE_PLAN_STALE');
      const receipt = { operationId: input.operationId, planId: plan.planId, planHash: plan.planHash, context: ctx, action: plan.action, kind: plan.kind, id: plan.id, state: 'running', ownerSessionIds: plan.ownerSessionIds, startedAt: Date.now(), finishedAt: null, results: [], errorCode: null };
      data.requests[input.operationId] = receipt; this.data.operation = { ...receipt, id: input.operationId, resourceAction: plan.action }; this.save();
      if (plan.action === 'stop') {
        this.data.operation.intent = { kind: plan.kind, id: plan.id, action: 'stop' }; this.save();
        try { assertAppsExecution(this.manager);await this.manager.engine.request('POST', '/containers/' + plan.id + '/stop?t=10'); await this.manager.worker?.remember(); receipt.state = 'completed'; receipt.finishedAt = Date.now(); this.data.operation.intent = null; }
        catch { receipt.state = 'reconciliation_required'; receipt.errorCode = 'RESOURCE_STOP_OUTCOME_UNKNOWN'; }
        syncOperation(this, receipt); this.save();
      } else {
        const job = { id: crypto.randomBytes(8).toString('hex'), projectId: row.projectIds.length === 1 ? row.projectIds[0] : undefined, action: 'resource-export', status: 'queued', startedAt: Date.now() }; receipt.jobId = job.id;
        this.manager.store.jobs.push(job); this.manager.save(); this.save();
        // Start after the synchronous controller lock is released. The durable
        // operation reserves its session family throughout archive creation.
        this.manager.resourceExportPending = new Promise(resolve => setImmediate(resolve)).then(() => exportResource(this, receipt, plan, job)).finally(() => { this.manager.resourceExportPending = null; });
      }
      return { version: 1, context: ctx, operation: operationView(this, receipt) };
    });
  };
  Controller.prototype.resourceDownload = function(input) {
    assertAppsExecution(this.manager);
    const ctx = context(input), receipt = state(this).requests[input.operationId]; this.authority(input.token);
    if (!receipt) throw fail('RESOURCE_OPERATION_NOT_FOUND', 404); authorizeReceipt(receipt, ctx);
    if (receipt.state !== 'completed' || !receipt.export || receipt.export.expiresAt <= Date.now()) throw fail('RESOURCE_EXPORT_UNAVAILABLE', 410);
    const file = archivePath(this, receipt.jobId), descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)), stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== receipt.export.bytes) { fs.closeSync(descriptor); throw fail('RESOURCE_EXPORT_CHANGED'); }
    return { descriptor, bytes: stat.size, filename: receipt.kind + '-' + receipt.jobId + '.tar', format: receipt.export.format };
  };
}
function cleanupPlans(data) { for (const [id, plan] of Object.entries(data.plans)) if (plan.expiresAt <= Date.now()) delete data.plans[id]; if (Object.keys(data.plans).length > 32) delete data.plans[Object.keys(data.plans)[0]]; }
function archivePath(cleanup, id) { if (!/^[a-f0-9]{16}$/.test(id || '')) throw fail('RESOURCE_EXPORT_UNAVAILABLE'); return path.join(cleanup.manager.cfg.stateDir, 'resource-exports', id + '.tar'); }
async function exportResource(cleanup, receipt, plan, job) {
  const m = cleanup.manager; if (m.busy) { receipt.state = 'failed'; receipt.errorCode = 'RESOURCE_BUSY'; receipt.finishedAt = Date.now(); job.status = 'failed'; job.endedAt = receipt.finishedAt; syncOperation(cleanup, receipt); cleanup.save(); m.save(); return; }
  m.busy = job.id; job.status = 'running'; m.save(); m.heartbeat?.();
  const directory = path.join(m.cfg.stateDir, 'resource-exports'), file = archivePath(cleanup, job.id);
  try {
    assertAppsExecution(m);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 }); const stat = await fsp.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(directory) !== path.resolve(directory)) throw fail('RESOURCE_EXPORT_DIRECTORY_UNSAFE');
    const result = await writeArchive(m.engine, plan.kind === 'image' ? '/images/' + encodeURIComponent(plan.id) + '/get' : '/containers/' + plan.id + '/export', file, { maxBytes: m.cfg.resourceExportMaxBytes ?? 512 * 1024 ** 2, reserveBytes: m.cfg.minFreeBytes ?? 2 * 1024 ** 3,assertCurrent:()=>assertAppsExecution(m) });
    receipt.export = { ...result, format: plan.format, includesVolumes: false, includesRestoreConfig: false, expiresAt: Date.now() + 15 * 60000 }; receipt.state = 'completed'; job.status = 'passed'; job.resourceExport = { operationId: receipt.operationId, ...receipt.export };
  } catch (e) { receipt.state = 'failed'; receipt.errorCode = /^RESOURCE_[A-Z_]+$/.test(e.code || '') ? e.code : 'RESOURCE_EXPORT_FAILED'; job.status = 'failed'; job.error = receipt.errorCode; }
  finally { receipt.finishedAt = Date.now(); job.endedAt = Date.now(); syncOperation(cleanup, receipt); cleanup.data.operation.intent = null; cleanup.save(); m.save(); m.busy = null; m.heartbeat?.(); }
}
async function reconcile(cleanup, receipt, token) {
  if (receipt.action === 'export') {
    if (cleanup.manager.resourceExportPending) return;
    if (receipt.jobId) await fsp.unlink(archivePath(cleanup, receipt.jobId)).catch(e => { if (e.code !== 'ENOENT') throw e; }); receipt.state = 'failed'; receipt.errorCode = 'RESOURCE_EXPORT_INTERRUPTED';
    const job = cleanup.manager.store.jobs.find(j => j.id === receipt.jobId); if (job) { job.status = 'interrupted'; job.error = receipt.errorCode; job.endedAt = Date.now(); cleanup.manager.save(); }
  } else if (receipt.action === 'stop') {
    if (available(cleanup) !== 'ready') return;
    await locked(cleanup, async () => { cleanup.authority(token); const current = await cleanup.manager.engine.json('GET', '/containers/' + receipt.id + '/json'); if (current.State?.Running === false) { await cleanup.manager.worker?.remember(); receipt.state = 'completed'; receipt.errorCode = null; } });
  }
  if (!pending(receipt)) { receipt.finishedAt = Date.now(); if (cleanup.data.operation?.operationId === receipt.operationId) { syncOperation(cleanup, receipt); cleanup.data.operation.intent = null; } cleanup.save(); }
}
async function sweepExports(cleanup) {
  for (const receipt of Object.values(state(cleanup).requests)) if (receipt.export?.expiresAt <= Date.now() && !receipt.export.expired && receipt.jobId && !pending(receipt)) {
    await fsp.unlink(archivePath(cleanup, receipt.jobId)).catch(e => { if (e.code !== 'ENOENT') throw e; }); receipt.export.expired = true; cleanup.save();
  }
}
async function expireResources(cleanup) {
  if (!cleanup.data.resources || pending(cleanup.data.operation)) return;
  const m = cleanup.manager; if (m.busy || m.ticking || m.previewRequests || m.serviceClosing || m.sleepToken?.()) return;
  await locked(cleanup, () => sweepExports(cleanup));
}
module.exports = { initMethods, context, actions, item, operationView, sweepExports, expireResources };
