import { hostExecutionBinding, isolatedExecutionBinding, executionBindingFixture } from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { createRuntimeCapabilities, runtimeCapabilitiesFallback, isolatedRuntimeCapabilitiesFallback } from './runtime-capabilities.mjs';

const root = path.resolve('/capability-test/workspaces'), project = path.join(root, 'projects', 'own'), id = 'a'.repeat(16), otherId = 'b'.repeat(16), cid = 'c'.repeat(64), MIB = 1024 ** 2;

test('capability mode requires a trusted binding, never a config string or Apps availability',async()=>{
  assert.throws(()=>createRuntimeCapabilities({workspaceRoot:root,executionMode:'host-compat'}),{code:'PROJECT_EXECUTION_BINDING_REQUIRED'});
  const host=await fixture({state:ownState(),executionMode:'isolated-guest'}).service.snapshot(project);assert.equal(host.version,1);assert(Array.isArray(host.recipes.verify));
  const guest=fixture({state:{enabled:false,available:false,projects:[]}},isolatedExecutionBinding());const value=await guest.service.snapshot(project);assert.equal(value.version,2);assert.equal(value.apps.state,'configured');assert.deepEqual(value.recipes.register,{tool:'project_apps',arguments:{operation:'register'}});assert.doesNotMatch(guest.service.renderContext(project),/apps-cli\.cjs|\/data\/harness/);
});

test('isolated recipes are typed, project scoped and contain no host CLI authority',async()=>{
  const job='d'.repeat(16),f=fixture({state:ownState({jobs:[{id:job,projectId:id,action:'verify',status:'running'}]})},isolatedExecutionBinding()),value=await f.service.snapshot(project);
  assert.deepEqual(value.recipes.verify_deploy,{tool:'project_apps',arguments:{operation:'verify_deploy'}});assert.equal(value.recipes.verify,undefined);assert.equal(value.version,2);
  assert.deepEqual(value.jobTracking.jobs,[{id:job,status:{tool:'project_apps',arguments:{operation:'job_status',jobId:job}},logs:{tool:'project_apps',arguments:{operation:'job_log',jobId:job}}}]);
  assert.equal(value.verificationRecipes.documentation,'/opt/homeai/quality/README.md');assert.equal(value.jobTracking.repeatSubmission,false);assert.doesNotMatch(JSON.stringify(value),/apps-cli\.cjs|\/data\/harness/);assert.doesNotMatch(isolatedRuntimeCapabilitiesFallback,/apps-cli\.cjs|\/data\/harness/);
});

for(const mode of ['host-compat','isolated-guest'])test('stale '+mode+' binding cannot return cached or pending capability results',async()=>{
  const b=executionBindingFixture(mode),f=fixture({state:ownState()},b.binding);await f.service.snapshot(project);b.fail();await assert.rejects(f.service.snapshot(project),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.throws(()=>f.service.renderContext(project),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
  const pendingBinding=executionBindingFixture(mode);let entered,finish;const started=new Promise(resolve=>entered=resolve),g=fixture({readAppsState:()=>{entered();return new Promise(resolve=>finish=resolve);}},pendingBinding.binding),pending=g.service.snapshot(project);await started;pendingBinding.fail();finish(ownState());await assert.rejects(pending,{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
});

test('mode change during filesystem metadata wait stops before another read',async()=>{
  const b=executionBindingFixture('isolated-guest'),f=fixture({},b.binding);let calls=0;f.fs.realpath=async p=>{calls++;b.fail();return p;};await assert.rejects(f.service.snapshot(project),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(calls,1);
});
test('resource refusal guidance distinguishes unsupported environment from application repair and unknown-start replay',()=>{
 assert.match(runtimeCapabilitiesFallback,/MANAGED_RESOURCE_\*/);assert.match(runtimeCapabilitiesFallback,/keep deployment unverified/);assert.match(runtimeCapabilitiesFallback,/resourceDiagnostic/);assert.match(runtimeCapabilitiesFallback,/Do not repair application code or rebuild an image solely for SwapLimit=false/);assert.match(runtimeCapabilitiesFallback,/replay an unknown start/);
});
function fixture({ files = ['Dockerfile', '.dockerignore', '.harness-app.json', 'compose.yaml'], free = 3 * 1024 ** 3, state, ...options } = {}, executionBinding = hostExecutionBinding()) {
  const reads = [], fileSet = new Set(files), clock = { value: 10000 };
  const fs = {
    realpath: async p => { reads.push(['realpath', p]); return p; },
    stat: async p => { reads.push(['stat', p]); return { isDirectory: () => true }; },
    lstat: async p => { reads.push(['lstat', p]); if (!fileSet.has(path.basename(p))) throw Object.assign(Error('absent'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false }; },
    statfs: async p => { reads.push(['statfs', p]); return { bavail: BigInt(free), bsize: 1n }; },
  };
  const service = createRuntimeCapabilities({ workspaceRoot: root, capacityPath: root, fs, now: () => clock.value, ...(state === undefined ? {} : { readAppsState: async () => { reads.push(['apps']); return state; } }), ...options }, executionBinding);
  return { service, reads, clock, fs };
}
function ownState(extra = {}) { return { enabled: true, available: true, worker: { phase: 'ready', freeBytes: 900 * MIB }, projects: [{ id, path: path.relative(root, project), imageId: 'sha256:' + cid, containerId: cid }], ...extra }; }
test('a retained unresolved deployment is a hold with reviewable job identity, never a new verification recipe',async()=>{
 const f=fixture({state:ownState({deploymentRecovery:{required:true,projects:[otherId]},jobs:[{id:'d'.repeat(16),projectId:id,status:'recovery_required',action:'verify'}]})}),value=await f.service.snapshot(project);assert.equal(value.apps.recoveryRequired,true);assert.equal(value.capacity.canVerify,false);assert.equal(value.apps.jobs[0].status,'recovery_required');assert.equal(value.recipes.verify,undefined);assert.doesNotMatch(JSON.stringify(value),new RegExp(otherId));
});

test('reads only deployment file metadata, never contents, and returns reusable fixed argv', async () => {
  const { service, reads } = fixture({ state: ownState() }), s = await service.snapshot(project);
  assert.deepEqual(s.existingFiles, ['Dockerfile', '.dockerignore', '.harness-app.json', 'compose.yaml']);
  assert.equal(s.timestamp, '1970-01-01T00:00:10.000Z'); assert.equal(s.apps.state, 'ready');
  assert.deepEqual(s.recipes.verify, ['/data/harness/node/bin/node', '/data/harness/app/vast/apps-cli.cjs', 'verify', id]);
  assert.deepEqual(s.recipes.register.slice(-2), ['register', path.relative(root, project)]);
  assert.equal(s.apps.project.built, true); assert.equal(s.apps.project.deployed, true);
  assert.ok(reads.every(([op]) => ['realpath', 'stat', 'lstat', 'statfs', 'apps'].includes(op)));
  assert.ok(reads.filter(([op]) => op === 'lstat').every(([, p]) => path.dirname(p) === project));
  assert.equal(s.guidance.managedDockerOnly, true); assert.equal(s.guidance.enforceCapacityAgainAtExecution, true);
});

test('deployment recipes follow actual built/deployed state instead of suggesting invalid manual actions', async () => {
  for (const [built, deployed] of [[false, false], [true, false], [true, true]]) {
    const registered = { id, path: path.relative(root, project), ...(built ? { imageId: 'sha256:' + cid } : {}), ...(deployed ? { containerId: cid } : {}) };
    const s = await fixture({ state: ownState({ projects: [registered] }) }).service.snapshot(project);
    assert.ok(s.recipes.verify); assert.ok(s.recipes.build);
    assert.equal(Boolean(s.recipes.deploy), built); assert.equal(Boolean(s.recipes.check), deployed);
    assert.match(runtimeCapabilitiesFallback, /For a user preview, prefer verify/);
  }
});

test('does not disclose another project, secret, URL, job text, port or raw configuration', async () => {
  const state = ownState({ secret: 'CANARY_TOKEN', error: 'CANARY_ERROR', busy: 'CANARY_BUSY', previewSettings: { url: 'https://canary.invalid' },
    projects: [{ ...ownState().projects[0], name: 'CANARY_NAME', runtimeEnv: { key: 'CANARY_ENV' }, applicationUrl: 'https://canary.invalid/own' }, { id: otherId, path: 'projects/foreign', name: 'CANARY_FOREIGN' }],
    jobs: [{ id, projectId: id, action: 'verify', status: 'passed', startedAt: 99, error: 'CANARY_JOB', output: 'CANARY_LOG' }, { id: otherId, projectId: otherId, action: 'build', status: 'failed' }],
    containers: [{ id: cid, projectId: id, state: 'running', status: 'CANARY_STATUS', ports: [{ public: 4444 }] }, { id: 'd'.repeat(64), projectId: otherId, state: 'running', name: 'CANARY_CONTAINER' }],
  });
  const s = await fixture({ state }).service.snapshot(project), text = JSON.stringify(s);
  assert.equal(text.includes('CANARY'), false); assert.equal(text.includes('canary.invalid'), false);
  assert.equal(s.apps.jobs.length, 1); assert.equal(s.apps.containers.length, 1);
  assert.deepEqual(Object.keys(s.apps.jobs[0]), ['id', 'action', 'status', 'startedAt', 'endedAt']);
  assert.deepEqual(Object.keys(s.apps.containers[0]), ['id', 'state']);
});

test('requires full registered path and valid id; missing or ambiguous association reveals no jobs', async () => {
  for (const projects of [[{ id: otherId, path: 'foreign/own' }], [{ id, path: '../workspaces/projects/own' }], [{ id: 'bad', path: path.relative(root, project) }], [ownState().projects[0], { ...ownState().projects[0], id: otherId }]]) {
    const s = await fixture({ state: ownState({ projects, jobs: [{ id, projectId: id, action: 'build', status: 'running' }], containers: [{ id: cid, projectId: id, state: 'running' }] }) }).service.snapshot(project);
    assert.equal(s.apps.project, null); assert.deepEqual(s.apps.jobs, []); assert.deepEqual(s.apps.containers, []);
    assert.deepEqual(Object.keys(s.recipes), ['register']);
  }
});

test('rejects caller paths outside workspace, noncanonical paths, workspace itself and symlink escape', async () => {
  const f = fixture();
  for (const p of [root, path.resolve(root, '..', 'elsewhere'), 'relative', project + path.sep + '..' + path.sep + 'own', null]) await assert.rejects(f.service.snapshot(p));
  assert.equal(f.reads.length, 0);
  const escaped = fixture({ fs: { ...f.fs, realpath: async p => p === project ? path.resolve(root, '..', 'foreign') : p } });
  await assert.rejects(escaped.service.snapshot(project), /canonical/);
});

test('symlinked or unreadable deployment files are not advertised as reusable', async () => {
  const base = fixture(), fs = { ...base.fs, lstat: async p => { if (path.basename(p) === 'Dockerfile') return { isFile: () => true, isSymbolicLink: () => true }; if (path.basename(p) === '.harness-app.json') throw Object.assign(Error('CANARY_PRIVATE_PATH'), { code: 'EACCES' }); throw Object.assign(Error('absent'), { code: 'ENOENT' }); } };
  const s = await fixture({ fs }).service.snapshot(project);
  assert.deepEqual(s.existingFiles, []); assert.deepEqual(s.unavailableFiles, ['Dockerfile', '.harness-app.json']);
  assert.equal(JSON.stringify(s).includes('CANARY'), false);
});

test('reports configured, asleep, starting, ready and unreachable without waking anything', async () => {
  const cases = [
    [{ enabled: false }, 'configured'],
    [ownState({ available: false, worker: { phase: 'asleep' } }), 'asleep'],
    ...['starting', 'restoring', 'recovering', 'saving'].map(phase => [ownState({ available: false, worker: { phase } }), 'starting']),
    [ownState(), 'ready'], [ownState({ worker: null }), 'ready'],
    [ownState({ available: false, worker: { phase: 'ready' } }), 'unreachable'],
    [ownState({ available: true, worker: { phase: 'error', error: 'CANARY' } }), 'unreachable'],
  ];
  for (const [state, expected] of cases) assert.equal((await fixture({ state }).service.snapshot(project)).apps.state, expected);
  const missing = await fixture().service.snapshot(project); assert.equal(missing.apps.observed, false); assert.equal(missing.apps.reason, 'state-reader-not-configured');
});

test('statfs capacity honors minimum plus 512MiB verify reserve exactly', async () => {
  for (const [free, build, verify] of [[2 * 1024 ** 3 - 1, false, false], [2 * 1024 ** 3, true, false], [2 * 1024 ** 3 + 512 * MIB - 1, true, false], [2 * 1024 ** 3 + 512 * MIB, true, true]]) {
    const s = await fixture({ free }).service.snapshot(project);
    assert.equal(s.capacity.freeBytes, free); assert.equal(s.capacity.canBuild, build); assert.equal(s.capacity.canVerify, verify);
  }
  const f = fixture(), broken = fixture({ fs: { ...f.fs, statfs: async () => { throw Error('CANARY'); } } });
  const s = await broken.service.snapshot(project); assert.equal(s.capacity.known, false); assert.equal(s.capacity.canBuild, false); assert.equal(s.capacity.canVerify, false);
  for (const stat of [{ bavail: -1n, bsize: 1n }, { bavail: 2n ** 63n, bsize: 1n }, { bavail: 10n, bsize: 0n }]) assert.equal((await fixture({ fs: { ...f.fs, statfs: async () => stat } }).service.snapshot(project)).capacity.known, false);
});

test('exposes declared worker limits separately from observed driver and unknown build peak', async () => {
  const profile = { vcpus: 1, memoryMiB: 2048, diskBytes: 3 * 1024 ** 3, acceleration: 'tcg', configuredStorageDriver: 'vfs', observedStorageDriver: 'vfs', storageObservedAt: 1234, observedInRunningBoot: true, privateKey: 'PRIVATE_PROFILE_CANARY', peakBuildBytesKnown: true };
  const s = await fixture({ state: ownState({ worker: { phase: 'ready', profile } }) }).service.snapshot(project);
  assert.equal(s.apps.workerProfile.diskBytes, 3 * 1024 ** 3); assert.equal(s.apps.workerProfile.vcpus, 1);
  assert.equal(s.apps.workerProfile.configuredLayerCopies, 'full-parent-directory'); assert.equal(s.apps.workerProfile.peakBuildBytesKnown, false);
  assert.equal(s.apps.workerProfile.observedInRunningBoot, true); assert.equal(s.guidance.finalImageSizeIsNotPeakBuildUsage, true);
  assert.doesNotMatch(JSON.stringify(s), /PRIVATE_PROFILE_CANARY|privateKey/);
  const bad = await fixture({ state: ownState({ worker: { phase: 'ready', profile: { ...profile, vcpus: -1, memoryMiB: '2048', diskBytes: Infinity, acceleration: 'SECRET', observedStorageDriver: 'PRIVATE_PROFILE_CANARY', configuredStorageDriver: 'PRIVATE_PROFILE_CANARY' } } }) }).service.snapshot(project);
  for (const key of ['vcpus', 'memoryMiB', 'diskBytes', 'observedStorageDriver', 'configuredStorageDriver', 'acceleration']) assert.equal(bad.apps.workerProfile[key], null);
  assert.equal(bad.apps.workerProfile.observedInRunningBoot, false); assert.equal(bad.apps.workerProfile.configuredLayerCopies, 'unknown');
});

test('context renderer is synchronous cache-only, TTL expires and failed refresh cannot fabricate fresh state', async () => {
  let calls = 0; const f = fixture({ readAppsState: async () => { calls++; if (calls === 2) throw Error('CANARY'); return ownState(); } });
  assert.equal(f.service.renderContext(project), runtimeCapabilitiesFallback); assert.equal(f.reads.length, 0);
  const s = await f.service.snapshot(project), reads = f.reads.length;
  assert.match(f.service.renderContext(project), /"state":"ready"/); assert.equal(f.reads.length, reads);
  assert.equal(await f.service.snapshot(project), s); assert.equal(calls, 1);
  f.clock.value += 5000; assert.equal(f.service.renderContext(project), runtimeCapabilitiesFallback); assert.equal(calls, 1);
  const failed = await f.service.snapshot(project); assert.equal(failed.apps.state, 'unreachable'); assert.equal(failed.apps.observed, false); assert.equal(JSON.stringify(failed).includes('CANARY'), false);
  assert.equal(f.service.renderContext(path.join(root, 'other')), runtimeCapabilitiesFallback);
});

test('inflight dedupe, project-scoped cache, bounded admission and immutable results', async () => {
  let finish, calls = 0; const f = fixture({ maxEntries: 1, readAppsState: () => { calls++; return calls === 1 ? new Promise(resolve => { finish = resolve; }) : ownState(); } });
  const a = f.service.snapshot(project), b = f.service.snapshot(project); assert.equal(a, b);
  await assert.rejects(f.service.snapshot(path.join(root, 'projects', 'other')), /limit/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); finish(ownState());
  const s = await a; assert.ok(Object.isFrozen(s.recipes.verify)); assert.throws(() => { s.apps.state = 'forged'; }, TypeError);
  const other = await f.service.snapshot(path.join(root, 'projects', 'other'));
  assert.equal(other.apps.project, null); assert.equal(calls, 2);
  assert.equal(f.service.renderContext(project), runtimeCapabilitiesFallback);
  assert.match(f.service.renderContext(path.join(root, 'projects', 'other')), /project-not-registered/);
});

test('native host statfs is used at configured capacity path without a subprocess or worker wake', async () => {
  const f = fixture(), nativePath = process.cwd(); let observed;
  const service = fixture({ capacityPath: nativePath, fs: { ...f.fs, statfs: async (p, options) => { observed = p; return fsPromises.statfs(p, options); } } }).service;
  const s = await service.snapshot(project);
  assert.equal(observed, nativePath); assert.equal(s.capacity.known, true); assert.ok(s.capacity.freeBytes >= 0);
  assert.equal(s.capacity.canVerify, s.capacity.freeBytes >= s.capacity.verifyRequiredBytes);
});

test('bounded state timeout reports sanitized unreachable and releases inflight slot', async () => {
  let signal; const f = fixture({ stateTimeoutMs: 10, readAppsState: input => { signal = input.signal; return new Promise(() => {}); } });
  const s = await f.service.snapshot(project); assert.equal(signal.aborted, true); assert.equal(s.apps.state, 'unreachable'); assert.equal(s.apps.reason, 'state-read-failed');
  assert.equal(s.apps.project, null); assert.deepEqual(s.apps.jobs, []);
});

test('validates trusted configuration and serializes arbitrary registry strings as unknown enums', async () => {
  for (const options of [{ minFreeBytes: -1 }, { minFreeBytes: NaN }, { ttlMs: Infinity }, { stateTimeoutMs: 0 }, { maxEntries: 0 }, { readAppsState: true }]) assert.throws(() => fixture(options), TypeError);
  const state = ownState({ jobs: [{ id, projectId: id, action: 'CANARY_ACTION', status: 'CANARY_STATUS', startedAt: 'CANARY_DATE' }], containers: [{ id: cid, projectId: id, state: 'CANARY_STATE' }] });
  const s = await fixture({ state }).service.snapshot(project); assert.equal(JSON.stringify(s).includes('CANARY'), false); assert.equal(s.apps.jobs[0].action, 'unknown'); assert.equal(s.apps.jobs[0].startedAt, null);
});
