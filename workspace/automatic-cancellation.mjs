// One original caller signal per owned verification. Keep observing it after
// the bounded waiter returns, until terminal reconciliation/queue admission.
export function releaseAutomaticCancellation(manager,id,operation){
 const entry=manager.automaticCancellations?.get(id);
 if(entry&&entry.operation===operation)entry.dispose();
}
export function watchAutomaticCancellation(manager,id,record,budget,operation,signal){
 if(!signal)return;
 manager.automaticCancellations??=new Map();
 manager.automaticCancellations.get(id)?.dispose();
 const a=budget.automatic;
 const current=()=>manager.data.sessions[id]===record&&manager.budgets.get(id)===budget&&budget.automatic===a
  &&a.operation===operation&&record.root===operation.root
  &&(a.activeCallId===operation.callId||a.reconciledCallId===operation.callId);
 const entry={operation,dispose(){signal.removeEventListener('abort',abort);if(manager.automaticCancellations.get(id)===entry)manager.automaticCancellations.delete(id);}};
 const abort=()=>{
  try{
   if(!current())return;
   operation.cancelledByCaller=true;
   operation.cancellation={kind:'CALLER_STOP',at:Date.now(),ownerId:id,callId:operation.callId,root:operation.root,sourceHash:operation.sourceHash,task:structuredClone(operation.task)};
   a.continuationNeeded=false;
   a.recovery={state:a.activeCallId?'pending':'recovered',code:'AUTOMATIC_CANCELLED',canContinue:false};
   if(!a.activeCallId)a.phase='cancelled';
   record.budget=budget;
   // Queue the snapshot synchronously; later receipt/accounting writes retain
   // this stop. No error reason, prompt text or credential enters the audit.
   void Promise.resolve(manager.save()).catch(()=>manager.ctx.logger?.warn('Caller Stop persistence is unconfirmed; automatic continuation remains disabled.'));
  }catch{manager.ctx.logger?.warn('Caller Stop persistence is unconfirmed; automatic continuation remains disabled.');}
  finally{entry.dispose();}
 };
 manager.automaticCancellations.set(id,entry);
 if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
}
