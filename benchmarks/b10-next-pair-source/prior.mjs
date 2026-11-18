// Root supplies only its fixed protected bounded reads. No FS/auth at import.
// Adapted from the reviewed raw-envelope prior validator, not B03 DS ordering.
import {createHash} from 'node:crypto';
import {need,serviceCommit,frozen,validateFixedSlot} from './spec.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const same=(a,b)=>a&&Object.entries(b).every(([k,v])=>a[k]===v);
export const MAX_PRIOR_ENVELOPE_BYTES=2097152+8192;
const bound=new WeakMap();
export function validateActualPrior({checkpointBytes,expected}){
 need(expected&&hex(expected.checkpointSha256),'ROOT_ACTUAL_PRIOR_CHECKPOINT_PIN_REQUIRED');
 need(Buffer.isBuffer(checkpointBytes)&&checkpointBytes.length>0&&checkpointBytes.length<=MAX_PRIOR_ENVELOPE_BYTES,'ACTUAL_BOUNDED_BYTES_REQUIRED');
 need(sha(checkpointBytes)===expected.checkpointSha256,'PRIOR_CHECKPOINT_HASH_MISMATCH');
 const e=JSON.parse(checkpointBytes),r=e.snapshot,own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,expected[k]]));
 need(e.version===1&&e.phase==='final'&&e.attemptId===expected.attemptId&&same(e.target,own)&&uuid(e.checkpointId)&&uuid(e.requestId)&&uuid(e.previousCheckpointId),'EXACT_PRIOR_FINAL_ENVELOPE_REQUIRED');
 need(r&&hex(e.snapshotSha256)&&sha(Buffer.from(JSON.stringify(r)))===e.snapshotSha256&&Buffer.byteLength(JSON.stringify(r))<=2097152,'PRIOR_SNAPSHOT_HASH_MISMATCH');
 need(r.isTemplate===false&&['PASS','FAIL','BLOCKED'].includes(r.status)&&same(r,Object.fromEntries(['scenario','variant','pairId','runId','attemptId'].map(k=>[k,expected[k]])))&&r.comparison?.orderPosition===expected.orderPosition,'EXACT_ACTUAL_PRIOR_ATTEMPT_REQUIRED');
 need(same(r.identity,own)&&r.identity.sourceCommit===serviceCommit&&r.identity.runtimeCommit===serviceCommit&&r.identity.manifestSha256===frozen.frozenManifestSha256&&r.identity.promptSha256===expected.promptSha256&&r.identity.acceptanceVersion==='paired-20261116 v1 + product-qa supplement v1'&&same(r.identity.requestedModel,expected.modelSelection),'PRIOR_IDENTITY_FROZEN_INPUTS_MISMATCH');
 const op=r.operator,obs=r.nativeObservation;
 need(op?.finalized===true&&op.requestId===e.requestId&&Number.isSafeInteger(op.baselineSeq)&&op.baselineSeq>=-1&&typeof op.rootHandoff==='string'&&op.rootHandoff.length>0&&r.slotHandoffEvidence===op.rootHandoff,'PRIOR_FINALIZED_INTENT_REQUIRED');
 need(op.persistence?.unknownOutcome===false&&op.persistenceFailed!==true&&op.persistence.pendingCheckpointId===e.checkpointId&&op.persistence.lastDurableCheckpointId===e.previousCheckpointId,'PRIOR_DURABLE_CHAIN_REQUIRED');
 need(obs?.promptAdmission==='accepted'&&obs.settled===true&&obs.historyComplete===true&&Array.isArray(obs.events)&&obs.events.some(x=>x.type==='turn/start'&&x.seq>op.baselineSeq)&&obs.events.some(x=>x.type==='turn/end'&&x.seq>op.baselineSeq),'ACTUAL_PRIOR_SUBMITTED_SETTLED_REQUIRED');
 const start=Date.parse(r.timestampsUtc?.runSubmittedAt),end=Date.parse(r.timestampsUtc?.finishedAt),settled=Date.parse(r.timestampsUtc?.settledAt);
 need(r.limits?.mainSeconds===600&&Number.isFinite(start)&&Number.isFinite(end)&&Number.isFinite(settled)&&end>=start&&settled>=start&&Date.parse(op.primaryDeadlineAt)===start+600000,'PRIOR_ORIGINAL_CLOCK_REQUIRED');
 const fence=r.rootFinalization;
 need(fence?.status==='SETTLED_VISIBLE'&&fence.settled===true&&fence.visible===true&&fence.archiveState==='visible'&&fence.sourceCommit===serviceCommit&&fence.requestId===op.requestId&&same(fence.target,own)&&hex(fence.tupleSha256)&&Number.isSafeInteger(fence.deadline),'ACTUAL_PRIOR_SETTLED_VISIBLE_REQUIRED');
 // Real raw final envelopes omit nested fence.persistence. Never manufacture it.
 if(expected.actualWriterReceipt!==null&&expected.actualWriterReceipt!==undefined){const x=expected.actualWriterReceipt;need(x.durable===true&&x.checkpointId===e.checkpointId&&x.sha256===expected.checkpointSha256&&x.bytes===checkpointBytes.length,'ACTUAL_PRIOR_WRITER_RECEIPT_MISMATCH');}
 return Object.freeze({settled:true,finalized:true,scenario:expected.scenario,variant:expected.variant,pairId:expected.pairId,attemptId:expected.attemptId,sessionId:expected.sessionId,requestId:op.requestId,checkpointId:e.checkpointId,checkpointSha256:expected.checkpointSha256});
}
export function readActualPreviousRuns(slot,protectedRead){
 validateFixedSlot(slot);need(typeof protectedRead==='function','PROTECTED_PRIOR_READER_REQUIRED');
 const rows=Object.freeze(slot.previous.map(expected=>validateActualPrior({expected,checkpointBytes:protectedRead(expected.checkpointFile,MAX_PRIOR_ENVELOPE_BYTES)})));
 bound.set(rows,slot);return rows;
}
export function requireBoundPreviousRuns(slot,rows){
 need(bound.get(rows)===slot&&rows.length===slot.orderPosition-1,'ACTUAL_FIXED_CAMPAIGN_PRIORS_REQUIRED');
 return structuredClone(rows);
}
