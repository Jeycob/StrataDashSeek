// Root-only callback composition; does not authorize tools or accept idle as proof.
import {createHash} from 'node:crypto';
import {jobIdentity,terminalJob} from './native-transport.mjs';
const fail=code=>Object.assign(Error(code),{code}),need=(ok,code)=>{if(!ok)throw fail(code);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const NO_PROCESS=new Set(['read','write','edit','apply_patch','todo_write','explain_rewrite','read_image','job_list','job_output','runtime_capabilities']);
const PROCESS=new Set(['bash','project_exec','verify_project','focus_context','project_preview_restart','glob','grep']);
// These names identify the reviewed concrete source contracts only AFTER Root's
// exact source/target composition check. They confer no admission authority.
export function createRootLifecycle({target,sourceCommit},{native,assertTarget,proveOwnedRange,stopOwnedRanges,previewStatus}={},trusted={}){
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(k=>typeof target[k]==='string'&&target[k].length>0),'OWN_TARGET_REQUIRED');
 need(/^[a-f0-9]{40}$/.test(sourceCommit??'')&&typeof assertTarget==='function','SOURCE_TARGET_PROOF_REQUIRED');
 const own=Object.freeze(Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,target[k]])));
 need(['jobsSnapshot','followJob','killJob','projections','terminals'].every(k=>typeof native?.[k]==='function')&&Object.entries(own).every(([k,v])=>native.target?.[k]===v),'NATIVE_TARGET_REQUIRED');
 const now=trusted.now??Date.now;let intent=null,lastEvents=[],observing=null,stopping=false,epoch=0,previewBinding=null;const observationEpoch=Symbol('observationEpoch');const seenJobs=new Map(),terminalProof=new Map();
 const check=options=>{need(options?.[observationEpoch]===undefined||options[observationEpoch]===epoch,'LIFECYCLE_OBSERVATION_SUPERSEDED');need(intent,'DURABLE_INTENT_BINDING_REQUIRED');need(options?.sessionId===own.sessionId&&options.requestId===intent.requestId,'LIFECYCLE_TARGET_MISMATCH');need(Number.isSafeInteger(options.deadline)&&now()<options.deadline&&!options.signal?.aborted,'LIFECYCLE_DEADLINE');};
 const assertCurrent=async options=>{check(options);await assertTarget({...own,sourceCommit,requestId:intent.requestId,signal:options.signal,deadline:options.deadline});check(options);};
 function bindIntent(snapshot){
  need(!intent,'LIFECYCLE_INTENT_ALREADY_BOUND');need(snapshot?.identity&&Object.entries(own).every(([k,v])=>snapshot.identity[k]===v)&&snapshot.identity.sourceCommit===sourceCommit&&uuid(snapshot.operator?.requestId)&&Number.isSafeInteger(snapshot.operator.baselineSeq)&&snapshot.operator.baselineSeq>=-1,'LIFECYCLE_INTENT_INVALID');
  intent=Object.freeze({requestId:snapshot.operator.requestId,baselineSeq:snapshot.operator.baselineSeq});
 }
 async function exclusive(options,action,stop=false){
  check(options);need(stop?!stopping:!observing&&!stopping,'LIFECYCLE_BUSY');let token;if(stop){stopping=true;epoch++;observing=null;}else observing=token={};
  try{await assertCurrent(options);return await action();}finally{if(stop)stopping=false;else if(observing===token)observing=null;}
 }
 function history(events){
  need(Array.isArray(events)&&events.length<=16384&&Buffer.byteLength(JSON.stringify(events))<=8*1024*1024,'LIFECYCLE_HISTORY_LIMIT');
  for(let i=0;i<events.length;i++)need(events[i]?.seq===intent.baselineSeq+1+i,'LIFECYCLE_HISTORY_GAP');
  need(lastEvents.length<=events.length&&hash(events.slice(0,lastEvents.length))===hash(lastEvents),'LIFECYCLE_HISTORY_CHANGED');lastEvents=structuredClone(events);
  const calls=new Map(),results=new Map(),unknown=[];
  for(const row of events){
   if(row.type==='tool/call'){const d=row.data;need(typeof d?.callId==='string'&&d.callId.length<=256&&!calls.has(d.callId)&&typeof d.name==='string'&&d.name.length<=128&&typeof d.arguments==='string','LIFECYCLE_CALL_INVALID');calls.set(d.callId,row);}
   if(row.type==='tool/result'){const d=row.data,m=d?.message,id=m?.toolCallId;need(m?.role==='tool'&&m.source?.kind==='tool'&&m.source.callId===id&&typeof id==='string'&&!results.has(id)&&calls.has(id),'LIFECYCLE_RESULT_UNPAIRED');results.set(id,row);}
   if(row.type.startsWith('subagent/')||row.type==='tool/ptc-dispatch')unknown.push('UNSUPPORTED_EVENT_'+row.type);
  }
  return{calls,results,unknown};
 }
 async function inventory(options){
  const [rows,projection,terminals]=await Promise.all([native.jobsSnapshot(options),native.projections(options),native.terminals(options)]);await assertCurrent(options);
  need(Array.isArray(rows)&&rows.length<=128&&Array.isArray(terminals)&&terminals.length<=32,'LIFECYCLE_INVENTORY_INVALID');
  need(projection?.kind==='sequenced'&&Number.isSafeInteger(projection.asOfSeq)&&Array.isArray(projection.values?.subagentCatalog),'LIFECYCLE_CATALOG_UNKNOWN');
  const ownRows=[];for(const row of rows){
   if(row.owner!==own.sessionId)continue;
   need(typeof row.id==='string','LIFECYCLE_JOB_INVALID');const old=seenJobs.get(row.id);need(!old||jobIdentity(old)===jobIdentity(row),'LIFECYCLE_JOB_CHANGED');seenJobs.set(row.id,structuredClone(row));ownRows.push(row);
  }
  return{rows:ownRows,projection,terminals,unownedVisible:rows.filter(row=>row.owner===undefined).length};
 }
 async function excluded(row,options){
  if(typeof previewStatus!=='function')return false;
  const status=await previewStatus({...own,signal:options.signal,deadline:options.deadline});await assertCurrent(options);
  if(status?.jobId!==row.id)return false;
  // B's status is meaningful only with its trusted Root target binding. Its
  // workSettled value describes this preview, never all conversation work.
  need(status.state==='ready'&&status.sessionId===own.sessionId&&status.generation&&status.previewId&&Number.isSafeInteger(status.expiresAt)&&now()<status.expiresAt,'LIFECYCLE_PREVIEW_UNKNOWN');
  if(!previewBinding)previewBinding={id:status.previewId,expiresAt:status.expiresAt};
  need(status.previewId===previewBinding.id&&status.expiresAt===previewBinding.expiresAt,'LIFECYCLE_PREVIEW_LIFETIME_CHANGED');
  return{jobId:row.id,owner:row.owner,startedAt:row.startedAt,previewId:status.previewId,generation:status.generation,expiresAt:status.expiresAt};
 }
 async function observeWork(options){
  options={...options,[observationEpoch]:epoch};
  try{return await exclusive(options,async()=>{
   const h=history(options.events),inv=await inventory(options),unknown=[...h.unknown],proofs=[],exclusions=[],previewCandidates=[];
   for(const row of inv.rows)if(!terminalJob(row)){const candidate=await excluded(row,options);if(candidate)previewCandidates.push(candidate);}
   // N06 forbids delegation. A nonempty catalog is an explicit unknown branch;
   // never globally list/read/cancel unrelated conversations to make it empty.
   if(inv.projection.asOfSeq<(options.events.at(-1)?.seq??intent.baselineSeq))unknown.push('CATALOG_BEHIND_HISTORY');
   if(inv.projection.values.subagentCatalog.length)unknown.push('DESCENDANT_WORK_UNQUALIFIED');
   if(inv.terminals.length)unknown.push('PTY_WORK_UNQUALIFIED');
   for(const [id,call]of h.calls){
    const result=h.results.get(id);if(!result){unknown.push('TOOL_RESULT_PENDING');continue;}
    if(call.data.name==='runtime_capabilities'){
     // e782's reviewed tool accepts only {}. Do not generalize this effect
     // classification to malformed calls or infer authority from rendered text.
     let args;try{args=JSON.parse(call.data.arguments);}catch{}
     if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length){unknown.push('RUNTIME_CAPABILITIES_ARGUMENTS_INVALID');continue;}
    }
    if(NO_PROCESS.has(call.data.name)){proofs.push({callId:id,name:call.data.name,resultSeq:result.seq,kind:'reviewed-awaited-effect'});continue;}
    if(call.data.name==='job_kill'){
     let args;try{args=JSON.parse(call.data.arguments);}catch{}
     const row=inv.rows.find(item=>item.id===args?.job_id),old=seenJobs.get(args?.job_id);
     if(row||old&&terminalProof.get(old.id)===jobIdentity(old))proofs.push({callId:id,name:call.data.name,resultSeq:result.seq,kind:'owned-job-controller-ack-only',jobId:args.job_id});else unknown.push('JOB_KILL_TARGET_UNQUALIFIED');continue;
    }
    if(result.data.message.isError===true&&!PROCESS.has(call.data.name)){unknown.push('TOOL_ERROR_RANGE_UNKNOWN');continue;}
    if(call.data.name==='project_preview'&&typeof previewStatus==='function'){
     let args;try{args=JSON.parse(call.data.arguments);}catch{}
     if(!['open','status','close'].includes(args?.operation)){unknown.push('PREVIEW_OPERATION_UNKNOWN');continue;}
     const status=await previewStatus({...own,signal:options.signal,deadline:options.deadline});await assertCurrent(options);
     if(status?.sessionId===own.sessionId&&(status.state==='ready'||status.state==='closed'&&status.workSettled===true||status.state==='unavailable'))proofs.push({callId:id,name:call.data.name,resultSeq:result.seq,kind:'controller-awaited-preview-operation'});
     else unknown.push('PREVIEW_OPERATION_UNSETTLED');continue;
    }
    if(PROCESS.has(call.data.name)){
     // A successful result proves the foreground/direct outcome, not the
     // provider's separate managed range. The current shell hides waitForExit.
     const fingerprint=hash({call:call.data,result:result.data});
     const proof=typeof proveOwnedRange==='function'?await proveOwnedRange({...own,kind:'tool',requestId:intent.requestId,callId:id,fingerprint,call:structuredClone(call),result:structuredClone(result),previewCandidates:structuredClone(previewCandidates),signal:options.signal,deadline:options.deadline}):null;
     await assertCurrent(options);
     if(proof?.settled===true&&proof.callId===id&&proof.fingerprint===fingerprint&&typeof proof.evidence==='string'&&proof.evidence.length>0&&proof.evidence.length<=2048)proofs.push({callId:id,name:call.data.name,resultSeq:result.seq,kind:'owned-range',evidence:proof.evidence});
     else if(proof?.excludedPreview===true&&proof.callId===id&&proof.fingerprint===fingerprint&&typeof proof.evidence==='string'&&proof.evidence.length>0&&proof.evidence.length<=2048){
      const candidate=previewCandidates.find(item=>['jobId','owner','startedAt','previewId','generation','expiresAt'].every(key=>proof[key]===item[key]));
      const row=candidate&&inv.rows.find(item=>item.id===candidate.jobId),fresh=row&&await excluded(row,options);
      if(fresh&&JSON.stringify(fresh)===JSON.stringify(candidate))proofs.push({callId:id,name:call.data.name,resultSeq:result.seq,kind:'exact-preview-producer',jobId:candidate.jobId,evidence:proof.evidence});else unknown.push('PREVIEW_PRODUCER_CORRELATION_MISSING');
     }else unknown.push('MANAGED_RANGE_PROOF_MISSING');
    }else unknown.push('UNREVIEWED_TOOL_'+call.data.name);
   }
   for(const row of inv.rows){
    if(!terminalJob(row)){
     const exemption=previewCandidates.find(item=>item.jobId===row.id);if(exemption){exclusions.push(exemption);continue;}
     unknown.push('OWN_JOB_ACTIVE');continue;
    }
    const final=await native.followJob(row,options);await assertCurrent(options);need(terminalJob(final)&&jobIdentity(final)===jobIdentity(row),'LIFECYCLE_JOB_TERMINAL_INVALID');
    const fingerprint=hash({identity:jobIdentity(final),finishedAt:final.finishedAt});
    const range=typeof proveOwnedRange==='function'?await proveOwnedRange({...own,kind:'job',requestId:intent.requestId,jobId:row.id,fingerprint,job:structuredClone(final),signal:options.signal,deadline:options.deadline}):null;await assertCurrent(options);
    if(range?.settled===true&&range.jobId===row.id&&range.fingerprint===fingerprint&&typeof range.evidence==='string'&&range.evidence.length>0&&range.evidence.length<=2048)terminalProof.set(row.id,jobIdentity(final));else unknown.push('JOB_MANAGED_RANGE_PROOF_MISSING');
   }
   for(const [id,row]of seenJobs)if(!inv.rows.some(item=>item.id===id)&&terminalProof.get(id)!==jobIdentity(row))unknown.push('OWN_JOB_DISAPPEARED_UNSETTLED');
   await assertCurrent(options);
   return{settled:unknown.length===0,evidence:{version:1,target:own,sourceCommit,requestId:intent.requestId,throughSeq:options.events.at(-1)?.seq??intent.baselineSeq,toolProofs:proofs,terminalJobs:[...terminalProof.keys()],previewExclusions:exclusions,unownedVisibleIgnored:inv.unownedVisible,unknown:[...new Set(unknown)]}};
  });}catch(error){return{settled:false,evidence:{version:1,target:own,unknown:[error?.code??'LIFECYCLE_OBSERVATION_FAILED']}};}
 }
 async function stopOwnedWork(options){
  return exclusive(options,async()=>{
   const inv=await inventory(options),stopped=[],unknown=[];
   if(typeof stopOwnedRanges==='function'){await stopOwnedRanges({...own,requestId:intent.requestId,signal:options.signal,deadline:options.deadline});await assertCurrent(options);}
   if(inv.projection.values.subagentCatalog.length)unknown.push('DESCENDANT_WORK_UNQUALIFIED');if(inv.terminals.length)unknown.push('PTY_WORK_UNQUALIFIED');
   for(const row of inv.rows){
    if(await excluded(row,options))continue;await assertCurrent(options);
    if(!terminalJob(row)){await native.killJob(row,options);await assertCurrent(options);}
    // ACK is not settlement. Normal follow end after terminal status is required.
    const final=await native.followJob(row,options);await assertCurrent(options);need(terminalJob(final)&&jobIdentity(final)===jobIdentity(row),'LIFECYCLE_JOB_TERMINAL_INVALID');stopped.push(row.id);
   }
   return{settled:false,evidence:{stoppedJobs:stopped,unknown:[...unknown,'REQUIRES_FRESH_HISTORY_AND_OBSERVE']}};
  },true);
 }
 return Object.freeze({bindIntent,observeWork,stopOwnedWork});
}

// Keep the runner's original absolute deadline; add no budget and change no
// timer/abort behavior. Its realClock normally supplies only {signal}.
export function bindLifecycleClock(clock){
 need(clock&&['now','sleep','bound'].every(name=>typeof clock[name]==='function'),'LIFECYCLE_CLOCK_REQUIRED');
 return Object.freeze({now:clock.now.bind(clock),sleep:clock.sleep.bind(clock),bound(fn,deadline,outerSignal){
  need(Number.isSafeInteger(deadline),'LIFECYCLE_DEADLINE');
  return clock.bound(options=>fn({...options,deadline}),deadline,outerSignal);
 }});
}
