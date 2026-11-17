// Root-injected source unit. Import and construction perform no I/O.
const fail=code=>Object.assign(Error(code),{code});
const need=(value,code)=>{if(!value)throw fail(code);};
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identity=row=>JSON.stringify([row.id,row.owner,row.kind,row.startedAt]);
const terminal=row=>['completed','failed','killed'].includes(row.status)&&Number.isSafeInteger(row.finishedAt)&&row.finishedAt>=row.startedAt;
export const bounds=Object.freeze({totalMs:120000,operationMs:4000,resealMs:4000,jobs:128,terminals:32,receiptBytes:262144});

export function createRootFinalizer({target,sourceCommit,requestId,deadline},callbacks={},trusted={}){
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(key=>text(target[key])),'OWN_TARGET_REQUIRED');
 need(/^[a-f0-9]{40}$/.test(sourceCommit??'')&&text(requestId),'SOURCE_REQUEST_REQUIRED');
 const {rpc,previewClose,native,assertRuntime,observeOwnedWork}=callbacks;
 need([rpc,previewClose,assertRuntime,observeOwnedWork,...['jobsSnapshot','killJob','followJob','state','projections','terminals'].map(key=>native?.[key])].every(value=>typeof value==='function'),'ACTUAL_CALLBACKS_REQUIRED');
 const own=Object.freeze(Object.fromEntries(['sessionId','workspaceId','projectId'].map(key=>[key,target[key]])));
 need(Object.entries(own).every(([key,value])=>native.target?.[key]===value),'NATIVE_TARGET_MISMATCH');
 const now=trusted.now??Date.now,setTimer=trusted.setTimeout??setTimeout,clearTimer=trusted.clearTimeout??clearTimeout;
 need(Number.isSafeInteger(deadline)&&deadline>now()&&deadline-now()<=bounds.totalMs,'FIXED_DEADLINE_REQUIRED');
 let used=false,tupleSha256,archiveState='unknown',restored=false;
 const receipts=[],seen=new Map(),proved=new Set();
 function receipt(phase,details={}){
  const row={phase,at:now(),...details};
  need(Buffer.byteLength(JSON.stringify([...receipts,row]))<=bounds.receiptBytes,'RECEIPT_LIMIT');receipts.push(row);
 }
 async function call(phase,fn,{reserve=false,signal}={}){
  const end=Math.min(deadline-(reserve?bounds.resealMs:0),now()+bounds.operationMs);
  need(now()<end&&!signal?.aborted,'FINALIZER_DEADLINE_OR_ABORT');
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
  let timer;
  try{
   const value=await Promise.race([Promise.resolve().then(()=>{need(!controller.signal.aborted,'FINALIZER_ABORTED');return fn({...own,sourceCommit,requestId,deadline:end,signal:controller.signal});}),new Promise((_,reject)=>{timer=setTimer(()=>{controller.abort();reject(fail('FINALIZER_OPERATION_DEADLINE'));},Math.max(0,end-now()));})]);
   need(now()<end&&!controller.signal.aborted,'FINALIZER_DEADLINE_OR_ABORT');receipt(phase,{ok:true});return value;
  }catch(error){receipt(phase,{ok:false,code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:'CALLBACK_FAILED'});throw error;}
  finally{clearTimer(timer);signal?.removeEventListener('abort',abort);controller.abort();}
 }
 async function current(phase,options){
  const proof=await call(phase,input=>assertRuntime(input),options);
  need(proof&&Object.entries(own).every(([key,value])=>proof[key]===value)&&proof.sourceCommit===sourceCommit&&sha(proof.tupleSha256),'RUNTIME_PROOF_INVALID');
  if(tupleSha256===undefined)tupleSha256=proof.tupleSha256;
  need(proof.tupleSha256===tupleSha256,'RUNTIME_TUPLE_CHANGED');
 }
 async function archive(phase,options){
  // A rejected/timeout response may still have committed: retain UNKNOWN.
  archiveState='unknown';
  const value=await call(phase,input=>rpc('workspace/archiveSession',{request:{sessionId:own.sessionId,stopActivity:true}},input),options);
  need(Array.isArray(value?.archivedSessionIds)&&value.archivedSessionIds.includes(own.sessionId),'ARCHIVE_UNCONFIRMED');archiveState='archived';restored=false;
 }
 async function inventory(phase,options){
  // Sequential bounded reads keep the transcript ordered; every callback gets
  // the same absolute end bound, never a refreshed total budget.
  const rows=await call(phase+'_jobs',input=>native.jobsSnapshot(input),options);
  need(Array.isArray(rows)&&rows.length<=bounds.jobs,'JOB_INVENTORY_UNKNOWN');
  const ids=new Set(),owned=[];let unowned=0,foreign=0;
  for(const row of rows){
   need(row&&text(row.id)&&!ids.has(row.id)&&text(row.kind)&&Number.isSafeInteger(row.startedAt)&&row.startedAt>=0&&['running','stopping','completed','failed','killed'].includes(row.status),'JOB_ROW_INVALID');ids.add(row.id);
   if(row.owner!==own.sessionId){if(row.owner===undefined)unowned++;else{need(text(row.owner),'JOB_OWNER_INVALID');foreign++;}continue;}
   const pin=identity(row),prior=seen.get(row.id);need(!prior||prior===pin,'OWN_JOB_IDENTITY_CHANGED');seen.set(row.id,pin);owned.push(row);
  }
  const state=await call(phase+'_state',input=>native.state(input),options);
  const projection=await call(phase+'_projections',input=>native.projections(input),options);
  const terminals=await call(phase+'_terminals',input=>native.terminals(input),options);
  await current(phase+'_runtime',options);
  need(Number.isSafeInteger(state?.cursor)&&state.cursor>=-1&&typeof state.active==='boolean'&&typeof state.running==='boolean'&&Array.isArray(state.queue)&&Array.isArray(state.pendingInput),'SESSION_STATE_UNKNOWN');
  need(projection?.kind==='sequenced'&&Number.isSafeInteger(projection.asOfSeq)&&projection.asOfSeq>=state.cursor&&Array.isArray(projection.values?.subagentCatalog),'CHILD_CATALOG_UNKNOWN');
  need(Array.isArray(terminals)&&terminals.length<=bounds.terminals,'PTY_INVENTORY_UNKNOWN');
  receipt(phase+'_inventory',{ownJobs:owned.map(row=>({id:row.id,status:row.status,identity:identity(row)})),unownedIgnored:unowned,foreignIgnored:foreign,queue:state.queue.length,pendingInput:state.pendingInput.length,children:projection.values.subagentCatalog.length,ptys:terminals.length});
  return{owned,state,projection,terminals};
 }
 async function follow(row,phase,options){
  const final=await call(phase,input=>native.followJob(structuredClone(row),input),options);
  need(final?.owner===own.sessionId&&identity(final)===identity(row)&&terminal(final),'JOB_SETTLEMENT_UNCONFIRMED');proved.add(row.id);
  receipt(phase+'_terminal',{jobId:row.id,status:final.status,finishedAt:final.finishedAt});await current(phase+'_runtime',options);
 }
 async function settled(phase,options){
  const inv=await inventory(phase,options);
  for(const row of inv.owned){need(terminal(row),'LATE_OWN_JOB_ACTIVE');if(!proved.has(row.id))await follow(row,phase+'_follow_'+proved.size,options);}
  for(const id of seen.keys())need(inv.owned.some(row=>row.id===id)||proved.has(id),'OWN_JOB_DISAPPEARED');
  need(!inv.state.running&&inv.state.queue.length===0&&inv.state.pendingInput.length===0,'SESSION_NOT_QUIET');
  // N06 has no delegation/PTY allowance. A nonempty catalog is HOLD even if
  // its rows claim idle; this module never adopts or kills child/PTY handles.
  need(inv.projection.values.subagentCatalog.length===0,'CHILD_WORK_UNQUALIFIED');need(inv.terminals.length===0,'PTY_WORK_UNQUALIFIED');
  const proof=await call(phase+'_owned_work',input=>observeOwnedWork({...input,throughSeq:inv.state.cursor}),options);
  need(proof?.settled===true&&proof.sessionId===own.sessionId&&proof.requestId===requestId&&Number.isSafeInteger(proof.throughSeq)&&proof.throughSeq>=inv.state.cursor&&typeof proof.evidence==='string'&&proof.evidence.length>0&&proof.evidence.length<=4096,'OWNED_WORK_UNCONFIRMED');
  receipt(phase+'_proof',{throughSeq:proof.throughSeq,evidence:proof.evidence});await current(phase+'_final_runtime',options);
 }
 async function finalizeFence({signal}={}){
  need(!used,'FINALIZER_ONCE_ONLY');used=true;
  try{
   await current('initial_runtime',{signal});
   await archive('archive',{signal});await current('archived_runtime',{signal});
   const close=await call('preview_close',input=>previewClose(input),{signal});
   need(close?.sessionId===own.sessionId&&close.state==='closed'&&close.workSettled===true,'PREVIEW_CLOSE_UNSETTLED');await current('closed_runtime',{signal});
   const initial=await inventory('stop_inventory',{signal});
   for(const row of initial.owned){
    if(!terminal(row)){const ack=await call('kill_'+proved.size,input=>native.killJob(structuredClone(row),input),{signal});need(['requested','already-finished'].includes(ack?.outcome),'KILL_UNCONFIRMED');await current('killed_runtime',{signal});}
    await follow(row,'follow_'+proved.size,{signal});
   }
   await settled('before_restore',{signal,reserve:true});
   // Reserve remains inside the ORIGINAL deadline for one safety reseal.
   archiveState='unknown';restored=true; // timeout/error can still mean committed
   const value=await call('unarchive',input=>rpc('workspace/unarchiveSession',{request:{sessionId:own.sessionId}},input),{signal,reserve:true});
   need(Array.isArray(value?.archivedSessionIds)&&!value.archivedSessionIds.includes(own.sessionId),'UNARCHIVE_UNCONFIRMED');archiveState='visible';
   await settled('after_restore',{signal,reserve:true});
   receipt('complete',{settled:true,visible:true});
   return{status:'SETTLED_VISIBLE',settled:true,visible:true,archiveState,target:own,sourceCommit,requestId,deadline,tupleSha256,receipts:structuredClone(receipts)};
  }catch(error){
   // No retry of the campaign or unarchive. Only re-establish the safety fence
   // after a possibly committed unarchive; ignore a caller's canceled signal
   // for this single cleanup request, within the unchanged original deadline.
   if(restored){try{await archive('safety_rearchive');}catch{archiveState='unknown';}}
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:'FINALIZER_UNCONFIRMED';
   return{status:'HOLD',settled:false,visible:archiveState==='visible',archiveState,code,target:own,sourceCommit,requestId,deadline,tupleSha256,receipts:structuredClone(receipts)};
  }
 }
 return Object.freeze({finalizeFence});
}
