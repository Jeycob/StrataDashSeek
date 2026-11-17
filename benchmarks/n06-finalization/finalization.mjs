// No I/O at import/construction. Actual effects are the already-bound Root APIs.
import {createHash,randomUUID} from 'node:crypto';
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone=v=>structuredClone(v);
export function createFinalizerWriter({checkpoint,now}){
 need(typeof checkpoint==='function'&&typeof now==='function','ACTUAL_WRITER_REQUIRED');
 let runnerLast=null,actualLast=null,latest,busy=false,quarantined=false,fence;
 async function write(snapshot,options,internal){
  need(!busy&&!quarantined,'FINALIZER_WRITER_UNAVAILABLE');
  if(!internal)need(snapshot.operator?.persistence?.lastDurableCheckpointId===runnerLast,'RUNNER_CHECKPOINT_CHAIN_CHANGED');
  busy=true;
  try{
   const copy=clone(snapshot);copy.operator.persistence.lastDurableCheckpointId=actualLast;
   if(fence)copy.rootFinalization=clone(fence);
   const receipt=await checkpoint(copy,options);
   need(now()<options.deadline&&!options.signal?.aborted&&receipt?.durable===true&&receipt.checkpointId===options.checkpointId,'FINALIZER_DURABILITY_UNCONFIRMED');
   actualLast=receipt.checkpointId;latest=copy;latest.operator.persistence.lastDurableCheckpointId=actualLast;
   if(!internal)runnerLast=actualLast;return receipt;
  }catch(e){quarantined=true;throw e;}finally{busy=false;}
 }
 return Object.freeze({
  runner:(s,o)=>write(s,o,false),
  async retain(result,options){
   need(latest&&result.requestId===latest.operator.requestId,'ACTUAL_INTENT_REQUIRED');fence=clone(result);
   const checkpointId=randomUUID(),snapshot=clone(latest);snapshot.operator.persistence.pendingCheckpointId=checkpointId;
   return write(snapshot,{...options,checkpointId,phase:'observation'},true);
  },
 });
}

export function createDriverFinalization({target,sourceCommit,native,rpc,runtime,modules,writer,now,settlementMs,stopScope}){
 need(['assertArchiveRuntime','previewClose','archiveRPC'].every(k=>typeof runtime?.[k]==='function')&&typeof rpc==='function'&&typeof writer?.retain==='function'&&typeof now==='function','ACTUAL_FINALIZATION_BINDINGS_REQUIRED');
 need(['createRootFinalizer','createRootLifecycle','createRootBindings','readOwnObservation'].every(k=>typeof modules?.[k]==='function'),'FROZEN_FINALIZATION_MODULES_REQUIRED');
 need(Number.isSafeInteger(settlementMs)&&settlementMs>0&&settlementMs<=120000,'FIXED_SETTLEMENT_WINDOW_REQUIRED');
 need(typeof stopScope?.finalization==='function','ACTUAL_STOP_SCOPE_REQUIRED');
 let intent,cutCalls=null,phase='visible',finalizing,result,primaryDeadline;
 const own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,target[k]]));
 const attribute=input=>{need(input&&Object.entries({...own,requestId:intent?.operator.requestId}).every(([k,v])=>!Object.hasOwn(input,k)||input[k]===v),'FOREIGN_FINALIZATION_REQUEST');return{...input,...own,requestId:intent?.operator.requestId};};
 const check=input=>need(intent&&Object.entries(own).every(([k,v])=>input?.[k]===v)&&input.requestId===intent.operator.requestId&&Number.isSafeInteger(input.deadline)&&now()<input.deadline&&!input.signal?.aborted,'FINALIZATION_IDENTITY_OR_DEADLINE');
 const actualRuntime=async input=>{check(input);return runtime.assertArchiveRuntime(input);};
 const observation=input=>modules.readOwnObservation({rpc,sessionId:own.sessionId,afterSeq:intent.operator.baselineSeq,deadline:input.deadline,signal:input.signal});
 // Qualification is the ACTUAL prearchive WeakSet witness from preflight, bound
 // by runtime to unchanged source/profile/launch/native PID+start/project inode.
 // The fresh preview field below is an ACTUAL allowed close response, not status.
 const archivedAttest=async input=>{const proof=await actualRuntime(input),preview=await runtime.previewClose(input);check(input);need(preview?.sessionId===own.sessionId&&preview.state==='closed'&&preview.workSettled===true,'ACTUAL_PREVIEW_CLOSE_REQUIRED');await actualRuntime(input);return{...proof,version:1,preview};};
 const binding=modules.createRootBindings({target,sourceCommit},{native,attest:archivedAttest,cancelOwned:input=>rpc('session/cancel',{sessionId:own.sessionId},input)});
 const life=modules.createRootLifecycle({target,sourceCommit},{native,assertTarget:actualRuntime,...binding,previewStatus:async input=>(await archivedAttest({...input,...own,requestId:intent?.operator.requestId})).preview});
 async function assertRuntime(input){
  const proof=await actualRuntime(input);
  if(phase==='archived'&&cutCalls===null){const obs=await observation(input);check(input);cutCalls=new Set(obs.events.filter(e=>e.type==='tool/call').map(e=>e.data.callId));await actualRuntime(input);}
  return proof;
 }
 async function observeOwnedWork(input){
  check(input);need(cutCalls,'DURABLE_ARCHIVE_CUT_REQUIRED');const obs=await observation(input);check(input);
  need(obs.historyComplete===true&&obs.state.cursor>=input.throughSeq&&obs.events.every(e=>e.type!=='tool/call'||cutCalls.has(e.data.callId)),'NEW_OR_UNKNOWN_CALL_AFTER_ARCHIVE');
  const proof=await life.observeWork({...input,events:obs.events});check(input);
  need(proof.settled===true&&proof.evidence?.throughSeq===obs.state.cursor,'ARCHIVED_OWNED_RANGE_UNCONFIRMED');
  const evidence=JSON.stringify({kind:'actual-archive-safe-lifecycle',throughSeq:obs.state.cursor,historySha256:hash(obs.events),proofSha256:hash(proof.evidence),toolProofs:proof.evidence.toolProofs.length,terminalJobs:proof.evidence.terminalJobs});
  need(evidence.length<=4096,'ARCHIVED_PROOF_LIMIT');return{settled:true,...own,requestId:input.requestId,throughSeq:obs.state.cursor,evidence};
 }
 async function finalize(options){
  need(intent,'ACTUAL_DURABLE_INTENT_REQUIRED');
  options=stopScope.finalization(options);if(finalizing)return finalizing;
  const deadline=options.deadline;need(Number.isSafeInteger(deadline)&&now()<deadline&&deadline-now()<=settlementMs,'ORIGINAL_BOUNDED_FINALIZATION_DEADLINE_REQUIRED');
  finalizing=(async()=>{
   const originalRPC=async(method,args,input)=>{
    check(input);phase='archived'; // unknown mutation outcome must never permit status
    const value=await runtime.archiveRPC(method,args,input);check(input);
    if(method==='workspace/unarchiveSession')phase='visible';return value;
   };
   const finalizer=modules.createRootFinalizer({target,sourceCommit,requestId:intent.operator.requestId,deadline},{rpc:originalRPC,native:{...native,state:input=>rpc('session/state',{sessionId:own.sessionId},input)},assertRuntime,
    async previewClose(input){
     const close=await runtime.previewClose(input);check(input);need(close?.state==='closed'&&close.workSettled===true,'PREVIEW_CLOSE_UNCONFIRMED');
     // CLOSED retains its actual jobId. No live exemption applies: bindings
     // cancel/kill only; core finalizer follows exact rows and life observes.
     await binding.stopOwnedRanges(input);check(input);return close;
    },observeOwnedWork});
   const fence=await finalizer.finalizeFence({signal:options.signal});result=clone(fence);
   try{const receipt=await writer.retain(fence,{deadline:Math.min(deadline,now()+4000),signal:options.signal});result.persistence={durable:true,checkpointId:receipt.checkpointId};}
   catch{result={...result,status:'HOLD',settled:false,persistence:{durable:false,unknown:true},code:'FINALIZER_EVIDENCE_UNCONFIRMED'};}
   return clone(result);
  })();return finalizing;
 }
 return Object.freeze({
  bindIntent(snapshot){need(!intent,'FINALIZER_INTENT_ALREADY_BOUND');intent=clone(snapshot);primaryDeadline=Date.parse(intent.operator.primaryDeadlineAt);need(Number.isSafeInteger(primaryDeadline),'ORIGINAL_PRIMARY_DEADLINE_REQUIRED');life.bindIntent(snapshot);},
  stop:options=>{need(options?.sessionId===own.sessionId&&options.requestId===intent?.operator.requestId,'FOREIGN_FINALIZATION_REQUEST');return finalize(attribute(options));},
  finish:options=>finalize(attribute(stopScope.finalization({...options,deadline:Math.min(primaryDeadline,now()+settlementMs)},{finish:true}))),
  cleanup:options=>finalize(attribute(options)),
  state:()=>({phase,result:result?clone(result):null}),
 });
}
