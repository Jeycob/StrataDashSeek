'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RuntimeRecovery,createRuntimeRecovery}=require('./runtime-recovery.cjs');
const old='a'.repeat(40),candidate='b'.repeat(40),compatibilityId='1'.repeat(64),policy={enabled:true,minimumSecurityEpoch:1,compatibilityId,deniedCommits:[]};
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sdsh-runtime-recovery-'));fs.chmodSync(directory,0o700);const file=path.join(directory,'state.json');let time=100000,pointer=old,tail=Promise.resolve(),switches=0,restarts=0,activeJobs=0,changed=false;
 t.after(()=>{const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('sdsh-runtime-recovery-'));fs.rmSync(resolved,{recursive:true,force:true});});
 const store={read(){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},write(value){fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);}};
 const hooks={verifyRelease:async({commit})=>({commit,digest:(changed&&commit===old?'3':'2').repeat(64),signatureVerified:true,rootProtected:true,securityEpoch:1,admissionProtocol:1,compatibilityId}),currentCommit:async()=>pointer,fence:async({attemptId,commit})=>({attemptId,commit,admissionClosed:true,acceptedWork:0,activeRequests:0,activeJobs,fenceToken:'4'.repeat(64),observedAt:time}),switchRelease:async({to})=>{switches++;pointer=to;},restart:async()=>{restarts++;}};
 const exclusive=fn=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;},controller=()=>new RuntimeRecovery({policy,store,hooks,exclusive,now:()=>time});
 return{directory,file,store,hooks,controller,health:(commit=pointer)=>({version:1,phase:'model_loading',sourceCommit:commit,sourceReady:true,runtimeReady:true,modelReady:false,observedAt:new Date(time).toISOString()}),advance:ms=>{time+=ms;},setPointer:value=>{pointer=value;},setJobs:value=>{activeJobs=value;},changeLastGood:()=>{changed=true;},counts:()=>({switches,restarts})};
}
async function begin(f){const c=f.controller();await c.adoptHealthy(old,f.health(old));const status=await c.begin(candidate);f.setPointer(candidate);return{c,id:status.attemptId};}

test('missing root policy or hooks disables automation without writing a trust baseline',async()=>{
 let writes=0;const c=new RuntimeRecovery({policy:{enabled:false},store:{read:()=>null,write:()=>writes++},hooks:{},exclusive:fn=>fn()});assert.equal((await c.status()).phase,'recovery_required');assert.equal((await c.begin(candidate)).recoveryRequired,true);assert.equal(writes,0);
});
test('only fresh functional Native health establishes a signed compatible baseline, independently of model loading',async t=>{
 const f=fixture(t),c=f.controller();await assert.rejects(c.adoptHealthy(old,{...f.health(old),runtimeReady:false}),{code:'RUNTIME_RECOVERY_HEALTH_UNPROVEN'});await assert.rejects(c.adoptHealthy(old,{...f.health(old),phase:'failed'}),{code:'RUNTIME_RECOVERY_HEALTH_UNPROVEN'});await assert.rejects(c.adoptHealthy(old,{...f.health(old),observedAt:new Date(1).toISOString()}),{code:'RUNTIME_RECOVERY_HEALTH_UNPROVEN'});await c.adoptHealthy(old,f.health(old));assert.equal((await c.status()).lastGoodCommit,old);
 const s=await c.begin(candidate);f.setPointer(candidate);const ready=await c.observe(s.attemptId,f.health());assert.equal(ready.phase,'healthy');assert.equal(ready.lastGoodCommit,candidate);assert.equal(ready.runtimeReady,null);assert.equal(ready.functionalHealthConfirmed,true);assert.deepEqual(f.counts(),{switches:0,restarts:0});
 await c.admitWork(s.attemptId,candidate);assert.equal((await c.status()).acceptedWork,true);f.advance(100000);assert.equal((await c.observe(s.attemptId,{...f.health(),runtimeReady:false})).phase,'healthy');assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
test('initial healthy baseline admits work and reenrollment preserves the same epoch, latch and history',async t=>{
 const f=fixture(t),c=f.controller(),baseline=await c.adoptHealthy(old,f.health(old));assert.equal(baseline.phase,'healthy');assert(baseline.attemptId);await c.admitWork(baseline.attemptId,old);const reopened=f.controller(),same=await reopened.adoptHealthy(old,f.health(old));assert.equal(same.attemptId,baseline.attemptId);assert.equal(same.acceptedWork,true);assert.equal(f.store.read().history.length,1);
 f.setJobs(1);const held=await reopened.begin(candidate);assert.notEqual(held.attemptId,baseline.attemptId);assert.equal(held.phase,'recovery_required');assert.equal(f.store.read().history[0].acceptedWork,true);assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
test('legacy505, unknown safety/ABI, unverified signatures and changed last-good bytes cannot authorize rollback',async t=>{
 const f=fixture(t),c=f.controller(),unsafe='505460d62e63c389def4fba5c82da8b9ab9cfd13';f.setPointer(unsafe);await assert.rejects(c.adoptHealthy(unsafe,f.health(unsafe)),{code:'RUNTIME_RECOVERY_RELEASE_UNSAFE'});f.setPointer(old);
 const verify=f.hooks.verifyRelease;for(const patch of [{signatureVerified:false},{rootProtected:false},{securityEpoch:0},{compatibilityId:'9'.repeat(64)},{admissionProtocol:0}]){f.hooks.verifyRelease=async args=>({...await verify(args),...patch});await assert.rejects(c.adoptHealthy(old,f.health(old)),{code:'RUNTIME_RECOVERY_RELEASE_UNSAFE'});}f.hooks.verifyRelease=verify;
 await c.adoptHealthy(old,f.health(old));f.changeLastGood();await assert.rejects(c.begin(candidate),{code:'RUNTIME_RECOVERY_LAST_GOOD_CHANGED'});assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
test('90-second deadline and consumed attempt survive controller restart; returned restart is not health',async t=>{
 const f=fixture(t),{c,id}=await begin(f);await assert.rejects(c.admitWork(id,candidate),{code:'RUNTIME_RECOVERY_ADMISSION_CLOSED'});f.advance(89999);assert.equal((await f.controller().observe(id,{...f.health(),runtimeReady:false})).phase,'monitoring');f.advance(1);
 const switched=await f.controller().observe(id,{...f.health(),runtimeReady:false});assert.equal(switched.phase,'rollback_switched');assert.equal(switched.runtimeReady,null);assert.equal(switched.functionalHealthConfirmed,false);assert.deepEqual(f.counts(),{switches:1,restarts:1});await assert.rejects(c.admitWork(id,old),{code:'RUNTIME_RECOVERY_ADMISSION_CLOSED'});assert.equal((await f.controller().observe(id,f.health())).phase,'rollback_switched');assert.deepEqual(f.counts(),{switches:1,restarts:1});
 assert.equal((await f.controller().reconcile(id,f.health())).phase,'rolled_back');await c.admitWork(id,old);await assert.rejects(c.begin(candidate),{code:'RUNTIME_RECOVERY_ATTEMPT_LIMIT'});
});
test('unknown/active work or missing fence proof holds failure without stopping or switching anything',async t=>{
 const f=fixture(t),{c,id}=await begin(f);f.setJobs(1);f.advance(90000);assert.equal((await c.observe(id,{...f.health(),runtimeReady:false})).phase,'recovery_required');assert.deepEqual(f.counts(),{switches:0,restarts:0});await assert.rejects(c.admitWork(id,candidate),{code:'RUNTIME_RECOVERY_ADMISSION_CLOSED'});
});
test('ambiguous switch is never replayed after restart and requires observed fallback health before admission',async t=>{
 const f=fixture(t),{c,id}=await begin(f);f.hooks.switchRelease=async({to})=>{f.setPointer(to);throw Error('lost switch acknowledgement');};f.advance(90000);assert.equal((await c.observe(id,{...f.health(),runtimeReady:false})).phase,'recovery_required');assert.deepEqual(f.counts(),{switches:0,restarts:0});
 const restarted=f.controller();assert.equal((await restarted.reconcile(id,{...f.health(),runtimeReady:false})).recoveryRequired,true);assert.equal((await restarted.reconcile(id,f.health())).phase,'rolled_back');assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
test('cold fallback proof requires an already-switched previous release and the durable zero-work fence',async t=>{
 const f=fixture(t),{c,id}=await begin(f);f.advance(90000);
 f.hooks.restart=async()=>{throw Error('fallback supervisor did not start');};
 assert.equal((await c.observe(id,{...f.health(),runtimeReady:false})).phase,'recovery_required');
 const cold=f.controller(),stored=fs.readFileSync(f.file,'utf8');
 const admission={version:1,epoch:id,sourceCommit:candidate,open:false,acceptedWork:0,fenceToken:'4'.repeat(64)};
 assert.equal((await cold.fallbackForStartup(admission)).commit,old);
 assert.equal((await cold.fallbackForStartup({...admission,sourceCommit:old})).commit,old);
 for(const changes of [{open:true},{epoch:'b'.repeat(36)},{acceptedWork:1},{sourceCommit:'c'.repeat(40)},{fenceToken:null}])
  await assert.rejects(cold.fallbackForStartup({...admission,...changes}),{code:'RUNTIME_RECOVERY_FALLBACK_FENCE_UNPROVEN'});
 f.setPointer(candidate);
 await assert.rejects(cold.fallbackForStartup(admission),{code:'RUNTIME_RECOVERY_POINTER_MISMATCH'});
 f.setPointer(old);
 assert.equal(fs.readFileSync(f.file,'utf8'),stored);
 await assert.rejects(cold.admitWork(id,old),{code:'RUNTIME_RECOVERY_ADMISSION_CLOSED'});
 assert.equal((await cold.reconcile(id,f.health())).phase,'rolled_back');
 await assert.rejects(cold.begin(candidate),{code:'RUNTIME_RECOVERY_ATTEMPT_LIMIT'});
 assert.deepEqual(f.counts(),{switches:1,restarts:0});
});
test('policy changes, damaged journals and backward clocks cannot silently reset a durable attempt budget',async t=>{
 const f=fixture(t),{c}=await begin(f),state=f.store.read();f.advance(-1);await assert.rejects(c.status(),{code:'RUNTIME_RECOVERY_CLOCK_UNCERTAIN'});f.advance(1);f.store.write({...state,policyHash:'0'.repeat(64)});await assert.rejects(f.controller().status(),{code:'RUNTIME_RECOVERY_STATE_UNTRUSTED'});f.store.write({...state,history:[{...state.history[0],record:{}}]});await assert.rejects(c.status(),{code:'RUNTIME_RECOVERY_RELEASE_UNSAFE'});assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
test('two rollback attempts consume the persistent daily budget; a third candidate remains held',async t=>{
 const f=fixture(t),c=f.controller();await c.adoptHealthy(old,f.health());for(const ch of ['b','c','d']){const sha=ch.repeat(40),s=await c.begin(sha);f.setPointer(sha);f.advance(90000);const outcome=await f.controller().observe(s.attemptId,{...f.health(),runtimeReady:false});if(ch==='d'){assert.equal(outcome.reasonCode,'RUNTIME_RECOVERY_ATTEMPT_LIMIT');assert.equal(outcome.phase,'recovery_required');}else{assert.equal(outcome.phase,'rollback_switched');assert.equal((await c.reconcile(s.attemptId,f.health())).phase,'rolled_back');}}assert.deepEqual(f.counts(),{switches:2,restarts:2});
});
test('a bounded hook abort does not start recovery side effects',async t=>{
 const f=fixture(t);let aborted=false;f.hooks.fence=({signal})=>new Promise(()=>signal.addEventListener('abort',()=>{aborted=true;}));const start=Date.now();await assert.rejects(f.controller().call('fence',{},20),{code:'RUNTIME_RECOVERY_HOOK_TIMEOUT'});assert.equal(aborted,true);assert(Date.now()-start<1000);assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
test('actual controller death after pointer switch retains intent and never replays the switch',async t=>{
 const f=fixture(t),{id}=await begin(f),cp=require('node:child_process');
 const script=`const fs=require('node:fs'),{RuntimeRecovery}=require(process.argv[1]),file=process.argv[2],id=process.argv[3],policy=JSON.parse(process.argv[4]),candidate='b'.repeat(40),old='a'.repeat(40);const store={read:()=>JSON.parse(fs.readFileSync(file)),write:value=>{fs.writeFileSync(file+'.tmp',JSON.stringify(value));fs.renameSync(file+'.tmp',file);}},hooks={verifyRelease:async({commit})=>({commit,digest:'2'.repeat(64),signatureVerified:true,rootProtected:true,securityEpoch:1,admissionProtocol:1,compatibilityId:policy.compatibilityId}),currentCommit:async()=>candidate,fence:async({attemptId,commit})=>({attemptId,commit,admissionClosed:true,acceptedWork:0,activeRequests:0,activeJobs:0,fenceToken:'4'.repeat(64),observedAt:190000}),switchRelease:async()=>{fs.writeFileSync(file+'.pointer',old);process.kill(process.pid,'SIGKILL');},restart:async()=>{throw Error('must not run');}};new RuntimeRecovery({policy,store,hooks,exclusive:fn=>fn(),now:()=>190000}).observe(id,{version:1,sourceReady:true,runtimeReady:false,sourceCommit:candidate,observedAt:new Date(190000).toISOString()}).catch(()=>process.exitCode=2);`;
 const result=cp.spawnSync(process.execPath,['-e',script,path.resolve(__dirname,'runtime-recovery.cjs'),f.file,id,JSON.stringify(policy)],{timeout:5000,encoding:'utf8',windowsHide:true});assert.notEqual(result.status,0);assert.equal(fs.readFileSync(f.file+'.pointer','utf8'),old);assert.equal(f.store.read().history.find(row=>row.id===id).phase,'rollback_intent');f.advance(90000);f.setPointer(old);assert.equal((await f.controller().reconcile(id,f.health())).phase,'rolled_back');assert.deepEqual(f.counts(),{switches:0,restarts:0});
});
if(process.env.HARNESS_RUNTIME_RECOVERY_ROOT_TEST==='1')test('Linux root adapter persists protected state and rejects linked state before recovery',async t=>{
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const f=fixture(t),hooks={...f.hooks,fence:async args=>({...await f.hooks.fence(args),observedAt:Date.now()})},c=createRuntimeRecovery({root:f.directory,policy,hooks});assert.equal((await c.adoptHealthy(old,{...f.health(),observedAt:new Date().toISOString()})).phase,'healthy');const file=path.join(f.directory,'root-secrets/runtime/state/runtime-recovery.json');assert.equal(fs.statSync(file).mode&0o077,0);const second=createRuntimeRecovery({root:f.directory,policy,hooks});assert.equal((await second.status()).lastGoodCommit,old);fs.linkSync(file,path.join(f.directory,'linked-state'));await assert.rejects(second.status(),/Untrusted privileged file/);
});
