// Inert runner integration: synthetic own history, transport, clock and writes.
// No service, SDK/model execution, credential, socket or benchmark input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runPrimary} from './runner.mjs';
import {Clock,syntheticRecord,target} from '../n06-evidence-storage/fixtures.mjs';
const sourceCommit='a'.repeat(40),privateText='PRIVATE_DIAGNOSTIC_MUST_NOT_ESCAPE';
const failure=code=>Object.assign(Error(privateText),{code,body:privateText,headers:{Cookie:privateText}});
const httpFailure=(method,status)=>Object.assign(failure('RPC_HTTP_STATUS'),{rpcMethod:method,httpStatus:status});

async function scenario({faults=[],invalid=null,abortBackoff=false}={}){
 const clock=new Clock(),began=clock.now(),outer=new AbortController(),history=[{seq:0,type:'session/context',data:{}}],calls=[],checkpoints=[],late=[];
 const own={...target,preparedFixtureEvidence:'synthetic-fixture',modelSelection:{provider:'synthetic-provider',model:'synthetic-model'}},record=syntheticRecord(),prompt=Buffer.from('Inert diagnostic fixture, not a benchmark prompt');
 record.identity.promptSha256=createHash('sha256').update(prompt).digest('hex');
 let submitted=false,cancelled=false,completed=false,invalidUsed=false,backoffs=0;
 const add=(type,data)=>history.push({seq:history.length,type,data});
 const end=kind=>{if(!completed){completed=true;add('turn/end',{reason:{kind}});}};
 const phase=()=>cancelled?'CLEANUP':'PRIMARY';
 const bounded=(fn,deadline,signal)=>new Promise((resolve,reject)=>{
  const controller=new AbortController();let ended=false;
  const finish=(error,value)=>{if(ended)return;ended=true;clock.clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{controller.abort();finish(failure('USER_STOP'));};
  const timer=clock.setTimeout(()=>{controller.abort();finish(failure('DEADLINE'));},Math.max(0,deadline-clock.now()));
  if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>fn({deadline,signal:controller.signal})).then(value=>finish(null,value),error=>finish(error));
 });
 const modelClock={now:clock.now,bound:bounded,sleep:async ms=>{if(ms<=100){backoffs++;if(abortBackoff)outer.abort(privateText);}clock.advance(ms);}};
 async function faultAt(operation,options){
  const index=faults.findIndex(row=>!row.used&&row.phase===phase()&&row.operation===operation);if(index<0)return false;
  const row=faults[index];row.used=true;if(row.delayMs)clock.advance(row.delayMs);
  if(row.kind==='outer'){
   clock.advance(options.deadline-clock.now());
   return await new Promise(resolve=>late.push(resolve));
  }
  throw typeof row.error==='function'?row.error():row.error;
 }
 const io={
  preflight:async()=>({quiet:true,mode:'host-compat',sourceCommit,runtimeCommit:sourceCommit,workspaceId:own.workspaceId,fixtureEvidence:own.preparedFixtureEvidence,modelSelection:own.modelSelection,modelSelectionEvidence:'synthetic',preview:{supported:true,evidence:'synthetic'}}),
  async rpc(method,data,options){
   calls.push({method,at:clock.now(),deadline:options.deadline,signal:options.signal,phase:phase()});
   assert.equal(data.sessionId??data.address?.sessionId,own.sessionId);
   if(method==='session/prompt'){assert.equal(submitted,false);assert.equal(checkpoints[0].phase,'intent');submitted=true;add('turn/start',{});add('step/start',{});return{accepted:true};}
   if(method==='session/cancel'){cancelled=true;end('aborted');return{accepted:true};}
   if(method==='session/updateQueue')return{accepted:true};
   if(submitted){const value=await faultAt(method==='session/state'?'STATE_READ':'PAGE_READ',options);if(value!==false)return value;}
   if(method==='session/state'){
    if(submitted&&invalid==='STATE'&&!invalidUsed){invalidUsed=true;return{cursor:2,running:'private-invalid',queue:[],pendingInput:[]};}
    if(submitted&&!cancelled)end('completed');return{active:true,cursor:history.at(-1).seq,running:false,queue:[],pendingInput:[]};
   }
   if(method==='session/page'){
    if(submitted&&invalid&&!invalidUsed){invalidUsed=true;if(invalid==='PAGE')return{records:null,hasMore:false};const value={hasMore:false};Object.defineProperty(value,'records',{get(){throw Error(privateText);}});return value;}
    const rows=history.filter(row=>row.seq<=data.throughSeq&&row.seq<(data.beforeSeq??Infinity)).slice(-64);return{records:rows.map(event=>({type:'event',event})),hasMore:rows[0].seq>0};
   }
   throw Error('Unexpected inert RPC');
  },
  async observeWork(options){calls.push({method:'observeWork',at:clock.now(),deadline:options.deadline,signal:options.signal,phase:phase()});const value=await faultAt('OWNED_WORK',options);return value===false?{settled:true,evidence:{version:1,synthetic:true}}:value;},
  stopOwnedWork:async()=>({settled:false,evidence:{synthetic:true}}),
  checkpoint:async(row,options)=>{checkpoints.push({phase:options.phase,row:structuredClone(row),deadline:options.deadline});return{durable:true,checkpointId:options.checkpointId};},
 };
 const result=await runPrimary({record,target:own,handoff:{liveAuthorized:true,rootOperator:true,id:'synthetic-diagnostic',sourceCommit,runtimeCommit:sourceCommit,orderPosition:1,previousRuns:[],settlementObservationMs:120000},inputs:{verify:async()=>({unchanged:true,prompt})},io,clock:modelClock,signal:outer.signal});
 assert.equal(calls.filter(row=>row.method==='session/prompt').length,1);
 assert.equal(Date.parse(result.operator.primaryDeadlineAt)-Date.parse(result.timestampsUtc.submittedAt),600000);
 assert(calls.every(row=>row.deadline<=row.at+4000));
 return{result,clock,began,calls,checkpoints,late,backoffs};
}
const diagnostics=n=>({first:n.firstObservationFailure,subsequent:n.subsequentObservationFailures,legacy:n.observationError,context:n.observationErrorContext});

for(const [operation,method]of [['STATE_READ','session/state'],['PAGE_READ','session/page'],['OWNED_WORK',null]]){
 test(`first ${operation} outer deadline survives a different cleanup failure and a late callback`,async()=>{
  const f=await scenario({faults:[{phase:'PRIMARY',operation,kind:'outer'},{phase:'CLEANUP',operation:'STATE_READ',error:()=>httpFailure('session/state',401)}]});
  const n=f.result.nativeObservation,first=n.firstObservationFailure;
  assert.deepEqual(first,{version:1,phase:'PRIMARY',operation,code:'DEADLINE',rpcMethod:method,httpStatus:null,attemptCount:method?1:null,budgetMs:4000,elapsedMs:4000,sinceSubmitMs:4000,deadlineExpired:true,aborted:true});
  assert(Object.isFrozen(first));assert.equal(Object.getOwnPropertyDescriptor(n,'firstObservationFailure').writable,false);
  assert.deepEqual(n.subsequentObservationFailures.PRIMARY,{count:0,saturated:false,latest:null});
  assert.equal(n.subsequentObservationFailures.CLEANUP.count,1);assert.equal(n.subsequentObservationFailures.CLEANUP.latest.code,'RPC_HTTP_STATUS');
  assert.equal(n.subsequentObservationFailures.CLEANUP.latest.phase,'CLEANUP');assert.equal(n.observationError,'RPC_HTTP_STATUS');
  assert.equal(f.result.stopReason,'observation_unconfirmed');assert.equal(f.result.status,'BLOCKED');assert.equal(n.settled,true);
  const saved=structuredClone(diagnostics(n));for(const resolve of f.late)resolve({settled:true,evidence:{privateText}});await Promise.resolve();await Promise.resolve();
  assert.deepEqual(diagnostics(n),saved);assert.deepEqual(f.checkpoints.at(-1).row.nativeObservation.firstObservationFailure,first);
  assert(!JSON.stringify(diagnostics(n)).includes(privateText));
 });
}
test('recovered 503 state/page reads retain retry provenance without recording a first failure',async()=>{
 for(const [operation,method]of [['STATE_READ','session/state'],['PAGE_READ','session/page']]){
  const f=await scenario({faults:[{phase:'PRIMARY',operation,error:()=>httpFailure(method,503)}]});
  assert.equal(f.result.blockingPhase,'independent_acceptance');assert.equal(f.result.nativeObservation.firstObservationFailure,undefined);assert.equal(f.result.nativeObservation.subsequentObservationFailures,undefined);assert.equal(f.result.nativeObservation.observationError,undefined);
  assert.deepEqual(f.result.nativeObservation.observationRpcRetries,{attempts:[{method,firstStatus:503,attemptCount:2,retryOutcome:'succeeded'}],omitted:0});
  const reads=f.calls.filter(row=>row.method===method&&row.phase==='PRIMARY').slice(-2);assert.equal(reads[0].deadline,reads[1].deadline);assert.equal(reads[1].at-reads[0].at,100);assert.equal(f.backoffs,1);
 }
});
test('unhandled second retry has actual attempt two and the original four-second budget',async()=>{
 const f=await scenario({faults:[{phase:'PRIMARY',operation:'STATE_READ',error:()=>httpFailure('session/state',503)},{phase:'PRIMARY',operation:'STATE_READ',error:()=>httpFailure('session/state',500)}]});
 assert.deepEqual(f.result.nativeObservation.firstObservationFailure,{version:1,phase:'PRIMARY',operation:'STATE_READ',code:'RPC_HTTP_STATUS',rpcMethod:'session/state',httpStatus:500,attemptCount:2,budgetMs:4000,elapsedMs:100,sinceSubmitMs:100,deadlineExpired:false,aborted:false});
 assert.deepEqual(f.result.nativeObservation.observationRpcRetries,{attempts:[{method:'session/state',firstStatus:503,attemptCount:2,retryOutcome:'failed'}],omitted:0});
});
test('deadline and Stop during backoff never dispatch attempt two or renew the deadline',async()=>{
 for(const settings of [{delayMs:3950},{abortBackoff:true}]){
  const f=await scenario({abortBackoff:settings.abortBackoff,faults:[{phase:'PRIMARY',operation:'STATE_READ',delayMs:settings.delayMs,error:()=>httpFailure('session/state',503)}]});
  const first=f.result.nativeObservation.firstObservationFailure;assert.equal(first.code,settings.abortBackoff?'USER_STOP':'DEADLINE');assert.equal(first.attemptCount,1);assert.equal(first.budgetMs,4000);assert.equal(first.aborted,true);assert.equal(first.deadlineExpired,!settings.abortBackoff);
  assert.deepEqual(f.result.nativeObservation.observationRpcRetries,{attempts:[{method:'session/state',firstStatus:503,attemptCount:1,retryOutcome:'not_dispatched'}],omitted:0});
  assert.equal(f.calls.filter(row=>row.method==='session/state'&&row.phase==='PRIMARY').length,2); // initial idle read plus one failed attempt
 }
});
test('schema failures after a successful read are VALIDATION, never invented RPC failures',async()=>{
 for(const [invalid,code]of [['STATE','OWN_STATE_UNKNOWN'],['PAGE','OWN_PAGE_UNKNOWN'],['PRIVATE','OTHER']]){
  const f=await scenario({invalid}),first=f.result.nativeObservation.firstObservationFailure;
  assert.equal(first.operation,invalid==='PRIVATE'?'UNKNOWN':'VALIDATION');assert.equal(first.code,code);assert.equal(first.rpcMethod,null);assert.equal(first.attemptCount,null);assert.equal(first.budgetMs,null);assert.equal(first.elapsedMs,null);
  assert(!JSON.stringify(diagnostics(f.result.nativeObservation)).includes(privateText));
 }
});
test('malformed and private errors only retain fixed safe fields, including bounded status',async()=>{
 const errors=[null,privateText,Object.assign(failure(privateText),{httpStatus:200}),Object.assign(failure('RPC_HTTP_STATUS'),{rpcMethod:privateText,httpStatus:401}),{get code(){throw Error(privateText);},httpStatus:privateText},httpFailure('session/state',999)];
 for(const [index,error]of errors.entries()){
  const f=await scenario({faults:[{phase:'PRIMARY',operation:'STATE_READ',error}]}),n=f.result.nativeObservation;
  // The unchanged clock treats a null rejection as an undefined read value;
  // the resulting schema error is validation, rather than a guessed RPC error.
  assert.equal(n.firstObservationFailure.code,index===0?'OWN_STATE_UNKNOWN':[3,5].includes(index)?'RPC_HTTP_STATUS':'OTHER');assert.equal(n.firstObservationFailure.httpStatus,null);assert.equal(n.firstObservationFailure.rpcMethod,index===0?null:'session/state');assert(!JSON.stringify(diagnostics(n)).includes(privateText));
 }
 const work=await scenario({faults:[{phase:'PRIMARY',operation:'OWNED_WORK',error:()=>httpFailure('session/state',401)}]});
 assert.equal(work.result.nativeObservation.firstObservationFailure.operation,'OWNED_WORK');assert.equal(work.result.nativeObservation.firstObservationFailure.rpcMethod,null);assert.equal(work.result.nativeObservation.firstObservationFailure.httpStatus,null);assert.equal(work.result.nativeObservation.observationErrorContext,undefined);
});
test('subsequent phase facts saturate at 64 without arrays, while first and clocks stay fixed',async()=>{
 const faults=[{phase:'PRIMARY',operation:'STATE_READ',error:()=>httpFailure('session/state',401)},...Array.from({length:70},()=>({phase:'CLEANUP',operation:'STATE_READ',error:()=>httpFailure('session/state',403)}))];
 const f=await scenario({faults}),n=f.result.nativeObservation;
 assert.equal(n.firstObservationFailure.httpStatus,401);assert.equal(n.subsequentObservationFailures.CLEANUP.count,64);assert.equal(n.subsequentObservationFailures.CLEANUP.saturated,true);assert.equal(n.subsequentObservationFailures.CLEANUP.latest.httpStatus,403);
 assert.deepEqual(Object.keys(n.subsequentObservationFailures),['PRIMARY','CLEANUP']);assert(!Array.isArray(n.subsequentObservationFailures));assert(JSON.stringify(diagnostics(n)).length<2000);
 assert(Date.parse(f.result.timestampsUtc.settledAt)<=Date.parse(f.result.timestampsUtc.stopRequestedAt)+120000);assert.equal(f.clock.pending.size,0);
});
