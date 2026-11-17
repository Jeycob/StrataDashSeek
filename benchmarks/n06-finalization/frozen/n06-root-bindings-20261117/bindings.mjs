// Root-only proof composition. No endpoint, credential, PID or import-time I/O.
import {createHash} from 'node:crypto';
import {jobIdentity,terminalJob} from '../n06-root-lifecycle-20261117-r2/native-transport.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const foreground=new Set(['bash','project_exec','verify_project','focus_context','glob','grep']);
const fields=['jobId','owner','startedAt','previewId','generation','expiresAt'];
export function createRootBindings({target,sourceCommit},{native,attest,cancelOwned},trusted={}){
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(k=>text(target[k]))&&/^[a-f0-9]{40}$/.test(sourceCommit??''),'BINDING_TARGET_REQUIRED');
 need(typeof attest==='function'&&typeof cancelOwned==='function'&&['jobsSnapshot','projections','terminals','killJob'].every(k=>typeof native?.[k]==='function'),'BINDING_CALLBACKS_REQUIRED');
 const own=Object.freeze(Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,target[k]]))),now=trusted.now??Date.now;let profileSha256,requestId;
 need(Object.entries(own).every(([k,v])=>native.target?.[k]===v),'BINDING_NATIVE_TARGET');
 function check(input){need(Object.entries(own).every(([k,v])=>input?.[k]===v)&&text(input?.requestId)&&(!requestId||input.requestId===requestId)&&Number.isSafeInteger(input.deadline)&&now()<input.deadline&&!input.signal?.aborted,'BINDING_EXPIRED_OR_FOREIGN');}
 async function fresh(input){
  check(input);const proof=await attest({...own,sourceCommit,requestId:input.requestId,deadline:input.deadline,signal:input.signal});check(input);
  need(proof?.version===1&&proof.sourceCommit===sourceCommit&&Object.entries(own).every(([k,v])=>proof[k]===v)&&proof.mode==='host-compat'&&proof.ownedRangeProvider===true&&/^[a-f0-9]{64}$/.test(proof.profileSha256??'')&&proof.preview?.sessionId===own.sessionId&&proof.preview.state&&proof.preview.state!=='unavailable','BINDING_LIVE_ATTESTATION_REQUIRED');
  need(!profileSha256||profileSha256===proof.profileSha256,'BINDING_PROFILE_CHANGED');profileSha256=proof.profileSha256;requestId=input.requestId;return proof;
 }
 async function roster(input){const rows=await native.jobsSnapshot(input);check(input);need(Array.isArray(rows)&&rows.length<=128,'BINDING_ROSTER_INVALID');const ids=new Set();for(const row of rows){need(text(row?.id)&&text(row.kind)&&Number.isSafeInteger(row.startedAt)&&row.startedAt>=0&&(row.owner===undefined||text(row.owner))&&!ids.has(row.id),'BINDING_ROSTER_INVALID');ids.add(row.id);}return rows.filter(row=>row.owner===own.sessionId);}
 function preview(row,status){
  const c=status?.correlation;
  if(!row||row.kind!=='bash'||row.owner!==own.sessionId||terminalJob(row)||status?.state!=='ready'||status.sessionId!==own.sessionId||status.jobId!==row.id||!text(status.previewId)||!text(status.generation)||!Number.isSafeInteger(status.expiresAt)||now()>=status.expiresAt)return null;
  if(![c?.originalCall,c?.producerCall].every(value=>text(value?.callId)&&text(value.rootCallId)&&text(value.toolName)))return null;
  if(c?.version!==1||c.sessionId!==own.sessionId||c.ownerAgentId!==own.sessionId||['jobId','previewId','generation','expiresAt'].some(k=>c[k]!==status[k]))return null;
  return{jobId:row.id,owner:row.owner,startedAt:row.startedAt,previewId:status.previewId,generation:status.generation,expiresAt:status.expiresAt};
 }
 function evidence(kind,rows,excluded){return JSON.stringify({version:1,kind,sourceCommit,profileSha256,inventorySha256:hash(rows.map(row=>[jobIdentity(row),row.status,row.finishedAt??null])),excludedPreview:excluded??null});}
 async function proveOwnedRange(input){
  await fresh(input);
  if(input.kind==='job'){
   need(input.job?.id===input.jobId&&input.fingerprint===hash({identity:jobIdentity(input.job),finishedAt:input.job.finishedAt}),'BINDING_JOB_FINGERPRINT');
   const rows=await roster(input),receipt=await fresh(input),row=rows.find(item=>item.id===input.jobId);
   if(!row||row.kind!=='bash'||!terminalJob(row)||jobIdentity(row)!==jobIdentity(input.job)||row.finishedAt!==input.job.finishedAt)return null;
   return{settled:true,jobId:row.id,fingerprint:input.fingerprint,evidence:evidence('attested-strict-provider-job-terminal',rows)};
  }
  const call=input.call?.data,result=input.result?.data?.message;
  need(input.kind==='tool'&&call?.callId===input.callId&&result?.toolCallId===input.callId&&result.source?.kind==='tool'&&result.source.callId===input.callId&&input.fingerprint===hash({call:input.call.data,result:input.result.data}),'BINDING_TOOL_FINGERPRINT');
  let args;try{args=JSON.parse(call.arguments);}catch{return null;}
  if(!foreground.has(call.name)&&call.name!=='project_preview_restart')return null;
  const background=call.name==='project_preview_restart'||(['bash','project_exec'].includes(call.name)&&args?.run_in_background===true);
  if(!background){await fresh(input);return{settled:true,callId:input.callId,fingerprint:input.fingerprint,evidence:evidence('attested-awaited-foreground-or-pre-spawn-failure',[])};}
  const [rows,projection,terminals]=await Promise.all([roster(input),native.projections(input),native.terminals(input)]),receipt=await fresh(input);
  if(projection?.kind!=='sequenced'||!Number.isSafeInteger(projection.asOfSeq)||projection.asOfSeq<input.result.seq||!Array.isArray(projection.values?.subagentCatalog)||projection.values.subagentCatalog.length||!Array.isArray(terminals)||terminals.length)return null;
  const active=rows.filter(row=>!terminalJob(row));if(rows.some(row=>row.kind!=='bash')||active.length>1)return null;
  const excluded=active.length?preview(active[0],receipt.preview):null;if(active.length&&!excluded)return null;
  if(excluded){
   const c=receipt.preview.correlation,related=[c.originalCall,c.producerCall].filter(value=>value.callId===input.callId||value.rootCallId===input.callId);
   if(related.some(value=>value.callId!==input.callId||value.rootCallId!==input.callId||value.toolName!==call.name))return null;const matches=related;
   if(matches.length){if(!input.previewCandidates?.some(value=>fields.every(k=>value[k]===excluded[k])))return null;return{excludedPreview:true,callId:input.callId,fingerprint:input.fingerprint,...excluded,evidence:evidence('attested-private-preview-call-correlation',rows,excluded)};}
  }
  return{settled:true,callId:input.callId,fingerprint:input.fingerprint,evidence:evidence('attested-all-nonpreview-background-ranges-terminal',rows,excluded)};
 }
 async function stopOwnedRanges(input){
  await fresh(input);
  // Start foreground cancellation independently of every background registry read.
  const cancel=Promise.resolve().then(()=>{check(input);return cancelOwned({...own,requestId:input.requestId,deadline:input.deadline,signal:input.signal});});
  const jobs=(async()=>{const rows=await roster(input),latest=await fresh(input);const kills=[];for(const row of rows){if(row.kind!=='bash'||terminalJob(row)||preview(row,latest.preview))continue;check(input);kills.push(Promise.resolve().then(()=>{check(input);return native.killJob(row,input);}));}return Promise.allSettled(kills);})();
  const results=await Promise.allSettled([cancel,jobs]);check(input);await fresh(input);
  return{settled:false,started:true,unknown:['REQUIRES_FRESH_LIFECYCLE_OBSERVATION'],outcomes:results.map(result=>result.status)};
 }
 return Object.freeze({proveOwnedRange,stopOwnedRanges});
}
