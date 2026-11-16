'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { createRuntimePlan } = require('./apps-project-runtime-policy.cjs');
const { createManagedContainer } = require('./apps-container-create.cjs');
const { startManagedContainer } = require('./apps-managed-resources.cjs');
const { supportedInfo, inspection } = require('./resource-fixture.cjs');
const image = 'sha256:' + 'a'.repeat(64), id = 'b'.repeat(64), generation = 'c'.repeat(32), authorityToken = 'd'.repeat(32);
function fixture(kind = 'executor') {
  const base = path.resolve('/synthetic-projects'), root = path.join(base, 'session-one'), metadata = new Map([[base, { ino: 1 }], [root, { ino: 2 }], [path.join(root, '.git'), { ino: 3 }]]);
  const filesystem = { realpathSync: p => { if (!metadata.has(p)) throw Error('SYNTHETIC_PATH_ABSENT'); return p; }, lstatSync: p => { const value = metadata.get(p); if (!value) throw Error('SYNTHETIC_PATH_ABSENT'); return { dev: 10, uid: 1001, gid: 1001, isDirectory: () => true, isSymbolicLink: () => false, ...value }; }, existsSync: p => metadata.has(p) };
  const context = { version: 1, op: kind === 'executor' ? 'execute' : 'ensure', kind, sessionId: 'session-one', projectRoot: root, readOnly: true, generation, ports: [21000, 21001, 21002, 21003] };
  const authority = { expiresAt: Date.now() + 300000, archivedIds: [], sessions: [{ id: context.sessionId, root, managed: true }], runtimeContext: context };
  const proof = { version: 1, verified: true, bootPid: 123, projectsRoot: base, guestProjectsRoot: '/srv/homeai/projects', hostDev: 10, hostIno: 1, uid: 1001, gid: 1001 };
  const job = { id: 'e'.repeat(16), status: 'running', creations: [] }, calls = [], m = { cfg: { projectRuntime: { enabled: true, projectsRoot: base, uid: 1001, gid: 1001, images: { executor: image, editor: image, relay: image } } }, worker: { status: () => ({ projectRuntimeIsolation: proof }), pid: () => 123 }, archivedCleanup: { authority: t => { if (t !== authorityToken) throw Error('AUTHORITY_TOKEN_INVALID'); return authority; } }, store: { jobs: [job], projects: {} }, log() {}, save() {} };
  const containers = new Map();
  m.engine = { async json(method, route, options) { calls.push([method, route]); if (route === '/info') return supportedInfo(); if (route.startsWith('/images/')) return { Id: image, Config: { User: '1001:1001' } }; if (method === 'POST' && route.startsWith('/containers/create')) { assert(job.creations[0].resourcePolicy); const c = inspection(id, options.json, new URL(route, 'http://synthetic').searchParams.get('name')); for(const key of ['Entrypoint','Cmd','Env','WorkingDir'])c.Config[key]=structuredClone(options.json[key]);c.Mounts = options.json.HostConfig.Mounts.map(v => ({ Type: v.Type, Source: v.Source, Destination: v.Target, RW: !v.ReadOnly, Propagation: v.BindOptions.Propagation })); containers.set(id, c); return { Id: id }; } throw Error('UNEXPECTED_ENGINE_CALL'); }, async owned() { return structuredClone(containers.get(id)); }, async request(method, route) { calls.push([method, route]); return { status: 204 }; } };
  const input = { op: context.op, kind, sessionId: context.sessionId, generation, token: authorityToken, ...(kind === 'executor' ? { command: 'printf synthetic' } : {}) };
  const plan = () => createRuntimePlan(m, input, { filesystem, guestPort: 18400 });
  const create = async p => { p ??= plan(); job.projectId = p.projectId; await createManagedContainer(m, job, p.body, { runtimeGrant: p.grant }); return p; };
  return { m, job, calls, containers, context, authority, proof, input, plan, create, metadata, root, filesystem };
}
test('runtime bind policy uses the existing durable journal and preserves owner read-only without exposing authority token', async () => {
  const f = fixture(), p = await f.create();
  assert.equal(p.body.HostConfig.NetworkMode, 'none'); assert.equal(p.body.HostConfig.Mounts[0].ReadOnly, true); assert.equal(p.body.User, '1001:1001');
  assert.deepEqual(p.body.Cmd, ['printf synthetic']); assert(!p.body.Env.some(v => /KEY|TOKEN|SECRET/.test(v)));
  await startManagedContainer(f.m, id); assert.equal(f.calls.filter(([method, route]) => method === 'POST' && route.endsWith('/start')).length, 1);
  assert(!JSON.stringify(f.m.store).includes(authorityToken));
});
test('forged input fields and JSON lookalike grants cannot authorize any bind or host-network access', async () => {
  const f = fixture();
  for (const extra of [{ projectRoot: '/foreign' }, { readOnly: false }, { ports: [1, 2, 3, 4] }, { guestPort: 2375 }]) assert.throws(() => createRuntimePlan(f.m, { ...f.input, ...extra }, { filesystem: f.filesystem }), { code: 'PROJECT_RUNTIME_REQUEST_INVALID' });
  const p = f.plan(); f.job.projectId = p.projectId;
  await assert.rejects(createManagedContainer(f.m, f.job, p.body, { runtimeGrant: {} }), { code: 'PROJECT_RUNTIME_BIND_GRANT_REQUIRED' });
  assert.equal(f.calls.length, 0);
  const g = fixture('relay'), relay = g.plan(); g.job.projectId = relay.projectId;
  await assert.rejects(createManagedContainer(g.m, g.job, relay.body), { code: 'MANAGED_RESOURCE_POLICY_INVALID' }); assert.equal(g.calls.length, 0);
});
test('read-only mount tampering after minting fails before consulting Docker', async () => {
  const f = fixture(), p = f.plan(); p.body.HostConfig.Mounts[0].ReadOnly = false; f.job.projectId = p.projectId;
  await assert.rejects(createManagedContainer(f.m, f.job, p.body, { runtimeGrant: p.grant }), { code: 'PROJECT_RUNTIME_BIND_GRANT_REQUIRED' }); assert.equal(f.calls.length, 0);
});
test('archive, context revocation, replaced host inode and changed VM boot invalidate the original start grant', async () => {
  for (const mutate of [f => f.authority.archivedIds.push(f.context.sessionId), f => { f.context.readOnly = false; }, f => f.metadata.set(f.root, { ino: 99 }), f => { f.proof.bootPid = 456; }]) {
    const f = fixture(); await f.create(); f.calls.length = 0; mutate(f); await assert.rejects(startManagedContainer(f.m, id)); assert(!f.calls.some(([method]) => method === 'POST'));
  }
});
test('actual bind or namespace differences cannot pass the managed start inspection', async () => {
  for (const mutate of [c => { c.Mounts[0].Source = '/foreign'; }, c => { c.Mounts[0].Destination = '/'; }, c => { c.Mounts[0].RW = true; }, c => { delete c.Mounts[0].RW; }, c => { c.Mounts[0].Propagation = 'shared'; }, c => { c.HostConfig.CgroupnsMode = 'host'; }, c => { c.HostConfig.PidMode = 'host'; }, c=>{c.Config.Cmd=['unexpected'];}, c=>{c.Config.Env.push('UNEXPECTED_SECRET=value');}]) {
    const f = fixture(); await f.create(); mutate(f.containers.get(id)); f.calls.length = 0;
    await assert.rejects(startManagedContainer(f.m, id), { code: 'MANAGED_RESOURCE_INSPECT_MISMATCH' }); assert(!f.calls.some(([method]) => method === 'POST'));
  }
});
test('trusted relay alone can use guest host networking with only its immutable fixed socket directory', async () => {
  const f = fixture('relay'), p = await f.create();
  assert.equal(p.body.HostConfig.NetworkMode, 'host'); assert.equal(p.body.HostConfig.Mounts.length, 2);
  assert.equal(p.body.HostConfig.Mounts[0].Target, '/run/homeai-editor'); assert.equal(p.body.HostConfig.Mounts[0].ReadOnly, true);
  assert.deepEqual(p.body.Cmd, ['--port', '18400']); await startManagedContainer(f.m, id);
});

test('one editor authority privately derives its relay with transport keys mounted only into relay', () => {
  const f = fixture('editor'), editor = f.plan();
  const relay = createRuntimePlan(f.m, f.input, { filesystem: f.filesystem, guestPort: 19180, component: 'relay' });
  assert.equal(relay.scopeId, editor.scopeId);
  assert.equal(relay.body.HostConfig.NetworkMode, 'host');
  assert(relay.body.HostConfig.Mounts.some(m => m.Target === '/run/homeai-transport' && m.ReadOnly));
  assert(!editor.body.HostConfig.Mounts.some(m => m.Target === '/run/homeai-transport'));
  assert(editor.body.Cmd.includes('0600'));
  assert.throws(() => createRuntimePlan(f.m, { ...f.input, component: 'relay' }, { filesystem: f.filesystem }), { code: 'PROJECT_RUNTIME_REQUEST_INVALID' });
  const x = fixture();
  assert.throws(() => createRuntimePlan(x.m, x.input, { filesystem: x.filesystem, component: 'relay' }), { code: 'PROJECT_RUNTIME_REQUEST_INVALID' });
});
test('a reconstructed manager cannot automatically resume a runtime using a historical grant', async () => {
  const f = fixture(); await f.create(); const replacement = { ...f.m, store: structuredClone(f.m.store) }; f.calls.length = 0;
  await assert.rejects(startManagedContainer(replacement, id), { code: 'PROJECT_RUNTIME_FRESH_AUTHORITY_REQUIRED' }); assert(!f.calls.some(([method]) => method === 'POST'));
});
