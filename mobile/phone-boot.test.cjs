'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeAvailability,deviceDTO,createWakeCredentials,createAvailabilityController}=require('./phone-boot.js');
const ready={phase:'ready',sourceReady:true,runtimeReady:true,modelReady:true,reasonCode:'READY'};
const modelLoading={phase:'model_loading',sourceReady:true,runtimeReady:true,modelReady:false,reasonCode:'MODEL_NOT_LOADED'};
const token=()=>({version:2,wakeUrl:'https://wake.example.com',credential:'device-only-fixture-token',deviceId:'fixture-device-123',expiresAt:9999999999999,scope:['status','wake']});
function fixture(overrides={}){
 let time=100000;const states=[],calls={health:0,status:0,wake:0,provision:0,clear:0};
 const options={now:()=>time,sleep:async ms=>{time+=ms;},onChange:s=>states.push(s),
  health:async()=>{calls.health++;return ready;},status:async()=>{calls.status++;return{status:'stopped',intended:'stopped'};},wake:async()=>{calls.wake++;return{ok:true};},
  credentials:{get:()=>token(),clear:()=>calls.clear++,provision:async()=>{calls.provision++;return token();}},...overrides};
 return{controller:createAvailabilityController(options),calls,states,options,time:()=>time,advance:ms=>time+=ms};
}
test('web ready and worker running do not imply model readiness; observations retain actual time',()=>{
 assert.equal(normalizeAvailability({ready:true}).phase,'starting_services');
 assert.equal(normalizeAvailability({phase:'ready',sourceReady:true,runtimeReady:true}).phase,'model_loading');
 const actual=normalizeAvailability({...ready,observedAt:'1970-01-01T00:00:00.000Z'},100000);assert.equal(actual.phase,'ready');assert.equal(actual.stale,true);assert.equal(actual.observedAt,'1970-01-01T00:00:00.000Z');
 assert.equal(normalizeAvailability({...ready,phase:'offline'}).phase,'offline');assert.equal(normalizeAvailability({phase:'sleeping',reasonCode:'secret error payload'}).reasonCode,'STATUS_UNKNOWN');
});
test('queued capacity is visible, one controller deduplicates opens and honors retryAfter',async()=>{
 let f;f=fixture({health:async()=>{f.calls.health++;if(f.calls.wake>=2)return ready;throw Error('offline');},wake:async()=>{f.calls.wake++;return f.calls.wake===1?{queued:true,retryAfterSeconds:15}:{ok:true};}});
 const a=f.controller.start(),b=f.controller.start();assert.equal(a,b);await a;
 assert.equal(f.calls.wake,2);assert(f.states.some(s=>s.phase==='capacity_wait'));assert.equal(f.controller.state.phase,'ready');
 assert(f.states.find(s=>s.phase==='capacity_wait').lastCheckedAt<f.controller.state.lastCheckedAt);
});
test('hidden queued client never retries GPU wake',async()=>{
 let visible=true,f;f=fixture({visible:()=>visible,health:async()=>{throw Error();},wake:async()=>{f.calls.wake++;visible=false;return{queued:true};}});
 await f.controller.start();assert.equal(f.calls.wake,1);assert.notEqual(f.controller.state.phase,'ready');
});
test('queued wake throttle does not delay observing an already available source',async()=>{
 let f;f=fixture({health:async()=>{if(f.calls.wake)return ready;throw Error('offline');},wake:async()=>{f.calls.wake++;return{queued:true,retryAfterSeconds:15};}});await f.controller.start();assert.equal(f.calls.wake,1);assert(f.time()<115000);assert.equal(f.controller.state.phase,'ready');
});
test('edge Retry-After backs off edge calls while source readiness is still checked',async()=>{
 let f;const edgeTimes=[];f=fixture({budgetMs:35000,health:async()=>{f.calls.health++;throw Error('offline');},status:async()=>{edgeTimes.push(f.time());throw Object.assign(Error(),{retryAfterSeconds:30});}});await f.controller.start();assert.equal(edgeTimes.length,2);assert(edgeTimes[1]-edgeTimes[0]>=30000);assert(f.calls.health>edgeTimes.length);assert.equal(f.calls.wake,0);
});
test('wake failure never reports ready or sleeping; running worker never retriggers wake',async()=>{
 let f;f=fixture({budgetMs:3000,health:async()=>{throw Error();},wake:async()=>{f.calls.wake++;throw Error();}});await f.controller.start();assert.equal(f.controller.state.phase,'failed');assert(f.states.some(s=>s.phase==='offline'&&s.reasonCode==='WAKE_SERVICE_UNREACHABLE'));
 const g=fixture({budgetMs:3000,health:async()=>{throw Error();},status:async()=>({status:'running',intended:'running'})});await g.controller.start();assert.equal(g.calls.wake,0);assert.equal(g.controller.state.modelReady,false);
});
test('reachable source exposes model-loading phase and polls without waking',async()=>{
 let f;f=fixture({health:async()=>++f.calls.health<3?{phase:'model_loading',sourceReady:true,runtimeReady:true,modelReady:false}:ready});await f.controller.start();assert(f.states.some(s=>s.phase==='model_loading'&&s.sourceReady));assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
});
test('fresh model loading can outlast the measured cold hydration and finish engine load',async()=>{
 let f;f=fixture({health:async()=>{
  const elapsed=f.time()-started,observedAt=new Date(f.time()).toISOString();
  return {...(elapsed<430000?modelLoading:ready),observedAt};
 }});
 const started=f.time(),result=await f.controller.start();
 assert.equal(result.phase,'ready');assert.equal(f.time()-started,430000);
 assert(f.states.some(s=>s.phase==='model_loading'&&!s.stale&&Date.parse(s.observedAt)-started>=398750));
 assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
});
test('the first fresh model observation starts a single bounded wait',async()=>{
 let f;f=fixture({health:async()=>{
  const elapsed=f.time()-started,observedAt=new Date(f.time()).toISOString();
  if(elapsed<120000||elapsed===180000)return{phase:'starting_services',sourceReady:true,observedAt,retryAfterSeconds:60};
  return{...modelLoading,observedAt,retryAfterSeconds:60};
 }});
 const started=f.time(),result=await f.controller.start();
 assert.equal(result.reasonCode,'WAIT_TIMEOUT');assert.equal(f.time()-started,120000+990000);
 assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
});
test('stale and incomplete model observations keep the original connection timeout',async t=>{
 for(const [name,overrides] of [
  ['explicitly stale',{stale:true}],['old timestamp',{observedAt:new Date(0).toISOString()}],['unknown timestamp',{observedAt:null}],
  ['source still starting',{sourceReady:false}],['runtime still starting',{runtimeReady:false}],['missing model readiness',{modelReady:undefined}],['invalid ready phase',{phase:'ready'}],
 ])await t.test(name,async()=>{
  let f;f=fixture({health:async()=>({...modelLoading,observedAt:new Date(f.time()).toISOString(),...overrides})});
  const started=f.time(),result=await f.controller.start();
  assert.equal(result.reasonCode,'WAIT_TIMEOUT');assert.equal(f.time()-started,360000);
  assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
 });
});
test('a brief health transport outage after six minutes still allows a ready response',async()=>{
 let f;f=fixture({health:async()=>{
  const elapsed=f.time()-started,observedAt=new Date(f.time()).toISOString();
  if(elapsed===380000)throw Object.assign(Error('proxy temporarily offline'),{status:503});
  return{...(elapsed<380000?modelLoading:ready),observedAt};
 }});
 const started=f.time(),result=await f.controller.start();
 assert.equal(result.phase,'ready');assert.equal(f.time()-started,382000);
 assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
});
test('sustained transport loss cannot wait beyond the last observation or the model deadline',async t=>{
 for(const [lossAt,timeoutAt] of [[380000,408000],[980000,990000]])await t.test('transport loss at '+lossAt,async()=>{
  let f;const missed=[];
  f=fixture({health:async({timeoutMs})=>{
   const elapsed=f.time()-started;
   if(elapsed>=lossAt){missed.push({elapsed,timeoutMs});throw Error('offline');}
   return{...modelLoading,observedAt:new Date(f.time()).toISOString()};
  }});
  const started=f.time(),result=await f.controller.start();
  assert.equal(result.reasonCode,'WAIT_TIMEOUT');assert.equal(f.time()-started,timeoutAt);
  assert.equal(missed[0].elapsed,lossAt);assert.deepEqual(missed.at(-1),{elapsed:timeoutAt-2000,timeoutMs:2000});
  assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
 });
});
test('an explicit loss of verified model loading after six minutes does not use transport grace',async t=>{
 for(const phase of ['sleeping','capacity_wait','model_loading','starting_services'])await t.test(phase,async()=>{
  let f;f=fixture({health:async()=>{
   const observedAt=new Date(f.time()).toISOString();
   if(f.time()-started<380000)return{...modelLoading,observedAt};
   return{...modelLoading,phase,observedAt,stale:phase==='model_loading',runtimeReady:phase==='model_loading'};
  }});
  const started=f.time(),result=await f.controller.start();
  assert.equal(result.reasonCode,'WAIT_TIMEOUT');assert.equal(f.time()-started,380000);
  assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
 });
});
test('Stop waiting during extended model polling ignores a late ready response until manual Retry',async()=>{
 let f,releaseHealth,requestStarted;
 const inFlight=new Promise(resolve=>{requestStarted=resolve;});
 f=fixture({health:async()=>{
  f.calls.health++;
  const elapsed=f.time()-started,observedAt=new Date(f.time()).toISOString();
  if(elapsed<380000)return{...modelLoading,observedAt};
  if(!releaseHealth)return new Promise(resolve=>{releaseHealth=resolve;requestStarted();});
  return{...ready,observedAt};
 }});
 const started=f.time(),first=f.controller.start();
 await inFlight;
 assert.equal(f.controller.state.phase,'model_loading');assert.equal(f.time()-started,380000);
 f.controller.cancel();releaseHealth({...ready,observedAt:new Date(f.time()).toISOString()});
 const result=await first;
 assert.equal(result.reasonCode,'WAIT_CANCELLED');assert.equal(result.modelReady,false);
 const healthCalls=f.calls.health;await f.controller.start();
 assert.equal(f.calls.health,healthCalls);assert.equal(f.calls.provision,0);
 assert(f.states.every(state=>state.phase!=='ready'));
 assert.equal((await f.controller.start({retry:true})).phase,'ready');assert.equal(f.calls.provision,1);
 assert.equal(f.calls.status,0);assert.equal(f.calls.wake,0);
});
test('cancel ignores late nonabortable health result, does not stop backend, and remains paused until Retry',async()=>{
 let resolve;const f=fixture({health:()=>new Promise(r=>resolve=r)});const request=f.controller.start();f.controller.cancel();resolve(ready);await request;assert.equal(f.controller.state.reasonCode,'WAIT_CANCELLED');assert.equal(f.controller.state.modelReady,false);
 await f.controller.start();assert.equal(f.controller.state.reasonCode,'WAIT_CANCELLED');
 // Retry invokes a fresh request; the old transport is not allowed to publish anything.
 const retry=f.controller.start({retry:true});resolve(ready);await retry;assert.equal(f.controller.state.phase,'ready');assert.equal(f.calls.wake,0);
});
test('revoked token is cleared and not silently renewed through a paired session',async()=>{
 const f=fixture({health:async()=>{throw Error();},status:async()=>{throw Object.assign(Error(),{code:'DEVICE_REVOKED',status:401});}});await f.controller.start();assert.equal(f.controller.state.phase,'authentication_required');assert.equal(f.calls.clear,1);assert.equal(f.calls.provision,0);
});
test('expiry renews only once, failed paired renewal asks for access',async()=>{
 let provision=0;const f=fixture({health:async()=>{throw Error();},status:async()=>{throw Object.assign(Error(),{code:'DEVICE_EXPIRED',status:401});},credentials:{get:()=>token(),clear(){},provision:async()=>{provision++;throw Error('offline');}}});await f.controller.start();assert.equal(provision,1);assert.equal(f.controller.state.phase,'authentication_required');
});
function storage(){const values=new Map();return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}
test('credential adapter refuses legacy key, removes it only after scoped provisioning, and persists revocation',async()=>{
 const store=storage();store.setItem('harness.wake.key','account-wide-secret');let count=0,body;
 const adapter=createWakeCredentials({storage:store,request:async(url,options)=>{count++;body=JSON.parse(options.body);return token();}});
 assert.equal(adapter.get(),null);await adapter.provision();assert.equal(store.getItem('harness.wake.key'),null);assert.equal(body.deviceId,null);assert.equal(adapter.get().credential,token().credential);
 adapter.clear();assert.equal(adapter.get(),null);const reopened=createWakeCredentials({storage:store,request:async()=>{count++;return token();}});await assert.rejects(reopened.provision(),e=>e.code==='DEVICE_REVOKED');assert.equal(count,1);
});
test('v1 response cannot replace existing data or become a bearer credential',async()=>{
 const store=storage();store.setItem('harness.wake.key','account-wide-secret');const adapter=createWakeCredentials({storage:store,request:async()=>({key:'legacy',wakeUrl:'https://wake.example.com'})});await assert.rejects(adapter.provision(),e=>e.code==='AUTH_UPGRADE_REQUIRED');assert.equal(store.getItem('harness.wake.key'),'account-wide-secret');assert.equal(adapter.get(),null);
 for(const change of [{wakeUrl:'http://wake.example.com'},{wakeUrl:'https://wake.example.com/x'},{scope:['status','wake','stop']},{expiresAt:'invalid'},{deviceId:'../root'}])assert.throws(()=>deviceDTO({...token(),...change}));
});
test('explicit reenrollment requires a matching owner approval and never clears a tombstone on failure',async()=>{
 const store=storage();store.setItem('harness.wake.device.v2',JSON.stringify(token()));let reply={...token(),reenrollment:{deviceId:'another-device',generation:2,confirmedAt:100000}},requests=[];
 const adapter=createWakeCredentials({storage:store,request:async(route,options)=>{requests.push({route,body:JSON.parse(options.body)});return reply;}});adapter.clear();assert.equal(adapter.identity().revoked,true);await assert.rejects(adapter.provision(),e=>e.code==='DEVICE_REVOKED');assert.equal(requests.length,0);
 await assert.rejects(adapter.claimReenrollment(),e=>e.code==='DEVICE_REENROLLMENT_REQUIRED');assert.equal(adapter.get(),null);assert.equal(adapter.identity().revoked,true);
 reply={...token(),reenrollment:{deviceId:token().deviceId,generation:2,confirmedAt:100000}};await adapter.claimReenrollment();assert.equal(adapter.get().deviceId,token().deviceId);assert.equal(adapter.identity().revoked,false);assert(requests.every(r=>r.route==='/phone/api/devices/claim-reenrollment'&&r.body.deviceId===token().deviceId));
});
test('a late provisioning response cannot erase a newer local revocation',async()=>{
 const store=storage();store.setItem('harness.wake.device.v2',JSON.stringify(token()));let resolve;const adapter=createWakeCredentials({storage:store,request:()=>new Promise(r=>resolve=r)});const provisioning=adapter.provision();adapter.clear();resolve(token());await assert.rejects(provisioning,e=>e.code==='DEVICE_REVOKED');assert.equal(adapter.identity().revoked,true);assert.equal(adapter.get(),null);
});
test('only a completely fresh device can attempt owner Tailscale entry once after pairing 401',async()=>{
 const store=storage(),calls=[];let provisions=0;const adapter=createWakeCredentials({storage:store,request:async route=>{calls.push(route);if(route==='/phone/api/wake-credential'&&++provisions===1)throw Object.assign(Error(),{status:401,code:'PAIRING_REQUIRED'});return route==='/phone/api/wake-credential'?token():{authorized:true};}});await adapter.provision();assert.deepEqual(calls,['/phone/api/wake-credential','/phone/api/tailscale-login','/phone/api/wake-credential']);
 adapter.clear();await assert.rejects(adapter.provision(),e=>e.code==='DEVICE_REVOKED');assert.equal(calls.length,3);
});
test('a revoked pairing response persists its verified device ID even after client storage was cleared',async()=>{
 const store=storage(),deviceId='11111111-2222-4333-8444-555555555555',calls=[];const adapter=createWakeCredentials({storage:store,request:async route=>{calls.push(route);throw Object.assign(Error(),{status:401,code:'DEVICE_REVOKED',deviceId});}});await assert.rejects(adapter.provision(),e=>e.code==='DEVICE_REVOKED');assert.deepEqual(adapter.identity(),{deviceId,revoked:true});await assert.rejects(adapter.provision(),e=>e.code==='DEVICE_REVOKED');assert.equal(calls.length,1);
});
