import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {WorkspaceManager} from './manager.mjs';
import {RepairBudget} from './policy.mjs';
import {sourceManifest} from './storage.mjs';
import {consumedPrestepProof} from './automatic-consumed-recovery.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const errorMessage='The recorded continuation has no confirmed durable acceptance. It will not be submitted again.';
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'consumed-prestep-')),root=path.join(directory,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'app.mjs'),'export const value=1;\n');
 t.after(async()=>{assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));assert(path.basename(directory).startsWith('consumed-prestep-'));await fs.rm(directory,{recursive:true,force:true});});
 const message={id:'old-internal',role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'Continue the SAME original task with unchanged accounting.'}]},task={turn:1,messageId:'human-original'},events=[{seq:0,type:'user/message',data:{id:task.messageId,role:'user',source:{kind:'user'},content:[]}},{seq:1,type:'session/end-seed',data:{}}];
 const add=(type,data)=>events.push({seq:events.length,type,data});
 add('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]});add('turn/start',{turn:3});add('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});add('turn/end',{turn:3,reason:{kind:'error',error:{message:errorMessage,code:'UNKNOWN'}}});add('session/end-seed',{});
 let maintenance,flush=async()=>true,sends=0,wakes=0,removes=0;
 const agent={id:'owner',status:'idle',session:{id:'owner',seq:events.length,header:{cwd:root}},inbox:{nextTurn:[],nextStep:[],remove(id){const n=this.nextTurn.findIndex(m=>m.id===id);if(n<0)return false;this.nextTurn.splice(n,1);removes++;add('agent/inbox/spliced',{target:'next-turn',start:n,removedCount:1,inserted:[],outcome:'canceled'});agent.session.seq=events.length;return true;}},
  followup(input){assert(maintenance,'Real dispatch must be reserved by maintenance');sends++;this.inbox.nextTurn.push(input);add('agent/inbox/spliced',{target:'next-turn',start:this.inbox.nextTurn.length-1,inserted:[structuredClone(input)]});this.session.seq=events.length;},
  async runMaintenance(job){assert(!maintenance);maintenance=new AbortController();try{return await job(maintenance.signal);}finally{if(this.inbox.nextTurn.length||this.inbox.nextStep.length)wakes++;maintenance=null;}},
 };
 const ctx={agents:{get:id=>id==='owner'?agent:undefined},sessions:{flush:async()=>flush()},sessionQuery:{readSession:async()=>({events:structuredClone(events)})},jobs:{list:()=>[]},sessionProjections:{snapshot:()=>({asOfSeq:agent.session.seq-1,values:{subagentCatalog:[]}})},terminalController:{list:()=>[]},logger:{warn(){}},get(name){return this[name];}};
 const manager=new WorkspaceManager(ctx,{stateRoot:path.join(directory,'state')},hostExecutionBinding()),sourceHash=(await sourceManifest(root)).sha256,receipt={version:1,callId:'automatic-review-owned',ownerId:'owner',root,sourceHash,at:1,isError:false,report:{sourceHash,passed:false,complete:false,stale:false,checks:[]}},budget=new RepairBudget({steps:80}),record={root,budget,automaticRequest:task,budgetRequest:task};
 const old={version:1,state:'unknown',callId:receipt.callId,root,sourceHash,task:structuredClone(task),receiptSha256:hash(receipt),message:structuredClone(message),messageSha256:hash(message),baselineSeq:2};
 const a=budget.automatic={version:1,taskSteps:80,checks:3,proofSerial:0,proofs:{},admitted:{},nextCheckAt:100,phase:'repairing',receipt,operation:{ownerId:'owner',callId:receipt.callId,root,sourceHash,task:structuredClone(task),rangeRequired:true,rangeQualified:true,rangeSettled:true},terminalAcknowledged:true,reconciledCallId:receipt.callId,accountedCallId:receipt.callId,continuation:old,continuationNeeded:true,recovery:{state:'blocked',code:'AUTOMATIC_CONTINUATION_UNCONFIRMED',canContinue:false}};
 manager.data={sessions:{owner:record},trash:{},workspaces:{}};manager.budgets.set('owner',budget);await manager.save();
 return{directory,root,manager,ctx,agent,budget,record,a,events,old:structuredClone(old),add,stop:()=>maintenance.abort({kind:'user'}),setFlush:fn=>flush=fn,stats:()=>({sends,wakes,removes})};
}
test('exact consumed pre-step failure creates one new intent, immutable negative audit and same-body fresh ID without accounting reset',async t=>{
 const f=await fixture(t),before={steps:f.budget.steps,taskSteps:f.a.taskSteps,checks:f.a.checks,proofSerial:f.a.proofSerial};
 const results=await Promise.all([f.manager.automaticResumeConsumed('owner'),f.manager.automaticResumeConsumed('owner')]);assert(results.every(r=>r.continued));
 assert.equal(f.stats().sends,1);assert.equal(f.stats().wakes,1);assert.equal(f.a.continuation.recoveryOf,f.old.message.id);assert.notEqual(f.a.continuation.message.id,f.old.message.id);assert.deepEqual({...f.a.continuation.message,id:f.old.message.id},f.old.message);
 assert.equal(f.a.consumedPrestepRecoveries.length,1);const audit=f.a.consumedPrestepRecoveries[0];assert.deepEqual(audit.oldIntent,f.old);assert.equal(audit.oldIntentSha256,hash(f.old));assert(Object.isFrozen(audit.oldIntent.message));assert.equal(audit.failureProof.insertSeq,2);assert.equal(audit.failureProof.claimSeq,4);assert.equal(audit.failureProof.failedTurnEndSeq,5);
 assert.deepEqual({steps:f.budget.steps,taskSteps:f.a.taskSteps,checks:f.a.checks,proofSerial:f.a.proofSerial},before);await f.manager.automaticResumeConsumed('owner');assert.equal(f.stats().sends,1);
 const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions.owner.budget.automatic;assert.deepEqual(saved.consumedPrestepRecoveries[0].oldIntent,f.old);assert.equal(saved.continuation.state,'accepted');
});
test('unknown NEW acceptance removes only its queued ID before maintenance release and is never resent',async t=>{
 const f=await fixture(t);f.setFlush(async()=>f.stats().sends===0||f.stats().removes>0);
 assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,false);assert.deepEqual(f.stats(),{sends:1,wakes:0,removes:1});assert.equal(f.a.continuation.state,'unknown');assert.equal(f.a.continuationNeeded,false);
 for(let i=0;i<3;i++)assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,false);assert.equal(f.stats().sends,1);
 assert.equal(f.a.continuation.removal.durable,true);
});

test('unconfirmed Native withdrawal flush remains HOLD and cannot be retried as another dispatch',async t=>{
 const f=await fixture(t);f.setFlush(async()=>f.stats().sends===0);await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'),e=>e.code==='AUTOMATIC_CONSUMED_WITHDRAWAL_UNCONFIRMED');assert.equal(f.stats().sends,1);assert.equal(f.stats().wakes,0);assert.equal(f.a.continuation.removal.durable,false);assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,false);assert.equal(f.stats().sends,1);
});
test('Stop after followup but before proof removes exact new message, retains foreign input and persists same-task cancellation',async t=>{
 const f=await fixture(t),foreign={id:'new-human',role:'user',source:{kind:'user'},content:[]};f.setFlush(async()=>{if(f.stats().sends>0&&!f.a.operation.cancelledByCaller){f.agent.inbox.nextTurn.push(foreign);f.stop();}return true;});
 await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,1);assert.equal(f.stats().removes,1);assert.deepEqual(f.agent.inbox.nextTurn,[foreign]);assert.equal(f.a.operation.cancelledByCaller,true);assert.equal(f.a.continuation.state,'cancelled');assert.equal(f.a.continuationNeeded,false);assert.deepEqual(f.a.consumedPrestepRecoveries[0].oldIntent,f.old);
 await f.manager.persistQueue;const saved=JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions.owner.budget.automatic;assert.equal(saved.operation.cancellation.kind,'CALLER_STOP');assert.equal(saved.continuation.state,'cancelled');
});
test('unknown, new human, model/tool/step activity, canceled claim, wrong error and bad boundary all reject without a new effect',async t=>{
 for(const mutate of [
  f=>f.events[2].seq=99,f=>f.events[2].data.inserted[0].id='foreign',f=>f.events[4].data.outcome='canceled',f=>f.events[5].data.reason.error.message+=' changed',f=>f.events[3].type='step/start',f=>f.events[3].type='request/header',f=>f.events[3].type='tool/call',f=>f.events.push({seq:f.events.length,type:'user/message',data:{id:'new',role:'user',source:{kind:'user'}}}),f=>f.events.at(-1).type='unknown/runtime',
 ]){const f=await fixture(t);mutate(f);f.agent.session.seq=f.events.length;await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,0);assert.equal(f.a.consumedPrestepRecoveries,undefined);}
});
test('changed source, original task, receipt, Stop, range, busy inbox or unknown/active work never recover',async t=>{
 for(const mutate of [
  async f=>fs.appendFile(path.join(f.root,'app.mjs'),'// changed'),f=>f.record.automaticRequest={turn:2,messageId:'new-human'},f=>f.a.receipt.ownerId='foreign',f=>f.a.operation.cancelledByCaller=true,f=>f.a.operation.rangeSettled=false,f=>f.agent.inbox.nextStep.push({id:'pending'}),f=>f.ctx.jobs.list=()=>[{id:'owned',owner:'owner',status:'running'}],f=>f.ctx.sessionProjections.snapshot=()=>({asOfSeq:f.agent.session.seq-1,values:{subagentCatalog:[{id:'child'}]}}),f=>f.ctx.terminalController.list=()=>[{id:'pty'}],f=>f.ctx.terminals={list:()=>[{id:'internal-pty'}]},f=>delete f.ctx.terminalController,f=>f.manager.automaticInFlight=new Map([['owner',Promise.resolve()]]),f=>delete f.a.receipt,
 ]){const f=await fixture(t);await mutate(f);await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,0);}
});
test('missing/child owner cannot access another conversation or invoke a recovery effect',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.manager.automaticResumeConsumed('foreign'),e=>e.code==='AUTOMATIC_OWNER_REQUIRED');f.agent.session.header.origin='subagent';f.agent.session.header.parentSession='absent';await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,0);
});
test('one-per-receipt audit and an unconfirmed saved intent never allocate or dispatch another message',async t=>{
 const f=await fixture(t),save=f.manager.save.bind(f.manager);f.manager.save=async()=>{if(f.a.continuation?.recoveryOf&&f.a.continuation.state==='intent')throw Error('simulated intent persistence failure');return save();};
 await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,0);assert.equal(f.a.consumedPrestepRecoveries.length,1);const id=f.a.continuation.message.id;assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,false);assert.equal(f.a.continuation.message.id,id);assert.equal(f.stats().sends,0);
});
test('first action deadline survives a delayed previous reconciliation and a delayed maintenance entry',async t=>{
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;t.after(()=>Date.now=originalNow);
 const f=await fixture(t);let release;const previous=new Promise(r=>release=r);f.manager.automaticReconciliations=new Map([['owner',previous]]);const result=f.manager.automaticResumeConsumed('owner');now+=12001;release(false);await assert.rejects(result,e=>e.code==='AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');assert.equal(f.stats().sends,0);
 const g=await fixture(t),maintenance=g.agent.runMaintenance.bind(g.agent);g.agent.runMaintenance=job=>{now+=12001;return maintenance(job);};await assert.rejects(()=>g.manager.automaticResumeConsumed('owner'),e=>e.code==='AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');assert.equal(g.stats().sends,0);assert.equal(g.a.consumedPrestepRecoveries,undefined);
});
test('whole-action expiry during dispatch persistence cannot enter followup despite the core own4s default',async t=>{
 const originalNow=Date.now;let now=originalNow();Date.now=()=>now;t.after(()=>Date.now=originalNow);const f=await fixture(t),save=f.manager.save.bind(f.manager);let delayed=false;
 f.manager.save=async()=>{await save();if(!delayed&&f.a.continuation?.recoveryOf&&f.a.continuation.state==='dispatching'){delayed=true;now+=12001;}};
 await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(delayed,true);assert.equal(f.stats().sends,0);assert.equal(f.a.continuationNeeded,false);
});
test('pure proof permits only neutral trailing seed markers and uses NEXT boundary without a Doom-specific ID',async t=>{
 const f=await fixture(t),proof=consumedPrestepProof(f.events,f.old,f.agent.session.seq);assert.equal(proof.baselineSeq,2);assert.equal(proof.failedTurn,3);assert.equal(proof.throughSeq,6);assert.equal(proof.messageSha256,hash(f.old.message));
 f.events.at(-1).data={inherited:true};assert.throws(()=>consumedPrestepProof(f.events,f.old,f.agent.session.seq));
});
test('pending unpublished internal terminal prevents recovery even when its published list is empty',async t=>{
 const f=await fixture(t);f.ctx.terminals={list:()=>[],hasOwnerActivity:()=>true};await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,0);
});

test('retained terminal own jobs do not block recovery; unknown own status cannot stand for settlement',async t=>{
 const f=await fixture(t);f.ctx.jobs.list=()=>['completed','failed','killed'].map(status=>({owner:'owner',status})).concat({owner:'foreign',status:'running'});assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,true);assert.equal(f.stats().sends,1);
 const g=await fixture(t);g.ctx.jobs.list=()=>[{owner:'owner',status:'unknown'}];await assert.rejects(()=>g.manager.automaticResumeConsumed('owner'));assert.equal(g.stats().sends,0);
});
test('fresh owned work, source mutation or any new human during admission proof prevents maintenance wake',async t=>{
 for(const kind of ['job','source','human']){const f=await fixture(t);let changed=false;f.setFlush(async()=>{if(f.stats().sends&&!changed){changed=true;if(kind==='job')f.ctx.jobs.list=()=>[{id:'late-job',owner:'owner',status:'running'}];if(kind==='source')await fs.appendFile(path.join(f.root,'app.mjs'),'// late');if(kind==='human'){const message={id:'late-human',role:'user',source:{kind:'user'},content:[]};f.agent.inbox.nextTurn.push(message);f.add('agent/inbox/spliced',{target:'next-turn',start:1,inserted:[message]});f.agent.session.seq=f.events.length;f.agent.inbox.remove(message.id);}}return true;});
  await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));assert.equal(f.stats().sends,1);assert.equal(f.stats().wakes,0);assert.equal(f.agent.inbox.nextTurn.length,0);
 }
});
test('Stop after accepted state was saved, including after job return but before maintenance exit, still removes own queue and reports no continuation',async t=>{
 const f=await fixture(t),maintenance=f.agent.runMaintenance.bind(f.agent);f.agent.runMaintenance=job=>maintenance(async signal=>{const result=await job(signal);f.stop();return result;});
 assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,false);assert.equal(f.stats().sends,1);assert.equal(f.stats().wakes,0);assert.equal(f.stats().removes,1);assert.equal(f.a.operation.cancelledByCaller,true);assert.equal(f.a.continuation.state,'cancelled');await f.manager.persistQueue;
});
test('serialized registry snapshots fsync the file before rename and Linux parent before any recovery followup',async t=>{
 const f=await fixture(t),open=fs.open,rename=fs.rename,order=[];let files=0,parents=0;
 fs.open=async function(file,...args){const h=await open.call(fs,file,...args);if(!String(file).startsWith(f.directory))return h;return new Proxy(h,{get(target,key){if(key==='sync')return async()=>{const isParent=String(file)===path.dirname(f.manager.file);order.push(isParent?'parent-sync':'file-sync');if(isParent)parents++;else files++;return target.sync();};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 fs.rename=async function(...args){order.push('rename');return rename.apply(fs,args);};
 const followup=f.agent.followup.bind(f.agent);f.agent.followup=message=>{order.push('followup');assert(files>=3);if(process.platform==='linux')assert(parents>=3);followup(message);};
 try{assert.equal((await f.manager.automaticResumeConsumed('owner')).continued,true);}finally{fs.open=open;fs.rename=rename;}
 assert(order.indexOf('file-sync')<order.indexOf('rename'));assert(order.indexOf('rename')<order.indexOf('followup'));if(process.platform==='linux')assert(order.indexOf('parent-sync')<order.indexOf('followup'));
});
test('registry file-sync failure, and Linux parent-sync failure, prevent the only new followup',async t=>{
 for(const kind of ['file',...(process.platform==='linux'?['parent']:[])]){const f=await fixture(t),open=fs.open;fs.open=async function(file,...args){const h=await open.call(fs,file,...args);if(!String(file).startsWith(f.directory))return h;return new Proxy(h,{get(target,key){if(key==='sync')return async()=>{const isParent=String(file)===path.dirname(f.manager.file);if(kind===(isParent?'parent':'file'))throw Error('Simulated fsync failure');return target.sync();};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};try{await assert.rejects(()=>f.manager.automaticResumeConsumed('owner'));}finally{fs.open=open;}assert.equal(f.stats().sends,0);}
});
