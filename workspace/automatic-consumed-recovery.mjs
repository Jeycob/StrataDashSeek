import {createHash,randomUUID} from 'node:crypto';
import {WorkbenchError} from './policy.mjs';
import {sourceManifest} from './storage.mjs';
import {automaticBound} from './automatic-bounds.mjs';
import {continueAutomaticTask} from './automatic-continuation.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const textHash=v=>createHash('sha256').update(v).digest('hex');
const need=(v,c='AUTOMATIC_CONSUMED_PRESTEP_UNCONFIRMED')=>{if(!v)throw new WorkbenchError(c,'The consumed continuation has no complete safe pre-step recovery proof. Files and accounting are retained.',409);};
const errorHash='510f9f00f9bcb7c3c1d1e06f1935c29024c2ace43a915a9ffe976782adbf716b';
const exact=(message,intent)=>message?.id===intent.message?.id&&hash(message)===intent.messageSha256;
const flights=new WeakSet();
const MAX_AUDITS=6;
const terminalJobs=new Set(['completed','failed','killed']);
const immutable=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(immutable);Object.freeze(value);}return value;};
async function bounded(action,deadline){need(Date.now()<deadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');let value;need(await automaticBound(Promise.resolve().then(()=>{need(Date.now()<deadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');return action();}).then(v=>value=v),deadline),'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');need(Date.now()<deadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');return value;}

// Session.seq is NEXT. Fold the real durable inbox schema, including prefix
// state, then accept only the exact insert -> turn -> claim -> known failure.
export function consumedPrestepProof(events,intent,nextSeq){
 need(Array.isArray(events)&&events.length<=16384&&Buffer.byteLength(JSON.stringify(events))<=8*1024**2&&events.length===nextSeq);
 need(events.every((e,i)=>e?.seq===i)&&Number.isSafeInteger(intent.baselineSeq)&&intent.baselineSeq>=0);
 const inbox={'next-turn':[],'next-step':[]};let lastHuman;
 const splice=d=>{const list=inbox[d?.target],removed=d?.removedCount??0;need(list&&Number.isSafeInteger(d.start)&&d.start>=0&&d.start<=list.length&&Number.isSafeInteger(removed)&&removed>=0&&d.start+removed<=list.length&&Array.isArray(d.inserted));list.splice(d.start,removed,...d.inserted);};
 for(const e of events.slice(0,intent.baselineSeq)){
  if(e.type==='agent/inbox/spliced'){splice(e.data);for(const m of e.data.inserted)if(m?.role==='user'&&m.source?.kind==='user')lastHuman=m.id;}
  if(e.type==='user/message'&&e.data?.source?.kind==='user')lastHuman=e.data.id;
 }
 need(!inbox['next-turn'].length&&!inbox['next-step'].length&&lastHuman===intent.task?.messageId);
 const rows=events.slice(intent.baselineSeq),[insert,start,claim,end]=rows;
 need(rows.length>=4&&insert.type==='agent/inbox/spliced'&&insert.data.target==='next-turn'&&insert.data.start===0&&(insert.data.removedCount??0)===0&&insert.data.outcome===undefined&&insert.data.inserted?.length===1&&exact(insert.data.inserted[0],intent));
 need(intent.message.role==='user'&&intent.message.source?.kind==='workspace-runtime');
 need(start.type==='turn/start'&&Number.isSafeInteger(start.data?.turn)&&start.data.turn>0);
 need(claim.type==='agent/inbox/spliced'&&claim.data.target==='next-turn'&&claim.data.start===0&&claim.data.removedCount===1&&claim.data.inserted?.length===0&&claim.data.outcome===undefined);
 need(end.type==='turn/end'&&end.data?.turn===start.data.turn&&end.data.reason?.kind==='error'&&end.data.reason.error?.code==='UNKNOWN'&&typeof end.data.reason.error.message==='string'&&textHash(end.data.reason.error.message)===errorHash);
 need(rows.slice(4).every(e=>e.type==='session/end-seed'&&e.data&&Object.keys(e.data).length===0));
 return{version:1,baselineSeq:intent.baselineSeq,insertSeq:insert.seq,turnStartSeq:start.seq,claimSeq:claim.seq,failedTurnEndSeq:end.seq,failedTurn:start.data.turn,throughSeq:events.length-1,messageSha256:intent.messageSha256,errorMessageSha256:errorHash,prefixSha256:hash(events.slice(0,intent.baselineSeq)),historySha256:hash(events)};
}

// Explicit OWNER action only. No model/HTTP proof input, prompt, verifier or
// allowance renewal. One immutable negative audit/new intent per final receipt.
export function resumeConsumedPrestep(manager,id){return resumeWithin(manager,id,Date.now()+12000);}
async function resumeWithin(manager,id,actionDeadline){
 need(Date.now()<actionDeadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');
 manager.automaticReconciliations??=new Map();
 const previous=manager.automaticReconciliations.get(id);
 if(previous){if(flights.has(previous))return bounded(()=>previous,actionDeadline);await bounded(()=>previous,actionDeadline);return resumeWithin(manager,id,actionDeadline);}
 const gate=Promise.withResolvers();void gate.promise.catch(()=>{});flights.add(gate.promise);manager.automaticReconciliations.set(id,gate.promise);
 try{
  const agent=manager.ctx.agents.get(id),record=manager.data.sessions[id],budget=manager.budgets.get(id),a=budget?.automatic,operation=a?.operation,receipt=a?.receipt;
  need(agent&&record&&manager.ownerAgent(agent)===agent&&!manager.data.trash[id],'AUTOMATIC_OWNER_REQUIRED');
  need(typeof agent.runMaintenance==='function'&&typeof agent.inbox?.remove==='function','AUTOMATIC_CONSUMED_APIS_UNAVAILABLE');
  const task=record.automaticRequest??record.budgetRequest;
  need(budget&&a&&operation&&receipt?.version===1&&typeof receipt.isError==='boolean'&&Number.isSafeInteger(receipt.at)&&/^[a-f0-9]{64}$/.test(operation.sourceHash??'')&&a.accountedCallId===receipt.callId&&Number.isSafeInteger(task?.turn)&&task.turn>0&&typeof task.messageId==='string','AUTOMATIC_CONSUMED_IDENTITY_UNAVAILABLE');
  const receiptSha256=hash(receipt);
  const counters=()=>hash({stage:budget.stage,steps:budget.steps,errors:budget.errors,taskSteps:a.taskSteps,checks:a.checks,proofSerial:a.proofSerial,proofs:a.proofs,admitted:a.admitted,nextCheckAt:a.nextCheckAt});
  const originalCounters=counters();let newIntent;
  const current=()=>{manager.execution.assertUnchanged();need(manager.ctx.agents.get(id)===agent&&manager.ownerAgent(agent)===agent&&manager.data.sessions[id]===record&&manager.budgets.get(id)===budget&&budget.automatic===a&&!manager.data.trash[id]&&a.operation===operation&&record.root===operation?.root&&operation.ownerId===id&&receipt?.ownerId===id&&receipt.root===record.root&&receipt.callId===operation.callId&&receipt.sourceHash===operation.sourceHash&&a.reconciledCallId===receipt.callId&&a.accountedCallId===receipt.callId&&hash(a.receipt)===receiptSha256&&hash(record.automaticRequest??record.budgetRequest)===hash(task)&&hash(operation.task)===hash(task)&&counters()===originalCounters,'AUTOMATIC_CONSUMED_IDENTITY_CHANGED');};
  const noStop=()=>need(!operation.cancelledByCaller&&!budget.blocked&&!a.activeCallId&&!a.uncertain&&a.terminalAcknowledged===true&&operation.rangeRequired===true&&operation.rangeQualified===true&&operation.rangeSettled===true,'AUTOMATIC_CONSUMED_WORK_UNCONFIRMED');
  const quiet=(allowNew=false)=>{current();noStop();need(Date.now()<actionDeadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');need(agent.status==='idle'&&Array.isArray(agent.inbox.nextTurn)&&Array.isArray(agent.inbox.nextStep)&&agent.inbox.nextStep.length===0&&agent.inbox.nextTurn.length<=(allowNew?1:0)&&agent.inbox.nextTurn.every(m=>allowNew&&newIntent&&exact(m,newIntent))&&!manager.automaticInFlight?.has(id)&&!manager.automaticReviews?.has(id),'AUTOMATIC_CONSUMED_NOT_IDLE');};
  const resources=(allowNew=false)=>{
   quiet(allowNew);const get=name=>typeof manager.ctx.get==='function'?manager.ctx.get(name):manager.ctx[name],jobs=get('jobs'),projections=get('sessionProjections'),terminal=get('terminalController');
   need(typeof jobs?.list==='function'&&typeof projections?.snapshot==='function'&&typeof terminal?.list==='function','AUTOMATIC_CONSUMED_APIS_UNAVAILABLE');
   const rows=jobs.list(id),view=projections.snapshot(agent.session,['subagentCatalog']),ptys=terminal.list(id);
   need(Array.isArray(rows)&&rows.length<=128&&rows.every(r=>typeof r?.owner==='string')&&!rows.some(r=>r.owner===id&&!terminalJobs.has(r.status))&&view?.asOfSeq===agent.session.seq-1&&Array.isArray(view.values?.subagentCatalog)&&view.values.subagentCatalog.length===0&&Array.isArray(ptys)&&ptys.length===0,'AUTOMATIC_CONSUMED_WORK_UNCONFIRMED');
   const localTerminal=get('terminals');if(localTerminal!==undefined){need(typeof localTerminal.list==='function'&&typeof localTerminal.hasOwnerActivity==='function','AUTOMATIC_CONSUMED_APIS_UNAVAILABLE');const rows=localTerminal.list(agent);need(localTerminal.hasOwnerActivity(agent)===false&&Array.isArray(rows)&&rows.length===0,'AUTOMATIC_CONSUMED_WORK_UNCONFIRMED');}quiet(allowNew);
  };
  current();noStop();
  const audits=a.consumedPrestepRecoveries??[];need(Array.isArray(audits)&&audits.length<=MAX_AUDITS&&audits.every(x=>x?.version===1&&hash(x.oldIntent)===x.oldIntentSha256),'AUTOMATIC_CONSUMED_AUDIT_INVALID');
  const oldAudit=audits.find(x=>x.receiptSha256===receiptSha256);
  if(oldAudit){need(a.continuation?.recoveryOf===oldAudit.oldIntent.message.id&&a.continuation.message?.id===oldAudit.newMessageId,'AUTOMATIC_CONSUMED_AUDIT_INVALID');const value=a.continuation.state!=='intent'&&!a.continuation.removal?await continueAutomaticTask(manager,id,{deadline:actionDeadline}):false;gate.resolve(value===true);return value===true;}
  need(audits.length<MAX_AUDITS,'AUTOMATIC_CONSUMED_RECOVERY_LIMIT');quiet();
  const old=a.continuation;need(old?.version===1&&['accepted','unknown','dispatching'].includes(old.state)&&old.callId===receipt.callId&&old.root===record.root&&old.sourceHash===operation.sourceHash&&old.receiptSha256===receiptSha256&&hash(old.task)===hash(task)&&hash(old.message)===old.messageSha256&&Buffer.byteLength(JSON.stringify(old))<=16384);
  const oldIntent=immutable(structuredClone(old));
  let stopListening=()=>{},withdrawal,withdrawn=false;const cleanupDeadline=actionDeadline+1000;
  let result;try{result=await agent.runMaintenance(async signal=>{
   need(Date.now()<actionDeadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');
   const removeOwn=reason=>{if(newIntent){const own=agent.inbox.nextTurn.find(m=>exact(m,newIntent));if(own)agent.inbox.remove(own.id);newIntent.removal={...newIntent.removal,reason,at:Date.now()};newIntent.state=reason==='CALLER_STOP'?'cancelled':'unknown';a.continuationNeeded=false;a.recovery={state:'blocked',code:reason==='CALLER_STOP'?'AUTOMATIC_CANCELLED':'AUTOMATIC_CONTINUATION_UNCONFIRMED',canContinue:false};if(!withdrawn){withdrawn=true;newIntent.removal.durable=false;withdrawal=bounded(()=>manager.ctx.sessions.flush(agent.session),cleanupDeadline).then(value=>{need(value===true,'AUTOMATIC_CONSUMED_WITHDRAWAL_UNCONFIRMED');newIntent.removal.durable=true;});void withdrawal.catch(()=>{});}}};
   const abort=()=>{try{current();operation.cancelledByCaller=true;operation.cancellation={kind:'CALLER_STOP',at:Date.now(),ownerId:id,callId:operation.callId,root:record.root,sourceHash:operation.sourceHash,task:structuredClone(task)};removeOwn('CALLER_STOP');a.phase='cancelled';a.continuationNeeded=false;a.recovery={state:'recovered',code:'AUTOMATIC_CANCELLED',canContinue:false};void bounded(()=>manager.save(),cleanupDeadline).catch(()=>{});}catch{}};
   signal.addEventListener('abort',abort,{once:true});
   stopListening=()=>signal.removeEventListener('abort',abort);
   try{
    if(signal.aborted)abort();
    quiet();signal.throwIfAborted();need(await continueAutomaticTask(manager,id,{deadline:actionDeadline}),'AUTOMATIC_CONSUMED_OLD_ADMISSION_UNCONFIRMED');quiet();signal.throwIfAborted();
    const deadline=Math.min(actionDeadline,Date.now()+4000),check=()=>{quiet();signal.throwIfAborted();need(Date.now()<deadline,'AUTOMATIC_CONSUMED_RECOVERY_TIMEOUT');};
    const read=async()=>{check();need(await bounded(()=>manager.ctx.sessions.flush(agent.session),deadline)===true);check();const saved=await bounded(()=>manager.ctx.sessionQuery.readSession(id),deadline);check();return consumedPrestepProof(saved?.events,oldIntent,agent.session.seq);};
    need(typeof manager.ctx.sessions?.flush==='function'&&typeof manager.ctx.sessionQuery?.readSession==='function','AUTOMATIC_CONSUMED_APIS_UNAVAILABLE');
    await bounded(()=>manager.resultWork.get(id)??Promise.resolve(),deadline);check();resources();const proof=await read();
    const source=await bounded(()=>sourceManifest(record.root,{signal}),deadline);check();need(source.sha256===operation.sourceHash&&receipt.sourceHash===operation.sourceHash,'AUTOMATIC_CONSUMED_SOURCE_CHANGED');
    const message={...structuredClone(oldIntent.message),id:randomUUID()};
    newIntent={version:1,state:'intent',callId:receipt.callId,root:record.root,sourceHash:operation.sourceHash,task:structuredClone(task),receiptSha256,message,messageSha256:hash(message),baselineSeq:agent.session.seq,recoveryOf:oldIntent.message.id};
    const audit=immutable({version:1,receiptSha256,oldIntent,oldIntentSha256:hash(oldIntent),failureProof:proof,newMessageId:message.id,at:Date.now()});
    a.consumedPrestepRecoveries=Object.freeze([...audits,audit]);a.continuation=newIntent;a.continuationNeeded=true;a.recovery={state:'blocked',code:'AUTOMATIC_CONSUMED_RECOVERY_INTENT',canContinue:false};record.budget=budget;
    await bounded(()=>manager.save(),deadline);check();resources();const after=await read();need(after.historySha256===proof.historySha256,'AUTOMATIC_CONSUMED_HISTORY_CHANGED');
    const latest=await bounded(()=>sourceManifest(record.root,{signal}),deadline);check();need(latest.sha256===source.sha256,'AUTOMATIC_CONSUMED_SOURCE_CHANGED');
    a.recovery={state:'recovered',code:'AUTOMATIC_CONSUMED_PRESTEP_RECOVERED',canContinue:true};
    const accepted=await continueAutomaticTask(manager,id,{deadline:actionDeadline});current();signal.throwIfAborted();quiet(true);
    if(accepted){
     need(await bounded(()=>manager.ctx.sessions.flush(agent.session),actionDeadline)===true);const saved=await bounded(()=>manager.ctx.sessionQuery.readSession(id),actionDeadline);quiet(true);const events=saved?.events,tail=events?.slice(newIntent.baselineSeq);
     need(Array.isArray(events)&&events.length===agent.session.seq&&events.every((e,i)=>e?.seq===i)&&hash(events.slice(0,newIntent.baselineSeq))===proof.historySha256&&tail.length===1&&tail[0].type==='agent/inbox/spliced'&&tail[0].data?.target==='next-turn'&&tail[0].data.start===0&&(tail[0].data.removedCount??0)===0&&tail[0].data.inserted?.length===1&&exact(tail[0].data.inserted[0],newIntent),'AUTOMATIC_CONSUMED_HISTORY_CHANGED');
     const finalSource=await bounded(()=>sourceManifest(record.root,{signal}),actionDeadline);need(finalSource.sha256===source.sha256,'AUTOMATIC_CONSUMED_SOURCE_CHANGED');resources(true);signal.throwIfAborted();
    }
    if(!accepted)removeOwn('UNCONFIRMED_ACCEPTANCE');
    if(withdrawn){await withdrawal;await bounded(()=>manager.save(),cleanupDeadline);}
    // Resolve the SAME owner gate while maintenance still holds wake/claim.
    gate.resolve(accepted===true&&!newIntent.removal);return accepted===true&&!newIntent.removal;
   }catch(error){removeOwn(signal.aborted?'CALLER_STOP':'UNCONFIRMED_ACCEPTANCE');if(withdrawn)await automaticBound(withdrawal,cleanupDeadline);if(newIntent&&Date.now()<cleanupDeadline)await automaticBound(bounded(()=>manager.save(),cleanupDeadline),cleanupDeadline);throw error;}
  });}finally{try{if(withdrawn){await withdrawal;await bounded(()=>manager.save(),cleanupDeadline);}}finally{stopListening();}}
  return result===true&&!operation.cancelledByCaller&&!newIntent?.removal;
 }catch(error){gate.reject(error);throw error;}
 finally{if(manager.automaticReconciliations.get(id)===gate.promise)manager.automaticReconciliations.delete(id);}
}
