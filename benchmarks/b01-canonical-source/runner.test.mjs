import test from 'node:test';
import assert from 'node:assert/strict';
import {runPrimary,finishAcceptance,acceptancePlan,assessAcceptance,criteria} from '../n06-evidence-storage/runner.mjs';
import {campaign,report} from './test-fixtures.mjs';
import {primaryPolicy,matchesPrimaryLimits,originalPrimaryDeadline,b01Criteria} from './policy.mjs';
import {classify} from '../../development/ci/inventory.mjs';
test('frozen policy preserves B03/B10 exact600 and B01 exact900 with one separate300 repair',()=>{
 for(const scenario of ['B03','B10','B01']){const record={scenario,limits:primaryPolicy(scenario)},started=1700000000000;assert.equal(originalPrimaryDeadline(record,started)-started,scenario==='B01'?900000:600000);
  for(const [key,value]of [['mainSeconds',1200],['repairSeconds',600],['maxRepairs',2]])assert.equal(matchesPrimaryLimits({...record,limits:{...record.limits,[key]:value}}),false);
 }
 assert.equal(primaryPolicy('B02'),null);
 for(const [name,count]of [['runner',8],['prior-supervisor',7]]){const row=classify('benchmarks/b01-canonical-source/'+name+'.test.mjs');assert.equal(row.required,true);assert.equal(row.kind,'node');assert.equal(row.lane,'portable');assert.equal(row.minTests,count);}
});
test('B03/B10 still stop at actual600 deadline and never inherit900',async()=>{
 for(const scenario of ['B03','B10']){const c=campaign({scenario,variant:scenario==='B10'?'DS':'HomeAI',completionMs:Infinity}),out=await runPrimary(c);assert.equal(c.rawClock.now()-Date.parse(out.timestampsUtc.submittedAt),600000);assert.equal(out.stopReason,'main_deadline');assert.equal(c.stats().prompts,1);assert.equal(c.stats().cancels,1);assert.equal(out.limits.repairSeconds,300);assert.equal(out.limits.maxRepairs,1);}
});
test('both B01 positions really run beyond600 through actual adapter/runner/writer and preserve one900 deadline',async()=>{
 for(const variant of ['HomeAI','DS']){const c=campaign({variant}),out=await runPrimary(c);assert.equal(out.comparison.orderPosition,variant==='HomeAI'?5:6);assert.equal(out.blockingPhase,'independent_acceptance');assert.equal(c.stats().prompts,1);assert.equal(c.stats().cancels,0);assert.equal(c.rawClock.now()-Date.parse(out.timestampsUtc.submittedAt),620000);assert.equal(Date.parse(out.operator.primaryDeadlineAt)-Date.parse(out.timestampsUtc.submittedAt),900000);assert(c.calls.every(x=>x.deadline-x.at<=4000));assert(c.checkpoints.some(x=>x.phase==='intent'&&x.receipt.durable));assert(c.checkpoints.at(-1).receipt.durable);assert(c.checkpoints.length<2048);}
});
test('B01 QA can accept after600 but before original900 without changing start or deadline',async()=>{
 const c=campaign(),out=await runPrimary(c),started=out.timestampsUtc.submittedAt,deadline=out.operator.primaryDeadlineAt;c.rawClock.advance(200000);const accepted=finishAcceptance({record:out,report:report(out,c.rawClock.now()),now:c.rawClock.now()});assert.equal(accepted.status,'PASS');assert.equal(accepted.quality.mandatoryCriteriaCount,11);assert.equal(accepted.timestampsUtc.submittedAt,started);assert.equal(accepted.operator.primaryDeadlineAt,deadline);assert.equal(accepted.timingMs.runTimeToAcceptance,820000);
});
test('B01 QA after original900 cannot accept or reset clock; forged600/1200 clocks reject',async()=>{
 const c=campaign(),out=await runPrimary(c),start=Date.parse(out.timestampsUtc.submittedAt),deadline=Date.parse(out.operator.primaryDeadlineAt);c.rawClock.advance(deadline-c.rawClock.now()+1);const late=finishAcceptance({record:out,report:report(out,c.rawClock.now()),now:c.rawClock.now()});assert.notEqual(late.status,'PASS');assert.equal(late.quality.accepted,false);assert.equal(Date.parse(late.operator.primaryDeadlineAt),deadline);
 for(const ms of [600000,1200000]){const bad=structuredClone(out);bad.operator.primaryDeadlineAt=new Date(start+ms).toISOString();assert.throws(()=>finishAcceptance({record:bad,report:report(out,start+620000),now:start+620000}),/ORIGINAL_DEADLINE_INVALID/);}
});
test('B01 no-completion stops once at actual900 and persists the original absolute deadline',async()=>{
 const c=campaign({completionMs:Infinity}),out=await runPrimary(c);assert.equal(c.rawClock.now()-Date.parse(out.timestampsUtc.submittedAt),900000);assert.equal(out.stopReason,'main_deadline');assert.equal(out.timestampsUtc.stopRequestedAt,out.operator.primaryDeadlineAt);assert.equal(c.stats().prompts,1);assert.equal(c.stats().cancels,1);assert.equal(c.stats().stops,1);
});
test('B01 requires all eleven frozen criteria, original cards/API and own task restart plan',()=>{
 assert.deepEqual(criteria.B01,b01Criteria);const refs={apiAcceptance:'synthetic-api',browserAcceptance:'synthetic-browser',acceptanceCards:'synthetic-cards'},plan=acceptancePlan({scenario:'B01'},refs);assert.equal(plan.api.args[0],'B01');assert.equal(plan.manualSource,'synthetic-cards');assert.equal(plan.restart.criterion,'B01-06');assert.equal(plan.restart.commonCriterion,'B01-C05');assert.equal(plan.manualCriteria.length,11);
 assert.throws(()=>assessAcceptance('B01',{checks:b01Criteria.slice(0,10).map(id=>({id,status:'PASS',evidence:['synthetic']}))}),/QA_CRITERIA_INCOMPLETE/);
});
test('wrong B01 limit, claimed priors and missing host restart refuse before any prompt',async()=>{
 const wrong=campaign();wrong.record.limits={...wrong.record.limits,mainSeconds:600};await assert.rejects(()=>runPrimary(wrong),/PRIMARY_NOT_PREPARED/);assert.equal(wrong.stats().prompts,0);
 const claimed=campaign();claimed.handoff.previousRuns=claimed.handoff.previousRuns.map(x=>({...x}));await assert.rejects(()=>runPrimary(claimed),/ACTUAL_BOUND_B01_PRIORS/);assert.equal(claimed.stats().prompts,0);
 const unavailable=campaign({missingRestart:true});await assert.rejects(()=>runPrimary(unavailable),/HOST_RESTART_UNCONFIRMED/);assert.equal(unavailable.stats().prompts,0);
});
