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
import {Clock,MemoryFS,target,dependencies,syntheticRecord} from './fixtures.mjs';
import {classify} from '../../development/ci/inventory.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceCommit='a'.repeat(40);
async function composition({refuseCritical=false}={}){
 const clock=new Clock(),memory=new MemoryFS(),began=clock.now(),log=[],checkpoints=[],own={...target,scenario:'B03',variant:'HomeAI',projectRoot:'/synthetic/project',preparedFixtureEvidence:'synthetic-fixture',modelSelection:{provider:'synthetic-provider',model:'synthetic-model'},sessionUrl:null};
 const record=syntheticRecord(),prompt=Buffer.from('Synthetic composition text; not a benchmark prompt');record.identity.promptSha256=hash(prompt);
 let submitted=false,archived=false,ready=false,requestId;
 const history=[{seq:0,type:'session/context',data:{}}];
 const add=(type,data)=>history.push({seq:history.length,type,data});
 const state=()=>{
  if(submitted&&!ready&&clock.now()-began>=15000){ready=true;add('turn/end',{reason:{kind:'completed'}});}
  return{active:true,cursor:history.at(-1).seq,running:submitted&&!ready,queue:[],pendingInput:[]};
 };
 // This is EventEmitter transport injection, not a loopback listener or HTTP request.
 const request=(settings,respond)=>{
  assert.equal(settings.hostname,'127.0.0.1');assert.equal(settings.port,3090);
  const req=new EventEmitter();req.destroy=()=>{};
  req.end=bytes=>queueMicrotask(()=>{
   const envelope=JSON.parse(bytes),method=envelope.method,data=envelope.payload.args.request;log.push(method);
   assert.equal(data.sessionId??data.address?.sessionId,own.sessionId);
   let value;
   if(method==='session/state')value=state();
   else if(method==='session/page'){const rows=history.filter(e=>e.seq<=data.throughSeq&&e.seq<(data.beforeSeq??Infinity)).slice(-64);value={records:rows.map(event=>({type:'event',event})),hasMore:rows[0].seq>0};}
   else if(method==='session/prompt'){
    assert.equal(checkpoints[0].phase,'intent');assert.equal(checkpoints[0].receipt.durable,true);submitted=true;requestId=data.requestId;
    add('turn/start',{});add('request/header',{header:{config:own.modelSelection}});
    add('tool/call',{callId:'synthetic-cwd-call',name:'working_directory',arguments:JSON.stringify({cd:own.projectRoot})});
    add('tool/result',{message:{role:'tool',toolCallId:'synthetic-cwd-call',source:{kind:'tool',callId:'synthetic-cwd-call'},content:[{type:'text',text:own.projectRoot}]}});value={accepted:true};
   }else if(method==='session/cancel')value={accepted:true};else throw Error('Unexpected synthetic RPC');
   const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};respond(res);res.emit('data',Buffer.from(JSON.stringify({result:{ok:true,value}})));res.emit('end');
  });return req;
 };
 const bounded=async(fn,deadline,signal)=>{assert(clock.now()<deadline);assert(!signal?.aborted);return fn({deadline,signal:signal??new AbortController().signal});};
 const modelClock={now:clock.now,sleep:async ms=>clock.advance(ms),bound:bounded};
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
   return{rpc:adapter.rpc,checkpoint:async(row,options)=>{
    if(refuseCritical&&options.critical==='finalizer')memory.fail='file.sync:'+config.checkpointDirectory+'/'+options.checkpointId+'.json';
    const receipt=await adapter.checkpoint(row,options);checkpoints.push({phase:options.phase,critical:options.critical,receipt});return receipt;
   }};
  },
  createNativeLifecycleTransport:()=>native,
  createRootLifecycle:(a,b)=>createRootLifecycle(a,b,{now:clock.now}),
  createRootBindings:(a,b)=>createRootBindings(a,b,{now:clock.now}),
  createRootFinalizer:(a,b)=>createRootFinalizer(a,b,{now:clock.now,setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout}),
 };
 const driver=composeFirstB03({target:own,sourceCommit,checkpointDirectory:'/synthetic/attemptA',record,inputs:{verify:async()=>({unchanged:true,prompt})},runtime,modules,
  handoff:{liveAuthorized:true,rootOperator:true,id:'synthetic-source-test',sourceCommit,runtimeCommit:sourceCommit,orderPosition:1,previousRuns:[],settlementObservationMs:120000}},{setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout});
 const result=await driver.run();
 return{driver,result,clock,memory,checkpoints,log,own,sourceCommit,history,get archived(){return archived;},get requestId(){return requestId;}};
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
test('published generic modules are byte-pinned; historical eight-source closure is unchanged',async()=>{
 const current={
  'driver-core.mjs':'0b5e666bb1d2143f8d08130861d8ff6d16638b9046aeec905ca705db1f647922',
  'stop-scope.mjs':'8768d4a17a384baf964fee8fbcab2122293c14caf6ba4de1ef22a15c288e0e72',
  'adapter.mjs':'1b3ecb581e6eb88124b0f84223d7e6adca22dd3be4854c17e20bbba868931f36',
  'runner.mjs':'2202c63649287677a0ca18eccb4546274fb3459550283b6c679eb37d796d7696',
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
 for(const[name,count]of [['checkpoint',10],['lifecycle',5],['composition',4]]){
  const row=classify('benchmarks/n06-evidence-storage/'+name+'.test.mjs');assert.equal(row.required,true);assert.equal(row.kind,'node');assert.equal(row.lane,'portable');assert.equal(row.minTests,count);
 }
 assert.equal(classify('benchmarks/n06-finalization/finalization.test.mjs').minTests,13);
 assert.equal(classify('benchmarks/unrelated-history.test.mjs').required,false);
});
