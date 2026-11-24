'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const commit='a'.repeat(40);
const fixtureFloor={createExecutionFloor:()=>({capturePolicy:()=>({assertPolicyUnchanged(){},assertReleaseAllowed(){}})})};
function fixture(phase,health){const module={exports:{}},calls=[];const dependencies={'node:fs':fs,'node:path':path,'node:child_process':{},'node:crypto':require('node:crypto'),'node:url':require('node:url'),'./project-execution-floor.cjs':fixtureFloor,'./runtime-paths.cjs':{publish(){},writePrivate:(_root,name,value)=>calls.push({name,value})},'./runtime-release.cjs':{currentCommit:()=>commit},'./startup-update.cjs':{},'./runtime-admission-server.cjs':{},'./runtime-recovery.cjs':require('./runtime-recovery.cjs')};function load(name){return dependencies[name]??assert.fail(name);}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'runtime-launcher.cjs'),'utf8'),{module,exports:module.exports,require:load,__dirname,process:{},Date,console,setTimeout,clearTimeout,setInterval,clearInterval,Promise});const owner=new module.exports.RuntimeLauncher({root:'/fixture',uid:1001,gid:1001});owner.controller={status:async()=>({phase,attemptId:'epoch',servingCommit:commit})};owner.readiness={sample:async()=>health};owner.launchAttempt={sourceCommit:commit,startedAt:Date.now()};owner.broker={open:async observation=>{assert.equal(observation,health);calls.push({open:true});},closeAdmission:async()=>calls.push({closed:true})};return{owner,calls};}
test('a persisted healthy or rolled-back row cannot reopen a cold process before fresh functional Native health',async()=>{
 for(const phase of ['healthy','rolled_back'])for(const patch of [{runtimeReady:false},{sourceReady:false},{sourceCommit:'b'.repeat(40)},{observedAt:new Date(1).toISOString()}]){const health={version:1,phase:'model_loading',sourceCommit:commit,sourceReady:true,runtimeReady:true,observedAt:new Date().toISOString(),...patch},f=fixture(phase,health);await f.owner.tick();assert.equal(f.calls.some(c=>c.open),false);assert(f.calls.some(c=>c.closed));}
});
test('fresh matching Native health opens the recovered process while a cold model remains independent',async()=>{
 const f=fixture('healthy',{version:1,phase:'model_loading',sourceCommit:commit,sourceReady:true,runtimeReady:true,modelReady:false,observedAt:new Date().toISOString()});await f.owner.tick();assert.equal(f.calls.filter(c=>c.open).length,1);assert.equal(f.calls.some(c=>c.closed),false);
});

test('pending offline purge recovery blocks every Native spawn at launch boundary',async()=>{
 const module={exports:{}},calls=[],dependencies={'node:fs':fs,'node:path':path,'node:child_process':{spawn(){calls.push('spawn');throw Error('must not spawn');}},'node:crypto':require('node:crypto'),'node:url':require('node:url'),'./project-execution-floor.cjs':fixtureFloor,'./runtime-paths.cjs':{},'./runtime-release.cjs':{currentCommit:()=>commit,verify:async()=>calls.push('verify')},'./startup-update.cjs':{},'./runtime-admission-server.cjs':{},'./runtime-recovery.cjs':{},'./offline-purge-maintenance.cjs':{beforeNativeStart:async()=>{calls.push('purge-recovery');throw Error('PURGE_RECOVERY_REQUIRED');}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'runtime-launcher.cjs'),'utf8'),{module,exports:module.exports,require:name=>dependencies[name]??assert.fail(name),__dirname,process:{},Date,console,setTimeout,clearTimeout,setInterval,clearInterval,Promise});
 const owner=new module.exports.RuntimeLauncher({root:'/fixture',uid:1001,gid:1001});await assert.rejects(owner.launchUi(),/PURGE_RECOVERY_REQUIRED/);assert.deepEqual(calls,['verify','purge-recovery']);
});
function guardedLauncher(){
 let closed=false,pointer=commit;const module={exports:{}},calls=[],check=()=>{if(closed)throw Object.assign(Error('changed'),{code:'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});};
 const dependencies={'node:fs':fs,'node:path':path,'node:child_process':{spawn(){calls.push('spawn');assert.fail('no spawn');}},'node:crypto':require('node:crypto'),'node:url':require('node:url'),'./project-execution-floor.cjs':{createExecutionFloor:()=>({capturePolicy:()=>({assertPolicyUnchanged:check,assertReleaseAllowed:check})})},'./runtime-paths.cjs':{},'./runtime-release.cjs':{currentCommit:()=>pointer,verify:async()=>({digest:'d'.repeat(64)}),verifySync(){calls.push('sync-verify');}},'./startup-update.cjs':{activate(){calls.push('activate');assert.fail('no activation');}},'./runtime-admission-server.cjs':{},'./runtime-recovery.cjs':{},'./offline-purge-maintenance.cjs':{beforeNativeStart:async()=>{}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'runtime-launcher.cjs'),'utf8'),{module,exports:module.exports,require:name=>dependencies[name]??assert.fail(name),__dirname,process:{},Date,console,setTimeout,clearTimeout,setInterval,clearInterval,Promise});
 const owner=new module.exports.RuntimeLauncher({root:'/fixture',uid:60059,gid:60059});return{owner,calls,dependencies,close(){closed=true;},changePointer(){pointer='b'.repeat(40);}};
}
test('launchUi rejects changed policy after verification or purge await, and changed current before spawn',async()=>{
 for(const boundary of ['verify','purge','pointer']){const f=guardedLauncher();if(boundary==='verify')f.dependencies['./runtime-release.cjs'].verify=async()=>{f.close();};else f.dependencies['./offline-purge-maintenance.cjs'].beforeNativeStart=async()=>boundary==='purge'?f.close():f.changePointer();await assert.rejects(f.owner.launchUi(),{code:boundary==='pointer'?'RUNTIME_LAUNCH_RELEASE_CHANGED':'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});assert.equal(f.calls.includes('spawn'),false);}
});
test('recovery switch rechecks the captured floor after stopping UI before any pointer effect',async()=>{
 const f=guardedLauncher(),id='11111111-2222-3333-4444-555555555555',token='f'.repeat(64);f.owner.broker={state:{open:false,acceptedWork:0,epoch:id,fenceToken:token}};f.owner.stopUi=async()=>{f.calls.push('stop');f.close();};await assert.rejects(f.owner.switchRelease({attemptId:id,fenceToken:token,from:commit,to:'b'.repeat(40),fromDigest:'d'.repeat(64),toDigest:'d'.repeat(64)}),{code:'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});assert.deepEqual(f.calls,['stop']);
});
test('tick cannot reopen after health sampling changes the captured policy',async()=>{
 const health={version:1,phase:'ready',sourceCommit:commit,sourceReady:true,runtimeReady:true,observedAt:new Date().toISOString()},f=fixture('healthy',health);let closed=false;const check=()=>{if(closed)throw Object.assign(Error('changed'),{code:'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});};f.owner.executionFloor={assertPolicyUnchanged:check,assertReleaseAllowed:check};f.owner.readiness.sample=async()=>{closed=true;return health;};await f.owner.tick();assert.equal(f.calls.some(call=>call.open),false);assert.equal(f.calls.some(call=>call.closed),true);
});

function startupFixture({phase='recovery_required',transaction=false,applied=commit,open=false,agentRunning=false,
 enabled=true,startupPhase='checking'}={}){
 const calls=[],module={exports:{}},digest='d'.repeat(64),attemptId='f'.repeat(36),candidate='b'.repeat(40);
 const record=Buffer.from(JSON.stringify({commit:applied,digest}));
 const startupStatus={phase:startupPhase,appliedCommit:null,signatureVerified:false};
 const admission={version:1,epoch:attemptId,sourceCommit:candidate,acceptedWork:0,open,fenceToken:'e'.repeat(64)};
 const stat={dev:1,ino:2,uid:0,nlink:1,isFile:()=>true,size:record.length};
 const controller={fallbackForStartup:async saved=>{
  calls.push('prove-existing-fence');assert.equal(saved,admission);
  if(saved.open)throw Error('EXISTING_FENCE_OPEN');
  return{commit,digest};
 }};
 const dependencies={
  'node:fs':{constants:fs.constants,lstatSync:()=>stat,fstatSync:()=>stat,
   readdirSync:()=>agentRunning?['27']:[],statSync:()=>({uid:1001}),
   openSync:()=>5,readSync:(_fd,buffer)=>record.copy(buffer),closeSync(){},
   readFileSync:()=>JSON.stringify({version:1,enabled,repository:'Jeycob/StrataDashSeek',branch:'main',signers:['A'.repeat(40)]})},
  'node:path':path,'node:url':require('node:url'),'node:crypto':require('node:crypto'),
  'node:child_process':{spawnSync:()=>{calls.push('check-fd9');return{status:0};}},
  './project-execution-floor.cjs':fixtureFloor,
  './runtime-paths.cjs':{
   lockFile:()=>'/fixture/supervisor.lock',prepare(){},
   trustedFile:(_file,options)=>options?.optional?(transaction?stat:null):stat,
   readPrivate:(_root,name)=>name==='runtime-recovery.json'?{active:attemptId,history:[{id:attemptId,phase}]}:admission
  },
  './runtime-release.cjs':{currentCommit:()=>commit,verify:async()=>{calls.push('verify-current');return{commit};}},
  './runtime-admission-server.cjs':{createRootAdmission:()=>{
   calls.push('create-broker');return{state:{...admission,open:false},createServer:()=>({
    once(){},listen(port,host,ready){assert.equal(port,3094);assert.equal(host,'127.0.0.1');ready();}
   })};
  }},
  './runtime-recovery.cjs':{...require('./runtime-recovery.cjs'),createRuntimeRecovery:()=>controller},
  './startup-update.cjs':{config:require('./startup-update.cjs').config,update:async()=>calls.push('ordinary-update'),
   statusWriter:()=>status=>{Object.assign(startupStatus,status);calls.push('publish-proven-fallback');}}
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'runtime-launcher.cjs'),'utf8'),{
  module,exports:module.exports,require:name=>dependencies[name]??assert.fail(name),__dirname,Buffer,
  process:{platform:'linux',getuid:()=>0},Date,console,setTimeout,clearTimeout,
  setInterval:()=>({unref(){}}),clearInterval,Promise
 });
 const owner=new module.exports.RuntimeLauncher({root:'/fixture',uid:1001,gid:1001});
 owner.launchUi=async target=>{
  if(target===commit)assert.deepEqual(startupStatus,{phase:'ready',appliedCommit:commit,targetCommit:commit,signatureVerified:true,error:null});
  calls.push(target===commit?'launch-fallback':'ordinary-launch');
 };
 owner.tick=async()=>calls.push('reconcile-on-health');
 return{owner,calls};
}

test('cold startup resumes the complete fallback before invoking the signed-main updater',async()=>{
 for(const startupPhase of ['checking','blocked']){
  const {owner,calls}=startupFixture({startupPhase});await owner.initialize();
  assert.deepEqual(calls,['check-fd9','verify-current','prove-existing-fence','create-broker',
   'publish-proven-fallback','launch-fallback','reconcile-on-health']);
 }
 const ordinary=startupFixture({phase:'healthy'});await ordinary.owner.initialize();
 assert.deepEqual(ordinary.calls,['check-fd9','create-broker','ordinary-update','ordinary-launch','reconcile-on-health']);
});

test('unproven fallback, pending update transaction and active UID cannot fall through to update or launch',async()=>{
 for(const [options,error] of [
  [{transaction:true},'RUNTIME_LAUNCH_UPDATE_TRANSACTION_PENDING'],
  [{applied:'b'.repeat(40)},'RUNTIME_LAUNCH_FALLBACK_APPLIED_UNPROVEN'],
  [{open:true},'EXISTING_FENCE_OPEN'],
  [{agentRunning:true},'RUNTIME_LAUNCH_USER_PROCESS_ACTIVE'],
  [{enabled:false},'The signed startup update policy must be enabled before Harness can start']
 ]){
  const {owner,calls}=startupFixture(options);await assert.rejects(owner.initialize(),{message:error});
  assert.equal(calls.some(call=>['create-broker','ordinary-update','ordinary-launch','launch-fallback','publish-proven-fallback'].includes(call)),false);
 }
});
