import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceManager} from './manager.mjs';
import {RepairBudget,DEFAULTS} from './policy.mjs';
import {prepareAutomaticRequest,automaticReviewView} from './automatic-review.mjs';
import {acknowledgeAutomatic,retainAutomaticProcess} from './automatic-recovery.mjs';
import {registerOwnedRangeProvider} from './owned-range-state.mjs';
import {sourceManifest} from './storage.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';

async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'automatic-recovery-')),root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'app.mjs'),'export const value=1;\n');
 t.after(async()=>{assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));assert(path.basename(directory).startsWith('automatic-recovery-'));await fs.rm(directory,{recursive:true,force:true});});
 const events=[],agent={id:'owner',status:'running',session:{id:'owner',seq:0,header:{cwd:root}},inbox:{nextTurn:[],nextStep:[]},followup(){throw Error('A running agent must not receive a second prompt');}};
 const ctx={agents:{get:id=>id==='owner'?agent:undefined},sessions:{flush:async()=>true},sessionQuery:{readSession:async()=>({events})},jobs:{list:()=>[]},logger:{warn(){}},subprocess:{},waterfall:async()=>[],sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};
 const manager=new WorkspaceManager(ctx,{stateRoot:path.join(directory,'state')},hostExecutionBinding());
 const budget=new RepairBudget({steps:80}),record={root,legacy:false,budget};manager.data={sessions:{owner:record},trash:{},workspaces:{}};manager.budgets.set('owner',budget);manager.settings=()=>({...DEFAULTS,maxStageSteps:10});
 prepareAutomaticRequest(record,budget,{turn:1,messages:[{id:'human-original',role:'user',source:{kind:'user'}}]},10);
 const a=budget.automatic,sourceHash=(await sourceManifest(root)).sha256,callId='automatic-review-inert-owned';
 Object.assign(a,{phase:'stopped',checks:1,activeCallId:callId,uncertain:true,terminalAcknowledged:false,operation:{ownerId:'owner',callId,root,sourceHash,task:structuredClone(record.automaticRequest??record.budgetRequest),startedAt:Date.now()-120001,deadlineAt:Date.now()-1}});
 budget.blocked={code:'AUTOMATIC_VERIFICATION_UNCERTAIN',message:'Inert owned verifier wait expired'};
 await manager.save();
 const report={passed:true,complete:true,stale:false,sourceHash,checks:[{id:'fixture',kind:'test',passed:true,checksPassed:1,checksTotal:1}]};
 async function terminal({id=callId,isError=false,signal=new AbortController().signal}={}){
  manager.observeToolResult({agent,name:'verify_project',arguments:{kind:'all'},callId:id,signal},{isError,value:isError?undefined:report,error:isError?{info:{code:'ABORTED'}}:undefined,content:[]});
  await manager.drainToolResults('owner');
 }
 return{manager,record,budget,a,agent,root,callId,sourceHash,report,terminal,events};
}
test('matching durable final receipt reconciles once and preserves original task accounting',async t=>{
 const f=await fixture(t);await f.terminal();f.a.terminalAcknowledged=true;await f.manager.save();
 const results=await Promise.all([f.manager.automaticReconcile('owner'),f.manager.automaticReconcile('owner')]);
 assert.equal(f.a.activeCallId,undefined);assert.equal(f.a.uncertain,undefined);assert.equal(f.budget.blocked,null);assert.equal(f.a.taskSteps,80);assert.equal(f.a.checks,1);assert.equal(f.a.proofSerial,1);assert.equal(f.budget.stage,2);assert(results.every(r=>r.continued===false));
 await f.manager.automaticReconcile('owner');await f.terminal();assert.equal(f.a.proofSerial,1);assert.equal(f.budget.stage,2);
 const view=automaticReviewView(f.a);assert.equal(view.terminalAcknowledged,true);assert.equal(view.recovery.state,'recovered');assert.equal(view.receipt,undefined);assert.equal(view.operation,undefined);assert.equal(view.activeCallId,undefined);
});
test('foreign call result and pending verifier never become terminal proof or PASS',async t=>{
 const f=await fixture(t);await f.terminal({id:'foreign-call'});assert.equal(f.a.receipt,undefined);
 await f.manager.automaticReconcile('owner');assert.equal(f.a.recovery.canContinue,false);assert.equal(f.budget.blocked.code,'AUTOMATIC_VERIFICATION_UNCERTAIN');assert.equal(f.a.proofSerial,0);
 f.a.terminalAcknowledged=true;await f.manager.automaticReconcile('owner');assert.equal(f.a.activeCallId,f.callId);assert.equal(f.a.proofSerial,0);
});
test('malformed saved final receipt cannot clear the exact unknown-operation fence',async t=>{
 const f=await fixture(t);await f.terminal();f.a.terminalAcknowledged=true;delete f.a.receipt.isError;await f.manager.automaticReconcile('owner');
 assert.equal(f.a.recovery.code,'AUTOMATIC_TERMINAL_RECEIPT_MISMATCH');assert.equal(f.a.proofSerial,0);assert.equal(f.a.activeCallId,f.callId);assert.equal(f.budget.blocked.code,'AUTOMATIC_VERIFICATION_UNCERTAIN');
});
test('aborted signal retains exact SDK error receipt and recovers without granting a pass',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();await f.terminal({isError:true,signal:controller.signal});
 assert.equal(f.a.receipt.callId,f.callId);assert.equal(f.a.receipt.isError,true);assert.equal(f.a.proofSerial,0);
 await acknowledgeAutomatic(f.manager,'owner',f.callId);await f.manager.reconcileAutomatic('owner');
 assert.equal(f.a.recovery.state,'recovered');assert.equal(f.a.recovery.code,'AUTOMATIC_RECOVERED_WITHOUT_PASS');assert.equal(f.a.taskSteps,80);assert.equal(f.budget.stage,1);assert.equal(f.a.lastCheck.passed,false);
});
test('restart reconciles only a saved matching receipt; legacy ACK without receipt remains blocked',async t=>{
 const f=await fixture(t);await f.terminal();f.a.terminalAcknowledged=true;await f.manager.save();
 const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8'));f.manager.data=saved;const reloaded=new RepairBudget(saved.sessions.owner.budget);f.manager.budgets.set('owner',reloaded);
 await f.manager.automaticReconcile('owner');assert.equal(reloaded.automatic.recovery.state,'recovered');assert.equal(reloaded.automatic.proofSerial,1);
 const g=await fixture(t);g.a.terminalAcknowledged=true;g.a.operation.cleanupDeadlineAt=Date.now()-1;await g.manager.automaticReconcile('owner');assert.equal(g.a.recovery.state,'blocked');assert.equal(g.a.recovery.code,'AUTOMATIC_TERMINAL_RECEIPT_MISSING');assert.equal(g.a.proofSerial,0);
});
test('changed source cannot earn progress from a late old-source receipt',async t=>{
 const f=await fixture(t);await f.terminal();f.a.terminalAcknowledged=true;await fs.appendFile(path.join(f.root,'app.mjs'),'// newer source\n');
 await f.manager.automaticReconcile('owner');assert.equal(f.a.proofSerial,0);assert.equal(f.budget.stage,1);assert.equal(await fs.readFile(path.join(f.root,'app.mjs'),'utf8'),'export const value=1;\n// newer source\n');
});
test('bounded cleanup stops only the retained matching own handle; kill ACK alone is not quiescence',async t=>{
 const f=await fixture(t);registerOwnedRangeProvider(f.manager.ctx.subprocess);let kills=0,release;const done=new Promise(resolve=>release=resolve),process={done,kill(){kills++;return true;}};
 await retainAutomaticProcess(f.manager,{execution:{agent:f.agent,callId:f.callId},projectRoot:f.root,sourceHash:f.sourceHash,process});
 await f.terminal();f.a.terminalAcknowledged=true;f.a.operation.cleanupDeadlineAt=Date.now()+25;
 await f.manager.automaticReconcile('owner');assert.equal(kills,1);assert.equal(f.a.activeCallId,f.callId);assert.equal(f.a.proofSerial,0);const deadline=f.a.operation.cleanupDeadlineAt;
 await f.manager.automaticReconcile('owner');assert.equal(kills,1);assert.equal(f.a.operation.cleanupDeadlineAt,deadline);
 release();await new Promise(resolve=>setImmediate(resolve));await f.manager.automaticReconcile('owner');assert.equal(f.a.recovery.state,'recovered');assert.equal(f.a.proofSerial,1);assert.equal(kills,1);
});
test('foreign process registration and changed project identity cannot authorize cleanup',async t=>{
 const f=await fixture(t);registerOwnedRangeProvider(f.manager.ctx.subprocess);let kills=0;const process={done:new Promise(()=>{}),kill(){kills++;}};
 await retainAutomaticProcess(f.manager,{execution:{agent:f.agent,callId:'foreign'},projectRoot:f.root,sourceHash:f.sourceHash,process});assert.equal(f.manager.automaticProcesses?.size??0,0);
 f.record.root+='-changed';await f.manager.automaticReconcile('owner');assert.equal(kills,0);assert.equal(f.a.recovery.state,'blocked');assert.equal(f.a.proofSerial,0);
});
test('owner reconcile refuses missing and child identities without any prompt or verifier dispatch',async t=>{
 const f=await fixture(t);await assert.rejects(f.manager.automaticReconcile('foreign'),e=>e.code==='AUTOMATIC_OWNER_REQUIRED');
 f.agent.session.header={origin:'subagent',parentSession:'missing'};await assert.rejects(f.manager.automaticReconcile('owner'),e=>e.code==='PARENT_UNAVAILABLE');
});

function acceptFollowup(f){
 let sent=0;f.agent.status='idle';f.agent.followup=message=>{sent++;f.agent.inbox.nextTurn.push(message);f.events.push({seq:++f.agent.session.seq,type:'agent/inbox/spliced',data:{inserted:[structuredClone(message)]}});};return()=>sent;
}
test('late SDK drain with closed panel autonomously queues exactly one durable same-task continuation',async t=>{
 const f=await fixture(t),sent=acceptFollowup(f);await f.terminal();await acknowledgeAutomatic(f.manager,'owner',f.callId);
 assert.equal(sent(),1);assert.equal(f.a.continuation.state,'accepted');assert.equal(f.a.continuationNeeded,false);assert.equal(f.a.taskSteps,80);
 for(let i=0;i<3;i++)assert.equal((await f.manager.automaticReconcile('owner')).continued,true);
 assert.equal(sent(),1);const persisted=JSON.parse(await fs.readFile(f.manager.file,'utf8'));assert.equal(persisted.sessions.owner.budget.automatic.continuation.state,'accepted');
});
test('unknown followup acceptance is HOLD and owner reconnect never repeats the dispatch',async t=>{
 const f=await fixture(t);f.agent.status='idle';let sent=0;f.agent.followup=()=>{sent++;throw Error('Ambiguous queue write');};await f.terminal();await acknowledgeAutomatic(f.manager,'owner',f.callId);
 assert.equal(sent,1);assert.equal(f.a.recovery.code,'AUTOMATIC_CONTINUATION_UNCONFIRMED');assert.equal(f.a.continuation.state,'unknown');assert.equal((await f.manager.automaticReconcile('owner')).continued,false);assert.equal(sent,1);
});
test('late matching durable inbox evidence resolves unknown acceptance without another followup',async t=>{
 const f=await fixture(t),sent=acceptFollowup(f);let flush=false;f.manager.ctx.sessions.flush=async()=>flush;await f.terminal();await acknowledgeAutomatic(f.manager,'owner',f.callId);
 assert.equal(sent(),1);assert.equal(f.a.continuation.state,'unknown');assert.equal(f.a.recovery.canContinue,false);
 flush=true;const response=await f.manager.automaticReconcile('owner');assert.equal(response.continued,true);assert.equal(f.a.continuation.state,'accepted');assert.equal(sent(),1);
});
test('busy or nonempty inbox never creates a second simultaneous continuation',async t=>{
 const f=await fixture(t),sent=acceptFollowup(f);f.agent.inbox.nextStep.push({id:'other-pending'});await f.terminal();await acknowledgeAutomatic(f.manager,'owner',f.callId);assert.equal(sent(),0);assert.equal(f.a.recovery.canContinue,true);
 f.agent.inbox.nextStep=[];f.agent.status='running';await f.manager.automaticReconcile('owner');assert.equal(sent(),0);
 f.agent.status='idle';await f.manager.automaticReconcile('owner');assert.equal(sent(),1);
});
test('changed task identity after late completion never resumes the previous user request',async t=>{
 const f=await fixture(t),sent=acceptFollowup(f);await f.terminal();f.record.automaticRequest={turn:2,messageId:'different-human'};await acknowledgeAutomatic(f.manager,'owner',f.callId);
 assert.equal(sent(),0);assert.equal(f.a.recovery.code,'AUTOMATIC_ORIGINAL_TASK_CHANGED');assert.equal(f.a.taskSteps,80);
});
test('explicit caller cancellation settles owned evidence without automatically restarting the task',async t=>{
 const f=await fixture(t),sent=acceptFollowup(f);f.a.operation.cancelledByCaller=true;await f.terminal({isError:true});await acknowledgeAutomatic(f.manager,'owner',f.callId);
 assert.equal(sent(),0);assert.equal(f.a.phase,'cancelled');assert.equal(f.a.recovery.canContinue,false);assert.equal(f.a.recovery.code,'AUTOMATIC_CANCELLED');assert.equal(f.a.proofSerial,0);
});

function legacy(f){
 delete f.a.operation;delete f.a.receipt;f.a.activeCallId='automatic-review-11111111-1111-4111-8111-111111111111';f.a.terminalAcknowledged=true;f.a.checks=2;f.a.nextCheckAt=80;f.agent.status='idle';
}
test('legacy ACK writes separate UNKNOWN audit without credit/reset, then requires fresh verification',async t=>{
 const f=await fixture(t);legacy(f);const before=structuredClone({steps:f.budget.steps,taskSteps:f.a.taskSteps,checks:f.a.checks,proofSerial:f.a.proofSerial,stage:f.budget.stage,errors:f.budget.errors,nextCheckAt:f.a.nextCheckAt});let invoked=0;
 f.manager.runRecoveryVerification=async()=>{invoked++;assert.equal(f.a.legacyRecovery.outcome,'TERMINAL_OUTCOME_UNKNOWN');assert.equal(f.a.receipt,undefined);assert.deepEqual({steps:f.budget.steps,taskSteps:f.a.taskSteps,checks:f.a.checks,proofSerial:f.a.proofSerial,stage:f.budget.stage,errors:f.budget.errors,nextCheckAt:f.a.nextCheckAt},before);f.a.legacyRecovery.verificationState='started';};
 await f.manager.automaticReconcile('owner');assert.equal(invoked,1);assert.equal(f.a.activeCallId,undefined);assert.equal(f.budget.blocked,null);assert.equal(f.a.recovery.canContinue,false);assert.equal(f.a.recovery.code,'AUTOMATIC_LEGACY_FRESH_VERIFICATION_REQUIRED');
});
test('legacy ACK false, active execution, pending own job and mismatching call all retain the fence',async t=>{
 for(const variant of ['ack','execution','job','call']){
  const f=await fixture(t);legacy(f);if(variant==='ack')f.a.terminalAcknowledged=false;if(variant==='execution')f.manager.automaticInFlight=new Map([['owner',new Promise(()=>{})]]);if(variant==='job')f.manager.ctx.jobs.list=()=>[{owner:'owner',id:'own-job',status:'running'}];if(variant==='call')f.a.activeCallId='other-call';
  const before=JSON.stringify({steps:f.budget.steps,taskSteps:f.a.taskSteps,checks:f.a.checks,stage:f.budget.stage,errors:f.budget.errors});await f.manager.automaticReconcile('owner');assert.equal(f.a.legacyRecovery,undefined,variant);assert.equal(f.budget.blocked.code,'AUTOMATIC_VERIFICATION_UNCERTAIN',variant);assert.equal(JSON.stringify({steps:f.budget.steps,taskSteps:f.a.taskSteps,checks:f.a.checks,stage:f.budget.stage,errors:f.budget.errors}),before,variant);
 }
});
test('legacy recovery performs one actual third bounded check before followup and no model step is charged',async t=>{
 const f=await fixture(t);legacy(f);let checks=0,sent=0;acceptFollowup(f);const followup=f.agent.followup;f.agent.followup=message=>{assert.equal(checks,1);assert.equal(f.a.checks,3);sent++;followup(message);};f.manager.locks.acquire=async()=>{};f.manager.changes.list=async()=>({files:[{path:'app.mjs'}]});
 f.manager.ctx.tools={execute:async batch=>{checks++;assert.equal(f.a.legacyRecovery.outcome,'TERMINAL_OUTCOME_UNKNOWN');assert.equal(f.budget.stage,1);assert.equal(f.budget.steps,80);assert.equal(f.a.taskSteps,80);assert.equal(f.a.checks,3);const result={isError:false,value:f.report,content:[]};f.manager.observeToolResult({agent:f.agent,name:'verify_project',arguments:{kind:'all'},callId:batch.calls[0].id,signal:batch.signal},result);return{results:[{callId:batch.calls[0].id,result}]};}};
 await f.manager.automaticReconcile('owner');assert.equal(checks,1);assert.equal(sent,1);assert.equal(f.a.taskSteps,80);assert.equal(f.a.checks,3);assert.equal(f.a.proofSerial,1);assert.equal(f.a.legacyRecovery.verificationState,'settled');
 await f.manager.automaticReconcile('owner');assert.equal(checks,1);assert.equal(sent,1);
});
test('failed fresh legacy verification remains a concrete blocker and cannot repeat automatically',async t=>{
 const f=await fixture(t);legacy(f);const sent=acceptFollowup(f);let checks=0;f.manager.locks.acquire=async()=>{};f.manager.changes.list=async()=>({files:[{path:'app.mjs'}]});
 f.manager.ctx.tools={execute:async batch=>{checks++;const result={isError:true,error:{info:{code:'PERMISSION_REQUIRED'}},content:[]};f.manager.observeToolResult({agent:f.agent,name:'verify_project',arguments:{kind:'all'},callId:batch.calls[0].id,signal:batch.signal},result);return{results:[{callId:batch.calls[0].id,result}]};}};
 await f.manager.automaticReconcile('owner');await f.manager.automaticReconcile('owner');assert.equal(checks,1);assert.equal(sent(),0);assert.equal(f.a.checks,3);assert.equal(f.a.taskSteps,80);assert.equal(f.a.proofSerial,0);assert.equal(f.budget.blocked.code,'AUTOMATIC_VERIFICATION_UNAVAILABLE');
});
