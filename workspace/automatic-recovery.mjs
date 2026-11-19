import {hasOwnedRangeProvider} from './owned-range-state.mjs';
import {continueAutomaticTask} from './automatic-continuation.mjs';
import {reconcileLegacyAutomatic} from './automatic-legacy.mjs';
import {automaticBound as pauseUntil} from './automatic-bounds.mjs';
import {releaseAutomaticCancellation} from './automatic-cancellation.mjs';

export const AUTOMATIC_CLEANUP_MS=10000;
const own=(manager,id,a)=>!!manager.data.sessions[id]&&manager.budgets.get(id)?.automatic===a
 && a?.operation?.ownerId===id&&a.operation.callId===a.activeCallId
 &&a.operation.root===manager.data.sessions[id]?.root;
const code=value=>typeof value==='string'&&/^[A-Z0-9_]{1,80}$/.test(value)?value:'VERIFICATION_RESULT_UNAVAILABLE';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const unresolvedAutomatic=a=>!!a&&(a.phase==='checking'||a.activeCallId||a.uncertain);
export function recoveryState(a,state,reason,canContinue=false){a.recovery={state,code:reason,canContinue};}
export function automaticReceipt(manager,exec,result){
 const id=exec.agent?.id,a=manager.budgets.get(id)?.automatic;
 if(!own(manager,id,a)||exec.name!=='verify_project'||exec.callId!==a.activeCallId||exec.arguments?.kind!==(a.operation.verificationKind??'all'))return false;
 if(a.receipt)return a.receipt.callId===exec.callId;
 const value=result.value;
 a.receipt={version:1,callId:exec.callId,ownerId:id,root:a.operation.root,sourceHash:a.operation.sourceHash,verificationKind:a.operation.verificationKind??'all',at:Date.now(),
  isError:result.isError===true||!!result.error,errorCode:code(result.error?.info?.code),
  // Only structured final SDK data; no rendered text, paths or credentials.
  report:value&&typeof value==='object'?{passed:value.passed===true,complete:value.complete===true,stale:value.stale!==false,
   sourceHash:hash(value.sourceHash)?value.sourceHash:null,code:typeof value.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(value.code)?value.code:undefined,
   checks:Array.isArray(value.checks)?value.checks.slice(0,24).map(c=>({id:typeof c?.id==='string'?c.id.slice(0,80):'',kind:['test','build','browser','acceptance'].includes(c?.kind)?c.kind:undefined,passed:c?.passed===true,checksPassed:Number.isSafeInteger(c?.checksPassed)?c.checksPassed:undefined,checksTotal:Number.isSafeInteger(c?.checksTotal)?c.checksTotal:undefined,countsMeasured:c?.countsMeasured===true&&value.checks.length<=24,
    category:['success','verification','setup','invocation','configuration','timeout','empty-verification','tool-error'].includes(c?.category)?c.category:undefined,diagnosticCode:code(c?.diagnosticCode)})):[]}:null};
 return true;
}
export function acknowledgeAutomatic(manager,id,callId){
 const a=manager.budgets.get(id)?.automatic;
 if(!own(manager,id,a)||a.activeCallId!==callId)return;
 a.terminalAcknowledged=true;
 return manager.save().then(()=>manager.reconcileAutomatic(id)).catch(()=>manager.ctx.logger?.warn('Automatic terminal receipt could not be reconciled.'));
}
// The quality plugin supplies the actual retained shell handle. Never discover
// or adopt work by PID, job-name, command text or a model-provided identifier.
export async function retainAutomaticProcess(manager,{execution,projectRoot,sourceHash,process}){
 const owner=manager.ownerAgent(execution?.agent),id=owner?.id,a=manager.budgets.get(id)?.automatic;
 if(!own(manager,id,a)||execution.callId!==a.activeCallId||projectRoot!==a.operation.root||sourceHash!==a.operation.sourceHash)return;
 if(!process?.done||typeof process.kill!=='function')throw Error('AUTOMATIC_PROCESS_HANDLE_INVALID');
 manager.automaticProcesses??=new Map();
 if(manager.automaticProcesses.has(id))throw Error('AUTOMATIC_PROCESS_ALREADY_RETAINED');
 const entry={callId:a.activeCallId,process};manager.automaticProcesses.set(id,entry);
 a.operation.rangeRequired=true;a.operation.rangeQualified=hasOwnedRangeProvider(manager.ctx.subprocess);a.operation.rangeSettled=false;
 await manager.save();
 void Promise.resolve(process.done).then(async()=>{
  if(!own(manager,id,a)||manager.automaticProcesses.get(id)!==entry)return;
  if(a.operation.rangeQualified)a.operation.rangeSettled=true;
  await manager.save();
  await manager.reconcileAutomatic(id);
 },()=>{}).catch(()=>manager.ctx.logger?.warn('Automatic process terminal proof could not be saved.'));
}
const pending=(a,reason,state='pending')=>{recoveryState(a,state,reason);return false;};
export async function reconcileAutomatic(manager,id){
 manager.automaticReconciliations??=new Map();
 if(manager.automaticReconciliations.has(id))return manager.automaticReconciliations.get(id);
 const work=(async()=>{
  const budget=manager.budgets.get(id),record=manager.data.sessions[id],a=budget?.automatic;
  if(a?.legacyRecovery?.verificationState==='required'&&!unresolvedAutomatic(a)){
   await manager.runRecoveryVerification(id);
   return continueAutomaticTask(manager,id);
  }
  if(!unresolvedAutomatic(a))return continueAutomaticTask(manager,id);
  record.budget=budget;
  if(!a.operation&&await reconcileLegacyAutomatic(manager,id,pauseUntil)){
   await manager.runRecoveryVerification(id);
   return continueAutomaticTask(manager,id);
  }
  if(!own(manager,id,a)){pending(a,'AUTOMATIC_OPERATION_IDENTITY_UNAVAILABLE','blocked');return false;}
  const operation=a.operation,callId=a.activeCallId;
  const current=()=>manager.data.sessions[id]===record&&own(manager,id,a)&&a.operation===operation&&a.activeCallId===callId;
  if(!a.uncertain&&Date.now()<operation.deadlineAt)return pending(a,'AUTOMATIC_VERIFICATION_RUNNING');
  recoveryState(a,'reconciling','AUTOMATIC_RECONCILING');
  operation.cleanupDeadlineAt??=Math.min(operation.deadlineAt+AUTOMATIC_CLEANUP_MS,Date.now()+AUTOMATIC_CLEANUP_MS);
  const retained=manager.automaticProcesses?.get(id);
  if(retained?.callId===callId&&!operation.rangeSettled){
   if(!operation.rangeQualified)return pending(a,'AUTOMATIC_RANGE_PROVIDER_UNQUALIFIED','blocked');
   if(!operation.cleanupRequested&&Date.now()<operation.cleanupDeadlineAt){
    operation.cleanupRequested=true;if(!await pauseUntil(manager.save(),operation.cleanupDeadlineAt))return pending(a,'AUTOMATIC_RECOVERY_PERSISTENCE_UNCONFIRMED','blocked');if(!current())return false;
    try{retained.process.kill();}catch{return pending(a,'AUTOMATIC_OWNED_STOP_FAILED','blocked');} // An ACK is not quiescence.
   }
   await pauseUntil(retained.process.done,operation.cleanupDeadlineAt);
  }
  if(!current())return false;
  await pauseUntil(manager.resultWork.get(id)??Promise.resolve(),Math.min(operation.cleanupDeadlineAt,Date.now()+1000));
  if(!current())return false;
  if(!a.terminalAcknowledged||!a.receipt)return pending(a,Date.now()>=operation.cleanupDeadlineAt?'AUTOMATIC_TERMINAL_RECEIPT_MISSING':'AUTOMATIC_TERMINAL_PENDING',Date.now()>=operation.cleanupDeadlineAt?'blocked':'pending');
  const receipt=a.receipt;
  if(receipt.version!==1||receipt.callId!==callId||receipt.ownerId!==id||receipt.root!==operation.root||receipt.sourceHash!==operation.sourceHash||(receipt.verificationKind??'all')!==(operation.verificationKind??'all')||typeof receipt.isError!=='boolean'||!Number.isSafeInteger(receipt.at)||!receipt.isError&&!receipt.report)return pending(a,'AUTOMATIC_TERMINAL_RECEIPT_MISMATCH','blocked');
  if(operation.rangeRequired&&(!operation.rangeQualified||!operation.rangeSettled))return pending(a,'AUTOMATIC_OWNED_RANGE_UNCONFIRMED','blocked');
  if(budget.blocked&&!['AUTOMATIC_VERIFICATION_UNCERTAIN','AUTOMATIC_VERIFICATION_TIMEOUT'].includes(budget.blocked.code))return pending(a,budget.blocked.code,'blocked');
  // Save the terminal proof before the one accounting transition. Restart
  // resumes only this receipt, not an absent process handle or a boolean reset.
  if(!await pauseUntil(manager.save(),Date.now()+4000))return pending(a,'AUTOMATIC_RECOVERY_PERSISTENCE_UNCONFIRMED','blocked');if(!current())return false;
  budget.blocked=null;
  if(a.accountedCallId!==callId){
   if(!receipt.isError&&receipt.report){
    const agent=manager.ctx.agents.get(id);if(!agent)return pending(a,'AUTOMATIC_OWNER_UNAVAILABLE','blocked');
    if(!await pauseUntil(manager.toolResult({agent,name:'verify_project',arguments:{kind:operation.verificationKind??'all'},callId,signal:AbortSignal.timeout(4000)},{isError:false,value:receipt.report,content:[]},undefined,receipt),Date.now()+4000))return pending(a,'AUTOMATIC_ACCOUNTING_UNCONFIRMED','blocked');
   }else a.accountedCallId=callId;
  }
  if(!current())return false;
  if(receipt.isError&&a.repairEvidenceReview)budget.blocked={code:'AUTOMATIC_VERIFICATION_UNAVAILABLE',message:'The owned current-source check failed to provide verification totals. Files and failed results are retained.'};
  a.recoveryFailures=receipt.isError?(a.recoveryFailures??0)+1:0;
  if(a.recoveryFailures>=3){budget.blocked={code:'AUTOMATIC_RECOVERY_NO_PROGRESS',message:'Repeated owned verification recovery did not finish successfully. Files and terminal evidence are retained.'};}
  a.lastCheck={at:receipt.at,passed:!receipt.isError&&receipt.report?.passed===true&&a.lastAutomaticOutcome?.sourceHash===receipt.report?.sourceHash,stale:receipt.report?.stale!==false||a.lastAutomaticOutcome?.sourceHash!==receipt.report?.sourceHash,checks:receipt.report?.checks??[]};
  const currentPass=!receipt.isError&&receipt.report?.passed===true&&receipt.report?.stale===false&&a.lastAutomaticOutcome?.sourceHash===receipt.report.sourceHash;
  a.phase=budget.blocked?'stopped':currentPass?'working':'repairing';
  a.nextCheckAt=a.taskSteps+(currentPass?a.interval:20);
  a.continuationNeeded=!operation.cancelledByCaller;
  a.reconciledCallId=callId;delete a.activeCallId;delete a.uncertain;
  delete a.reason;
  recoveryState(a,budget.blocked?'blocked':'recovered',budget.blocked?.code??(receipt.isError?'AUTOMATIC_RECOVERED_WITHOUT_PASS':'AUTOMATIC_RESULT_RECONCILED'),!budget.blocked);
  if(operation.cancelledByCaller){a.phase='cancelled';recoveryState(a,'recovered','AUTOMATIC_CANCELLED',false);}
  if(manager.automaticProcesses?.get(id)?.callId===callId)manager.automaticProcesses.delete(id);
  record.budget=budget;if(!await pauseUntil(manager.save(),Date.now()+4000))return pending(a,'AUTOMATIC_RECOVERY_PERSISTENCE_UNCONFIRMED','blocked');
  if(operation.cancelledByCaller||budget.blocked)releaseAutomaticCancellation(manager,id,operation);
  return continueAutomaticTask(manager,id);
 })();
 manager.automaticReconciliations.set(id,work);
 try{return await work;}finally{if(manager.automaticReconciliations.get(id)===work)manager.automaticReconciliations.delete(id);}
}
