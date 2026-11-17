'use strict';
const {hostExecutionBinding,executionBindingFixture}=require('./fixtures/execution-binding.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { ArchivedDockerCleanup, graph } = require('./apps-archived-cleanup.cjs'), { LABEL } = require('./apps-engine.cjs');
const pid = 'a'.repeat(16), cid = 'b'.repeat(64), image = 'sha256:' + 'c'.repeat(64), jobId = 'd'.repeat(16), token = 'e'.repeat(32), operationId = 'f'.repeat(32), sid = 'session-a';

test('mode invalidation during fresh resource capture prevents stop dispatch and a new action receipt',async t=>{
 const f=fixture(t),binding=executionBindingFixture('host-compat');f.manager.execution=binding.binding;f.source.containers[0].State={Running:true,Status:'running'};
 const inventory=await f.call({op:'inventory'}),preview=await f.call({op:'action',phase:'preview',action:'stop',kind:'container',id:cid,operationId,inventoryId:inventory.inventoryId}),capture=f.cleanup.capture;
 f.cleanup.capture=async(...args)=>{const value=await capture(...args);binding.fail();return value;};await assert.rejects(f.call({op:'action',phase:'apply',action:'stop',kind:'container',id:cid,operationId,planId:preview.plan.planId,planHash:preview.plan.planHash}),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
 assert.equal(f.calls.some(([method])=>method==='POST'),false);assert.equal(f.cleanup.data.resources.requests[operationId],undefined);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-controller-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'), record = { containerId: cid, projectId: pid, jobId, imageId: image, name: 'sdsh-' + pid + '-' + jobId, token, state: 'created', role: 'candidate' };
  const source = { authority: { sessions: [{ id: sid, root, managed: true }], archivedIds: [], activeIds: [], pinnedIds: [], workspaceRefs: [] }, projects: { [pid]: { id: pid, directory: root, name: 'Synthetic project', dataPolicy: { kind: 'stateless' } } }, jobs: [{ id: jobId, status: 'failed', creations: [record] }], releases: [], deployments: [], saved: { resumeIds: [] }, daemonId: 'synthetic-engine',
    containers: [{ Id: cid, Image: image, Name: '/' + record.name, Config: { Labels: { [LABEL]: 'managed', [LABEL + '.project']: pid, [LABEL + '.job']: jobId, [LABEL + '.create']: token } }, State: { Status: 'exited', Running: false }, Mounts: [] }],
    images: [{ Id: image, Parent: '', Size: 1024, RepoTags: ['stratadashseek-app:' + pid + '-' + jobId], Labels: { [LABEL]: 'managed', [LABEL + '.project']: pid, [LABEL + '.source']: '9'.repeat(64) } }] };
  const calls = [], manager = { execution:hostExecutionBinding(), cfg: { stateDir: directory, enabled: true }, store: { projects: source.projects, jobs: source.jobs }, busy: null, save() {}, engine: { async request(method, route) { calls.push([method, route]); if (method === 'DELETE') source.containers = []; else if (method === 'POST') { source.containers[0].State = { Status: 'exited', Running: false }; } }, async json() { return source.containers[0]; } } };
  const cleanup = new ArchivedDockerCleanup(manager); manager.archivedCleanup = cleanup;
  cleanup.authority = value => { assert.equal(value, token); return { ...source.authority, reservedIds: [sid] }; };
  cleanup.capture = async value => { cleanup.authority(value); return { availability: 'ready', ...graph(source), containers: structuredClone(source.containers) }; };
  const ctx = { scope: 'project', projectId: pid, sessionId: sid, token };
  const call = input => cleanup.resources({ ...ctx, ...input });
  return { cleanup, manager, source, calls, ctx, call };
}
test('paginated census includes inactive containers/images and scopes sessions without silently dropping pages', async t => {
  const f = fixture(t), first = await f.call({ op: 'inventory', limit: 1 });
  assert.equal(first.totalKnown, 2); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = await f.call({ op: 'inventory', limit: 1, cursor: first.nextCursor });
  assert.equal(second.inventoryId, first.inventoryId); assert.equal(second.items.length, 1); assert.notEqual(second.items[0].id, first.items[0].id); assert.equal(second.nextCursor, null);
  await assert.rejects(f.call({ op: 'inventory', limit: 1, q: 'changed', cursor: first.nextCursor }), { code: 'RESOURCE_CURSOR_STALE' });
  assert.equal((await f.call({ op: 'inventory', projectId: '0'.repeat(16), sessionId: 'other' })).items.length, 0);
});
test('delete uses existing reference/receipt path and same operation never repeats DELETE', async t => {
  const f = fixture(t), inventory = await f.call({ op: 'inventory' }), input = { op: 'action', phase: 'preview', action: 'delete', kind: 'container', id: cid, inventoryId: inventory.inventoryId, operationId };
  const { plan } = await f.call(input); assert.equal(plan.blocked, false); assert.match(plan.warning, /writable/);
  const request = { ...input, phase: 'apply', planId: plan.planId, planHash: plan.planHash };
  const result = await f.call(request); assert.equal(result.operation.state, 'completed'); await f.call(request); assert.equal(f.calls.filter(c => c[0] === 'DELETE').length, 1);
  await assert.rejects(f.call({ ...request, planHash: '0'.repeat(64) }), { code: 'RESOURCE_OPERATION_CONFLICT' });
  await assert.rejects(f.call({ op: 'inventory', operationId, projectId: '0'.repeat(16), sessionId: 'other' }), { code: 'RESOURCE_CONTEXT_MISMATCH' });
});
test('a newly published reference or active session invalidates deletion before the first mutation', async t => {
  const f = fixture(t), inventory = await f.call({ op: 'inventory' }), input = { op: 'action', phase: 'preview', action: 'delete', kind: 'container', id: cid, inventoryId: inventory.inventoryId, operationId };
  const { plan } = await f.call(input); f.source.projects[pid].containerId = cid;
  await assert.rejects(f.call({ ...input, phase: 'apply', planId: plan.planId, planHash: plan.planHash }), { code: 'CLEANUP_PLAN_STALE' }); assert.equal(f.calls.length, 0);
});
test('stop intent is durable before POST and unknown outcome reconciles without replay', async t => {
  const f = fixture(t); f.source.containers[0].State = { Status: 'running', Running: true };
  const inventory = await f.call({ op: 'inventory' }), input = { op: 'action', phase: 'preview', action: 'stop', kind: 'container', id: cid, inventoryId: inventory.inventoryId, operationId };
  const { plan } = await f.call(input); assert.equal(plan.blocked, false);
  f.manager.engine.request = async (method, route) => { f.calls.push([method, route]); assert.equal(JSON.parse(fs.readFileSync(f.cleanup.file)).operation.intent.action, 'stop'); f.source.containers[0].State = { Running: false, Status: 'exited' }; throw Error('lost response'); };
  const request = { ...input, phase: 'apply', planId: plan.planId, planHash: plan.planHash };
  assert.equal((await f.call(request)).operation.state, 'reconciliation_required'); assert.equal((await f.call(request)).operation.state, 'reconciliation_required'); assert.equal(f.calls.length, 1);
  assert.equal((await f.call({ op: 'inventory', operationId })).operation.state, 'completed'); assert.equal(f.calls.length, 1);
});
test('sleeping inventory is explicitly stale and cannot authorize mutation or claim a fresh census', async t => {
  const f = fixture(t); await f.call({ op: 'inventory' }); f.manager.cfg.enabled = false;
  const value = await f.call({ op: 'inventory' }); assert.equal(value.availability, 'disabled'); assert.equal(value.stale, true); assert.ok(value.items.every(r => r.actions.length === 0));
});

test('failed census refresh retains stale rows without fresh actions even when the daemon stays ready', async t => {
  const f = fixture(t), first = await f.call({ op: 'inventory', limit: 1 });
  f.cleanup.data.resources.snapshots[first.inventoryId].observedAt -= 11000;
  f.cleanup.capture = async () => ({ availability: 'unavailable', reasonCode: 'INVENTORY_INCOMPLETE', rows: [], binding: null });
  const failed = await f.call({ op: 'inventory', limit: 1 }); assert.equal(failed.availability, 'unavailable'); assert.equal(failed.stale, true); assert.equal(failed.items.length, 1); assert.deepEqual(failed.items[0].actions, []);
  const next = await f.call({ op: 'inventory', limit: 1, cursor: failed.nextCursor }); assert.equal(next.stale, true); assert.equal(next.availability, 'unavailable'); assert.deepEqual(next.items[0].actions, []);
});

test('export uses the existing job registry, authenticates download again and expires only its completed artifact', async t => {
  const f = fixture(t); let transfers = 0;
  const server = http.createServer((req, res) => { transfers++; assert.equal(req.url, '/images/' + encodeURIComponent(image) + '/get'); res.end('SYNTHETIC_IMAGE_ARCHIVE'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.manager.engine.connection = { hostname: '127.0.0.1', port: server.address().port }; f.manager.cfg.minFreeBytes = 0; f.manager.cfg.resourceExportMaxBytes = 1024;
  const inventory = await f.call({ op: 'inventory' }), input = { op: 'action', phase: 'preview', action: 'export', kind: 'image', id: image, inventoryId: inventory.inventoryId, operationId };
  const { plan } = await f.call(input); assert.equal(plan.format, 'docker-image-archive'); assert.equal(plan.includesVolumes, false); assert.equal(plan.blocked, false);
  const request = { ...input, phase: 'apply', planId: plan.planId, planHash: plan.planHash };
  const started = await f.call(request); assert.ok(started.operation.jobId); assert.equal(f.manager.store.jobs.at(-1).action, 'resource-export');
  await f.manager.resourceExportPending; assert.equal(f.manager.store.jobs.at(-1).status, 'passed'); assert.equal(f.manager.busy, null);
  const done = await f.call({ op: 'inventory', operationId }); assert.equal(done.operation.state, 'completed'); assert.equal(done.operation.export.includesRestoreConfig, false); assert.equal(done.operation.export.bytes, 23);
  await f.call(request); assert.equal(transfers, 1);
  assert.throws(() => f.cleanup.resourceDownload({ ...f.ctx, operationId, sessionId: 'other', projectId: '0'.repeat(16) }), { code: 'RESOURCE_CONTEXT_MISMATCH' });
  const download = f.cleanup.resourceDownload({ ...f.ctx, operationId }); const data = Buffer.alloc(download.bytes); fs.readSync(download.descriptor, data); fs.closeSync(download.descriptor); assert.equal(data.toString(), 'SYNTHETIC_IMAGE_ARCHIVE');
  f.cleanup.data.resources.requests[operationId].export.expiresAt = 0; await require('./apps-resources.cjs').expireResources(f.cleanup);
  assert.throws(() => f.cleanup.resourceDownload({ ...f.ctx, operationId }), { code: 'RESOURCE_EXPORT_UNAVAILABLE' });
  assert.equal(fs.existsSync(path.join(f.manager.cfg.stateDir, 'resource-exports', started.operation.jobId + '.tar')), false);
});

test('interrupted export cannot become completed through the legacy periodic reconcile path', async t => {
  const f = fixture(t), receipt = { operationId, planId: '7'.repeat(32), context: { scope: 'project', projectId: pid, sessionId: sid }, action: 'export', kind: 'image', id: image, state: 'running', ownerSessionIds: [sid] };
  f.cleanup.data.resources = { version: 1, snapshots: {}, plans: {}, requests: { [operationId]: receipt } }; f.cleanup.data.operation = { ...receipt, id: operationId, resourceAction: 'export' }; f.cleanup.save();
  const result = await f.cleanup.handle({ op: 'reconcile', token }); assert.equal(result.operation.state, 'failed'); assert.equal(result.operation.errorCode, 'RESOURCE_EXPORT_INTERRUPTED'); assert.equal(f.calls.length, 0);
});

test('reconciling a historical delete does not reconcile the latest resource export', async t => {
  const f = fixture(t), oldPlanId = '6'.repeat(32), oldOperationId = '8'.repeat(32), latestPlanId = '7'.repeat(32);
  const receipt = { operationId, planId: latestPlanId, context: { scope: 'project', projectId: pid, sessionId: sid }, action: 'export', kind: 'image', id: image, state: 'running', ownerSessionIds: [sid] };
  f.cleanup.data.receipts[oldPlanId] = { id: oldOperationId, planId: oldPlanId, state: 'completed', intent: null, results: [] };
  f.cleanup.data.resources = { version: 1, snapshots: {}, plans: {}, requests: { [operationId]: receipt } };
  f.cleanup.data.operation = { ...receipt, id: operationId, resourceAction: 'export' }; f.cleanup.save();
  const old = await f.cleanup.handle({ op: 'reconcile', token, planId: oldPlanId });
  assert.equal(old.operation.id, oldOperationId); assert.equal(receipt.state, 'running');
  const current = await f.cleanup.handle({ op: 'reconcile', token, planId: latestPlanId });
  assert.equal(current.operation.id, operationId); assert.equal(current.operation.state, 'failed');
});
