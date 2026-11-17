// Inert transports and synthetic identities; no inference, filesystem writes or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {composeFirstB03,validateHandoff} from './driver-core.mjs';
import {createDriverFinalization as after,createFinalizerWriter} from './finalization.mjs';
import {createStopScope} from './stop-scope.mjs';
import {runPrimary,readOwnObservation,collectorIdentity,finishAcceptance} from './frozen/n06-pilots-b-20261117-r2/runner.mjs';
import {createRootFinalizer} from './frozen/n06-root-finalizer-20261117/finalizer.mjs';
import {createRootLifecycle,bindLifecycleClock} from './frozen/n06-root-lifecycle-20261117-r3/lifecycle.mjs';
import {createRootBindings} from './frozen/n06-root-bindings-20261117/bindings.mjs';
const sourceCommit='a'.repeat(40);
const first=Object.freeze({owned:true,scenario:'B03',variant:'HomeAI',sessionId:'synthetic-session',workspaceId:'synthetic-workspace',projectId:'synthetic-project',projectRoot:'/synthetic/project',preparedFixtureEvidence:'synthetic-fixture-evidence',modelSelection:Object.freeze({provider:'synthetic-provider',model:'synthetic-model',reasoningEffort:'medium'}),sessionUrl:null});
function syntheticRecord(){return{
 recordVersion:1,isTemplate:true,recordKind:'model_benchmark_attempt',status:'NOT RUN',scenario:'B03',variant:'HomeAI',pairId:'synthetic-pair',runId:'synthetic-run',attemptId:'planned-b03-homeai-primary',
 identity:{promptSha256:null,manifestSha256:'c'.repeat(64),acceptanceVersion:'synthetic-acceptance'},
 limits:{mainSeconds:600,repairSeconds:300,maxRepairs:1},
 timestampsUtc:{runSubmittedAt:null,submittedAt:null,firstOutputAt:null,implementationReadyAt:null,validationStartedAt:null,acceptedAt:null,limitReachedAt:null,stopRequestedAt:null,finishedAt:null,settledAt:null},
 timingMs:{},counts:{},quality:{accepted:null,checks:[]},missingDataReasons:[],
};}

const requestId='11111111-1111-4111-8111-111111111111';
const modules={createRootFinalizer,createRootLifecycle,createRootBindings,readOwnObservation};
async function fixture(factory,{closeState='closed',workSettled=true,runningRow=false,pendingResult=false}={}){
 const log=[],replies=[],rosters=[],row={id:'bash-owned-preview',owner:first.sessionId,kind:'bash',startedAt:10,status:runningRow?'running':'killed',...(runningRow?{}:{finishedAt:20}),output:{total:0}},foreign={id:'foreign',owner:'FOREIGN',kind:'bash',startedAt:1,status:'running',output:{total:0}};
 const events=[{seq:0,type:'session/context',data:{}},{seq:1,type:'tool/call',data:{callId:'launch-call',name:'project_exec',arguments:'{"command":"node app.mjs","run_in_background":true}'}}];
 if(!pendingResult)events.push({seq:2,type:'tool/result',data:{message:{role:'tool',toolCallId:'launch-call',source:{kind:'tool',callId:'launch-call'},content:[]}}},{seq:3,type:'tool/call',data:{callId:'preview-call',name:'project_preview',arguments:'{"operation":"open"}'}},{seq:4,type:'tool/result',data:{message:{role:'tool',toolCallId:'preview-call',source:{kind:'tool',callId:'preview-call'},content:[]}}});
 let archived=false;
 const rpc=async(method)=>{if(method==='session/state')return{cursor:events.at(-1).seq,active:true,running:false,queue:[],pendingInput:[]};if(method==='session/page')return{records:events.map(event=>({type:'event',event:structuredClone(event)})),hasMore:false};if(method==='session/cancel'){log.push('cancel');return{accepted:true};}throw Error('REFUSED');};
 const native={target:first,jobsSnapshot:async()=>{rosters.push([row.id,foreign.id]);return structuredClone([row,foreign]);},projections:async()=>({kind:'sequenced',asOfSeq:events.at(-1).seq,values:{subagentCatalog:[]}}),terminals:async()=>[],killJob:async job=>{assert.equal(job.id,row.id);log.push('kill-own');return{outcome:'requested'};},followJob:async job=>{assert.equal(job.id,row.id);log.push('follow-own');return structuredClone(row);}};
 const runtime={assertArchiveRuntime:async()=>({...first,sourceCommit,tupleSha256:'a'.repeat(64),profileSha256:'b'.repeat(64),mode:'host-compat',ownedRangeProvider:true}),
  previewClose:async()=>{const value={version:1,sessionId:first.sessionId,state:closeState,workSettled,jobId:row.id,previewId:'owned-preview',generation:'owned-generation',expiresAt:Date.now()+60000};replies.push(structuredClone(value));return value;},
  archiveRPC:async method=>{log.push(method);archived=method==='workspace/archiveSession';return{archivedSessionIds:archived?[first.sessionId]:[]};}};
 const writer=createFinalizerWriter({now:Date.now,checkpoint:async(_s,o)=>({durable:true,checkpointId:o.checkpointId})});
 const snapshot={attemptId:'INERT',identity:{...first,sourceCommit},operator:{requestId,baselineSeq:0,primaryDeadlineAt:new Date(Date.now()+600000).toISOString(),persistence:{lastDurableCheckpointId:null}}};
 await writer.runner(snapshot,{phase:'intent',checkpointId:'intent',deadline:Date.now()+4000});
 const stopScope=createStopScope({now:Date.now,settlementMs:120000});stopScope.bindIntent(Date.parse(snapshot.operator.primaryDeadlineAt));
 const bridge=factory({target:first,sourceCommit,native,rpc,runtime,modules,writer,now:Date.now,settlementMs:120000,stopScope});bridge.bindIntent(snapshot);
 const result=await bridge.stop({...first,requestId,deadline:Date.now()+10000});return{result,log,replies,rosters,row,foreign,archived};
}
test('AFTER: actual r2 composition preserves CLOSED jobId and terminal row, follows and proves before/after restore',async()=>{const f=await fixture(after);assert.equal(f.result.status,'SETTLED_VISIBLE');assert.equal(f.result.persistence.durable,true);assert.equal(f.archived,false);assert(f.log.includes('follow-own'));assert(f.log.includes('workspace/unarchiveSession'));assert(f.result.receipts.some(r=>r.phase==='after_restore_proof'));assert(f.replies.every(r=>r.jobId===f.row.id&&r.state==='closed'));assert(f.rosters.every(ids=>ids.includes(f.row.id)));assert.equal(f.foreign.status,'running');assert(!f.log.includes('kill-own'));});
test('READY, blocked or unproved CLOSED never become a cleanup exemption',async()=>{for(const patch of [{closeState:'ready'},{closeState:'blocked'},{workSettled:false}]){const f=await fixture(after,patch);assert.equal(f.result.status,'HOLD');assert.equal(f.archived,true);assert(!f.log.includes('workspace/unarchiveSession'));}});
test('CLOSED plus live row and mere kill ACK still holds without actual terminal follow',async()=>{const f=await fixture(after,{runningRow:true});assert.equal(f.result.status,'HOLD');assert(f.log.includes('kill-own'));assert.equal(f.archived,true);assert(!f.log.includes('workspace/unarchiveSession'));});
test('CLOSED terminal preview cannot hide an incomplete known process call/result',async()=>{const f=await fixture(after,{pendingResult:true});assert.equal(f.result.status,'HOLD');assert.equal(f.archived,true);assert(!f.log.includes('workspace/unarchiveSession'));});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function until(predicate){for(let i=0;i<200&&!predicate();i++)await flush();assert(predicate(),'expected inert real-composition checkpoint');}
function clock(){let at=1000000,id=0;const timers=new Map(),bounds=[];
 const api={now:()=>at,setTimeout(fn,delay){const key=++id;timers.set(key,{at:at+delay,fn});return key;},clearTimeout:key=>timers.delete(key),jump:value=>{at=value;},
  runDue(){for(const[key,t]of [...timers].sort((a,b)=>a[1].at-b[1].at))if(t.at<=at){timers.delete(key);t.fn();}},
  async sleep(ms){at+=ms;api.runDue();await Promise.resolve();},
  async bound(fn,deadline,_outerSignal){bounds.push(deadline);if(at>=deadline)throw Object.assign(Error('DEADLINE'),{code:'DEADLINE'});
   // Intentional delayed abort observation, analogous to a stalled continuation.
   // Driver scope must enforce the earlier bound independently of this clock.
   return fn({signal:new AbortController().signal});},bounds};return api;
}
async function realComposition({holdFollow=false,early=false,afterCap=false,mutateInput=false}={}){
 const c=clock(),record=syntheticRecord(),prompt=Buffer.from('INERT: no model transport');record.identity.promptSha256=createHash('sha256').update(prompt).digest('hex');
 const firstRead=deferred(),follow=deferred(),effects=[],constructors=[],signals=[],boundTargets=[];let submitted=false,held=false,primaryDeadline,archived=false;
 const row={id:'owned-terminal-preview',owner:first.sessionId,kind:'bash',startedAt:1,status:'killed',finishedAt:2,output:{total:0}},closed={version:1,sessionId:first.sessionId,state:'closed',workSettled:true,jobId:row.id,previewId:'preview',generation:'generation',expiresAt:9999999999};
 const events=()=>submitted?[{seq:0,type:'session/context',data:{}},{seq:1,type:'turn/start',data:{}},{seq:2,type:'turn/end',data:{reason:{kind:'interrupted'}}}]:[{seq:0,type:'session/context',data:{}}];
 const state=()=>({cursor:events().at(-1).seq,active:true,running:false,queue:[],pendingInput:[]});
 function effect(kind,options){assert(!options.signal?.aborted);assert(c.now()<options.deadline);effects.push({kind,at:c.now(),deadline:options.deadline,signal:options.signal});}
 const rpc=async(method,_data,options)=>{effect('rpc:'+method,options);if(method==='session/prompt'){submitted=true;return{accepted:true};}if(method==='session/cancel')return{accepted:true};if(method==='session/state'){if(submitted&&!held){held=true;return firstRead.promise;}return state();}if(method==='session/page')return{records:events().map(event=>({type:'event',event})),hasMore:false};throw Error('REFUSED');};
 const native={target:first,jobsSnapshot:async o=>{effect('native:jobs',o);return structuredClone([row]);},projections:async o=>{effect('native:projections',o);return{kind:'sequenced',asOfSeq:state().cursor,values:{subagentCatalog:[]}};},terminals:async o=>{effect('native:terminals',o);return[];},killJob:async(_row,o)=>{effect('native:kill',o);return{outcome:'already-finished'};},followJob:async(_row,o)=>{effect('native:follow',o);signals.push(o.signal);return holdFollow?follow.promise:structuredClone(row);}};
 const proof=()=>({...first,version:1,sourceCommit,mode:'host-compat',profileSha256:'b'.repeat(64),ownedRangeProvider:true,preview:closed,tupleSha256:'a'.repeat(64)});
 const runtime={ownerHost:'benchmark.invalid',ownerCookie:'INERT',WebSocket:class{},assertTarget:async o=>{effect('runtime:target',o);},attest:async o=>{effect('runtime:attest',o);return proof();},previewStatus:async o=>{effect('runtime:status',o);return closed;},assertArchiveRuntime:async o=>{effect('runtime:archive-proof',o);return proof();},previewClose:async o=>{effect('runtime:close',o);return closed;},archiveRPC:async(method,_args,o)=>{effect(method,o);archived=method==='workspace/archiveSession';return{archivedSessionIds:archived?[first.sessionId]:[]};},preflight:async o=>{effect('runtime:preflight',o);return{quiet:true,mode:'host-compat',sourceCommit,runtimeCommit:sourceCommit,workspaceId:first.workspaceId,fixtureEvidence:first.preparedFixtureEvidence,modelSelection:first.modelSelection,modelSelectionEvidence:'INERT',preview:{supported:true,evidence:'INERT'}};}};
 const modules={runPrimary,readOwnObservation,collectorIdentity,finishAcceptance,bindLifecycleClock,realClock:()=>c,createRootIOAdapter:({target})=>(boundTargets.push(target),{rpc,checkpoint:async(_s,o)=>{effect('checkpoint',o);return{durable:true,checkpointId:o.checkpointId};}}),createNativeLifecycleTransport:({target})=>(boundTargets.push(target),native),
  createRootBindings:(a,b)=>createRootBindings(a,b,{now:c.now}),createRootLifecycle:(a,b)=>createRootLifecycle(a,b,{now:c.now}),createRootFinalizer:(a,b)=>{constructors.push(a.deadline);return createRootFinalizer(a,b,{now:c.now,setTimeout:c.setTimeout,clearTimeout:c.clearTimeout});}};
 const suppliedTarget={...structuredClone(first),metadata:{nested:{label:'original'}}};
 const driver=composeFirstB03({target:suppliedTarget,sourceCommit,checkpointDirectory:'/synthetic/checkpoints',handoff:{liveAuthorized:true,rootOperator:true,id:'INERT',sourceCommit,runtimeCommit:sourceCommit,orderPosition:1,previousRuns:[],settlementObservationMs:120000},record,inputs:{verify:async()=>({unchanged:true,prompt})},runtime,modules,onIntent:value=>{primaryDeadline=value.primaryDeadline;}},{setTimeout:c.setTimeout,clearTimeout:c.clearTimeout});
 if(mutateInput){
  suppliedTarget.sessionId='foreign-session';suppliedTarget.modelSelection.model='foreign-model';suppliedTarget.metadata.nested.label='mutated';
  for(const bound of boundTargets){
   assert.equal(bound.sessionId,first.sessionId);assert.equal(bound.modelSelection.model,first.modelSelection.model);assert.equal(bound.metadata.nested.label,'original');
   assert(Object.isFrozen(bound)&&Object.isFrozen(bound.modelSelection)&&Object.isFrozen(bound.metadata.nested));
   assert.throws(()=>{bound.modelSelection.model='foreign-model';},TypeError);
   assert.throws(()=>{bound.metadata.nested.label='mutated';},TypeError);
  }
 }
 const running=driver.run();await until(()=>held&&Number.isSafeInteger(primaryDeadline));
 const stopAt=early?primaryDeadline-100000:primaryDeadline,cap=stopAt+120000,cleanup=new AbortController();
 c.jump(stopAt);driver.stop({deadline:cap,signal:cleanup.signal});
 // Real runPrimary cannot see the aborted main signal until its pending read
 // returns100s later (119s for the cap/abort case); its computed deadline would
 // renew the window. Positive case leaves the real finalizer's4s safety reserve.
 c.jump(stopAt+(afterCap?121000:holdFollow?119000:100000));firstRead.resolve(state());
 if(!afterCap)await until(()=>constructors.length>0);
 return{driver,running,c,cap,primaryDeadline,stopAt,effects,constructors,signals,cleanup,follow,get archived(){return archived;}};
}
test('REAL frozen delayed stop gets actual finalizer/rpc/native/checkpoint deadlines clamped to original D+window',async()=>{
 const f=await realComposition(),result=await f.running;
 assert(Date.parse(result.timestampsUtc.stopRequestedAt)>f.primaryDeadline);assert(f.c.bounds.some(d=>d>f.cap),'real runner proposed a later cleanup bound');
 assert(f.constructors.every(d=>d<=f.cap));assert(f.effects.every(e=>e.deadline<=f.cap));assert(f.effects.filter(e=>e.kind==='checkpoint').length>=3);assert(f.effects.some(e=>e.kind==='native:follow'));assert.equal(result.rootFinalization.status,'SETTLED_VISIBLE');assert.equal(result.nativeObservation.settled,true);assert.equal(f.effects.filter(e=>e.kind==='rpc:session/prompt').length,1);
});
test('REAL active finalizer observes shared cleanup abort at cap; late follow causes no RPC/native/checkpoint effects',async()=>{
 const f=await realComposition({holdFollow:true});await until(()=>f.signals.length>0);f.c.jump(f.cap);f.cleanup.abort();f.c.runDue();assert(f.signals.every(s=>s.aborted));
 f.follow.resolve({id:'owned-terminal-preview',owner:first.sessionId,kind:'bash',startedAt:1,status:'killed',finishedAt:2,output:{total:0}});const result=await f.running;
 assert(f.constructors.every(d=>d<=f.cap));assert(f.effects.every(e=>e.at<f.cap&&e.deadline<=f.cap));assert(f.effects.every(e=>e.signal?.aborted),'shared cap abort reaches rpc/native/runtime/checkpoint branches');assert.equal(result.nativeObservation.settled,false);assert.equal(result.rootFinalization.status,'HOLD');assert(!f.effects.some(e=>e.kind==='workspace/unarchiveSession'));assert.equal(f.effects.filter(e=>e.kind==='rpc:session/prompt').length,1);
 await assert.rejects(async()=>f.driver.cleanup({deadline:f.cap+120000,signal:new AbortController().signal}),/STOP_SCOPE_CLOSED/);
});
test('REAL delayed early stop preserves supervisor first bound, not primary D+window or observation-time renewal',async()=>{const f=await realComposition({early:true}),result=await f.running;assert(f.cap<f.primaryDeadline+120000);assert(f.constructors.every(d=>d<=f.cap));assert(f.effects.every(e=>e.deadline<=f.cap));assert.equal(result.nativeObservation.settled,true);});
test('REAL stop first observed AFTER cap creates no finalizer or late backend effects',async()=>{const f=await realComposition({afterCap:true}),result=await f.running;assert.equal(f.constructors.length,0);assert(f.effects.every(e=>e.at<f.cap&&e.deadline<=f.cap));assert.equal(result.nativeObservation.settled,false);assert.equal(f.effects.filter(e=>e.kind==='rpc:session/prompt').length,1);});
test('scope rebinds after async assertion and rejects a late effect even before an overdue timer runs',async()=>{
 const c=clock(),scope=createStopScope({now:c.now,settlementMs:120000},{setTimeout:c.setTimeout,clearTimeout:c.clearTimeout}),gate=deferred();scope.bindIntent(c.now()+600000);const cap=c.now()+1000;scope.stop({deadline:cap});let dispatched=false;
 const work=scope.effect({deadline:cap+5000},async input=>{await gate.promise;return scope.effect(input,()=>{dispatched=true;});});c.jump(cap+1);gate.resolve();await assert.rejects(work,/STOP_SCOPE_CLOSED/);assert.equal(dispatched,false);
});
test('driver scope cannot widen a first early stop even if a caller supplies the later primary ceiling',()=>{const c=clock(),scope=createStopScope({now:c.now,settlementMs:120000},{setTimeout:c.setTimeout,clearTimeout:c.clearTimeout}),at=c.now();scope.bindIntent(at+600000);scope.stop({deadline:at+720000});assert.equal(scope.snapshot().deadline,at+120000);c.jump(at+1000);scope.stop({deadline:at+720000});assert.equal(scope.snapshot().deadline,at+120000);});


test('published frozen dependency closure and repaired finalization bytes stay pinned',async()=>{
 const expected={
  "stop-scope.mjs": "8768d4a17a384baf964fee8fbcab2122293c14caf6ba4de1ef22a15c288e0e72",
  "finalization.mjs": "2022572c64adf839b0303391d0edaa21b02373532000b96dd43cf524c652ba53",
  "frozen/n06-pilots-b-20261117-r2/runner.mjs": "23ec97da879503c004607271e18703f1de417762129dfe190216a665562a1dbd",
  "frozen/n06-root-finalizer-20261117/finalizer.mjs": "9100ec8f0dee5982c58463fe9c01c624ffe58c7d59e2d5d6c97f13406df63e80",
  "frozen/n06-root-lifecycle-20261117-r3/lifecycle.mjs": "583f7d9c502333f2475e25e7180f0738fe3c9101a805d9a3794cb2c6229f272a",
  "frozen/n06-root-bindings-20261117/bindings.mjs": "17a49477afe215a730ef17c06f0a5b6851151f3bab8625d45658ec7752771d3a",
  "frozen/n06-root-lifecycle-20261117-r2/native-transport.mjs": "11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026",
  "frozen/n06-root-lifecycle-20261117-r3/native-transport.mjs": "11375282950bf54dfdaaf7a148d602a20c52453653ddc2f4debbf5aafb5fe026"
};
 for(const [path,digest] of Object.entries(expected))assert.equal(createHash('sha256').update(await fs.readFile(new URL(path,import.meta.url))).digest('hex'),digest,path);
});
test('portable composition refuses missing fixed configuration and a mismatched handoff before adapters',()=>{
 assert.throws(()=>composeFirstB03({}),/FIXED_CONFIGURATION_REQUIRED/);
 assert.throws(()=>composeFirstB03({sourceCommit,checkpointDirectory:'/synthetic/checkpoints',target:{...first,owned:false}}),/FIXED_FIRST_TARGET_REQUIRED/);
 assert.throws(()=>validateHandoff({liveAuthorized:true,rootOperator:true,id:'synthetic-handoff',sourceCommit:'b'.repeat(40),runtimeCommit:sourceCommit,orderPosition:1,previousRuns:[],settlementObservationMs:120000},sourceCommit),/FIRST_B03_STARTUP_HANDOFF_REQUIRED/);
});

test('portable composition snapshots and freezes caller target including nested model selection',async()=>{
 const f=await realComposition({mutateInput:true}),result=await f.running;
 assert.equal(result.identity.sessionId,first.sessionId);assert.equal(result.identity.requestedModel.model,first.modelSelection.model);
 assert.equal(result.rootFinalization.status,'SETTLED_VISIBLE');
});
