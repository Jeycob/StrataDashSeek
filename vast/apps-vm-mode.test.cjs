'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {DockerVM,bootstrap}=require('./apps-vm.cjs');
const {LABEL}=require('./apps-engine.cjs');
const {hostExecutionBinding,executionBindingFixture}=require('./fixtures/execution-binding.cjs');
const {fixture:ownedFixture}=require('./fixtures/vm-ownership.cjs');

// Evaluate the actual controller with inert process/filesystem adapters. A
// spawn attempt records its exact argv then throws; it never creates a child.
function fixture({mode='host-compat',enabled=true,execution=executionBindingFixture(mode)}={}){
 const events=[],manifest={version:1,vcpus:1,memoryMiB:2048,diskBytes:3*1024**3,volumeId:'a'.repeat(32)},manifestSha256=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 const exported={projects:{fd:31},transport:{fd:32},toolchain:{fd:33}},saved={workerProcess:{version:1,state:'absent'},initialized:true,resumeIds:[],containers:[],controlIsolationVersion:1,resourceBootstrapVersion:2};
 let afterStat,afterExports,prepareHook,spawned;
 const project=require('./apps-project-vm.cjs'),projectAdapter={...project,
  forwards(){events.push('forwards');return project.forwards();},
  kernelFingerprint(){events.push('kernel');return 'b'.repeat(64);},
  openExports(){events.push('exports');afterExports?.();return exported;},
  closeExports(value){if(value)events.push('close-exports');},
 };
 for(const method of ['prepare','health','prepareEgress','egressHealth'])projectAdapter[method]=async()=>{events.push(method);prepareHook?.();return {method};};
 const fakeFS={lstatSync(){throw Object.assign(Error('absent'),{code:'ENOENT'});},existsSync:()=>true,readFileSync(file){const name=String(file).replaceAll('\\','/');if(name.endsWith('/manifest.json'))return Buffer.from(JSON.stringify(manifest));if(name.endsWith('/vm.json'))return JSON.stringify(saved);throw Object.assign(Error('absent'),{code:'ENOENT'});},unlinkSync(){events.push('remove-stale-ipc');},statfsSync(){afterStat?.();return{bavail:16*1024**3,bsize:1};},openSync(){events.push('log');return 20;},closeSync(){events.push('close-log');}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'apps-vm.cjs'),'utf8'),{module,exports:module.exports,process:{getuid:()=>1001},Buffer,Date,setTimeout,clearTimeout,structuredClone,console,require(name){
  if(name==='node:fs')return fakeFS;
  if(name==='./apps-vm-reconciliation.cjs')return{gatePending:()=>false};
  if(name==='node:child_process')return{spawn(binary,args,options){events.push('spawn');spawned={binary,args,options};throw Object.assign(Error('inert spawn boundary'),{code:'SYNTHETIC_SPAWN'});}};
  if(name==='./apps-project-vm.cjs')return projectAdapter;
  if(name==='./apps-worker-growth-policy.cjs')return{inspectWorkerCapacity(){events.push('capacity');return{allowed:true,phase:'legacy',diskBytes:manifest.diskBytes,manifestSha256};}};
  if(name==='../mobile/private-json.cjs')return{atomicJson(){events.push('save');}};
  return require(name.startsWith('.')?path.join(__dirname,name):name);
 }});
 const worker=new module.exports.DockerVM({enabled:true,stateDir:'/synthetic/state',vm:{enabled:true,root:'/data/harness/docker-worker'},portCount:0,projectRuntime:{enabled}}, {},execution.binding);
 worker.pid=()=>null;
 return{worker,events,execution,setAfterStat:value=>{afterStat=value;},setAfterExports:value=>{afterExports=value;},setPrepareHook:value=>{prepareHook=value;},get spawned(){return spawned;}};
}

test('VM construction requires a trusted execution binding before filesystem or user access',()=>{
 assert.throws(()=>new DockerVM({vm:{root:'/data/harness/docker-worker'}},{}),{code:'PROJECT_EXECUTION_BINDING_REQUIRED'});
});

for(const [mode,enabled,expected]of [['host-compat',true,false],['isolated-guest',false,false],['isolated-guest',true,true]])test(mode+' / project runtime '+enabled+' exports only its explicitly enabled isolated descriptors',async()=>{
 const f=fixture({mode,enabled});await assert.rejects(f.worker.start(),{code:'SYNTHETIC_SPAWN'});
 const {args,options}=f.spawned,net=args[args.indexOf('-netdev')+1];
 assert.match(args[args.indexOf('-append')+1],/cgroup_no_v1=all swapaccount=1/);
 assert.equal(f.events.includes('exports'),expected);assert.equal(f.events.includes('kernel'),expected);assert.equal(f.events.includes('forwards'),expected);
 assert.equal(args.includes('-fsdev'),expected);assert.equal(net.includes('127.0.0.1:19180-:19180'),expected);
 assert.equal(options.stdio.length,expected?6:3);assert.equal(f.events.includes('close-exports'),expected);assert.equal(f.events.filter(event=>event==='capacity').length,2);
 if(expected){assert(args.includes('local,id=homeai-toolchain,path=/proc/self/fd/5,security_model=none,multidevs=forbid,readonly=on'));assert.deepEqual(Array.from(options.stdio.slice(3)),[31,32,33]);}
});

test('host mode refuses every project preparation and health method before invoking the adapter',async()=>{
 const f=fixture();for(const method of ['prepareProjectRuntime','projectRuntimeHealth','prepareProjectEgress','projectEgressHealth'])await assert.rejects(f.worker[method]({}),{code:'PROJECT_RUNTIME_MODE_UNAVAILABLE'});
 assert.deepEqual(f.events,[]);
});

test('closed execution refuses starts before capacity or descriptors and releases descriptors if it closes during export preparation',async()=>{
 const closed=fixture();closed.execution.fail();await assert.rejects(closed.worker.start(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.deepEqual(closed.events,[]);
 const preflight=fixture();preflight.setAfterStat(()=>preflight.execution.fail());await assert.rejects(preflight.worker.start(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert(!preflight.events.some(event=>['exports','log','spawn'].includes(event)));
 const exporting=fixture({mode:'isolated-guest'});exporting.setAfterExports(()=>exporting.execution.fail());await assert.rejects(exporting.worker.start(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert(exporting.events.includes('close-exports'));assert(!exporting.events.includes('log'));assert(!exporting.events.includes('spawn'));
});

test('project preparation rechecks its binding after an awaited adapter result',async()=>{
 for(const method of ['prepareProjectRuntime','projectRuntimeHealth','prepareProjectEgress','projectEgressHealth']){const f=fixture({mode:'isolated-guest'});f.setPrepareHook(()=>f.execution.fail());await assert.rejects(f.worker[method]({}),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});}
});

test('stale execution status stays readable for settlement while retaining scoped storage and capacity fields',()=>{
 const f=fixture({mode:'isolated-guest'});f.worker.phase='ready';f.worker.pid=()=>73;f.worker.freeBytes=123;f.worker.storageCategories=[{id:'images',bytes:7}];f.worker.projectRuntimeIsolation={verified:true,bootPid:73};f.execution.fail();
 const status=f.worker.status();assert.equal(status.phase,'blocked');assert.equal(status.error,'PROJECT_EXECUTION_BINDING_CHANGED');assert.equal(status.capacity.allowed,true);assert.equal(status.profile.diskBytes,3*1024**3);assert.equal(status.freeBytes,123);assert.deepEqual(status.storageCategories,[{id:'images',bytes:7}]);assert.equal(status.projectRuntimeIsolation,null);assert.equal(status.controlIsolation.verified,false);
});

test('owned shutdown remains available after execution closes and stops ephemeral containers without saving their resume IDs',async()=>{
 const execution=executionBindingFixture('isolated-guest'),ids=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)],events=[];
 const f=ownedFixture({execution:execution.binding}),worker=f.worker;await worker.start();
 Object.assign(worker,{save(){events.push('save');},serial:{destroyed:false,destroy(){this.destroyed=true;},write(command){assert.match(command,/sync; poweroff/);events.push('poweroff');f.setRecord(null);f.exit();f.close();}},engine:{async list(){return[{Id:ids[0],State:'running',Labels:{[LABEL+'.role']:'application'}},{Id:ids[1],State:'running',Labels:{[LABEL+'.role']:'project-editor'}},{Id:ids[2],State:'running',Labels:{[LABEL+'.role']:'test'}}];},async owned(id){events.push('owned:'+id);},async request(method,route){assert.equal(events.filter(event=>event.startsWith('owned:')).length,2);events.push('stop:'+route);}}});
 execution.fail();await worker.stop();assert.equal(worker.phase,'asleep');assert.deepEqual(worker.saved.resumeIds,[ids[0]]);assert.equal(worker.saved.containers.length,2);assert.equal(events.filter(event=>event.startsWith('stop:')).length,2);assert(events.includes('poweroff'));
});

test('an old ready worker cannot reuse its flag without unified cgroup proof',async()=>{
 const f=ownedFixture({cgroupVersion:'1'}),worker=f.worker;worker.phase='ready';worker.saved.controlIsolationVersion=1;worker.saved.resumeIds=['b'.repeat(64)];worker.engine.available=async()=>assert.fail('old ready flag cannot bypass proof');worker.startManagedContainer=async()=>assert.fail('v1 never resumes');
 await assert.rejects(worker.start(),{code:'APPS_CGROUP_V2_REQUIRED'});assert.equal(worker.phase,'error');f.setRecord(null);f.exit();f.close();
 const script=bootstrap(worker.manifest,false,'b'.repeat(16));assert.match(script,/rc_cgroup_mode="unified"/);assert.match(script,/REFUSE_UNIFIED_COLD_BOOT_REQUIRED/);assert.match(script,/REFUSE_DAEMON_LEAF_COLD_BOOT_REQUIRED/);assert.match(script,/--cgroup-parent=\/homeai-containers/);assert.doesNotMatch(script,/umount.*cgroup|mount.*remount/);
});
