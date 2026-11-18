// In-memory actual driver/runner/adapter/writer/finalizer composition only.
// Synthetic HTTP events, identities, proofs and FS; no socket or model is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {composeB02} from './driver.mjs';
import {boundSlot,syntheticReport} from './test-fixtures.mjs';
import {serviceCommit,frozen} from './spec.mjs';
import {createRootIOAdapter} from '../n06-evidence-storage/adapter.mjs';
import {runPrimary,readOwnObservation,collectorIdentity,finishAcceptance,criteria} from './runner.mjs';
import {createRootLifecycle,bindLifecycleClock} from '../n06-evidence-storage/lifecycle.mjs';
import {createRootFinalizer} from '../n06-finalization/frozen/n06-root-finalizer-20261117/finalizer.mjs';
import {createRootBindings} from '../n06-finalization/frozen/n06-root-bindings-20261117/bindings.mjs';
import {Clock,MemoryFS,target,dependencies,syntheticRecord,options} from '../n06-evidence-storage/fixtures.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceCommit=serviceCommit;
async function composition({refuseCritical=false,observerStatuses=[],observerMethod='session/state',observerError=null,firstReadDelayMs=0,abortOnBackoff=false,completionMs=15000,variant='DS',missingRestart=false}={}){
 const {slot,previousRuns}=boundSlot(variant);
 const clock=Object.assign(new Clock(),{time:1700010000000}),memory=new MemoryFS(),began=clock.now(),log=[],checkpoints=[],own=slot.target;
 const record=JSON.parse(await fs.readFile(new URL((variant==='DS'?'ds-first':'homeai-second')+'/primary.record.json',import.meta.url)));
 Object.assign(record,{pairId:slot.pairId,runId:slot.runId,attemptId:slot.attemptId});
 const prompt=Buffer.from('Synthetic B02 composition input; not a benchmark prompt');record.identity.promptSha256=hash(prompt);
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
  restartPreview:async input=>{check(input);const before={version:1,state:'ready',sessionId:own.sessionId,previewId:'synthetic-preview',jobId:'synthetic-job1',generation:'synthetic-generation1',url:'https://synthetic.invalid/',expiresAt:began+900000};return{requestId:'synthetic-restart',before,after:{...before,jobId:'synthetic-job2',generation:'synthetic-generation2'}};},
  assertTarget:async input=>{check(input);assert.equal(archived,false);},
  assertArchiveRuntime:async input=>{check(input);return proof();},
  attest:async input=>{check(input);return proof();},
  previewStatus:async input=>{check(input);assert.equal(archived,false);return closed;},
  previewClose:async input=>{check(input);return closed;},
  archiveRPC:async(method,args,input)=>{check(input);assert.equal(args.request.sessionId,own.sessionId);log.push(method);archived=method==='workspace/archiveSession';return{archivedSessionIds:archived?[own.sessionId]:[]};},
  preflight:async()=>({quiet:true,mode:'host-compat',sourceCommit,runtimeCommit:sourceCommit,workspaceId:own.workspaceId,fixtureEvidence:own.preparedFixtureEvidence,modelSelection:own.modelSelection,modelSelectionEvidence:'synthetic',preview:{supported:true,evidence:'synthetic'},restart:missingRestart?null:{supported:true,evidence:'synthetic'}}),
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
 const driver=composeB02({slot,previousRuns,record,inputs:{verify:async()=>({unchanged:true,prompt})},runtime,modules,signal:outerAbort.signal,
  handoff:{liveAuthorized:true,rootOperator:true,id:'synthetic-source-test',sourceCommit,runtimeCommit:sourceCommit,orderPosition:slot.orderPosition,settlementObservationMs:120000}},{setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout});
 const result=await driver.run();
 return{driver,result,clock,memory,checkpoints,log,rpcCalls,own,sourceCommit,history,get archived(){return archived;},get requestId(){return requestId;}};
}
const report=syntheticReport;

test('actual public driver, sampling adapter, writer and r4 lifecycle compose honest skips with durable archive/final/acceptance chain',async()=>{
 const f=await composition();assert.equal(f.result.blockingPhase,'independent_acceptance');assert.equal(f.result.operator.persistenceFailed,undefined);
 const skips=f.checkpoints.filter(r=>r.receipt.skipped);assert(skips.length>10);assert(skips.every(r=>r.phase==='observation'&&!r.critical&&r.receipt.durable===false));
 const firstFinal=f.checkpoints.filter(r=>r.phase==='final').at(-1);assert.equal(f.result.operator.persistence.lastDurableCheckpointId,firstFinal.receipt.checkpointId);
 const accepted=await f.driver.finish(await report(f));assert.equal(accepted.status,'PASS');assert.equal(accepted.rootFinalization.status,'SETTLED_VISIBLE');assert.equal(accepted.rootFinalization.persistence.durable,true);assert.equal(f.archived,false);
 assert.equal(accepted.quality.b02Ordering.length,8);assert.equal(accepted.quality.b02Restart.kind,'B02_OWN_CATALOG_RESTART');
 assert.equal(f.log.filter(m=>m==='session/prompt').length,1);assert.equal(f.log.filter(m=>m==='workspace/archiveSession').length,1);assert.equal(f.log.filter(m=>m==='workspace/unarchiveSession').length,1);
 const durable=f.checkpoints.filter(r=>r.receipt.durable);assert.deepEqual(durable.filter(r=>r.phase==='intent'||r.phase==='final'||r.critical).map(r=>[r.phase,r.critical??null]),[['intent',null],['final',null],['observation','finalizer'],['final',null]]);
 let previous=null;for(const cp of durable){const envelope=JSON.parse(f.memory.nodes.get('/synthetic/attemptA/'+cp.receipt.checkpointId+'.json').bytes);assert.equal(envelope.previousCheckpointId,previous);assert.equal(envelope.snapshotSha256,hash(JSON.stringify(envelope.snapshot)));previous=cp.receipt.checkpointId;}
 assert.equal(previous,accepted.operator.persistence.lastDurableCheckpointId);assert.equal(Date.parse(accepted.operator.primaryDeadlineAt)-Date.parse(accepted.timestampsUtc.submittedAt),900000);
 assert.deepEqual(accepted.nativeObservation.events,f.history.slice(1));await assert.rejects(()=>f.driver.run(),/DRIVER_ONCE_ONLY/);
});
test('actual composed cleanup IO failure cannot accept or silently skip critical finalization evidence',async()=>{
 const f=await composition({refuseCritical:true});const r=await report(f);await assert.rejects(()=>f.driver.finish(r),/ROOT_FINALIZER_HOLD/);
 assert.equal(f.checkpoints.filter(r=>r.phase==='final').length,1);assert.equal(f.log.filter(m=>m==='session/prompt').length,1);
});

test('HomeAI second runs beyond600 with seven actual priors and same B02 DS pair',async()=>{const f=await composition({variant:'HomeAI',completionMs:620000});const accepted=await f.driver.finish(await report(f));assert.equal(accepted.status,'PASS');assert.equal(accepted.comparison.orderPosition,8);assert.equal(accepted.identity.requestedModel.provider,'strata-vast');assert.equal(Date.parse(accepted.operator.primaryDeadlineAt)-Date.parse(accepted.timestampsUtc.submittedAt),900000);assert(accepted.timingMs.runTimeToAcceptance>=620000);});
test('missing actual restart preflight blocks before any prompt',async()=>{await assert.rejects(()=>composition({missingRestart:true}),/HOST_RESTART_UNCONFIRMED/);});
test('B02-07 PASS requires captured runtime restart receipt',async()=>{const f=await composition();const r=await report(f);r.restartEvidence.requestId='caller-replacement';await assert.rejects(()=>f.driver.finish(r),/B02_CAPTURED_RESTART_RECEIPT_REQUIRED/);assert.equal(f.log.filter(x=>x==='workspace/archiveSession').length,0);});
test('QA inherits original deadline and cannot acquire another900s',async()=>{const f=await composition();const r=await report(f),deadline=Date.parse(f.result.operator.primaryDeadlineAt);f.clock.advance(deadline-f.clock.now());await assert.rejects(()=>f.driver.finish(r),/DEADLINE|EXPIRED/);assert.equal(f.log.filter(x=>x==='session/prompt').length,1);});
test('all actual adapter callbacks retain four second cap',async()=>{const f=await composition();assert(f.rpcCalls.every(x=>x.deadline-x.at<=4000));assert.equal(f.result.limits.repairSeconds,300);assert.equal(f.result.limits.maxRepairs,1);});
