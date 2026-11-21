const continuationLeases = new WeakMap();

export async function reserveAutomaticContinuation(manager,id,operation){
 const task=operation.task;
 if(!task||typeof manager.ctx.waterfall!=='function')return;
 const lease=await manager.ctx.waterfall('efficiency/continuation-lease',{
  sessionId:id,turn:task.turn,messageId:task.messageId
 },()=>undefined);
 if(typeof lease?.bind!=='function'||typeof lease?.release!=='function')return;
 if(operation.cancelledByCaller||manager.budgets.get(id)?.automatic?.operation!==operation)lease.release();
 else continuationLeases.set(operation,lease);
}

export function bindAutomaticContinuation(operation,messageId){
 continuationLeases.get(operation)?.bind(messageId);
}

export function handoffAutomaticContinuation(operation){
 // An accepted continuation can still be waiting for the SDK to open its turn.
 // The scheduler consumes the exact bound message or releases its bounded hold.
 continuationLeases.delete(operation);
}

export function releaseAutomaticContinuation(operation){
 const lease=continuationLeases.get(operation);
 if(!lease)return;
 continuationLeases.delete(operation);
 lease.release();
}

// One original caller signal per owned verification. Keep observing it after
// the bounded waiter returns, until terminal reconciliation/queue admission.
export function releaseAutomaticCancellation(manager,id,operation){
 releaseAutomaticContinuation(operation);
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
 const entry={operation,dispose(){releaseAutomaticContinuation(operation);signal.removeEventListener('abort',abort);if(manager.automaticCancellations.get(id)===entry)manager.automaticCancellations.delete(id);}};
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
