import test from 'node:test';
import assert from 'node:assert/strict';
import {runPrimary,finishAcceptance,collectorIdentity} from '../n06-evidence-storage/runner.mjs';
import {readB01PreviousRuns,requireB01PreviousRuns,validatePriorBytes,maxPriorBytes} from './prior.mjs';
import {createB01Supervisor} from './supervisor.mjs';
import {serviceCommit,ineligibleSession} from './policy.mjs';
import {campaign,report,priorEnvelope,hash,uuid} from './test-fixtures.mjs';
const until=async predicate=>{for(let i=0;i<64;i++){if(predicate())return;await new Promise(setImmediate);}throw Error('Synthetic controller phase not reached');};
test('B01 global5/6 bind every actual raw final predecessor, including900 HomeAI clock at6',()=>{
 for(const variant of ['HomeAI','DS']){const c=campaign({variant});assert.equal(requireB01PreviousRuns(c).length,variant==='HomeAI'?4:5);assert.equal(c.priors.rows[3].scenario,'B10');assert.equal(c.priors.rows[3].variant,'HomeAI');
  if(variant==='DS'){const p=c.priors.expected[4],e=JSON.parse(c.priors.files.get(p.checkpointFile));assert.equal(e.snapshot.limits.mainSeconds,900);assert.equal(Date.parse(e.snapshot.operator.primaryDeadlineAt)-Date.parse(e.snapshot.timestampsUtc.runSubmittedAt),900000);assert.equal(c.priors.rows[4].pairId,c.record.pairId);}
 }
});
test('B01 prior pins reject claimed, old, foreign, reordered, unknown, bad-clock and nondurable finals',()=>{
 const c=campaign({variant:'DS'}),claimed={...c,handoff:{...c.handoff,previousRuns:c.handoff.previousRuns.map(x=>({...x}))}};assert.throws(()=>requireB01PreviousRuns(claimed),/ACTUAL_BOUND_B01_PRIORS/);
 const foreign=campaign({variant:'DS'});foreign.record.attemptId+='-foreign';assert.throws(()=>requireB01PreviousRuns({...foreign,handoff:{...foreign.handoff,previousRuns:c.handoff.previousRuns}}),/ACTUAL_BOUND_B01_PRIORS/);
 const wrongOrder=structuredClone(c.priors.expected);[wrongOrder[2],wrongOrder[3]]=[wrongOrder[3],wrongOrder[2]];assert.throws(()=>readB01PreviousRuns({...c,expected:wrongOrder},c.priors.read),/EXACT_PRIOR_ORDER/);
 const old=structuredClone(c.priors.expected);old[0].attemptId='b03-pair03-homeai-primary';assert.throws(()=>readB01PreviousRuns({...c,expected:old},c.priors.read),/NEW_B03_PAIR04/);
 const wrongPair=structuredClone(c.priors.expected);wrongPair[4].pairId='old-B01';assert.throws(()=>readB01PreviousRuns({...c,expected:wrongPair},c.priors.read),/HOMEAI_FIRST_SAME_PAIR/);
 const p=c.priors.expected[4],check=mutate=>{const e=priorEnvelope(p);mutate(e);e.snapshotSha256=hash(JSON.stringify(e.snapshot));const bytes=Buffer.from(JSON.stringify(e));return()=>validatePriorBytes({...p,checkpointSha256:hash(bytes)},bytes);};
 for(const mutate of [e=>e.snapshot.status='HOLD',e=>e.snapshot.operator.persistence.unknownOutcome=true,e=>e.snapshot.operator.primaryDeadlineAt=new Date(1700000600000).toISOString(),e=>e.snapshot.rootFinalization.status='HOLD',e=>e.snapshot.identity.runtimeCommit='04b631bd64e4b1681c2a8ee1fd6ffcc48199ff05',e=>e.phase='observation'])assert.throws(check(mutate));
 assert.throws(()=>validatePriorBytes(p,Buffer.alloc(maxPriorBytes+1)),/ACTUAL_BOUNDED_PRIOR/);
});

function controller({badIntent=false,unknownCleanup=false}={}){
 const c=campaign(),events=[],stops=[],cleanups=[];let output,finishCalls=0;
 const supervisor=createB01Supervisor({slot:c.slot,record:c.record,previousRuns:c.handoff.previousRuns,emit:e=>events.push(e),prepare:async({handoff,onIntent})=>({
  run:async()=>{if(badIntent){const r=structuredClone(c.record);r.identity={...r.identity,...c.target,requestedModel:c.target.modelSelection};r.operator={requestId:uuid(11),baselineSeq:0,rootHandoff:handoff.id};onIntent({collectorIdentity:collectorIdentity(r),primaryStartedAt:c.rawClock.now(),primaryDeadline:c.rawClock.now()+600000});throw Error('must refuse intent');}
   output=await runPrimary({...c,handoff,io:{...c.io,checkpoint:async(snapshot,options)=>{const receipt=await c.io.checkpoint(snapshot,options);if(options.phase==='intent')onIntent({collectorIdentity:collectorIdentity(snapshot),primaryStartedAt:Date.parse(snapshot.timestampsUtc.runSubmittedAt),primaryDeadline:Date.parse(snapshot.operator.primaryDeadlineAt)});return receipt;}}});return output;},
  stop:options=>stops.push(options),cleanup:async options=>{cleanups.push(options);return unknownCleanup?{status:'HOLD',settled:false}:new Promise(()=>{});},
  finish:async r=>{finishCalls++;const accepted=finishAcceptance({record:output,report:r,now:c.rawClock.now()});
   // Synthetic fence only, exercising controller contract; no actual finalizer claim.
   accepted.rootFinalization={status:'SETTLED_VISIBLE',settled:true,visible:true,archiveState:'visible',sourceCommit:serviceCommit,requestId:accepted.operator.requestId,deadline:Date.parse(accepted.operator.primaryDeadlineAt),target:c.target,tupleSha256:'b'.repeat(64),persistence:{durable:true,checkpointId:uuid(12)}};return accepted;}
 })},{now:c.rawClock.now,setTimeout:c.rawClock.setTimeout,clearTimeout:c.rawClock.clearTimeout,randomUUID:()=>uuid(9)});
 return{...c,supervisor,events,stops,cleanups,output:()=>output,finishCalls:()=>finishCalls};
}
test('concrete B01 supervisor uses runner original900 intent and accepts QA at820 without renewing it',async()=>{
 const c=controller();c.supervisor.handle({op:'start'});await until(()=>c.supervisor.status().phase==='AWAITING_QA');const deadline=c.supervisor.status().primaryDeadlineAt;assert.equal(Date.parse(deadline)-Date.parse(c.supervisor.status().primaryStartedAt),900000);assert.equal(c.rawClock.now()-Date.parse(c.supervisor.status().primaryStartedAt),620000);
 c.rawClock.advance(200000);c.supervisor.handle({op:'accept',report:report(c.output(),c.rawClock.now())});await until(()=>c.supervisor.status().phase==='COMPLETED');assert.equal(c.supervisor.status().resultStatus,'PASS');assert.equal(c.supervisor.status().primaryDeadlineAt,deadline);assert.equal(c.finishCalls(),1);
});
test('B01 supervisor rejects a600 intent instead of silently increasing or accepting it',async()=>{
 const c=controller({badIntent:true});c.supervisor.handle({op:'start'});await until(()=>c.supervisor.status().phase==='HOLD');assert.equal(c.supervisor.status().primaryDeadlineAt,undefined);assert.equal(c.finishCalls(),0);assert.equal(c.stats().prompts,0);
});
test('B01 supervisor timer remains armed throughout QA, rejects at900 and never extends first cleanup120s',async()=>{
 const c=controller();c.supervisor.handle({op:'start'});await until(()=>c.supervisor.status().phase==='AWAITING_QA');const deadline=Date.parse(c.supervisor.status().primaryDeadlineAt);c.rawClock.advance(deadline-c.rawClock.now());assert.equal(c.supervisor.status().phase,'STOPPING');await until(()=>c.cleanups.length===1);
 const cap=c.supervisor.status().cleanupDeadlineAt;assert.equal(Date.parse(cap),deadline+120000);c.rawClock.advance(1000);c.supervisor.handle({op:'stop'});c.supervisor.handle({op:'accept',report:{}});assert.equal(c.supervisor.status().cleanupDeadlineAt,cap);assert.equal(c.finishCalls(),0);c.rawClock.advance(119000);assert.equal((await c.supervisor.wait()).phase,'HOLD');assert.equal(c.supervisor.status().reason,'ORIGINAL_CLEANUP_DEADLINE');
});
test('B01 unknown cleanup stays HOLD, without another prompt or automatic repair',async()=>{
 const c=controller({unknownCleanup:true});c.supervisor.handle({op:'start'});await until(()=>c.supervisor.status().phase==='AWAITING_QA');c.supervisor.handle({op:'stop'});await until(()=>c.supervisor.status().phase==='HOLD');assert.equal(c.supervisor.status().reason,'ACTUAL_FENCE_UNCONFIRMED');assert.equal(c.stats().prompts,1);assert.equal(c.finishCalls(),0);
});
test('disabled B01 controller, Doom and malformed Root source binding refuse before any effect',()=>{
 const c=campaign();let effects=0;assert.throws(()=>createB01Supervisor({slot:{...c.slot,executionEnabled:false},record:c.record,previousRuns:c.handoff.previousRuns,prepare:()=>effects++,emit:()=>effects++}),/DISABLED_B01/);assert.equal(effects,0);
 const doom={...c.target,sessionId:ineligibleSession};assert.throws(()=>requireB01PreviousRuns({...c,target:doom}),/FRESH_OWN_B01/);
});
