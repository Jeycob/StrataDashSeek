// Existing owner preview contract only. No HTTP client, shell, model or timer.
import {randomUUID} from 'node:crypto';
import {need,serviceCommit} from './spec.mjs';
const text=x=>typeof x==='string'&&x.length>0&&x.length<=8192;
const own=(value,target)=>value?.version===1&&value.state==='ready'&&value.sessionId===target.sessionId&&['previewId','jobId','generation','url'].every(k=>text(value[k]))&&Number.isSafeInteger(value.expiresAt);
const note=value=>value&&text(value.id)&&typeof value.title==='string'&&typeof value.body==='string'&&Number.isSafeInteger(value.version)&&value.version>0;
export function makeRestartRequest(target,before,requestId){
 need(own(before,target)&&text(requestId)&&/^[a-zA-Z0-9_-]{1,128}$/.test(requestId),'ACTUAL_OWN_READY_PREVIEW_REQUIRED');
 return Object.freeze({operation:'restart',sessionId:target.sessionId,previewId:before.previewId,generation:before.generation,requestId});
}
export function validateRestartTransition({target,before,after,beforeNote,afterNote,requestId}){
 const receipt=validateProcessRestart({target,before,after,requestId});
 need(note(beforeNote)&&note(afterNote)&&['id','title','body','version'].every(k=>beforeNote[k]===afterNote[k]),'B10_NOTE_VERSION_PERSISTENCE_REQUIRED');
 return Object.freeze({kind:'B10_OWN_PROCESS_RESTART',sourceCommit:serviceCommit,target:{sessionId:target.sessionId,workspaceId:target.workspaceId,projectId:target.projectId},...receipt,beforeNote:structuredClone(beforeNote),afterNote:structuredClone(afterNote)});
}
export function validateProcessRestart({target,before,after,requestId}){
 makeRestartRequest(target,before,requestId);need(own(after,target),'ACTUAL_RESTART_READY_RECEIPT_REQUIRED');
 need(after.previewId===before.previewId&&after.expiresAt===before.expiresAt&&new URL(after.url).origin===new URL(before.url).origin&&after.jobId!==before.jobId&&after.generation!==before.generation,'ACTUAL_PROCESS_RESTART_REQUIRED');
 const view=value=>Object.fromEntries(['version','state','sessionId','previewId','jobId','generation','url','expiresAt'].map(k=>[k,value[k]]));
 return Object.freeze({requestId,before:view(before),after:view(after)}); // fixed whitelist, no tool/correlation text
}
export function createB10RestartConsumer({target,readStatus,restart,readNote,assertTarget,now=Date.now,uuid=randomUUID}){
 need([readStatus,restart,readNote,assertTarget,now,uuid].every(x=>typeof x==='function'),'ACTUAL_RESTART_CALLBACKS_REQUIRED');
 let captured,noteId,firstDeadline;
 return Object.freeze({run(id,options){
  need(text(id)&&Number.isSafeInteger(options?.deadline),'ACTUAL_RESTART_NOTE_DEADLINE_REQUIRED');
  if(captured){need(id===noteId&&options.deadline===firstDeadline,'RESTART_OPERATION_ALREADY_CAPTURED');return captured;}
  noteId=id;firstDeadline=options.deadline;const requestId=uuid();
  const input=()=>{need(now()<firstDeadline&&!options.signal?.aborted,'ORIGINAL_QA_DEADLINE_EXPIRED');return{signal:options.signal,deadline:Math.min(firstDeadline,now()+4000)};};
  captured=(async()=>{await assertTarget({...target,...input()});const before=await readStatus(input()),beforeNote=await readNote(id,input());const request=makeRestartRequest(target,before,requestId);const after=await restart(request,input());input();const afterNote=await readNote(id,input());await assertTarget({...target,...input()});return validateRestartTransition({target,before,after,beforeNote,afterNote,requestId});})();
  return captured; // Unknown result remains captured; never resubmit a restart.
 }});
}
export function validateB10ReportRestart(slot,report,actualReceipt){
 const r3=report?.checks?.find(x=>x.id==='B10-R3');
 if(r3?.status!=='PASS')return;
 const p=report.restartEvidence;
 need(p?.kind==='B10_OWN_PROCESS_RESTART'&&p.sourceCommit===serviceCommit&&['sessionId','workspaceId','projectId'].every(k=>p.target?.[k]===slot.target[k]),'B10_ACTUAL_RESTART_QA_REQUIRED');
 need(actualReceipt&&['requestId','before','after'].every(k=>JSON.stringify(actualReceipt[k])===JSON.stringify(p[k])),'B10_RUNTIME_RESTART_RECEIPT_REQUIRED');
 validateRestartTransition({...p,target:slot.target});
}
