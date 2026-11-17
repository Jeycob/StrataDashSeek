'use strict';
const {isolatedExecutionBinding,executionBindingFixture}=require('./fixtures/execution-binding.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { ProjectRuntime, active, serverName } = require('./apps-project-runtime.cjs');
const { createRuntimePlan } = require('./apps-project-runtime-policy.cjs');
const { retainJobs } = require('./apps-container-create.cjs');
const { jobStatus } = require('./apps-job-status.cjs');
const { supportedInfo, inspection } = require('./resource-fixture.cjs');
const {enableEgressFixture}=require('./project-egress-fixture.cjs');
const image = 'sha256:' + 'a'.repeat(64), generation = 'c'.repeat(32), token = 'd'.repeat(32);
function fixture(kind = 'editor') {
  const base = path.resolve('/synthetic-projects'), root = path.join(base, 'session-one'), containers = new Map(), calls = [];
  const metadata = new Map([[base, 1], [root, 2], [path.join(root, '.git'), 3]]);
  const filesystem = { realpathSync: p => { if (!metadata.has(p)) throw Error('ABSENT'); return p; }, lstatSync: p => ({ dev: 10, ino: metadata.get(p), uid: 1001, gid: 1001, isDirectory: () => metadata.has(p), isSymbolicLink: () => false }), existsSync: p => metadata.has(p) };
  const context = { version: 1, op: kind === 'executor' ? 'execute' : 'ensure', kind, sessionId: 'session-one', projectRoot: root, readOnly: false, generation, ports: [21000,21001,21002,21003] };
  const authority = { expiresAt: Date.now() + 300000, archivedIds: [], sessions: [{ id: context.sessionId, root, managed: true }], runtimeContext: context };
  const proof = { version: 1, verified: true, bootPid: 123, projectsRoot: base, guestProjectsRoot: '/srv/homeai/projects', hostDev: 10, hostIno: 1, uid: 1001, gid: 1001 };
  const m = { execution:isolatedExecutionBinding(), cfg: { enabled: true, projectRuntime: { enabled: true, projectsRoot: base, uid: 1001, gid: 1001, images: { executor: image, editor: image, relay: image } } }, store: { jobs: [], projects: {} }, busy: null, save() {}, log() {}, replaceJobLog(job, text) { job.testOutput = text; }, heartbeat() {}, acceptActivity() {}, requireEnabled() {}, setBusy(value) { this.busy = value; }, async ready() {}, archivedCleanup: { authority(value) { assert.equal(value, token); return authority; } } };
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
  }, async runtimeLogs() { return {stdout:'bounded synthetic output\n',stderr:''}; } };
  const runtime = new ProjectRuntime(m, { plan: (manager, input, options) => createRuntimePlan(manager, input, { ...options, filesystem }) });
  const input = { op: context.op, kind, sessionId: context.sessionId, generation, token, stopToken: 's'.repeat(43), ...(kind === 'executor' ? { command: 'printf test' } : {}) };
  return { m, runtime, input, context, authority, calls, containers, filesystem };
}

test('changed mode refuses renewal and new creation while exact owned stop still settles every container',async()=>{
  const f=fixture(),binding=executionBindingFixture('isolated-guest');f.m.execution=binding.binding;
  const ready=await f.runtime.handle(f.input);assert.equal(ready.state,'ready');const starts=f.calls.filter(([m,r])=>m==='POST'&&r.endsWith('/start')).length;
  binding.fail();await assert.rejects(f.runtime.handle({...f.input,op:'touch'}),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
  await assert.rejects(f.runtime.handle({op:'stop',sessionId:f.input.sessionId,generation,stopToken:'t'.repeat(43)}),{code:'PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED'});
  const stopped=await f.runtime.handle({op:'stop',sessionId:f.input.sessionId,generation,stopToken:f.input.stopToken});assert.equal(stopped.state,'stopped');assert([...f.containers.values()].every(c=>c.State.Running===false));assert.equal(f.calls.filter(([m,r])=>m==='POST'&&r.endsWith('/start')).length,starts);
});
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
  assert.deepEqual(f.m.store.jobs[0].testOutput,{stdout:'bounded synthetic output\n',stderr:''}); assert(!active(f.m));
});
test('port assignments remain permanent and exhaustion does not reuse another project origin', () => {
  const f = fixture(); for(let n=0;n<64;n++)assert.equal(f.runtime.port(String(n)),19180+n);
  assert.equal(f.runtime.port('0'),19180); assert.throws(()=>f.runtime.port('new'),{code:'PROJECT_RUNTIME_PORT_POOL_FULL'});
});
test('editor lease expires independently of browser close and frees activity only after verified stop', async () => {
  const f = fixture(); f.runtime.pause = async () => {};
  const result = await f.runtime.handle(f.input), job = f.m.store.jobs[0];
  assert(job.projectRuntime.expiresAt <= Date.now()+300000);
  job.projectRuntime.expiresAt = Date.now()-1;
  await f.runtime.monitors.get(job.id);
  assert.equal(job.projectRuntime.state,'stopped'); assert.equal(job.error,'PROJECT_RUNTIME_EDITOR_EXPIRED'); assert(!active(f.m));
  await assert.rejects(f.runtime.touch({op:'touch',sessionId:result.sessionId,generation,stopToken:result.stopToken,token}),{code:'PROJECT_RUNTIME_EDITOR_EXPIRED'});
});
test('renewal needs fresh matching Native authority and cannot turn a read-only policy change into continued access', async () => {
  const f=fixture(),result=await f.runtime.handle(f.input),job=f.m.store.jobs[0];job.projectRuntime.expiresAt=Date.now()+1000;
  const touch={op:'touch',sessionId:result.sessionId,generation,stopToken:result.stopToken,token};
  const value=await f.runtime.touch(touch);assert(value.expiresAt>Date.now()+299000);assert.deepEqual(value.containerIds,result.containerIds);assert.equal(value.stopToken,result.stopToken);
  job.projectRuntime.hardDeadline=Date.now()+1500;const capped=await f.runtime.touch(touch);assert.equal(capped.expiresAt,job.projectRuntime.hardDeadline);
  f.context.readOnly=true;await assert.rejects(f.runtime.touch(touch),{code:'PROJECT_RUNTIME_AUTHORITY_REQUIRED'});
  await f.runtime.stop({op:'stop',sessionId:result.sessionId,generation,stopToken:result.stopToken});
});

test('stop-before-admission persists a tombstone across restart and prevents every delayed create',async()=>{
  const f=fixture(),stop={op:'stop',sessionId:f.input.sessionId,generation,stopToken:f.input.stopToken};let saved;
  f.m.save=()=>{saved=structuredClone(f.m.store);};const reply=await f.runtime.stop(stop);assert.equal(reply.state,'stopped');assert(saved.projectRuntimeIntents);assert(!JSON.stringify(saved).includes(f.input.stopToken));
  f.m.store=saved;const restarted=new ProjectRuntime(f.m,{plan:f.runtime.plan});
  await assert.rejects(restarted.handle(f.input),{code:'PROJECT_RUNTIME_GENERATION_ALREADY_RECORDED'});assert.equal(f.containers.size,0);
  assert.deepEqual(await restarted.stop(stop),reply);
  await assert.rejects(restarted.stop({...stop,stopToken:'x'.repeat(43)}),{code:'PROJECT_RUNTIME_STOP_AUTHORITY_REQUIRED'});
});

test('admission intent is durable before VM readiness and cancellation cannot acknowledge in-flight work',async()=>{
  const f=fixture('executor');let releaseReady,entered;const waiting=new Promise(r=>entered=r);
  f.m.ready=()=>{assert.equal(f.m.store.jobs.length,1);assert.equal(Object.keys(f.m.store.projectRuntimeIntents).length,1);entered();return new Promise(r=>releaseReady=r);};
  const pending=f.runtime.handle(f.input);pending.catch(()=>{});await waiting;
  const stop={op:'stop',sessionId:f.input.sessionId,generation,stopToken:f.input.stopToken};
  await assert.rejects(f.runtime.stop(stop),{code:'PROJECT_RUNTIME_BUSY'});assert(active(f.m));releaseReady();
  await assert.rejects(pending,{code:'PROJECT_RUNTIME_ADMISSION_CANCELLED'});assert.equal(f.containers.size,0);assert.equal((await f.runtime.stop(stop)).state,'stopped');assert(!active(f.m));
});

test('cancellation during a pending create retains busy until the exact partial container is inspected',async()=>{
  const f=fixture('executor');let releaseCreate,entered;const waiting=new Promise(r=>entered=r);
  f.m.onCreate=()=>{entered();return new Promise(r=>releaseCreate=r);};const pending=f.runtime.handle(f.input);pending.catch(()=>{});await waiting;
  const stop={op:'stop',sessionId:f.input.sessionId,generation,stopToken:f.input.stopToken};await assert.rejects(f.runtime.stop(stop),{code:'PROJECT_RUNTIME_BUSY'});
  releaseCreate();await assert.rejects(pending,{code:'PROJECT_RUNTIME_ADMISSION_CANCELLED'});assert(!f.calls.some(([,route])=>route.endsWith('/start')));assert.equal((await f.runtime.stop(stop)).state,'stopped');
});

test('a trimmed stopped job retains its generation fence and missing-cap admissions are refused',async()=>{
  const f=fixture('executor');f.m.onStart=c=>{c.State.Running=false;c.State.ExitCode=0;};const result=await f.runtime.handle(f.input);await f.runtime.monitors.get(result.jobId);
  f.m.store.jobs=[];await assert.rejects(f.runtime.handle(f.input),{code:'PROJECT_RUNTIME_GENERATION_ALREADY_RECORDED'});
  assert.equal((await f.runtime.stop({op:'stop',sessionId:f.input.sessionId,generation,stopToken:f.input.stopToken})).state,'stopped');
  await assert.rejects(f.runtime.handle({...f.input,stopToken:undefined}),{code:'PROJECT_RUNTIME_REQUEST_INVALID'});
});

test('tombstone capacity and durable-save failure never return a stopped acknowledgement',async()=>{
  const f=fixture(),stop={op:'stop',sessionId:f.input.sessionId,generation,stopToken:f.input.stopToken};
  f.m.store.projectRuntimeIntents=Object.fromEntries(Array.from({length:4096},(_,i)=>[String(i),{}]));
  await assert.rejects(f.runtime.stop(stop),{code:'PROJECT_RUNTIME_INTENT_REGISTRY_FULL'});assert.equal(Object.keys(f.m.store.projectRuntimeIntents).length,4096);
  f.m.store.projectRuntimeIntents={};f.m.save=()=>{throw Error('SYNTHETIC_DURABILITY_FAILURE');};await assert.rejects(f.runtime.stop(stop),/DURABILITY_FAILURE/);
});

test('executor exit is not terminal until its paired network capability is stopped and inspected',async()=>{
  const f=fixture('executor');enableEgressFixture(f);let entered,releaseStop;const stopping=new Promise(r=>entered=r);
  f.m.onStart=c=>{if(c.Config.Labels['io.stratadashseek.apps.role']==='project-executor'){c.State.Running=false;c.State.ExitCode=17;}};
  f.m.onStop=c=>{assert.equal(c.Config.Labels['io.stratadashseek.apps.role'],'project-egress');entered();return new Promise(r=>releaseStop=r);};
  const result=await f.runtime.handle(f.input);await stopping;const job=f.m.store.jobs[0];assert.equal(jobStatus(f.m,job.id).job.terminal,false);assert(active(f.m));assert.equal(job.creations.length,2);
  releaseStop();await f.runtime.monitors.get(result.jobId);assert.equal(jobStatus(f.m,job.id).job.exitCode,17);assert.equal(jobStatus(f.m,job.id).job.terminal,true);assert([...f.containers.values()].every(c=>!c.State.Running));assert(!active(f.m));
});

test('a lost proxy stop acknowledgement keeps executor outcome unresolved',async()=>{
  const f=fixture('executor');enableEgressFixture(f);f.m.onStart=c=>{if(c.Config.Labels['io.stratadashseek.apps.role']==='project-executor'){c.State.Running=false;c.State.ExitCode=0;}};f.m.onStop=()=>{throw Error('SYNTHETIC_LOST_PROXY_STOP');};
  const result=await f.runtime.handle(f.input);await f.runtime.monitors.get(result.jobId);assert.equal(f.m.store.jobs[0].projectRuntime.state,'reconciliation_required');assert.equal(f.m.store.jobs[0].exitCode,undefined);assert(active(f.m));
});

test('revoked acceptance after proxy start cannot admit the executor and stops the partial pair',async()=>{
  const f=fixture('executor'),evidence=enableEgressFixture(f);f.m.onStart=()=>{evidence.info.mode=0o666;};
  await assert.rejects(f.runtime.handle(f.input),{code:'PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED'});assert.equal(f.containers.size,1);assert([...f.containers.values()].every(c=>!c.State.Running));assert(!active(f.m));
});
