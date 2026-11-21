import {createHash,randomUUID} from 'node:crypto';
import {automaticBound} from './automatic-bounds.mjs';
import {bindAutomaticContinuation,handoffAutomaticContinuation,releaseAutomaticCancellation,releaseAutomaticContinuation} from './automatic-cancellation.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches=(message,intent)=>message?.id===intent.message.id&&sha(message)===intent.messageSha256;
const evidence=async(manager,agent,intent)=>{
 if(await manager.ctx.sessions.flush(agent.session)!==true)return false;
 const saved=await manager.ctx.sessionQuery.readSession(agent.id);
 // Session.seq is the NEXT append offset, so the first admitted splice can
 // have exactly baselineSeq. Matching message identity/hash remains required.
 return Array.isArray(saved.events)&&saved.events.some(event=>event.seq>=intent.baselineSeq&&(
  event.type==='agent/inbox/spliced'&&event.data?.inserted?.some(message=>matches(message,intent))
  ||event.type==='user/message'&&matches(event.data,intent)));
};
// Only called under the owner's reconciliation single-flight. There is one
// durable dispatch intent; an uncertain queue write is observed, never retried.
export async function continueAutomaticTask(manager,id,{deadline:ownerDeadline=Infinity}={}){
 const budget=manager.budgets.get(id),a=budget?.automatic,record=manager.data.sessions[id];
 const operation=a?.operation,release=()=>releaseAutomaticContinuation(operation);
 const cancelled=()=>{a.continuationNeeded=false;a.phase='cancelled';a.recovery={state:'recovered',code:'AUTOMATIC_CANCELLED',canContinue:false};releaseAutomaticCancellation(manager,id,a.operation);return false;};
 if(a?.operation?.cancelledByCaller)return cancelled();
 if(!a?.continuationNeeded||budget.blocked){
  const accepted=a?.continuation?.state==='accepted';
  if(accepted&&!budget.blocked)handoffAutomaticContinuation(operation);else release();
  return accepted;
 }
 const agent=manager.ctx.agents?.get(id);
 const observingUnknown=['dispatching','unknown'].includes(a.continuation?.state)&&a.recovery?.code==='AUTOMATIC_CONTINUATION_UNCONFIRMED';
 if(!a.recovery?.canContinue&&!observingUnknown){release();return false;}
 const block=reason=>{release();a.recovery={state:'blocked',code:reason,canContinue:false};return false;};
 const deadline=Math.min(Date.now()+4000,ownerDeadline);
 if(!Number.isFinite(deadline)||Date.now()>=deadline)return block('AUTOMATIC_CONTINUATION_PERSISTENCE_UNCONFIRMED');
 const save=()=>automaticBound(manager.save(),deadline);
 if(!agent||manager.ownerAgent(agent)!==agent||!a.receipt||a.reconciledCallId!==a.receipt.callId)return block('AUTOMATIC_CONTINUATION_IDENTITY_UNAVAILABLE');
 const task=record.automaticRequest??record.budgetRequest;
 if(!task||task.messageId!==operation.task?.messageId||task.turn!==operation.task?.turn)return block('AUTOMATIC_ORIGINAL_TASK_CHANGED');
 let intent=a.continuation;
 const current=()=>manager.data.sessions[id]===record&&manager.budgets.get(id)===budget&&a.operation===operation&&!operation.cancelledByCaller&&record.root===operation.root&&(record.automaticRequest??record.budgetRequest)?.messageId===task.messageId;
 if(intent&&intent.state!=='intent'){
  if(typeof manager.ctx.sessions?.flush!=='function'||typeof manager.ctx.sessionQuery?.readSession!=='function')return block('AUTOMATIC_CONTINUATION_PROOF_UNAVAILABLE');
  if(intent.callId!==a.receipt.callId||intent.root!==record.root||intent.receiptSha256!==sha(a.receipt))return block('AUTOMATIC_CONTINUATION_IDENTITY_CHANGED');
  try{let accepted=false;if(await automaticBound(evidence(manager,agent,intent).then(value=>accepted=value),deadline)&&accepted){if(operation.cancelledByCaller)return cancelled();intent.state='accepted';a.continuationNeeded=false;a.recovery={state:'recovered',code:'AUTOMATIC_CONTINUATION_ACCEPTED',canContinue:true};const saved=await save();if(operation.cancelledByCaller)return cancelled();if(saved){handoffAutomaticContinuation(operation);releaseAutomaticCancellation(manager,id,operation);}return saved;}}catch{}
  return block('AUTOMATIC_CONTINUATION_UNCONFIRMED');
 }
 if(agent.status!=='idle')return false;
 if(typeof manager.ctx.sessions?.flush!=='function'||typeof manager.ctx.sessionQuery?.readSession!=='function')return block('AUTOMATIC_CONTINUATION_PROOF_UNAVAILABLE');
 if(!Array.isArray(agent.inbox?.nextTurn)||!Array.isArray(agent.inbox?.nextStep))return block('AUTOMATIC_INBOX_UNAVAILABLE');
 if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length){release();return false;}
 if(!intent){
  const message={id:randomUUID(),role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'The original task verification has reached its recorded terminal state and its owned work is settled. Continue the SAME existing user task using the retained files, verification evidence and unchanged accounting. A recovered cancellation is not a passing test. Inspect the concrete verification result and make only the next bounded repair if needed; do not repeat an unchanged check or claim unverified completion.'}]};
  intent=a.continuation={version:1,state:'intent',callId:a.receipt.callId,root:record.root,sourceHash:operation.sourceHash,task:{...task},receiptSha256:sha(a.receipt),message,messageSha256:sha(message),baselineSeq:agent.session.seq};
  if(!Number.isSafeInteger(intent.baselineSeq))return block('AUTOMATIC_HISTORY_CURSOR_UNAVAILABLE');
  if(!await save())return block('AUTOMATIC_CONTINUATION_PERSISTENCE_UNCONFIRMED');
 }
 if(operation.cancelledByCaller)return cancelled();
 if(!current()||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length){release();return false;}
 // Persist BEFORE the only effect. Crash between this write and dispatch is
 // deliberately unknown; a reconnect may find the matching event, never resend.
 intent.state='dispatching';if(!await save())return block('AUTOMATIC_CONTINUATION_PERSISTENCE_UNCONFIRMED');
 if(Date.now()>=deadline)return block('AUTOMATIC_CONTINUATION_PERSISTENCE_UNCONFIRMED');
 if(operation.cancelledByCaller)return cancelled();
 if(!current())return block('AUTOMATIC_CONTINUATION_IDENTITY_CHANGED');
 if(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length){release();intent.state='intent';await manager.save();return false;}
 try{
  bindAutomaticContinuation(operation,intent.message.id);
  agent.followup(intent.message);
  let accepted=false;
  if(await automaticBound(evidence(manager,agent,intent).then(value=>accepted=value),deadline)&&accepted){
   if(operation.cancelledByCaller)return cancelled();
   intent.state='accepted';a.continuationNeeded=false;a.recovery.code='AUTOMATIC_CONTINUATION_ACCEPTED';const saved=await save();if(operation.cancelledByCaller)return cancelled();if(saved){handoffAutomaticContinuation(operation);releaseAutomaticCancellation(manager,id,operation);}return saved;
  }
 }catch{}
 intent.state='unknown';block('AUTOMATIC_CONTINUATION_UNCONFIRMED');await save();return false;
}
