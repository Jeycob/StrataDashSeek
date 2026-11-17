'use strict';
const {hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {validateCapacity,CONTRACT}=require('./apps-worker-growth-policy.cjs');
const GiB=1024**3,root='/data/harness/docker-worker',hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture({grown=false}={}){
 const manifest={version:grown?2:1,vcpus:1,memoryMiB:2048,diskBytes:(grown?4:3)*GiB,volumeId:'a'.repeat(32)};
 if(grown)manifest.capacityProfile={version:1,contract:CONTRACT,migrationId:'c'.repeat(32),planSha256:'d'.repeat(64),fromBytes:3*GiB,toBytes:4*GiB,fsUuid:'b'.repeat(32)};
 const raw={dev:1,ino:2,uid:1001,gid:1001,bytes:manifest.diskBytes,allocatedBytes:manifest.diskBytes,links:1,mode:0o600};
 let current=manifest,guard=grown?{version:1,contract:CONTRACT,phase:'approved',migrationId:'c'.repeat(32),planSha256:'d'.repeat(64),workerRoot:root,volumeId:manifest.volumeId,raw:Object.fromEntries(['dev','ino','uid','gid','bytes'].map(key=>[key,raw[key]])),manifestSha256:hash(manifest),fsUuid:'b'.repeat(32),fsckVerified:true}:undefined;
 const events=[],source=fs.readFileSync(path.join(__dirname,'apps-vm.cjs'),'utf8'),module={exports:{}};let afterStat;
 const fakeFS={existsSync:()=>true,readFileSync(file){const name=String(file).replaceAll('\\','/');if(name.endsWith('/manifest.json'))return Buffer.from(JSON.stringify(current));if(name.endsWith('/vm.json'))return JSON.stringify({initialized:true,controlIsolationVersion:1,resourceBootstrapVersion:2,resumeIds:[]});throw Object.assign(Error('absent'),{code:'ENOENT'});},unlinkSync(){events.push('remove-stale-ipc');},statfsSync(){afterStat?.();return{bavail:16*GiB,bsize:1};},openSync(){events.push('open-qemu-log');throw Error('Unexpected spawn path');}};
 vm.runInNewContext(source,{module,exports:module.exports,process:{getuid:()=>1001},Buffer,Date,setTimeout,clearTimeout,console,require(name){
  if(name==='node:fs')return fakeFS;
  if(name==='./apps-worker-growth-policy.cjs')return{inspectWorkerCapacity(){events.push('capacity-read');return validateCapacity({guard,manifest:current,manifestSha256:hash(current),raw,workerRoot:root});}};
  if(name==='node:child_process')return{spawn(){events.push('spawn');throw Error('No real process may start');}};
  return require(name.startsWith('.')?path.join(__dirname,name):name);
 }});
 const worker=new module.exports.DockerVM({enabled:true,stateDir:'/synthetic/state',vm:{enabled:true,root},portCount:0},{available:async()=>{events.push('engine-adopt');}},hostExecutionBinding());
 worker.phase='ready';worker.pid=()=>77;worker.touch=()=>events.push('touch');
 return{worker,events,manifest,setGuard:value=>{guard=value;},setManifest:value=>{current=value;},setAfterStat:value=>{afterStat=value;},get guard(){return guard;}};
}
const pending=f=>({version:1,contract:CONTRACT,phase:'running',migrationId:'c'.repeat(32),planSha256:'d'.repeat(64),workerRoot:root});
test('a pending gate published after actual controller construction blocks ensure and direct start before work',async()=>{
 const f=fixture();assert.equal(f.worker.status().capacity.allowed,true);f.setGuard(pending(f));
 await assert.rejects(f.worker.ensure(),{code:'WORKER_CAPACITY_RECOVERY_REQUIRED'});await assert.rejects(f.worker.start(),{code:'WORKER_CAPACITY_RECOVERY_REQUIRED'});
 assert.equal(f.worker.status().phase,'blocked');assert.equal(f.worker.status().capacity.phase,'running');assert(!f.events.some(name=>['touch','engine-adopt','spawn','open-qemu-log'].includes(name)));
});
test('start rechecks a newly pending gate after preflight immediately before any QEMU spawn',async()=>{
 const f=fixture();f.worker.phase='asleep';f.worker.pid=()=>null;f.setAfterStat(()=>f.setGuard(pending(f)));
 await assert.rejects(f.worker.start(),{code:'WORKER_CAPACITY_RECOVERY_REQUIRED'});assert(!f.events.includes('spawn'));assert(!f.events.includes('open-qemu-log'));assert.equal(f.events.filter(name=>name==='capacity-read').length,2);
});
test('resident controllers refuse even otherwise valid changed manifest bytes',async()=>{
 const f=fixture();f.setManifest({...f.manifest,operatorNote:'changed after construction'});
 assert.equal(f.worker.status().phase,'blocked');assert.equal(f.worker.status().capacity.allowed,false);assert.equal(f.worker.status().error,'WORKER_CAPACITY_MANIFEST_CHANGED');
 await assert.rejects(f.worker.ensure(),{code:'WORKER_CAPACITY_MANIFEST_CHANGED'});assert(!f.events.includes('engine-adopt'));assert(!f.events.includes('touch'));
});
test('exact approved v2 and absent-guard legacy v1 remain usable without changing CPU RAM or driver',async()=>{
 for(const grown of [false,true]){const f=fixture({grown});await f.worker.ensure();const status=f.worker.status();assert.equal(status.capacity.allowed,true);assert.equal(status.capacity.phase,grown?'approved':'legacy');assert.equal(status.profile.vcpus,1);assert.equal(status.profile.memoryMiB,2048);assert.equal(status.profile.configuredStorageDriver,'vfs');assert.equal(f.events.filter(name=>name==='engine-adopt').length,1);assert(!f.events.includes('spawn'));}
});
test('a grown controller without its guard and malformed or unknown gates remain blocked',async()=>{
 const grown=fixture({grown:true});grown.setGuard(undefined);await assert.rejects(grown.worker.ensure(),{code:'WORKER_CAPACITY_APPROVAL_REQUIRED'});
 for(const guard of [null,{},[],{...pending(),phase:'unknown'},{...pending(),phase:'planned'}]){const f=fixture();f.setGuard(guard);assert.equal(f.worker.status().capacity.allowed,false);await assert.rejects(f.worker.start());assert(!f.events.includes('engine-adopt'));assert(!f.events.includes('spawn'));}
});
