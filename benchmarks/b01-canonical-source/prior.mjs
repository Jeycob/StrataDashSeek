// Root supplies bounded protected raw final envelopes. No FS/auth at import.
import {createHash} from 'node:crypto';
import {need,campaignOrder,promptHashes,manifestSha256,acceptanceVersion,serviceCommit,modelFor,validateB01Primary,primaryPolicy,ineligibleSession} from './policy.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x),same=(a,b)=>a&&Object.entries(b).every(([k,v])=>a[k]===v);
export const maxPriorBytes=2097152+8192;
const actual=new WeakMap();
const key=({record,target,handoff})=>JSON.stringify([record.scenario,record.variant,record.pairId,record.runId,record.attemptId,record.comparison?.orderPosition,record.identity?.promptSha256,record.identity?.manifestSha256,target.sessionId,target.workspaceId,target.projectId,target.projectRoot,target.modelSelection,handoff.sourceCommit,handoff.runtimeCommit]);
export function validatePriorBytes(expected,bytes){
 need(hex(expected?.checkpointSha256)&&Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=maxPriorBytes,'ACTUAL_BOUNDED_PRIOR_REQUIRED');need(sha(bytes)===expected.checkpointSha256,'PRIOR_CHECKPOINT_HASH_MISMATCH');
 const e=JSON.parse(bytes),r=e.snapshot,own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,expected[k]]));
 need(e.version===1&&e.phase==='final'&&e.attemptId===expected.attemptId&&same(e.target,own)&&uuid(e.checkpointId)&&uuid(e.previousCheckpointId)&&uuid(e.requestId),'ACTUAL_PRIOR_FINAL_ENVELOPE_REQUIRED');
 need(r&&hex(e.snapshotSha256)&&Buffer.byteLength(JSON.stringify(r))<=2097152&&sha(JSON.stringify(r))===e.snapshotSha256,'PRIOR_SNAPSHOT_HASH_MISMATCH');
 need(r.isTemplate===false&&['PASS','FAIL','BLOCKED'].includes(r.status)&&same(r,Object.fromEntries(['scenario','variant','pairId','runId','attemptId'].map(k=>[k,expected[k]])))&&r.comparison?.orderPosition===expected.orderPosition,'ACTUAL_PRIOR_ATTEMPT_REQUIRED');
 need(same(r.identity,own)&&r.identity.sourceCommit===serviceCommit&&r.identity.runtimeCommit===serviceCommit&&r.identity.manifestSha256===manifestSha256&&r.identity.promptSha256===promptHashes[expected.scenario]&&r.identity.acceptanceVersion===acceptanceVersion&&same(r.identity.requestedModel,modelFor(expected.variant)),'PRIOR_FROZEN_IDENTITY_MISMATCH');
 const op=r.operator,obs=r.nativeObservation,start=Date.parse(r.timestampsUtc?.runSubmittedAt),finished=Date.parse(r.timestampsUtc?.finishedAt),settled=Date.parse(r.timestampsUtc?.settledAt),seconds=primaryPolicy(expected.scenario)?.mainSeconds;
 need(op?.finalized===true&&op.requestId===e.requestId&&Number.isSafeInteger(op.baselineSeq)&&op.baselineSeq>=0&&typeof op.rootHandoff==='string'&&op.rootHandoff.length>0&&r.slotHandoffEvidence===op.rootHandoff,'ACTUAL_PRIOR_FINALIZED_INTENT_REQUIRED');
 need(op.persistence?.unknownOutcome===false&&op.persistenceFailed!==true&&op.persistence.pendingCheckpointId===e.checkpointId&&op.persistence.lastDurableCheckpointId===e.previousCheckpointId,'ACTUAL_PRIOR_DURABLE_CHAIN_REQUIRED');
 need(obs?.promptAdmission==='accepted'&&obs.settled===true&&obs.historyComplete===true&&Array.isArray(obs.events)&&obs.events.some(x=>x.type==='turn/start'&&x.seq>op.baselineSeq)&&obs.events.some(x=>x.type==='turn/end'&&x.seq>op.baselineSeq),'ACTUAL_PRIOR_SUBMITTED_SETTLED_REQUIRED');
 need(r.limits?.mainSeconds===seconds&&[start,finished,settled].every(Number.isFinite)&&finished>=start&&settled>=finished&&Date.parse(op.primaryDeadlineAt)===start+seconds*1000,'PRIOR_ORIGINAL_SCENARIO_CLOCK_REQUIRED');
 const f=r.rootFinalization;need(f?.status==='SETTLED_VISIBLE'&&f.settled===true&&f.visible===true&&f.archiveState==='visible'&&f.sourceCommit===serviceCommit&&f.requestId===op.requestId&&same(f.target,own)&&hex(f.tupleSha256)&&Number.isSafeInteger(f.deadline),'ACTUAL_PRIOR_SETTLED_VISIBLE_REQUIRED');
 if(expected.actualWriterReceipt!=null){const x=expected.actualWriterReceipt;need(x.durable===true&&x.checkpointId===e.checkpointId&&x.sha256===expected.checkpointSha256&&x.bytes===bytes.length,'ACTUAL_PRIOR_RECEIPT_MISMATCH');}
 return Object.freeze({settled:true,finalized:true,scenario:expected.scenario,variant:expected.variant,pairId:expected.pairId,attemptId:expected.attemptId,sessionId:expected.sessionId,requestId:e.requestId,checkpointId:e.checkpointId,checkpointSha256:expected.checkpointSha256});
}
export function readB01PreviousRuns({record,target,handoff,expected},protectedRead){
 validateB01Primary(record,target);const position=record.comparison.orderPosition;
 need(handoff?.sourceCommit===serviceCommit&&handoff.runtimeCommit===serviceCommit&&handoff.orderPosition===position&&Array.isArray(expected)&&expected.length===position-1&&typeof protectedRead==='function','EXACT_ACTUAL_B01_PRIORS_REQUIRED');
 for(const [i,p]of expected.entries()){
  need(p.scenario+' '+p.variant===campaignOrder[i]&&p.orderPosition===i+1&&['pairId','runId','attemptId','sessionId','workspaceId','projectId'].every(k=>typeof p[k]==='string'&&p[k].length>0)&&p.sessionId!==ineligibleSession,'EXACT_PRIOR_ORDER_IDENTITY_REQUIRED');
  need(typeof p.checkpointDirectory==='string'&&p.checkpointDirectory.startsWith('/')&&!p.checkpointDirectory.split('/').includes('..')&&p.checkpointFile?.startsWith(p.checkpointDirectory+'/')&&uuid(p.checkpointFile.slice(p.checkpointDirectory.length+1,-5))&&p.checkpointFile.endsWith('.json')&&hex(p.checkpointSha256),'EXACT_PRIOR_CP_PIN_REQUIRED');
  if(p.scenario==='B03')need(p.attemptId.startsWith('b03-pair04-')&&p.checkpointDirectory.includes('/n06-b03-pair04-'),'NEW_B03_PAIR04_PRIOR_REQUIRED');
 }
 need(expected[0].pairId===expected[1].pairId&&expected[2].pairId===expected[3].pairId,'EXACT_PREVIOUS_PAIRS_REQUIRED');
 if(position===6)need(expected[4].pairId===record.pairId,'B01_HOMEAI_FIRST_SAME_PAIR_REQUIRED');
 need(new Set([...expected.map(p=>p.sessionId),target.sessionId]).size===position&&new Set([...expected.map(p=>p.attemptId),record.attemptId]).size===position&&new Set(expected.map(p=>p.checkpointFile)).size===position-1,'DISTINCT_ACTUAL_PRIORS_REQUIRED');
 const rows=Object.freeze(expected.map(p=>validatePriorBytes(p,protectedRead(p.checkpointFile,maxPriorBytes))));actual.set(rows,key({record,target,handoff}));return rows;
}
export function requireB01PreviousRuns({record,target,handoff}){
 validateB01Primary(record,target);need(actual.get(handoff?.previousRuns)===key({record,target,handoff}),'ACTUAL_BOUND_B01_PRIORS_REQUIRED');return handoff.previousRuns;
}
