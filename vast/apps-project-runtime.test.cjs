'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { ProjectRuntime, active, serverName } = require('./apps-project-runtime.cjs');
const { createRuntimePlan } = require('./apps-project-runtime-policy.cjs');
const { retainJobs } = require('./apps-container-create.cjs');
const { jobStatus } = require('./apps-job-status.cjs');
const { supportedInfo, inspection } = require('./resource-fixture.cjs');
const image = 'sha256:' + 'a'.repeat(64), generation = 'c'.repeat(32), token = 'd'.repeat(32);
function fixture(kind = 'editor') {
  const base = path.resolve('/synthetic-projects'), root = path.join(base, 'session-one'), containers = new Map(), calls = [];
  const metadata = new Map([[base, 1], [root, 2], [path.join(root, '.git'), 3]]);
  const filesystem = { realpathSync: p => { if (!metadata.has(p)) throw Error('ABSENT'); return p; }, lstatSync: p => ({ dev: 10, ino: metadata.get(p), uid: 1001, gid: 1001, isDirectory: () => metadata.has(p), isSymbolicLink: () => false }), existsSync: p => metadata.has(p) };
  const context = { version: 1, op: kind === 'executor' ? 'execute' : 'ensure', kind, sessionId: 'session-one', projectRoot: root, readOnly: false, generation, ports: [21000,21001,21002,21003] };
  const authority = { expiresAt: Date.now() + 300000, archivedIds: [], sessions: [{ id: context.sessionId, root, managed: true }], runtimeContext: context };
  const proof = { version: 1, verified: true, bootPid: 123, projectsRoot: base, guestProjectsRoot: '/srv/homeai/projects', hostDev: 10, hostIno: 1, uid: 1001, gid: 1001 };
  const m = { cfg: { enabled: true, projectRuntime: { enabled: true, projectsRoot: base, uid: 1001, gid: 1001, images: { executor: image, editor: image, relay: image } } }, store: { jobs: [], projects: {} }, busy: null, save() {}, log() {}, replaceJobLog(job, text) { job.testOutput = text; }, heartbeat() {}, acceptActivity() {}, requireEnabled() {}, setBusy(value) { this.busy = value; }, async ready() {}, archivedCleanup: { authority(value) { assert.equal(value, token); return authority; } } };
  m.worker = { pid: () => 123, status: () => ({ projectRuntimeIsolation: proof }), async prepareProjectRuntime(input) { return { version: 1, mtls: true, ...input, serverName: serverName(input.scopeId, input.generation) }; }, async projectRuntimeHealth() { return true; } };
  m.engine = { async json(method, route, options) {
    calls.push([method, route]);
    if (route === '/info') return supportedInfo();
    if (route.startsWith('/images/')) return { Id: image, Config: { User: '1001:1001' } };
    if (method === 'POST' && route.startsWith('/containers/create')) {
      const id = String(containers.size + 1).repeat(64), c = inspection(id, options.json, new URL(route, 'http://local').searchParams.get('name'));
      for (const key of ['Entrypoint','Cmd','Env','WorkingDir']) c.Config[key] = structuredClone(options.json[key]);
      c.Mounts = options.json.HostConfig.Mounts.map(v => ({ Type: v.Type, Source: v.Source, Destination: v.Target, RW: !v.ReadOnly, Propagation: v.BindOptions.Propagation }));
      c.State = { Running: false, Status: 'created', StartedAt: '0001-01-01T00:00:00Z', ExitCode: 0 }; containers.set(id,c);
      await m.onCreate?.(c); return { Id: id };
    }
    if (method === 'GET' && /^\/containers\/.+\/json$/.test(route)) { const name = route.slice(12,-5), c = containers.get(name) || [...containers.values()].find(c => c.Name === '/' + name); if (!c) throw Object.assign(Error('ABSENT'), { dockerStatus: 404 }); return structuredClone(c); }
    throw Error('UNEXPECTED_ENGINE_CALL');
  }, async owned(id) { return structuredClone(containers.get(id)); }, async request(method, route) {
    calls.push([method,route]); const c = containers.get(route.split('/')[2]);
    if (route.endsWith('/start')) { c.State.Running = true; c.State.Status = 'running'; await m.onStart?.(c); return { status: 204 }; }
    if (route.includes('/stop?')) { await m.onStop?.(c); c.State.Running = false; c.State.Status = 'exited'; return { status: 204 }; }
    throw Error('UNEXPECTED_REQUEST');
  }, async logs() { return 'bounded synthetic output\n'; } };
  const runtime = new ProjectRuntime(m, { plan: (manager, input, options) => createRuntimePlan(manager, input, { ...options, filesystem }) });
  const input = { op: context.op, kind, sessionId: context.sessionId, generation, token, ...(kind === 'executor' ? { command: 'printf test' } : {}) };
  return { m, runtime, input, context, authority, calls, containers };
}
test('editor is READY only after both journaled containers and authenticated health; only hashed stop authority persists', async () => {
  const f = fixture(), result = await f.runtime.handle(f.input);
  assert.equal(result.state, 'ready'); assert.equal(result.transport.hostPort, 19180); assert.equal(result.transport.mtls, true);
  assert.equal(Object.keys(result.containerIds).length, 2); assert.equal(f.m.store.jobs[0].creations.length, 2);
  assert(!JSON.stringify(f.m.store).includes(result.stopToken)); assert(!JSON.stringify(f.m.store).includes(token)); assert(active(f.m));
  assert.match(result.operationId,/^[a-f0-9]{32}$/); assert.match(result.stopToken,/^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(f.runtime.stop({ op: 'stop', sessionId: result.sessionId, generation, stopToken: 'x'.repeat(43) }), { code: 'PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED' });
  const stopped = await f.runtime.stop({ op: 'stop', sessionId: result.sessionId, generation, stopToken: result.stopToken });
  assert.equal(stopped.state, 'stopped'); assert(!active(f.m)); assert([...f.containers.values()].every(c => !c.State.Running));
});
test('abort after create prevents start and stops the exact recorded partial operation', async () => {
  const f = fixture(), controller = new AbortController(); f.m.onCreate = () => controller.abort();
  await assert.rejects(f.runtime.handle(f.input,{signal:controller.signal}), {code:'PROJECT_RUNTIME_ADMISSION_CANCELLED'});
  assert.equal(f.m.store.jobs[0].projectRuntime.state,'stopped'); assert(!f.calls.some(([,route])=>route.endsWith('/start')));
});
test('archive during first start revokes further admission and stops the first container before replying', async () => {
  const f = fixture(); f.m.onStart = () => f.authority.archivedIds.push(f.input.sessionId);
  await assert.rejects(f.runtime.handle(f.input), {code:'PROJECT_RUNTIME_AUTHORITY_REQUIRED'});
  assert.equal(f.containers.size,1); assert([...f.containers.values()].every(c=>!c.State.Running)); assert(!active(f.m));
});
test('lost start acknowledgement stays unresolved even after successful stop and retains journal beyond 100 jobs', async () => {
  const f = fixture(); f.m.onStart = () => { throw Error('LOST_ACK'); };
  await assert.rejects(f.runtime.handle(f.input), {code:'PROJECT_RUNTIME_RECONCILIATION_REQUIRED'});
  const job = f.m.store.jobs[0]; assert.equal(job.projectRuntime.state,'reconciliation_required'); assert(active(f.m));
  assert.equal(job.creations[0].resourceStart.state,'unknown'); assert([...f.containers.values()].every(c=>!c.State.Running));
  assert(retainJobs([job,...Array.from({length:101},(_,n)=>({id:String(n)}))]).includes(job));
});
test('transport identity mismatch prevents every container create and reveals no ready endpoint', async () => {
  const f = fixture(); f.m.worker.prepareProjectRuntime = async () => ({version:1,mtls:false});
  await assert.rejects(f.runtime.handle(f.input), {code:'PROJECT_RUNTIME_TRANSPORT_UNVERIFIED'});
  assert.equal(f.containers.size,0); assert(!active(f.m));
});
test('failed stop inspection retains reconciliation and cannot return stopped', async () => {
  const f = fixture(), result = await f.runtime.handle(f.input); f.m.onStop = () => { throw Error('STOP_LOST'); };
  await assert.rejects(f.runtime.stop({op:'stop',sessionId:result.sessionId,generation,stopToken:result.stopToken}),{code:'PROJECT_RUNTIME_RECONCILIATION_REQUIRED'});
  assert(active(f.m));
});
test('executor uses existing job terminal status and retains a real nonzero exit code', async () => {
  const f = fixture('executor'); f.m.onStart = c => { c.State.Running=false;c.State.ExitCode=17; };
  const result = await f.runtime.handle(f.input); await f.runtime.monitors.get(result.jobId);
  const status = jobStatus(f.m,result.jobId); assert.equal(status.job.status,'failed'); assert.equal(status.job.exitCode,17); assert.equal(status.job.terminal,true);
  assert.equal(f.m.store.jobs[0].testOutput,'bounded synthetic output\n'); assert(!active(f.m));
});
test('port assignments remain permanent and exhaustion does not reuse another project origin', () => {
  const f = fixture(); for(let n=0;n<64;n++)assert.equal(f.runtime.port(String(n)),19180+n);
  assert.equal(f.runtime.port('0'),19180); assert.throws(()=>f.runtime.port('new'),{code:'PROJECT_RUNTIME_PORT_POOL_FULL'});
});
