// In-memory actual driver/runner/adapter/writer/finalizer composition only.
// Synthetic HTTP events, identities, proofs and FS; no socket or model is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {composeFirstB03} from './driver-core.mjs';
import {createRootIOAdapter} from './adapter.mjs';
import {runPrimary,readOwnObservation,collectorIdentity,finishAcceptance,criteria} from './runner.mjs';
import {createRootLifecycle,bindLifecycleClock} from './lifecycle.mjs';
import {createRootFinalizer} from '../n06-finalization/frozen/n06-root-finalizer-20261117/finalizer.mjs';
import {createRootBindings} from '../n06-finalization/frozen/n06-root-bindings-20261117/bindings.mjs';
import {Clock,MemoryFS,target,dependencies,syntheticRecord,options} from './fixtures.mjs';
import {classify} from '../../development/ci/inventory.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceCommit='a'.repeat(40);
async function composition({refuseCritical=false,observerStatuses=[],observerMethod='session/state',observerError=null,firstReadDelayMs=0,abortOnBackoff=false,completionMs=15000}={}){
 const clock=new Clock(),memory=new MemoryFS(),began=clock.now(),log=[],checkpoints=[],own={...target,scenario:'B03',variant:'HomeAI',projectRoot:'/synthetic/project',preparedFixtureEvidence:'synthetic-fixture',modelSelection:{provider:'synthetic-provider',model:'synthetic-model'},sessionUrl:null};
 const record=syntheticRecord(),prompt=Buffer.from('Synthetic composition text; not a benchmark prompt');record.identity.promptSha256=hash(prompt);
 let submitted=false,archived=false,ready=false,requestId,observerResponses=0,errorInjected=false;const rpcCalls=[],outerAbort=new AbortController();
 const history=[{seq:0,type:'session/context',data:{}}];
 const add=(type,data)=>history.push({seq:history.length,type,data});
 const state=()=>{
  if(submitted&&!ready&&clock.now()-began>=completionMs){ready=true;add('turn/end',{reason:{kind:'completed'}});}
  return{active:true,cursor:history.at(-1).seq,running:submitted&&!ready,queue:[],pendingInput:[]};
 };
 // This is EventEmitter transport injection, not a loopback listener or HTTP request.
 const request=(settings,respond)=>{
  assert.equal(settings.hostname,'127.0.0.1');assert.equal(settings.port,3090);
  const req=new EventEmitter();req.destroy=()=>{};
  req.end=bytes=>queueMicrotask(()=>{
   const envelope=JSON.parse(bytes),method=envelope.method,data=envelope.payload.args.request;log.push(method);
   assert.equal(data.sessionId??data.address?.sessionId,own.sessionId);
   if(submitted&&method===observerMethod&&observerResponses<observerStatuses.length){
    const status=observerStatuses[observerResponses++];if(observerResponses===1)clock.advance(firstReadDelayMs);
    if(status!==200){const res=new EventEmitter();res.statusCode=status;res.destroy=()=>{};
     Object.defineProperty(res,'headers',{get(){throw Error('Non-200 headers must not be inspected');}});respond(res);return;}
   }
   let value;
   if(method==='session/state')value=state();
   else if(method==='session/page'){const rows=history.filter(e=>e.seq<=data.throughSeq&&e.seq<(data.beforeSeq??Infinity)).slice(-64);value={records:rows.map(event=>({type:'event',event})),hasMore:rows[0].seq>0};}
   else if(method==='session/prompt'){
    assert.equal(checkpoints[0].phase,'intent');assert.equal(checkpoints[0].receipt.durable,true);submitted=true;requestId=data.requestId;
    add('turn/start',{});add('request/header',{header:{config:own.modelSelection}});
    add('tool/call',{callId:'synthetic-cwd-call',name:'working_directory',arguments:JSON.stringify({cd:own.projectRoot})});
    add('tool/result',{message:{role:'tool',toolCallId:'synthetic-cwd-call',source:{kind:'tool',callId:'synthetic-cwd-call'},content:[{type:'text',text:own.projectRoot}]}});value={accepted:true};
   }else if(method==='session/cancel'){if(!ready){ready=true;add('turn/end',{reason:{kind:'aborted',reason:{kind:'user'}}});}value={accepted:true};}else throw Error('Unexpected synthetic RPC');
   const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};respond(res);res.emit('data',Buffer.from(JSON.stringify({result:{ok:true,value}})));res.emit('end');
  });return req;
 };
 const bounded=async(fn,deadline,signal)=>{assert(clock.now()<deadline);assert(!signal?.aborted);return fn({deadline,signal:signal??new AbortController().signal});};
 const modelClock={now:clock.now,sleep:async ms=>{if(abortOnBackoff&&observerResponses&&ms<=100)outerAbort.abort('Synthetic stop during read backoff');clock.advance(ms);},bound:bounded};
 const native={target:own,jobsSnapshot:async()=>[],projections:async()=>({kind:'sequenced',asOfSeq:state().cursor,values:{subagentCatalog:[]}}),terminals:async()=>[],killJob:async()=>{throw Error('Unexpected kill');},followJob:async()=>{throw Error('Unexpected follow');}};
 const closed={version:1,sessionId:own.sessionId,state:'closed',workSettled:true};
 const check=input=>{assert(clock.now()<input.deadline);assert(!input.signal?.aborted);};
 const proof=()=>({...own,version:1,sourceCommit,mode:'host-compat',profileSha256:'b'.repeat(64),tupleSha256:'d'.repeat(64),ownedRangeProvider:true,preview:closed});
 const runtime={ownerHost:'synthetic.invalid',ownerCookie:'synthetic-test-value',WebSocket:class{},
  assertTarget:async input=>{check(input);assert.equal(archived,false);},
  assertArchiveRuntime:async input=>{check(input);return proof();},
  attest:async input=>{check(input);return proof();},
  previewStatus:async input=>{check(input);assert.equal(archived,false);return closed;},
  previewClose:async input=>{check(input);return closed;},
  archiveRPC:async(method,args,input)=>{check(input);assert.equal(args.request.sessionId,own.sessionId);log.push(method);archived=method==='workspace/archiveSession';return{archivedSessionIds:archived?[own.sessionId]:[]};},
  preflight:async()=>({quiet:true,mode:'host-compat',sourceCommit,runtimeCommit:sourceCommit,workspaceId:own.workspaceId,fixtureEvidence:own.preparedFixtureEvidence,modelSelection:own.modelSelection,modelSelectionEvidence:'synthetic',preview:{supported:true,evidence:'synthetic'}}),
 };
 const modules={runPrimary,readOwnObservation,collectorIdentity,finishAcceptance,bindLifecycleClock,realClock:()=>modelClock,
  createRootIOAdapter:config=>{
   assert.equal(config.checkpointBudgetBytes,67108864);assert.equal(config.checkpointBudgetCount,2048);
   const adapter=createRootIOAdapter(config,{...dependencies(memory,clock),request});
   return{rpc:async(method,data,options)=>{
    rpcCalls.push({method,deadline:options.deadline,at:clock.now(),signal:options.signal});
    if(submitted&&observerError&&method===observerMethod&&!errorInjected){errorInjected=true;throw Object.assign(Error('Private synthetic error text'),{body:'Private synthetic response body',headers:{Cookie:'Private synthetic credential'},...observerError});}
    return adapter.rpc(method,data,options);
   },checkpoint:async(row,options)=>{
    if(refuseCritical&&options.critical==='finalizer')memory.fail='file.sync:'+config.checkpointDirectory+'/'+options.checkpointId+'.json';
    const receipt=await adapter.checkpoint(row,options);checkpoints.push({phase:options.phase,critical:options.critical,receipt});return receipt;
   }};
  },
  createNativeLifecycleTransport:()=>native,
  createRootLifecycle:(a,b)=>createRootLifecycle(a,b,{now:clock.now}),
  createRootBindings:(a,b)=>createRootBindings(a,b,{now:clock.now}),
  createRootFinalizer:(a,b)=>createRootFinalizer(a,b,{now:clock.now,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout}),
 };
 const driver=composeFirstB03({target:own,sourceCommit,checkpointDirectory:'/synthetic/attemptA',record,inputs:{verify:async()=>({unchanged:true,prompt})},runtime,modules,signal:outerAbort.signal,
  handoff:{liveAuthorized:true,rootOperator:true,id:'synthetic-source-test',sourceCommit,runtimeCommit:sourceCommit,orderPosition:1,previousRuns:[],settlementObservationMs:120000}},{setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout});
 const result=await driver.run();
 return{driver,result,clock,memory,checkpoints,log,rpcCalls,own,sourceCommit,history,get archived(){return archived;},get requestId(){return requestId;}};
}
function report(f){const at=f.clock.now();return{
 collectorIdentity:collectorIdentity(f.result),checks:criteria.B03.map(id=>({id,status:'PASS',evidence:['synthetic criterion; no QA execution']})),
 previewUrl:'https://synthetic.invalid/app/',previewEvidence:'synthetic',artifactEvidence:'synthetic',reopenInstructions:'synthetic',
 validationStartedAt:new Date(at).toISOString(),finishedAt:new Date(at).toISOString(),qaWorkSettledAt:new Date(at).toISOString(),qaWorkSettlementEvidence:'synthetic controlled collector',
 provider:f.own.modelSelection.provider,effectiveModel:f.own.modelSelection.model,effectiveInferenceEvidence:'synthetic header',sourceCommit,runtimeCommit:sourceCommit,
};}
test('actual public driver, sampling adapter, writer and r4 lifecycle compose honest skips with durable archive/final/acceptance chain',async()=>{
 const f=await composition();assert.equal(f.result.blockingPhase,'independent_acceptance');assert.equal(f.result.operator.persistenceFailed,undefined);
 const skips=f.checkpoints.filter(r=>r.receipt.skipped);assert(skips.length>10);assert(skips.every(r=>r.phase==='observation'&&!r.critical&&r.receipt.durable===false));
 const firstFinal=f.checkpoints.filter(r=>r.phase==='final').at(-1);assert.equal(f.result.operator.persistence.lastDurableCheckpointId,firstFinal.receipt.checkpointId);
 const accepted=await f.driver.finish(report(f));assert.equal(accepted.status,'PASS');assert.equal(accepted.rootFinalization.status,'SETTLED_VISIBLE');assert.equal(accepted.rootFinalization.persistence.durable,true);assert.equal(f.archived,false);
 assert.equal(f.log.filter(m=>m==='session/prompt').length,1);assert.equal(f.log.filter(m=>m==='workspace/archiveSession').length,1);assert.equal(f.log.filter(m=>m==='workspace/unarchiveSession').length,1);
 const durable=f.checkpoints.filter(r=>r.receipt.durable);assert.deepEqual(durable.filter(r=>r.phase==='intent'||r.phase==='final'||r.critical).map(r=>[r.phase,r.critical??null]),[['intent',null],['final',null],['observation','finalizer'],['final',null]]);
 let previous=null;for(const cp of durable){const envelope=JSON.parse(f.memory.nodes.get('/synthetic/attemptA/'+cp.receipt.checkpointId+'.json').bytes);assert.equal(envelope.previousCheckpointId,previous);assert.equal(envelope.snapshotSha256,hash(JSON.stringify(envelope.snapshot)));previous=cp.receipt.checkpointId;}
 assert.equal(previous,accepted.operator.persistence.lastDurableCheckpointId);assert.equal(Date.parse(accepted.operator.primaryDeadlineAt)-Date.parse(accepted.timestampsUtc.submittedAt),600000);
 assert.deepEqual(accepted.nativeObservation.events,f.history.slice(1));await assert.rejects(()=>f.driver.run(),/DRIVER_ONCE_ONLY/);
});
test('actual composed cleanup IO failure cannot accept or silently skip critical finalization evidence',async()=>{
 const f=await composition({refuseCritical:true});await assert.rejects(()=>f.driver.finish(report(f)),/ROOT_FINALIZER_HOLD/);
 assert.equal(f.checkpoints.filter(r=>r.phase==='final').length,1);assert.equal(f.log.filter(m=>m==='session/prompt').length,1);
});
test('non-200 RPC diagnostics expose only fixed method/status, close handles and never retry permanent or transient statuses',async()=>{
 for(const method of ['session/state','session/page'])for(const status of [400,401,403,404,415,500,503]){
  const memory=new MemoryFS(),clock=new Clock();let requests=0,requestClosed=false,responseClosed=false;
  const adapter=createRootIOAdapter(options(),{...dependencies(memory,clock),request:(settings,respond)=>{
   requests++;assert.equal(settings.path,'/api/'+method);const req=new EventEmitter();req.destroy=()=>{requestClosed=true;};
   req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.destroy=()=>{responseClosed=true;};Object.defineProperty(res,'headers',{get(){throw Error('Headers are private and not needed');}});respond(res);});return req;
  }});
  const data=method==='session/state'?{sessionId:target.sessionId}:{address:{kind:'session',sessionId:target.sessionId},throughSeq:0,maxMessages:64};
  await assert.rejects(()=>adapter.rpc(method,data,{deadline:clock.now()+4000}),error=>{
   assert.equal(error.code,'RPC_HTTP_STATUS');assert.equal(error.message,'RPC_HTTP_STATUS');
   assert.deepEqual({...error},{code:'RPC_HTTP_STATUS',rpcMethod:method,httpStatus:status});return true;
  });
  assert.equal(requests,1);assert.equal(requestClosed,true);assert.equal(responseClosed,true);assert.equal(clock.pending.size,0);assert.equal(memory.events.length,0);
 }
});
test('actual runner/adapter composition retains state/page HTTP failure context in durable final BLOCKED without another prompt',async()=>{
 for(const [method,status]of [['session/state',401],['session/page',503]]){
  const f=await composition({observerStatuses:status===503?[503,503]:[status],observerMethod:method});
  assert.equal(f.result.status,'BLOCKED');assert.equal(f.result.statusReason,'observation_unconfirmed');assert.equal(f.result.operator.finalized,true);
  assert.equal(f.result.nativeObservation.settled,true);assert.equal(f.result.nativeObservation.cancelAcknowledged,true);
  assert.equal(f.result.nativeObservation.observationError,'RPC_HTTP_STATUS');
  const expected={code:'RPC_HTTP_STATUS',rpcMethod:method,httpStatus:status};
  assert.deepEqual(f.result.nativeObservation.observationErrorContext,expected);
  assert.equal(f.log.filter(m=>m==='session/prompt').length,1);
  // Existing runner cancellation plus bindings.cancelOwned; neither resubmits the prompt.
  assert.equal(f.log.filter(m=>m==='session/cancel').length,2);
  const failed=f.log.indexOf(method,f.log.indexOf('session/prompt')+1);assert(failed>=0);assert.equal(f.log[failed+(status===503?2:1)],'session/cancel');
  const final=f.checkpoints.filter(row=>row.phase==='final').at(-1);assert.equal(final.receipt.durable,true);
  const envelope=JSON.parse(f.memory.nodes.get('/synthetic/attemptA/'+final.receipt.checkpointId+'.json').bytes);
  assert.equal(envelope.snapshot.status,'BLOCKED');assert.deepEqual(envelope.snapshot.nativeObservation.observationErrorContext,expected);
 }
});
test('only a method-matched 503 read retries once, under the same deadline/signal and with durable success provenance',async()=>{
 for(const method of ['session/state','session/page']){
  const f=await composition({observerStatuses:[503],observerMethod:method});
  assert.equal(f.result.blockingPhase,'independent_acceptance');assert.equal(f.result.stopReason,null);assert.equal(f.result.nativeObservation.observationError,undefined);
  const expected={attempts:[{method,firstStatus:503,attemptCount:2,retryOutcome:'succeeded'}],omitted:0};
  assert.deepEqual(f.result.nativeObservation.observationRpcRetries,expected);assert.equal(f.log.filter(m=>m==='session/prompt').length,1);assert.equal(f.log.filter(m=>m==='session/cancel').length,0);
  const p=f.rpcCalls.findIndex(row=>row.method==='session/prompt'),reads=f.rpcCalls.slice(p+1).filter(row=>row.method===method);
  assert.equal(reads[0].deadline,reads[1].deadline);assert.equal(reads[1].at-reads[0].at,100);
  // StopScope composes distinct per-call signals, both linked to the same owner stop.
  assert.equal(reads[0].signal.aborted,false);assert.equal(reads[1].signal.aborted,false);
  const final=f.checkpoints.filter(row=>row.phase==='final').at(-1),envelope=JSON.parse(f.memory.nodes.get('/synthetic/attemptA/'+final.receipt.checkpointId+'.json').bytes);
  assert.deepEqual(envelope.snapshot.nativeObservation.observationRpcRetries,expected);
  f.driver.stop();assert.equal(reads[0].signal.aborted,true);assert.equal(reads[1].signal.aborted,true);
 }
 for(const status of [400,401,403,404,415,500]){
  const f=await composition({observerStatuses:[status]});assert.equal(f.result.status,'BLOCKED');assert.equal(f.result.nativeObservation.observationErrorContext.httpStatus,status);
  assert.equal(f.result.nativeObservation.observationRpcRetries,undefined);
  const failed=f.log.indexOf('session/state',f.log.indexOf('session/prompt')+1);assert.equal(f.log[failed+1],'session/cancel');
 }
});
test('failed second read is not retried again; deadline/Stop during backoff prevents second dispatch and records attemptCount one',async()=>{
 const failed=await composition({observerStatuses:[503,500]});assert.equal(failed.result.status,'BLOCKED');
 assert.equal(failed.result.nativeObservation.observationErrorContext.httpStatus,500);
 assert.deepEqual(failed.result.nativeObservation.observationRpcRetries,{attempts:[{method:'session/state',firstStatus:503,attemptCount:2,retryOutcome:'failed'}],omitted:0});
 const at=failed.log.indexOf('session/state',failed.log.indexOf('session/prompt')+1);assert.deepEqual(failed.log.slice(at,at+3),['session/state','session/state','session/cancel']);
 for(const settings of [{firstReadDelayMs:3950},{abortOnBackoff:true}]){
  const f=await composition({observerStatuses:[503],...settings});assert.equal(f.result.status,'BLOCKED');
  assert.deepEqual(f.result.nativeObservation.observationRpcRetries,{attempts:[{method:'session/state',firstStatus:503,attemptCount:1,retryOutcome:'not_dispatched'}],omitted:0});
  const at=f.log.indexOf('session/state',f.log.indexOf('session/prompt')+1);assert.equal(f.log[at+1],'session/cancel');
  assert.equal(f.log.filter(m=>m==='session/prompt').length,1);assert.equal(Date.parse(f.result.operator.primaryDeadlineAt)-Date.parse(f.result.timestampsUtc.submittedAt),600000);
 }
});
test('retry provenance is bounded at 64 entries with explicit omissions rather than hiding successful rereads',async()=>{
 const f=await composition({observerStatuses:Array.from({length:66},()=>[503,200]).flat(),completionMs:50000});
 const rows=f.result.nativeObservation.observationRpcRetries;assert.equal(rows.attempts.length,64);assert.equal(rows.omitted,2);
 assert(rows.attempts.every(row=>row.method==='session/state'&&row.firstStatus===503&&row.attemptCount===2&&row.retryOutcome==='succeeded'));
 assert.equal(f.result.blockingPhase,'independent_acceptance');assert.equal(f.log.filter(m=>m==='session/prompt').length,1);
});
test('transport/parse/remote/credential failures and malformed or foreign HTTP context never enter the retry branch or copy private properties',async()=>{
 for(const error of [
  ...['RPC_TRANSPORT_FAILED','RPC_RESPONSE_INVALID','RPC_REMOTE_REJECTED','RPC_CREDENTIAL_ECHO'].map(code=>({code,rpcMethod:'session/state',httpStatus:503})),
  {code:'RPC_HTTP_STATUS',rpcMethod:'session/prompt',httpStatus:503},
  {code:'RPC_HTTP_STATUS',rpcMethod:'session/state',httpStatus:'503'},
 ]){
  const f=await composition({observerError:error});assert.equal(f.result.status,'BLOCKED');assert.equal(f.result.nativeObservation.observationError,error.code);
  assert.equal(f.result.nativeObservation.observationRpcRetries,undefined);
  const at=f.rpcCalls.findIndex((row,i)=>row.method==='session/state'&&i>f.rpcCalls.findIndex(r=>r.method==='session/prompt'));
  assert.equal(f.rpcCalls[at+1].method,'session/cancel');assert(!JSON.stringify(f.result).includes('Private synthetic'));
  if(error.code==='RPC_HTTP_STATUS'&&error.rpcMethod==='session/state')assert.deepEqual(f.result.nativeObservation.observationErrorContext,{code:'RPC_HTTP_STATUS',rpcMethod:'session/state',httpStatus:null});
  else assert.equal(f.result.nativeObservation.observationErrorContext,undefined);
 }
});
test('published generic modules are byte-pinned; historical eight-source closure is unchanged',async()=>{
 const current={
  'driver-core.mjs':'0b5e666bb1d2143f8d08130861d8ff6d16638b9046aeec905ca705db1f647922',
  'stop-scope.mjs':'8768d4a17a384baf964fee8fbcab2122293c14caf6ba4de1ef22a15c288e0e72',
  'adapter.mjs':'3dc9dae4b47fd6e0846bf34dbf0fab102a1eebbf55781269dbfe67f779d2bb16',
  'runner.mjs':'3d4840bd0f5e31778bef9b5be60ece8295899a11f930fb66145dd786e5a39dd8',
  'finalization.mjs':'e6c25073472114777fcf9c32db0054b33fbae29ab9dfbc5df3c86157d62f443e',
  'lifecycle.mjs':'21d75d10d59bba22564a9d1758f2817bb345d438854346f9105404d1d170bea7',
  'native-transport.mjs':'11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026',
 };
 const historical={
  'stop-scope.mjs':'8768d4a17a384baf964fee8fbcab2122293c14caf6ba4de1ef22a15c288e0e72',
  'finalization.mjs':'2022572c64adf839b0303391d0edaa21b02373532000b96dd43cf524c652ba53',
  'frozen/n06-pilots-b-20261117-r2/runner.mjs':'23ec97da879503c004607271e18703f1de417762129dfe190216a665562a1dbd',
  'frozen/n06-root-finalizer-20261117/finalizer.mjs':'9100ec8f0dee5982c58463fe9c01c624ffe58c7d59e2d5d6c97f13406df63e80',
  'frozen/n06-root-lifecycle-20261117-r3/lifecycle.mjs':'583f7d9c502333f2475e25e7180f0738fe3c9101a805d9a3794cb2c6229f272a',
  'frozen/n06-root-bindings-20261117/bindings.mjs':'17a49477afe215a730ef17c06f0a5b6851151f3bab8625d45658ec7752771d3a',
  'frozen/n06-root-lifecycle-20261117-r2/native-transport.mjs':'11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026',
  'frozen/n06-root-lifecycle-20261117-r3/native-transport.mjs':'11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026',
 };
 for(const[name,sha]of Object.entries(current))assert.equal(hash(await fs.readFile(new URL(name,import.meta.url))),sha,name);
 for(const[name,sha]of Object.entries(historical))assert.equal(hash(await fs.readFile(new URL('../n06-finalization/'+name,import.meta.url))),sha,name);
});
test('CI requires all three portable source suites and preserves historical benchmark exclusion',()=>{
 for(const[name,count]of [['checkpoint',10],['lifecycle',5],['composition',10]]){
  const row=classify('benchmarks/n06-evidence-storage/'+name+'.test.mjs');assert.equal(row.required,true);assert.equal(row.kind,'node');assert.equal(row.lane,'portable');assert.equal(row.minTests,count);
 }
 assert.equal(classify('benchmarks/n06-finalization/finalization.test.mjs').minTests,13);
 for(const[name,count]of [['composition',7],['contracts',10]]){
  const row=classify('benchmarks/b10-next-pair-source/'+name+'.test.mjs');assert.equal(row.required,true);assert.equal(row.kind,'node');assert.equal(row.lane,'portable');assert.equal(row.minTests,count);
 }
 assert.equal(classify('benchmarks/unrelated-history.test.mjs').required,false);
});
