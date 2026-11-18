// In-memory source tests only: no sockets, Native, model, guest, or real checkpoint directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRootIOAdapter,limits,checkpointPolicy} from './adapter.mjs';
import {createFinalizerWriter} from './finalization.mjs';
import {runPrimary} from './runner.mjs';
import {Clock,MemoryFS,target,attemptId,requestId,id,snapshot,options,dependencies,until,syntheticRecord} from './fixtures.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const code=c=>e=>e.code===c;
function setup(extra={}){
 const memory=new MemoryFS(),clock=new Clock();
 const adapter=createRootIOAdapter({...options(),checkpointBudgetBytes:67108864,checkpointBudgetCount:2048,...extra},dependencies(memory,clock));
 const writer=createFinalizerWriter({checkpoint:adapter.checkpoint,now:clock.now});
 return{memory,clock,adapter,writer};
}
const receiptOptions=(f,n,phase='observation',extra={})=>({checkpointId:id(n),phase,deadline:f.clock.now()+4000,...extra});
const files=f=>[...f.memory.nodes.entries()].filter(([name,node])=>node.kind==='file'&&name.endsWith('.json')&&!name.endsWith('/.writer.json')).map(([name,node])=>({name,bytes:node.bytes,envelope:JSON.parse(node.bytes)}));
const allocated=f=>[...f.memory.nodes.values()].reduce((sum,n)=>sum+(n.kind==='file'?n.bytes.length:0),0);
function checkChain(f){let last=null;for(const row of files(f)){assert.equal(row.envelope.previousCheckpointId,last);assert.equal(row.envelope.snapshotSha256,hash(JSON.stringify(row.envelope.snapshot)));last=row.envelope.checkpointId;}return last;}

test('fixed 4MiB observation policy and existing hard/count bounds protect four maximum critical envelopes',()=>{
 assert.equal(checkpointPolicy.observationBudgetBytes,4194304);assert.equal(checkpointPolicy.observationIntervalMs,10000);assert.equal(checkpointPolicy.criticalWrites,4);
 assert.equal(options().checkpointBudgetBytes,67108864);assert.equal(options().checkpointBudgetCount,2048);
 assert.equal(limits.snapshotBytes,2097152);assert.equal(limits.rpcMs,4000);assert.equal(limits.maxCheckpointCount,2048);assert.equal(limits.maxCheckpointBudgetBytes,67108864);
 assert.throws(()=>setup({checkpointBudgetBytes:4*1024**2}),code('CHECKPOINT_CRITICAL_RESERVE_REQUIRED'));
 assert.throws(()=>setup({checkpointBudgetCount:3}),code('CHECKPOINT_CRITICAL_RESERVE_REQUIRED'));
 assert.throws(()=>setup({checkpointBudgetBytes:limits.maxCheckpointBudgetBytes+1}));
});

test('unchanged and interval skips perform no FS work, return no durability fields and leave chain untouched',async()=>{
 const f=setup();await f.writer.runner(snapshot(null,id(1)),receiptOptions(f,1,'intent'));
 const one=snapshot(id(1),id(2));one.nativeObservation.events=['new'];
 await f.writer.runner(one,receiptOptions(f,2));
 const events=f.memory.events.length,bytes=allocated(f);
 for(const[n,change,reason]of[[3,false,'unchanged'],[4,true,'sample_interval']]){
  const row=snapshot(id(2),id(n));row.nativeObservation.events=[change?'changed':'new'];
  const skip=await f.writer.runner(row,receiptOptions(f,n));
  assert.deepEqual(skip,{checkpointId:id(n),durable:false,skipped:true,reason});
  assert.equal(f.memory.events.length,events);assert.equal(allocated(f),bytes);
 }
 f.clock.advance(10000);const row=snapshot(id(2),id(5));row.nativeObservation.events=['changed'];
 await f.writer.runner(row,receiptOptions(f,5));assert.equal(checkChain(f),id(5));
 assert.deepEqual(files(f).map(r=>r.envelope.checkpointId),[id(1),id(2),id(5)]);
});

test('4MiB ordinary exhaustion is expected; retained cleanup and both complete final snapshots remain durable',async()=>{
 const f=setup();await f.writer.runner(snapshot(null,id(1)),receiptOptions(f,1,'intent'));let last=id(1),skips=0;
 const payload='x'.repeat(1024*1024);
 for(let n=2;n<10;n++){
  f.clock.advance(10000);const row=snapshot(last,id(n));row.nativeObservation.events=[payload+String(n)];
  const receipt=await f.writer.runner(row,receiptOptions(f,n));
  if(receipt.durable)last=receipt.checkpointId;else{skips++;assert.equal(receipt.reason,'observation_budget');}
 }
 assert(skips>0);const ordinary=files(f).filter(r=>r.envelope.phase==='observation');
 assert(ordinary.reduce((n,r)=>n+r.bytes.length,0)<=4194304);
 // Near the existing 2MiB maximum, with the original full snapshot format.
 const final=snapshot(last,id(10));final.nativeObservation.events=['z'.repeat(limits.snapshotBytes-2000)];
 const firstFinal=await f.writer.runner(final,receiptOptions(f,10,'final'));
 const retained=await f.writer.retain({requestId,status:'SETTLED_VISIBLE',settled:true},{deadline:f.clock.now()+4000});
 assert.equal(retained.durable,true);
 final.operator.persistence.lastDurableCheckpointId=firstFinal.checkpointId;final.operator.persistence.pendingCheckpointId=id(11);
 const finalReceipt=await f.writer.runner(final,receiptOptions(f,11,'final'));assert.equal(finalReceipt.durable,true);
 assert.equal(checkChain(f),id(11));assert(allocated(f)<4*1024**2+4*(limits.snapshotBytes+4096));assert(allocated(f)<67108864);
 assert.equal(files(f).at(-1).envelope.snapshot.nativeObservation.events[0],final.nativeObservation.events[0]);
 await assert.rejects(()=>f.adapter.checkpoint(snapshot(id(11),id(12)),receiptOptions(f,12,'final')),code('CHECKPOINT_CRITICAL_COUNT_EXCEEDED'));
});

test('skipped observations cannot consume the four-count reserve either',async()=>{
 const f=setup({checkpointBudgetCount:4});await f.writer.runner(snapshot(null,id(1)),receiptOptions(f,1,'intent'));
 const receipt=await f.writer.runner(snapshot(id(1),id(2)),receiptOptions(f,2));assert.equal(receipt.reason,'observation_budget');
 await f.writer.runner(snapshot(id(1),id(3)),receiptOptions(f,3,'final'));
 await f.writer.retain({requestId,status:'SETTLED_VISIBLE'},{deadline:f.clock.now()+4000});
 await f.writer.runner(snapshot(id(3),id(4)),receiptOptions(f,4,'final'));
 assert.equal(files(f).length,4);checkChain(f);
});

async function campaign({failPhase,completionMs=599000}={}){
 const f=setup(),record=syntheticRecord();
 const prompt=Buffer.from('INERT synthetic growing history; never submitted to a real session');record.identity.promptSha256=hash(prompt);
 const own={...target,preparedFixtureEvidence:'SYNTHETIC prepared fixture',modelSelection:{provider:'mock-provider',model:'mock-model'}};
 // Adapter target/attempt are fixed at construction; this record is synthetic data.
 record.attemptId=attemptId;
 const handoff={liveAuthorized:true,rootOperator:true,id:'SYNTHETIC',sourceCommit:'a'.repeat(40),runtimeCommit:'b'.repeat(40),previousRuns:[],orderPosition:1,settlementObservationMs:120000};
 const began=f.clock.now();let submitted=false,request,complete=false,oldSchemeBytes=0,observations=0,skips=0,prompts=0,cancels=0,stopCalls=0;
 const all=[{seq:0,type:'session/header',data:{}}];
 const add=(type,data)=>all.push({seq:all.length,type,data});
 function state(){
  if(!submitted)return{active:true,cursor:0,running:false,queue:[],pendingInput:[]};
  if(all.length===1){add('turn/start',{});add('request/header',{header:{config:own.modelSelection}});}
  const wanted=Math.floor((f.clock.now()-began)/1000);
  while(!complete&&all.filter(e=>e.type==='assistant/message').length<wanted)add('assistant/message',{text:'x'.repeat(900)});
  if(f.clock.now()-began>=completionMs&&!complete){complete=true;add('turn/end',{reason:{kind:'completed'}});}
  return{active:true,cursor:all.at(-1).seq,running:!complete,queue:[],pendingInput:[]};
 }
 const clock={now:f.clock.now,sleep:async ms=>f.clock.advance(ms),bound:async(fn,deadline,signal)=>{
  if(signal?.aborted||f.clock.now()>=deadline)throw Error('SYNTHETIC_BOUND');return fn({signal:signal??new AbortController().signal,deadline});
 }};
 const io={
  preflight:async()=>({quiet:true,mode:'host-compat',sourceCommit:handoff.sourceCommit,runtimeCommit:handoff.runtimeCommit,workspaceId:own.workspaceId,fixtureEvidence:own.preparedFixtureEvidence,preview:{supported:true,evidence:'SYNTHETIC'},modelSelection:own.modelSelection,modelSelectionEvidence:'SYNTHETIC'}),
  rpc:async(method,data)=>{
   assert.equal(data.sessionId??data.address?.sessionId,target.sessionId);
   if(method==='session/state')return state();
   if(method==='session/page'){const rows=all.filter(e=>e.seq<=data.throughSeq&&e.seq<(data.beforeSeq??Infinity)).slice(-64);return{records:rows.map(event=>({type:'event',event})),hasMore:rows[0].seq>0};}
   if(method==='session/prompt'){prompts++;assert.equal(files(f)[0].envelope.phase,'intent');submitted=true;request=data.requestId;return{accepted:true};}
   if(method==='session/cancel'){cancels++;if(!complete){complete=true;add('turn/end',{reason:{kind:'cancelled'}});}return{accepted:true};}throw Error('Unexpected synthetic RPC');
  },
  observeWork:async()=>({settled:true,evidence:'SYNTHETIC no process tools or jobs'}),
  stopOwnedWork:async()=>{stopCalls++;},
  checkpoint:async(row,o)=>{
   assert(o.deadline-f.clock.now()<=4000);if(o.phase==='observation'){observations++;oldSchemeBytes+=Buffer.byteLength(JSON.stringify(row));}
   if(failPhase===o.phase)f.memory.fail='file.sync:/synthetic/attemptA/'+o.checkpointId+'.json';
   const receipt=await f.writer.runner(row,o);if(receipt.skipped)skips++;return receipt;
  },
 };
 return{f,io,record,target:own,handoff,clock,inputs:{verify:async()=>({unchanged:true,prompt})},stats:()=>({request,oldSchemeBytes,observations,skips,prompts,cancels,stopCalls,all})};
}

test('growing-history model completes within original 600s; old IO exceeds 64MiB, sparse writer retains full chronology and durable cleanup/final',async t=>{
 const c=await campaign(),out=await runPrimary(c),s=c.stats();
 assert.equal(s.prompts,1);assert.equal(s.cancels,0);assert.equal(s.stopCalls,0);assert.equal(out.stopReason,null);
 assert.equal(out.operator.persistenceFailed,undefined);assert.equal(out.operator.persistence.unknownOutcome,false);
 assert.equal(out.nativeObservation.settled,true);assert.equal(out.blockingPhase,'independent_acceptance');assert.equal(out.operator.finalized,false);assert.notEqual(out.status,'PASS');
 assert.equal(Date.parse(out.operator.primaryDeadlineAt)-Date.parse(out.timestampsUtc.submittedAt),600000);
 assert(s.observations>1000);assert(s.oldSchemeBytes>67108864);assert(s.skips>1000);
 assert.deepEqual(out.nativeObservation.events,s.all.slice(1));assert.equal(out.nativeObservation.events.at(-1).type,'turn/end');
 assert(allocated(c.f)<12*1024**2);assert(files(c.f).filter(r=>r.envelope.phase==='observation').reduce((n,r)=>n+r.bytes.length,0)<=4194304);
 const last=checkChain(c.f);assert.equal(out.operator.persistence.lastDurableCheckpointId,last);
 // Actual finalizer-writer composition after model-ready: one critical fence,
 // then the existing second final write, with a real contiguous durable chain.
 const fence=await c.f.writer.retain({requestId:s.request,status:'SETTLED_VISIBLE',settled:true},{deadline:c.clock.now()+4000});assert.equal(fence.durable,true);
 const copy=structuredClone(out),checkpointId=randomUUID();copy.operator.persistence.pendingCheckpointId=checkpointId;
 const end=await c.f.writer.runner(copy,{checkpointId,phase:'final',deadline:c.clock.now()+4000});assert.equal(end.durable,true);assert.equal(checkChain(c.f),checkpointId);
 assert.deepEqual(files(c.f).at(-1).envelope.snapshot.nativeObservation.events,s.all.slice(1));
 t.diagnostic(JSON.stringify({syntheticOnly:true,logicalDurationMs:c.clock.now()-Date.parse(out.timestampsUtc.submittedAt),oldObservationSnapshotBytes:s.oldSchemeBytes,observationAttempts:s.observations,skippedObservations:s.skips,durableFiles:files(c.f).length,allocatedIncludingClaim:allocated(c.f)}));
});

test('full logical 600s model run reaches its original deadline despite ordinary exhaustion, then stops once and persists complete final evidence',async()=>{
 const c=await campaign({completionMs:Infinity}),out=await runPrimary(c),s=c.stats(),deadline=Date.parse(out.operator.primaryDeadlineAt);
 assert.equal(c.clock.now(),deadline);assert.equal(out.stopReason,'main_deadline');assert.equal(out.status,'FAIL');assert.equal(out.nativeObservation.settled,true);
 assert.equal(s.prompts,1);assert.equal(s.cancels,1);assert.equal(s.stopCalls,1);assert.equal(out.operator.persistenceFailed,undefined);assert(s.skips>1000);assert(s.oldSchemeBytes>67108864);
 assert.equal(out.timestampsUtc.stopRequestedAt,out.operator.primaryDeadlineAt);assert.equal(out.nativeObservation.events.at(-1).data.reason.kind,'cancelled');
 assert.deepEqual(files(c.f).at(-1).envelope.snapshot.nativeObservation.events,s.all.slice(1));assert.equal(checkChain(c.f),out.operator.persistence.lastDurableCheckpointId);assert(allocated(c.f)<12*1024**2);
});

test('true durable-intent IO failure prevents submission and quarantines the actual writer',async()=>{
 const c=await campaign({failPhase:'intent'});await assert.rejects(()=>runPrimary(c),code('SYNTHETIC_IO'));assert.equal(c.stats().prompts,0);
 await assert.rejects(()=>c.f.writer.runner(snapshot(),receiptOptions(c.f,99,'intent')),code('FINALIZER_WRITER_UNAVAILABLE'));
 await assert.rejects(()=>c.f.adapter.checkpoint(snapshot(),receiptOptions(c.f,99,'intent')),code('CHECKPOINT_WRITER_QUARANTINED'));
});

test('true final IO failure remains BLOCKED and cannot become an expected observation skip',async()=>{
 const c=await campaign({failPhase:'final',completionMs:1000});const out=await runPrimary(c);assert.equal(out.status,'BLOCKED');assert.equal(out.operator.persistenceFailed,true);assert.equal(out.operator.persistence.unknownOutcome,true);assert.equal(out.operator.finalized,false);assert.equal(c.stats().prompts,1);assert(c.stats().stopCalls>0);
 await assert.rejects(()=>c.f.writer.runner(snapshot(),receiptOptions(c.f,99,'final')),code('FINALIZER_WRITER_UNAVAILABLE'));
});

test('late/unknown observation write still quarantines; expected skip never launders an in-flight write',async()=>{
 const f=setup();await f.writer.runner(snapshot(null,id(1)),receiptOptions(f,1,'intent'));
 f.memory.hold={name:'file.sync:/synthetic/attemptA/'+id(2)+'.json'};
 const pending=f.writer.runner(snapshot(id(1),id(2)),receiptOptions(f,2));await until(()=>f.memory.hold.entered);f.clock.advance(4000);
 await assert.rejects(pending,code('OPERATION_DEADLINE'));f.memory.hold.release();
 await assert.rejects(()=>f.writer.runner(snapshot(id(1),id(3)),receiptOptions(f,3)),code('FINALIZER_WRITER_UNAVAILABLE'));
});

test('intent/final/retention cannot accept skip; forged durability fields or late skip fail closed',async()=>{
 for(const phase of ['intent','final']){
  const writer=createFinalizerWriter({now:()=>1,checkpoint:async(_,o)=>({checkpointId:o.checkpointId,durable:false,skipped:true,reason:'observation_budget'})});
  await assert.rejects(()=>writer.runner(snapshot(),{checkpointId:id(1),phase,deadline:10}),code('FINALIZER_DURABILITY_UNCONFIRMED'));
 }
 let time=1,mode='durable';const writer=createFinalizerWriter({now:()=>time,checkpoint:async(_,o)=>mode==='durable'?{checkpointId:o.checkpointId,durable:true}:{checkpointId:o.checkpointId,durable:false,skipped:true,reason:'observation_budget'}});
 await writer.runner(snapshot(),{checkpointId:id(1),phase:'intent',deadline:10});mode='skip';
 await assert.rejects(()=>writer.retain({requestId},{deadline:10}),code('FINALIZER_DURABILITY_UNCONFIRMED'));
 for(const forged of [{sha256:'a'.repeat(64)},{}]){
  const w=createFinalizerWriter({now:()=>time,checkpoint:async(_,o)=>({checkpointId:o.checkpointId,durable:false,skipped:true,reason:'observation_budget',...forged})});
  time=Object.keys(forged).length?1:10;
  await assert.rejects(()=>w.runner(snapshot(),{checkpointId:id(2),phase:'observation',deadline:10}),code('FINALIZER_DURABILITY_UNCONFIRMED'));
 }
});
