import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceManager } from './manager.mjs';
import { RepairBudget, DEFAULTS, validateSettings } from './policy.mjs';
import { prepareAutomaticRequest, recordVerifiedProgress, automaticReviewView } from './automatic-review.mjs';
import { sourceManifest } from './storage.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {registerOwnedRangeProvider} from './owned-range-state.mjs';
import {getEventListeners} from 'node:events';

const human = id => ({id, role:'user', source:{kind:'user'}});
const success = () => ({passed:true, complete:true, stale:false, checks:[{id:'real-fixture',kind:'test',passed:true,checksTotal:1,checksPassed:1}]});
const failure = () => ({passed:false, complete:false, stale:false, checks:[{id:'real-fixture',kind:'test',passed:false,checksTotal:1,checksPassed:0,diagnostics:['synthetic assertion failure']}]});
async function fixture(t, options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'automatic-review-')),root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'app.mjs'),'export const value=1;\n');
  t.after(async()=>{assert(path.basename(directory).startsWith('automatic-review-'));assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  const agent={id:'owner',status:'running',session:{id:'owner',header:{cwd:root}},inject(){}};
  const settings={...DEFAULTS,maxStageSteps:10,...options.settings},record={root,legacy:false,budgetRequest:{turn:1,messageId:'first'},firstCheckGuided:true},calls=[];
  const ctx={agents:{get:id=>id==='owner'?agent:undefined},logger:{warn(){}},sandboxPolicy:{resolve:({session})=>({mode:session.mode??'workspace-write'})},tools:{}};
  const manager=new WorkspaceManager(ctx,{stateRoot:path.join(directory,'state')}, hostExecutionBinding());manager.data={sessions:{owner:record},trash:{},workspaces:{}};manager.settings=()=>settings;manager.ensureProject=async()=>record;manager.locks.acquire=async()=>{};manager.changes.list=async()=>({files:[{path:'app.mjs'}]});
  const budget=new RepairBudget({steps:options.steps??10});manager.budgets.set('owner',budget);record.budget=budget;
  const input={agent,signal:new AbortController().signal,turn:1,step:11,messages:[human('first')]};
  ctx.tools.execute=async batch=>{
    calls.push(batch);assert.equal(batch.maxParallelToolCalls,1);assert.equal(batch.calls[0].name,'verify_project');const requested=JSON.parse(batch.calls[0].arguments).kind;assert((Array.isArray(options.reviewKind)?options.reviewKind:[options.reviewKind??'all']).includes(requested));
    const report={...(options.report?.()??success()),sourceHash:(await sourceManifest(root)).sha256};
    if(options.changeSource)await fs.appendFile(path.join(root,'app.mjs'),'// changed during check\n');
    const result={isError:false,value:report,content:[{type:'text',text:JSON.stringify(report)}]};
    manager.observeToolResult({agent,name:'verify_project',arguments:{kind:requested},callId:batch.calls[0].id,signal:batch.signal},result);
    return{results:[{callId:batch.calls[0].id,result}],additionalContexts:[],concluded:false};
  };
  return{manager,ctx,budget,record,input,root,agent,settings,calls,async step(n){return manager.preStep({...input,step:n});}};
}

test('soft limit automatically dispatches guarded verification and continues the same task without a user message',async t=>{
 const f=await fixture(t);await f.step(11);assert.equal(f.calls.length,1);assert.equal(f.budget.blocked,null);assert.equal(f.budget.stage,2);assert.equal(f.budget.steps,1);assert.equal(f.budget.automatic.taskSteps,11);assert.equal(f.budget.automatic.checks,1);assert.equal(f.budget.automatic.phase,'working');assert.match(f.manager.pendingDiagnostics.get('owner').get('AUTOMATIC_REVIEW'),/verified progress/);
});

const countedFailure = (failed=2, passed=12) => ({passed:false,complete:false,stale:false,checks:[{id:'core',kind:'test',passed:false,checksTotal:failed+passed,checksPassed:passed,countsMeasured:true}]});
async function unknownRepair(t, options={}) {
 const f=await fixture(t,{steps:0,reviewKind:'test',report:countedFailure,...options});
 f.budget.checks.test={bestScore:5,lastScore:5,fingerprint:'historical-suite'};await f.step(1);
 f.shell=async suffix=>{
  const result={isError:false,value:{exitCode:1,stdout:'AssertionError: failure '+suffix,stderr:''},content:[{type:'text',text:'✖ failed assertion '+suffix}]},before=structuredClone(result);
  await f.manager.toolResult({agent:f.agent,name:'project_exec',arguments:{command:'node --test tests/core.test.mjs'},signal:f.input.signal},result);assert.deepEqual(result,before);
 };
 for(let n=0;n<3;n++)await f.shell(n);
 assert.equal(f.calls.length,0);assert.equal(f.budget.blocked,null);assert.equal(f.budget.stalled,3);assert.equal(f.budget.checks.test.bestScore,5);
 assert.deepEqual(f.budget.automatic.repairEvidenceReview,{kind:'test'});assert.equal(f.budget.automatic.repairEvidenceUsed,true);
 const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions.owner.budget;
 assert.equal(saved.automatic.repairEvidenceUsed,true,'the sole fallback is consumed durably before dispatch');
 return f;
}

test('unknown shell totals obtain one current-source canonical baseline, not fabricated partial progress',async t=>{
 const f=await unknownRepair(t);await f.step(2);
 assert.equal(f.calls.length,1);assert.equal(f.budget.blocked,null);assert.equal(f.budget.stage,1);assert.equal(f.budget.automatic.proofSerial,0);assert.equal(f.budget.automatic.taskSteps,2);
 assert.equal(f.budget.checks.test.bestScore,2);assert.equal(f.budget.checks.test.lastScore,2);assert.equal(f.budget.stalled,1);
 assert.equal(f.budget.automatic.repairEvidenceBaseline.previous.bestScore,5);assert.equal(f.budget.automatic.repairEvidenceUsed,true);assert.equal(f.budget.automatic.repairEvidenceReview,undefined);
 assert.equal(f.budget.automatic.phase,'repairing');assert.equal(f.budget.automatic.nextCheckAt,21);assert.equal(f.record.checkpoints,undefined);
 // Persist/reload and internal followups cannot acquire a second exception.
 const reloaded=new RepairBudget(JSON.parse(JSON.stringify(f.budget)));f.manager.budgets.set('owner',reloaded);f.record.budget=reloaded;
 assert.equal(prepareAutomaticRequest(f.record,reloaded,{turn:2,messages:[{id:'internal',role:'user',source:{kind:'workspace-runtime'}}]},10),false);
 await f.shell('fourth');await f.shell('fifth');
 assert.equal(reloaded.blocked,null);await f.step(3);assert.equal(f.calls.length,1);assert.equal(reloaded.automatic.repairAllowance.deadline,122);
});

test('the one canonical baseline supports all-fail counts and subsequent strategy changes stay bounded',async t=>{
 const f=await unknownRepair(t,{report:()=>countedFailure(5,0)});await f.step(2);
 assert.equal(f.budget.stalled,1);assert.equal(f.budget.stage,1);assert.equal(f.budget.checks.test.bestScore,5);assert.equal(f.budget.automatic.proofSerial,0);
 const report={...countedFailure(5,0),sourceHash:(await sourceManifest(f.root)).sha256},result={isError:false,value:report,content:[{type:'text',text:JSON.stringify(report)}]};
 for(let n=0;n<2;n++)await f.manager.toolResult({agent:f.agent,name:'verify_project',arguments:{kind:'test'},signal:f.input.signal},result);
 assert.equal(f.budget.blocked,null);await f.step(3);assert.equal(f.calls.length,1);assert.equal(f.budget.automatic.repairAllowance.deadline,122);
});

test('unknown, stale, mismatched or refused fallback evidence fails closed without another repair window',async t=>{
 const cases=[
  {report:()=>({...countedFailure(1,0),checks:[{...countedFailure(1,0).checks[0],countsMeasured:false}]})},
  {report:()=>({...countedFailure(),stale:true})},
  {report:()=>({...countedFailure(),checks:[{...countedFailure().checks[0],kind:'browser'}]})},
  {changeSource:true},
  {refused:true},
 ];
 for(const options of cases){
  const f=await unknownRepair(t,options);if(options.refused)f.ctx.tools.execute=async batch=>{f.calls.push(batch);return{results:[{callId:batch.calls[0].id,result:{isError:true,error:{message:'Permission refused'}}}]};};
  await assert.rejects(f.step(2),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.calls.length,1);assert.equal(f.budget.automatic.taskSteps,1);assert.equal(f.budget.stage,1);assert.equal(f.budget.checks.test.bestScore,5);assert.equal(f.budget.stalled,3);
  await assert.rejects(f.step(3),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.calls.length,1);
 }
});

test('a fresh owner request replaces a queued evidence review but cannot clear an uncertain one',async t=>{
 const f=await unknownRepair(t);await f.manager.preStep({...f.input,turn:2,step:1,messages:[human('new-task')]});
 assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.repairEvidenceReview,undefined);assert.equal(f.budget.automatic.repairEvidenceUsed,undefined);assert.equal(f.budget.automatic.taskSteps,1);assert.equal(f.budget.stalled,0);
 const g=await unknownRepair(t);g.budget.automatic.phase='checking';g.budget.automatic.activeCallId='pending-owned-check';
 assert.equal(prepareAutomaticRequest(g.record,g.budget,{turn:2,messages:[human('new-task')]},10),false);
 assert.equal(g.budget.blocked?.code,'AUTOMATIC_VERIFICATION_UNCERTAIN');assert.equal(g.budget.automatic.repairEvidenceUsed,true);assert.deepEqual(g.budget.automatic.repairEvidenceReview,{kind:'test'});assert.equal(g.budget.automatic.taskSteps,1);
});

test('missing source access and repeated passing evidence cannot recycle an unknown-result fallback',async t=>{
 for(const noSource of ['read-only','unchanged']){
  const f=await unknownRepair(t);if(noSource==='read-only')f.agent.session.mode='read-only';else f.manager.changes.list=async()=>({files:[]});
  await assert.rejects(f.step(2),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.taskSteps,1);assert.equal(f.budget.stalled,3);
 }
 const f=await unknownRepair(t,{report:()=>({...success(),checks:success().checks.map(check=>({...check,countsMeasured:true}))})});
 const hash=(await sourceManifest(f.root)).sha256;assert.equal(recordVerifiedProgress(f.budget,{kind:'test',manifestHash:hash}),true);
 // Restore the already-consumed marker after seeding historical proof. A
 // duplicate passing report is not a new proof that can renew the exception.
 f.budget.automatic.repairEvidenceUsed=true;f.budget.automatic.repairEvidenceReview={kind:'test'};const serial=f.budget.automatic.proofSerial;
 await assert.rejects(f.step(2),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.calls.length,1);assert.equal(f.budget.stage,1);assert.equal(f.budget.automatic.proofSerial,serial);assert.equal(f.budget.automatic.repairEvidenceUsed,true);
});

test('new foreground source-bound passing proof resolves a queued unknown-result review without another dispatch',async t=>{
 const f=await unknownRepair(t),report={...success(),sourceHash:(await sourceManifest(f.root)).sha256};
 await f.manager.toolResult({agent:f.agent,name:'verify_project',arguments:{kind:'test'},signal:f.input.signal},{isError:false,value:report,content:[{type:'text',text:JSON.stringify(report)}]});
 assert.equal(f.budget.stage,2);assert.equal(f.budget.automatic.proofSerial,1);assert.equal(f.budget.automatic.repairEvidenceUsed,undefined);assert.equal(f.budget.automatic.repairEvidenceReview,undefined);
 await f.step(2);assert.equal(f.calls.length,0);assert.equal(f.budget.blocked,null);
});
test('pre-dispatch source IO rejection records a concrete diagnostic without creating an operation or charging a check',async t=>{
 const f=await fixture(t);f.manager.review=async()=>{throw Object.assign(Error('Synthetic source read failure'),{code:'SOURCE_MANIFEST_IO'});};
 await assert.rejects(f.step(11),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');
 assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.checks,0);assert.equal(f.budget.automatic.taskSteps,10);assert.equal(f.budget.steps,10);assert.equal(f.budget.stage,1);
 assert.equal(f.budget.automatic.activeCallId,undefined);assert.equal(f.budget.automatic.operation,undefined);assert.equal(f.budget.automatic.receipt,undefined);assert.notEqual(f.budget.automatic.phase,'checking');assert.notEqual(f.budget.automatic.uncertain,true);
 assert.match(f.manager.pendingDiagnostics.get('owner').get('AUTOMATIC_REVIEW'),/SOURCE_MANIFEST_IO/);
 const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions.owner.budget;assert.equal(saved.blocked.code,'AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(saved.automatic.checks,0);assert.equal(saved.automatic.activeCallId,undefined);
});
test('pre-dispatch source binding requires the exact root and a real manifest hash',async t=>{
 for(const binding of [{root:'/other-project',sourceHash:'a'.repeat(64)},{sourceHash:'a'.repeat(64)},null]){
  const f=await fixture(t);f.manager.review=async()=>binding;
  await assert.rejects(f.step(11),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.checks,0);assert.equal(f.budget.automatic.activeCallId,undefined);assert.equal(f.budget.automatic.operation,undefined);
 }
 const f=await fixture(t);f.manager.review=async()=>({root:f.root,sourceHash:'not-a-manifest'});await assert.rejects(f.step(11),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.checks,0);
});
test('pre-dispatch source await cannot bind a replacement owner task or mutate its accounting',async t=>{
 const f=await fixture(t);let release,entered;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.manager.review=async()=>{entered();await gate;return{root:f.root,sourceHash:'a'.repeat(64)};};
 const pending=f.step(11);pending.catch(()=>{});await waiting;
 const replacement={...f.record},replacementBudget=new RepairBudget({steps:7});replacement.budget=replacementBudget;f.manager.data.sessions.owner=replacement;f.manager.budgets.set('owner',replacementBudget);
 release();await assert.rejects(pending,e=>e.code==='AUTOMATIC_SOURCE_BINDING_CHANGED');assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.checks,0);assert.equal(f.budget.automatic.activeCallId,undefined);assert.equal(replacementBudget.steps,7);assert.equal(replacementBudget.blocked,null);assert.equal(replacementBudget.automatic,undefined);
});
test('pre-dispatch source failure in the pending owner review propagates rather than being swallowed',async t=>{
 const f=await fixture(t),failure=Object.assign(Error('The pending source binding changed'),{code:'AUTOMATIC_SOURCE_BINDING_CHANGED'}),pending=Promise.reject(failure);pending.catch(()=>{});f.manager.automaticReviews.set('owner',pending);
 await assert.rejects(f.step(11),error=>error===failure);assert.equal(f.calls.length,0);assert.equal(f.budget.steps,10);assert.equal(f.budget.automatic,undefined);
});
test('caller Stop during admission persistence leaves no unstarted active check or listener',async t=>{
 const f=await fixture(t),caller=new AbortController(),save=f.manager.save.bind(f.manager);let stopped=false;
 f.manager.save=async()=>{await save();if(!stopped&&f.budget.automatic?.operation){stopped=true;caller.abort(Error('Stop before SDK dispatch'));}};
 await assert.rejects(f.manager.preStep({...f.input,signal:caller.signal}),/Stop before SDK dispatch/);await f.manager.persistQueue;
 assert.equal(f.calls.length,0);assert.equal(f.budget.automatic.checks,0);assert.equal(f.budget.automatic.activeCallId,undefined);assert.equal(f.budget.automatic.receipt,undefined);assert.equal(f.budget.automatic.operation.admissionOutcome,'NOT_DISPATCHED');assert.equal(f.budget.automatic.operation.cancelledByCaller,true);assert.equal(f.budget.automatic.recovery.canContinue,false);assert.equal(getEventListeners(caller.signal,'abort').length,0);assert.equal(f.manager.automaticCancellations.size,0);
 await assert.rejects(f.step(12),error=>error.code==='AUTOMATIC_CANCELLED');assert.equal(f.calls.length,0);
 await f.manager.preStep({...f.input,turn:2,step:1,messages:[human('explicit-new-owner-request')]});assert.equal(f.budget.automatic.taskSteps,1);assert.equal(f.budget.automatic.checks,0);assert.equal(f.calls.length,0);
});
test('normal qualified verifier completion releases its exact handle before the next automatic check',async t=>{
 const f=await fixture(t),execute=f.ctx.tools.execute;f.ctx.subprocess={};registerOwnedRangeProvider(f.ctx.subprocess);let retained=0;
 f.ctx.tools.execute=async batch=>{retained++;await f.manager.retainAutomaticProcess({execution:{agent:f.agent,callId:batch.calls[0].id},projectRoot:f.root,sourceHash:(await sourceManifest(f.root)).sha256,process:{done:Promise.resolve(),kill(){throw Error('Finished verifier must not be killed');}}});return execute(batch);};
 await f.step(11);assert.equal(f.manager.automaticProcesses.size,0);for(let n=12;n<=21;n++)await f.step(n);assert.equal(retained,2);assert.equal(f.manager.automaticProcesses.size,0);assert.equal(f.budget.blocked,null);
});
test('ordinary failed verification grants only a bounded repair window and preserves real failure history',async t=>{
 const f=await fixture(t,{report:failure});await f.step(11);assert.equal(f.budget.stage,1);assert.equal(f.budget.steps,11);assert.equal(f.budget.automatic.phase,'repairing');assert.equal(f.budget.automatic.nextCheckAt,30);assert.equal(f.budget.stalled,1);assert.equal(f.budget.blocked,null);
 for(let n=12;n<=30;n++)await f.step(n);assert.equal(f.calls.length,1);assert.equal(f.budget.automatic.taskSteps,30);
});
test('managed repeated failed repairs request a different strategy without ending the user task',async t=>{
 const f=await fixture(t,{report:failure});for(let n=11;n<=51;n++)await f.step(n);
 assert.equal(f.calls.length,3);assert.equal(f.budget.blocked,null);assert.equal(f.budget.stage,1);assert.equal(f.budget.stalled,3);assert.equal(f.budget.automatic.taskSteps,51);
 assert.match(f.manager.pendingDiagnostics.get('owner').get('REPAIR_STRATEGY_CHANGE'),/different approach/i);
 assert.equal(f.budget.automatic.phase,'repairing');
});

test('an old stagnation stop becomes truthful repairing status without renewing accounting',async t=>{
 const f=await fixture(t,{steps:0});await f.step(1);f.budget.stalled=3;f.budget.blocked={code:'REPAIR_NO_PROGRESS',message:'Old policy'};f.budget.automatic.phase='stopped';f.budget.automatic.reason='REPAIR_NO_PROGRESS';
 await f.step(2);assert.equal(f.calls.length,0);assert.equal(f.budget.blocked,null);assert.equal(f.budget.automatic.phase,'repairing');assert.equal(f.budget.automatic.reason,undefined);assert.equal(f.budget.automatic.taskSteps,2);assert.equal(f.budget.stalled,3);assert.equal(f.budget.automatic.repairAllowance.deadline,121);
});

async function warnedRepair(t, options={}) {
 const f=await fixture(t,{steps:0,reviewKind:['all','test'],report:countedFailure,...options});await f.step(1);
 f.foreground=async (kind,passed,checkKinds=[kind])=>{
  const sourceHash=(await sourceManifest(f.root)).sha256,report={passed,complete:passed,stale:false,sourceHash,checks:checkKinds.map(checkKind=>({id:checkKind,kind:checkKind,passed,checksTotal:14,checksPassed:passed?14:12,countsMeasured:true}))};
  await f.manager.toolResult({agent:f.agent,name:'verify_project',arguments:{kind},callId:'foreground-'+kind,signal:f.input.signal},{isError:false,value:report,content:[{type:'text',text:JSON.stringify(report)}]});
 };
 if(options.priorPass)await f.foreground('test',true);
 for(let n=0;n<3;n++)await f.foreground('test',false);
 assert.equal(f.budget.automatic.repairAllowance.kind,'test');assert.equal(f.budget.automatic.repairAllowance.deadline,121);return f;
}

test('one repair allowance survives reload and internal followups and stops at its exact deadline without rechecking current failure',async t=>{
 const f=await warnedRepair(t);await f.manager.save();const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8'));const budget=new RepairBudget(saved.sessions.owner.budget);f.manager.budgets.set('owner',budget);f.record.budget=budget;
 assert.equal(prepareAutomaticRequest(f.record,budget,{turn:2,messages:[{id:'internal',role:'user',source:{kind:'workspace-runtime'}}]},10),false);
 for(let n=2;n<=121;n++)await f.step(n);
 const calls=f.calls.length,deadline=budget.automatic.repairAllowance.deadline;assert.equal(deadline,121);assert.equal(budget.automatic.taskSteps,121);assert.equal(budget.blocked,null);
 await assert.rejects(f.step(122),e=>e.code==='AUTONOMOUS_REPAIR_EXHAUSTED');assert.equal(f.calls.length,calls);assert.equal(budget.automatic.taskSteps,121);assert.equal(budget.automatic.repairAllowance.deadline,deadline);
 await assert.rejects(f.step(123),e=>e.code==='AUTONOMOUS_REPAIR_EXHAUSTED');assert.equal(f.calls.length,calls);
});

test('only a new passing proof for the failing kind renews the repair allowance',async t=>{
 const f=await warnedRepair(t,{priorPass:true}),allowance=f.budget.automatic.repairAllowance;
 await f.foreground('test',true);assert.equal(f.budget.automatic.repairAllowance,allowance,'repeated passing source does not renew');
 await fs.appendFile(path.join(f.root,'app.mjs'),'// build change\n');await f.foreground('build',true);assert.equal(f.budget.automatic.repairAllowance,allowance);
 await fs.appendFile(path.join(f.root,'app.mjs'),'// unrelated all selection\n');await f.foreground('all',true,['build']);assert.equal(f.budget.automatic.repairAllowance,allowance);
 await fs.appendFile(path.join(f.root,'app.mjs'),'// repaired original test behavior\n');await f.foreground('all',true,['build','test']);assert.equal(f.budget.automatic.repairAllowance,undefined);assert.equal(f.budget.automatic.taskSteps,1);
});

test('the last repair step receives one current-source final check; PASS continues and failure exhausts exactly once',async t=>{
 for(const passed of [true,false]){
  let final=false;const f=await warnedRepair(t,{report:()=>final&&passed?{...success(),checks:success().checks.map(check=>({...check,countsMeasured:true}))}:countedFailure()});
  for(let n=2;n<=121;n++)await f.step(n);const calls=f.calls.length;
  await fs.appendFile(path.join(f.root,'app.mjs'),'// last admitted repair\n');final=true;
  if(passed){await f.step(122);assert.equal(f.budget.automatic.repairAllowance,undefined);assert.equal(f.budget.blocked,null);assert.equal(f.budget.automatic.taskSteps,122);}
  else{await assert.rejects(f.step(122),e=>e.code==='AUTONOMOUS_REPAIR_EXHAUSTED');assert.equal(f.budget.automatic.taskSteps,121);await assert.rejects(f.step(123),e=>e.code==='AUTONOMOUS_REPAIR_EXHAUSTED');}
  assert.equal(f.calls.length,calls+1);assert.equal(JSON.parse(f.calls.at(-1).calls[0].arguments).kind,'test');
 }
});
test('unchanged passing checks do not reset a stage or erase failed-round history',async t=>{
 const f=await fixture(t);await f.step(11);f.budget.stalled=2;const errors=f.budget.errors={kept:2};for(let n=12;n<=20;n++)await f.step(n);await f.step(21);assert.equal(f.calls.length,2);assert.equal(f.budget.stage,2);assert.equal(f.budget.steps,11);assert.equal(f.budget.stalled,2);assert.equal(f.budget.errors,errors);assert.equal(f.budget.automatic.phase,'working');assert.equal(f.budget.automatic.nextCheckAt,40);assert.match(f.manager.pendingDiagnostics.get('owner').get('AUTOMATIC_REVIEW'),/do not invent a repair/);
});
test('legacy task count is accounting rather than a manual gate, including reload and internal followups',async t=>{
 const f=await fixture(t,{steps:59,settings:{maxTaskSteps:60,maxAutomaticChecks:6,maxStageSteps:60}});await f.step(60);assert.equal(f.budget.automatic.taskSteps,60);await f.step(61);assert.equal(f.budget.blocked,null);assert.equal(f.calls.length,1);
 const reloaded=new RepairBudget(JSON.parse(JSON.stringify(f.budget)));assert.equal(reloaded.automatic.taskSteps,61);assert.equal(prepareAutomaticRequest(f.record,reloaded,{turn:2,messages:[human('first'),{role:'user',id:'internal',source:{kind:'workspace-runtime'}}]},60),false);assert.equal(reloaded.automatic.taskSteps,61);
 assert.equal(await fs.readFile(path.join(f.root,'app.mjs'),'utf8'),'export const value=1;\n');
});
test('only a new real human request renews the allowance; subagents cannot do so',async t=>{
 const f=await fixture(t);await f.step(11);f.budget.stalled=3;f.budget.errors={old:3};const checks=f.budget.checks;
 for(const input of [{turn:2,messages:[human('second')],owner:false},{turn:2,messages:[{role:'user',id:'internal',source:{kind:'workspace-runtime'}}]},{turn:2,messages:[human('first')]}]){
  assert.equal(prepareAutomaticRequest(f.record,f.budget,input,10),false);assert.equal(f.budget.automatic.taskSteps,11);assert.equal(f.budget.stalled,3);assert.deepEqual(f.budget.errors,{old:3});
 }
 assert.equal(prepareAutomaticRequest(f.record,f.budget,{turn:3,messages:[human('second')],owner:true},10),true);assert.equal(f.budget.automatic.taskSteps,0);assert.equal(f.budget.automatic.checks,0);assert.equal(f.budget.stalled,0);assert.deepEqual(f.budget.errors,{});assert.equal(f.budget.checks,checks);
});
test('concurrent child steps share one verification and retries are charged once even when interleaved',async t=>{
 const f=await fixture(t);f.manager.ownerAgent=()=>f.agent;const child=id=>({id,session:{id,header:{origin:'subagent',parentSession:'owner'}}});
 const a={...f.input,agent:child('a'),step:1},b={...f.input,agent:child('b'),step:1};await Promise.all([f.manager.preStep(a),f.manager.preStep(b)]);assert.equal(f.calls.length,1);assert.equal(f.budget.automatic.taskSteps,12);await f.manager.preStep(a);assert.equal(f.budget.automatic.taskSteps,12);assert([a.agent,b.agent].includes(f.calls[0].agent),'executor retains an initiating child scope rather than borrowing owner permissions');
});
test('stale, changed-source or zero-test outcomes never manufacture verified progress',async t=>{
 for(const options of[{report:()=>({...success(),stale:true})},{changeSource:true},{report:()=>({...success(),checks:[]})}]){
  const f=await fixture(t,options);await f.step(11);assert.equal(f.budget.stage,1);assert.equal(f.budget.automatic.proofSerial,0);assert.equal(f.budget.steps,11);assert.equal(f.budget.automatic.phase,'repairing');
 }
});
test('SDK refusal and cancellation do not reset counters or create success',async t=>{
 const f=await fixture(t);f.ctx.tools.execute=async batch=>({results:[{callId:batch.calls[0].id,result:{isError:true,error:{message:'Permission required'}}}]});await assert.rejects(f.step(11),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(f.budget.stage,1);assert.equal(f.budget.automatic.taskSteps,10);
 const g=await fixture(t),controller=new AbortController();g.ctx.tools.execute=async()=>{controller.abort(Error('cancelled fixture'));throw controller.signal.reason;};await assert.rejects(g.manager.preStep({...g.input,signal:controller.signal}),/cancelled fixture/);assert.equal(g.budget.automatic.phase,'cancelled');assert.equal(g.budget.stage,1);assert.equal(g.budget.automatic.checks,1);
});
test('a concurrent successful verifier cannot be mistaken for this failed automatic call, and a missing observer fails closed',async t=>{
 const f=await fixture(t);f.ctx.tools.execute=async batch=>{
  const sourceHash=(await sourceManifest(f.root)).sha256,other={...success(),sourceHash},own={...failure(),sourceHash};
  f.manager.observeToolResult({agent:f.agent,name:'verify_project',arguments:{kind:'build'},callId:'other-concurrent-check',signal:batch.signal},{isError:false,value:other,content:[{type:'text',text:JSON.stringify(other)}]});
  const result={isError:false,value:own,content:[{type:'text',text:JSON.stringify(own)}]};f.manager.observeToolResult({agent:f.agent,name:'verify_project',arguments:{kind:'all'},callId:batch.calls[0].id,signal:batch.signal},result);return{results:[{callId:batch.calls[0].id,result}]};
 };
 await f.step(11);assert.equal(f.budget.stage,2,'only the other actual success earned its stage');assert.equal(f.budget.automatic.phase,'repairing');assert.equal(f.budget.automatic.lastAutomaticOutcome.verifiedProgress,false);assert.match(f.manager.pendingDiagnostics.get('owner').get('AUTOMATIC_REVIEW'),/bounded repair/);
 const g=await fixture(t);g.ctx.tools.execute=async batch=>({results:[{callId:batch.calls[0].id,result:{isError:false,value:success()}}]});await assert.rejects(g.step(11),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(g.budget.stage,1);
});
test('legacy check counts and repair warnings do not stop work; crashed in-flight checks stay fenced',async t=>{
 const f=await fixture(t,{settings:{maxAutomaticChecks:1},report:failure});for(let n=11;n<=51;n++)await f.step(n);assert.equal(f.budget.blocked,null);assert.equal(f.calls.length,3);assert.equal(f.budget.automatic.repairAllowance.deadline,170);
 const g=await fixture(t);prepareAutomaticRequest(g.record,g.budget,g.input,10);g.budget.automatic.phase='checking';await assert.rejects(g.step(11),e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');assert.equal(g.calls.length,0);
});
test('saved checking plus a new human turn remains durably fenced, including manual review and idle lease release',async t=>{
 const f=await fixture(t);prepareAutomaticRequest(f.record,f.budget,f.input,10);f.budget.automatic.phase='checking';f.budget.automatic.activeCallId='pre-crash-call';f.budget.automatic.checks=1;await f.manager.save();
 const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8')),reloaded=new RepairBudget(saved.sessions.owner.budget);f.record.budget=saved.sessions.owner.budget;f.manager.budgets.set('owner',reloaded);const same=reloaded.automatic;
 await assert.rejects(f.manager.preStep({...f.input,turn:2,step:1,messages:[human('new-owner-request')]}),e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');
 assert.equal(reloaded.automatic,same);assert.equal(same.taskSteps,10);assert.equal(same.checks,1);assert.equal(same.activeCallId,'pre-crash-call');assert.equal(f.calls.length,0);assert.equal(same.uncertain,true);assert.equal(same.terminalAcknowledged,false);
 assert.equal(JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions.owner.budget.blocked.code,'AUTOMATIC_VERIFICATION_UNCERTAIN');
 f.agent.status='idle';await assert.rejects(f.manager.reviewResume('owner','Verify current work and retry one smaller repair.'),e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');assert.throws(()=>reloaded.resume('Use another concrete approach before proceeding.'),e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');let released=0;f.manager.locks.release=async()=>released++;await f.manager.releaseIfIdle('owner');assert.equal(released,0);
});
test('automatic verification has its own fixed deadline and a timeout never becomes progress',async t=>{
 const f=await fixture(t);let timerCreated=0;const original=globalThis.setTimeout;const timer=t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms>=110000&&ms<=120000){timerCreated++;queueMicrotask(fn);return{unref(){}};}return original(fn,ms,...args);});f.ctx.tools.execute=async({signal})=>{await Promise.resolve();signal.throwIfAborted();throw Error('Deadline was ignored');};
 try{await assert.rejects(f.step(11),e=>['AUTOMATIC_VERIFICATION_TIMEOUT','AUTOMATIC_VERIFICATION_UNCERTAIN'].includes(e.code));}finally{timer.mock.restore();}assert.equal(timerCreated,1);assert.equal(f.budget.stage,1);assert.equal(f.budget.automatic.taskSteps,10);assert.equal(f.budget.automatic.checks,1);
});
test('read-only scopes, unchanged code and prose never acquire a writable verifier or manufacture progress',async t=>{
 for(const mode of['read-only','prose','unchanged']){
  const f=await fixture(t);if(mode==='read-only')f.agent.session.mode='read-only';else f.manager.changes.list=async()=>({files:mode==='prose'?[{path:'notes.md'}]:[]});await f.step(11);assert.equal(f.calls.length,0);assert.equal(f.budget.stage,1);assert.equal(f.budget.steps,11);assert.equal(f.budget.automatic.taskSteps,11);assert.equal(f.budget.automatic.nextCheckAt,20);
 }
});
test('new source evidence advances a stage but never renews the actual task counter',async t=>{
 const f=await fixture(t);await f.step(11);await fs.appendFile(path.join(f.root,'app.mjs'),'export const next=2;\n');for(let n=12;n<=21;n++)await f.step(n);assert.equal(f.calls.length,2);assert.equal(f.budget.stage,3);assert.equal(f.budget.automatic.taskSteps,21);
});
test('long task crosses legacy task/check limits without consent while private accounting stays hidden',async t=>{
 const f=await fixture(t,{steps:0,settings:{maxTaskSteps:60,maxAutomaticChecks:6}});
 for(let n=1;n<=81;n++){if(n%10===0)await fs.appendFile(path.join(f.root,'app.mjs'),'// completed small change '+n+'\n');await f.step(n);}
 assert.equal(f.calls.length,8);assert.equal(f.budget.stage,9);assert.equal(f.budget.automatic.taskSteps,81);assert.equal(f.budget.blocked,null);
 const view=automaticReviewView(f.budget.automatic);assert.equal(view.taskSteps,81);assert.equal(view.admitted,undefined);assert.equal(view.proofs,undefined);
});
test('explicit one-click review schedules actual verification without inventing a stage or renewing counters',async t=>{
 const f=await fixture(t,{steps:2});await f.step(3);const before=f.budget.automatic.taskSteps,stage=f.budget.stage;f.budget.blocked={code:'REPAIR_NO_PROGRESS',message:'Fixture'};f.agent.status='idle';let followup;f.agent.followup=value=>followup=value;
 await f.manager.reviewResume('owner','First verify the current work and repair one smaller behavior.');assert(followup);assert.equal(f.budget.automatic.taskSteps,before);assert.equal(f.budget.stage,stage);assert.equal(f.budget.automatic.nextCheckAt,before);f.agent.status='running';await f.step(4);assert.equal(f.calls.length,1);assert.equal(f.budget.stage,stage+1);assert.equal(f.budget.automatic.taskSteps,before+1);
});
test('settings have autonomous defaults and finite validated bounds; verification cannot credit an unbound hash',()=>{
 assert.equal(DEFAULTS.maxTaskSteps,240);assert.equal(DEFAULTS.maxAutomaticChecks,3);for(const settings of[{maxTaskSteps:601},{maxTaskSteps:59},{maxAutomaticChecks:7},{maxAutomaticChecks:-1}])assert.throws(()=>validateSettings(settings),e=>e.code==='INVALID_SETTINGS');assert.equal(validateSettings({maxAutomaticChecks:0}).maxAutomaticChecks,0);
 const budget=new RepairBudget();prepareAutomaticRequest({},budget,{turn:1,messages:[human('one')]},60);assert.equal(recordVerifiedProgress(budget,{kind:'test'}),false);assert.equal(budget.automatic.proofSerial,0);
});
test('measured partial progress avoids a warning; unchanged failures start one finite repair allowance',()=>{
 const budget=new RepairBudget({steps:10});prepareAutomaticRequest({},budget,{turn:1,messages:[human('one')]},60);
 const observe=passed=>budget.observe({kind:'test',exitCode:1,text:'same concrete assertion',recovery:{failed:true,verification:true,category:'verification',evidence:{failed:1,passed}}});
 for(const passed of[0,1,2])observe(passed);assert.equal(budget.blocked,null);assert.equal(budget.stage,1);assert.equal(budget.steps,10);assert.equal(budget.automatic.taskSteps,10);assert.equal(budget.stalled,0);
 for(let n=0;n<3;n++)observe(2);assert.equal(budget.blocked,null);assert.equal(budget.automatic.repairAllowance.deadline,130);assert.equal(budget.automatic.taskSteps,10);
 const unbound=new RepairBudget();prepareAutomaticRequest({},unbound,{turn:1,messages:[human('one')]},60);unbound.observe({kind:'test',exitCode:0,text:'# tests 1\n# pass 1\n# fail 0'});assert.equal(unbound.stage,1);assert.equal(unbound.automatic.proofSerial,0);
});
test('an actual foreground test of an old source cannot credit a different source changed by another child',async t=>{
 const f=await fixture(t,{steps:2});await f.step(3);const ready=path.join(path.dirname(f.root),'ready'),release=path.join(path.dirname(f.root),'release'),file=path.join(f.root,'race.test.cjs');
 await fs.writeFile(file,"const fs=require('node:fs');require('node:test')('old snapshot',async()=>{const old=fs.readFileSync("+JSON.stringify(path.join(f.root,'app.mjs'))+",'utf8');fs.writeFileSync("+JSON.stringify(ready)+",'ready');while(!fs.existsSync("+JSON.stringify(release)+"))await new Promise(r=>setTimeout(r,5));require('node:assert/strict').match(old,/value=1/);});");
 const before=(await sourceManifest(f.root)).sha256,env={...process.env};delete env.NODE_TEST_CONTEXT;const run=promisify(execFile)(process.execPath,['--test','--test-reporter=tap',file],{timeout:5000,windowsHide:true,env});run.catch(()=>{});let result;
 try{const until=Date.now()+2500;while(!await fs.access(ready).then(()=>true,()=>false)){if(Date.now()>until)throw Error('Synthetic verifier did not start');await new Promise(r=>setTimeout(r,5));}await fs.writeFile(path.join(f.root,'app.mjs'),'export const value=2;\n');}finally{await fs.writeFile(release,'release');result=await run;}
 assert.notEqual((await sourceManifest(f.root)).sha256,before);assert.match(result.stdout,/# pass 1/);const outcome={isError:false,value:{exitCode:0,stdout:result.stdout,stderr:result.stderr},content:[{type:'text',text:result.stdout}]},retained=structuredClone(outcome);
 await f.manager.toolResult({agent:f.agent,name:'project_exec',arguments:{command:'node --test race.test.cjs'},signal:f.input.signal},outcome);assert.deepEqual(outcome,retained);assert.equal(f.budget.stage,1);assert.equal(f.budget.steps,3);assert.equal(f.budget.automatic.proofSerial,0);assert.equal(f.record.checkpoints,undefined);assert.match(f.manager.pendingDiagnostics.get('owner').get('VERIFICATION_SOURCE_UNBOUND'),/verify_project/);
});

test('actual pinned SDK executor runs its guard and single final observer for controller verification; refusal cannot bypass either',async t=>{
 const f=await fixture(t),cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js'),base=path.resolve(path.dirname(cli),'../..');
 const load=name=>import(pathToFileURL(path.join(base,name,'lib/index.js')));
 const[cordis,prompt,tools,pipeline,scope]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),import(pathToFileURL(path.join(base,'dsh-tools/lib/pipeline.js'))),load('dsh-scope')]);
 const ctx=new cordis.Context();new prompt.default(ctx,{});new tools.default(ctx);ctx.provide('agents',{get:()=>f.agent,list:()=>[f.agent]});ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write'})});
 const scoped=scope.createScope(ctx,f.agent);f.agent.ctx=scoped.ctx;f.agent.scope=scoped;f.manager.ctx=ctx;
 t.after(async()=>{await scoped.dispose();await ctx.fiber.dispose();});
 let guarded=0,observed=0,executed=0,allow=true,lastOutcome,hang=false,releaseHang;
 ctx.tools.guard(()=>{guarded++;if(!allow)return{reason:'Synthetic policy refusal',info:{code:'PERMISSION_REQUIRED'}};});
 ctx.on('tools/result',(exec,result)=>{observed++;lastOutcome=result;f.manager.observeToolResult(exec,result);},{global:true});
 ctx.tools.register({name:'verify_project',description:'Synthetic SDK integration verifier',parameters:{type:'object',properties:{kind:{type:'string'}},required:['kind'],additionalProperties:false},isConcurrencySafe:()=>false,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(){
  executed++;if(hang){await new Promise(resolve=>releaseHang=resolve);return{...success(),sourceHash:(await sourceManifest(f.root)).sha256};}await fs.writeFile(path.join(f.root,'behavior.test.cjs'),"require('node:test')('retained fixture behavior',()=>require('node:assert/strict').equal(2+2,4));");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap',path.join(f.root,'behavior.test.cjs')],{timeout:3000,windowsHide:true,env});assert.match(result.stdout,/(?:pass\s+1)/);
  return{...success(),sourceHash:(await sourceManifest(f.root)).sha256};
 }});
 const dispatch=new pipeline.ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>pipeline.executeToolBatch(input,dispatch,()=>1)});
 // The verifier must not create application source after its admission hash.
 await fs.writeFile(path.join(f.root,'behavior.test.cjs'),"require('node:test')('retained fixture behavior',()=>require('node:assert/strict').equal(2+2,4));");
 try{await f.step(11);}catch(error){assert.fail(JSON.stringify({code:error.code,guarded,observed,executed,lastOutcome}));}assert.equal(executed,1);assert.equal(guarded,1);assert.equal(observed,1);assert.equal(f.budget.stage,2);assert.equal(f.budget.automatic.taskSteps,11);assert.equal(f.manager.automaticCancellations.size,0);assert.equal(getEventListeners(f.input.signal,'abort').length,0);
 for(let n=12;n<=20;n++)await f.step(n);allow=false;await assert.rejects(f.step(21),e=>e.code==='AUTOMATIC_VERIFICATION_UNAVAILABLE');assert.equal(executed,1);assert.equal(guarded,2);assert.equal(observed,2);assert.equal(f.budget.stage,2);assert.equal(f.budget.automatic.taskSteps,20);
 // A real SDK body that ignores AbortSignal must not hold preStep forever.
 // Release only this synthetic fixture after proving bounded fencing; product
 // code never kills, replaces or bypasses the SDK executor.
 allow=true;hang=true;const advance=step=>f.manager.preStep({...f.input,turn:2,step,messages:[human('next-request')]});for(let n=1;n<=10;n++)await advance(n);
 const originalTimer=globalThis.setTimeout;let fire,execution;
 const timer=t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms>=110000&&ms<=120000){fire=()=>fn(...args);return{unref(){}};}return originalTimer(fn,ms,...args);});
 try{
  const pending=advance(11);pending.catch(()=>{});const until=Date.now()+2500;while(!releaseHang||!fire){if(Date.now()>until)throw Error('Synthetic SDK body did not start');await new Promise(r=>setImmediate(r));}
  execution=f.manager.automaticInFlight.get('owner');assert(execution);fire();let deadline;
  try{await Promise.race([assert.rejects(pending,e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN'),new Promise((_,reject)=>{deadline=originalTimer(()=>reject(Error('preStep remained stuck after deadline')),1500);})]);}finally{clearTimeout(deadline);}
  assert.equal(f.budget.automatic.uncertain,true);assert.equal(f.budget.automatic.taskSteps,10);assert.equal(f.budget.automatic.terminalAcknowledged,false);assert.equal(f.budget.stage,2);assert.equal(f.manager.automaticInFlight.has('owner'),true);
  f.agent.status='idle';let releases=0;f.manager.locks.release=async()=>releases++;await f.manager.releaseIfIdle('owner');assert.equal(releases,0);await assert.rejects(f.manager.reviewResume('owner','Verify the current work and retry a smaller stage.'),e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');
  await assert.rejects(f.manager.preStep({...f.input,turn:3,step:1,messages:[human('fresh-after-timeout')]}),e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');assert.equal(executed,2);
 }finally{timer.mock.restore();f.agent.status='running';releaseHang?.();if(execution)await execution;await new Promise(r=>setImmediate(r));await f.manager.persistQueue;}
 await f.manager.reconcileAutomatic('owner');assert.equal(f.manager.automaticInFlight.has('owner'),false);assert.equal(f.budget.automatic.terminalAcknowledged,true);assert.equal(f.budget.automatic.uncertain,undefined);assert.equal(f.budget.automatic.recovery.state,'recovered');assert.equal(f.budget.stage,2);assert.equal(f.budget.automatic.taskSteps,10);
 // A second real SDK dispatch times out while its original caller is still
 // alive. A later explicit Stop must remain authoritative through late drain.
 for(let n=12;n<=31;n++)await advance(n);
 const caller=new AbortController(),events=[];let followups=0,stopDeadline,stoppedExecution;
 f.agent.session.seq=0;f.agent.inbox={nextTurn:[],nextStep:[]};
 f.agent.followup=message=>{followups++;f.agent.inbox.nextTurn.push(message);events.push({seq:f.agent.session.seq++,type:'agent/inbox/spliced',data:{inserted:[message]}});};
 ctx.provide('sessions',{flush:async()=>true});ctx.provide('sessionQuery',{readSession:async()=>({events})});
 releaseHang=undefined;
 const stopTimer=t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{if(ms>=110000&&ms<=120000){stopDeadline=()=>fn(...args);return{unref(){}};}return originalTimer(fn,ms,...args);});
 try{
  const pending=f.manager.preStep({...f.input,turn:2,step:32,messages:[human('next-request')],signal:caller.signal});pending.catch(()=>{});
  const until=Date.now()+2500;while(!releaseHang||!stopDeadline){if(Date.now()>until)throw Error('Second synthetic SDK body did not start');await new Promise(r=>setImmediate(r));}
  stoppedExecution=f.manager.automaticInFlight.get('owner');assert(stoppedExecution);stopDeadline();
  await assert.rejects(pending,e=>e.code==='AUTOMATIC_VERIFICATION_UNCERTAIN');assert.equal(caller.signal.aborted,false);
  const operation=f.budget.automatic.operation;assert.notEqual(operation.cancelledByCaller,true);
  f.agent.status='idle';caller.abort(Error('Explicit user Stop after verification timeout'));await f.manager.persistQueue;
  const persisted=JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions.owner.budget.automatic;
  assert.equal(persisted.operation.cancelledByCaller,true);assert.equal(persisted.operation.cancellation.callId,operation.callId);assert.equal(persisted.operation.cancellation.sourceHash,operation.sourceHash);assert.deepEqual(persisted.operation.cancellation.task,operation.task);
  releaseHang();await stoppedExecution;await f.manager.drainToolResults('owner');await f.manager.reconcileAutomatic('owner');await f.manager.persistQueue;
  assert.equal(followups,0);assert.equal(f.budget.automatic.recovery.canContinue,false);assert.equal(f.budget.automatic.recovery.code,'AUTOMATIC_CANCELLED');assert.equal(getEventListeners(caller.signal,'abort').length,0);
  const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8'));f.manager.data=saved;const reloaded=new RepairBudget(saved.sessions.owner.budget);f.manager.budgets.set('owner',reloaded);
  await f.manager.reconcileAutomatic('owner');assert.equal(reloaded.automatic.operation.cancelledByCaller,true);assert.equal(reloaded.automatic.continuationNeeded,false);assert.equal(followups,0);
 }finally{stopTimer.mock.restore();releaseHang?.();if(stoppedExecution)await stoppedExecution;await f.manager.reconcileAutomatic('owner');await f.manager.persistQueue;}
});
