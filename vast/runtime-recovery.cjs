'use strict';
// Stable-root recovery controller. Release verification, admission fencing and
// pointer changes are root hooks; no project/database path is accepted here.
const crypto=require('node:crypto'),path=require('node:path');
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9-]{36}$/,WINDOW=86400000,TIMEOUT=90000;
const UNSAFE_BASELINE='505460d62e63c389def4fba5c82da8b9ab9cfd13';
const rollbackPending=phase=>['rollback_intent','rollback_switched','recovery_required'].includes(phase);
const fault=code=>Object.assign(Error(code),{code,status:409});
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function policyOf(value={}){
 if(value.enabled!==true||!HASH.test(value.compatibilityId||'')||!Number.isSafeInteger(value.minimumSecurityEpoch)||value.minimumSecurityEpoch<1||!Array.isArray(value.deniedCommits)||value.deniedCommits.some(x=>!SHA.test(x)))throw fault('RUNTIME_RECOVERY_POLICY_REQUIRED');
 return{version:1,enabled:true,compatibilityId:value.compatibilityId,minimumSecurityEpoch:value.minimumSecurityEpoch,deniedCommits:[...new Set([...value.deniedCommits,UNSAFE_BASELINE])].sort(),readinessTimeoutMs:TIMEOUT,maxPerCandidate:1,maxPerDay:2};
}
function verifiedRelease(value,commit,policy){
 if(!SHA.test(commit||'')||!value||value.commit!==commit||!HASH.test(value.digest||'')||value.signatureVerified!==true||value.rootProtected!==true||value.admissionProtocol!==1||!Number.isSafeInteger(value.securityEpoch)||value.securityEpoch<policy.minimumSecurityEpoch||value.compatibilityId!==policy.compatibilityId||policy.deniedCommits.includes(commit))throw fault('RUNTIME_RECOVERY_RELEASE_UNSAFE');
 return{commit,digest:value.digest,signatureVerified:true,rootProtected:true,securityEpoch:value.securityEpoch,compatibilityId:value.compatibilityId,admissionProtocol:1};
}
function healthy(value,commit,now,notBefore=0){const at=Date.parse(value?.observedAt);return value?.version===1&&['ready','model_loading'].includes(value.phase)&&value.stale!==true&&value.sourceCommit===commit&&value.sourceReady===true&&value.runtimeReady===true&&Number.isFinite(at)&&at>=notBefore&&at<=now+1000&&now-at<=5000;}
function empty(policy){return{version:1,policyHash:digest(policy),lastGood:null,active:null,history:[],lastAt:0};}
function validateState(value,policy){
 if(!value||value.version!==1||value.policyHash!==digest(policy)||!Array.isArray(value.history)||value.history.length>128||!Number.isSafeInteger(value.lastAt)||value.lastAt<0)throw fault('RUNTIME_RECOVERY_STATE_UNTRUSTED');
 if(value.lastGood)verifiedRelease(value.lastGood,value.lastGood.commit,policy);
 const phases=new Set(['monitoring','healthy','rollback_intent','rollback_switched','rolled_back','recovery_required']);
 for(const row of value.history){if(!UUID.test(row?.id||'')||!SHA.test(row.candidate||'')||!Number.isSafeInteger(row.startedAt)||row.startedAt<0||row.deadline!==row.startedAt+TIMEOUT||!phases.has(row.phase)||typeof row.acceptedWork!=='boolean'||row.rollbackAt!==null&&(!Number.isSafeInteger(row.rollbackAt)||row.rollbackAt<row.startedAt))throw fault('RUNTIME_RECOVERY_STATE_UNTRUSTED');verifiedRelease(row.record,row.candidate,policy);if(row.previous)verifiedRelease(row.previous,row.previous.commit,policy);}
 if(value.active!==null&&!value.history.some(row=>row.id===value.active))throw fault('RUNTIME_RECOVERY_STATE_UNTRUSTED');return value;
}
class RuntimeRecovery {
 constructor({policy,store,hooks,exclusive,now=Date.now}){
  this.store=store;this.hooks=hooks;this.now=now;this.exclusive=exclusive;
  try{this.policy=policyOf(policy);}catch{this.disabledReason='RUNTIME_RECOVERY_POLICY_REQUIRED';}
  if(typeof store?.read!=='function'||typeof store?.write!=='function'||typeof exclusive!=='function'||['verifyRelease','currentCommit','fence','switchRelease','restart'].some(key=>typeof hooks?.[key]!=='function'))this.disabledReason='RUNTIME_RECOVERY_HOOKS_REQUIRED';
 }
 async locked(fn){if(this.disabledReason)return{version:1,phase:'recovery_required',sourceReady:null,runtimeReady:false,recoveryRequired:true,reasonCode:this.disabledReason};return this.exclusive(async()=>{const state=validateState(await this.store.read()??empty(this.policy),this.policy),now=this.now();if(!Number.isSafeInteger(now)||now<state.lastAt)throw fault('RUNTIME_RECOVERY_CLOCK_UNCERTAIN');state.lastAt=now;return fn(state,now);});}
 async call(name,args={},timeoutMs=1500){const abort=new AbortController();let timer;try{return await Promise.race([Promise.resolve().then(()=>this.hooks[name]({...args,signal:abort.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(fault('RUNTIME_RECOVERY_HOOK_TIMEOUT'));},timeoutMs);})]);}finally{clearTimeout(timer);}}
 async save(state){await this.store.write(structuredClone(state));}
 row(state,id){const row=state.history.find(item=>item.id===id);if(!row||state.active!==id)throw fault('RUNTIME_RECOVERY_ATTEMPT_MISMATCH');return row;}
 statusOf(state){const row=state.history.find(item=>item.id===state.active);return{version:1,phase:row?.phase||'uninitialized',sourceReady:null,runtimeReady:null,functionalHealthConfirmed:row?['healthy','rolled_back'].includes(row.phase):false,recoveryRequired:row?.phase==='recovery_required',attemptId:row?.id||null,candidateCommit:row?.candidate||null,servingCommit:row?.servingCommit||null,reasonCode:row?.reasonCode||null,acceptedWork:row?.acceptedWork??false,deadline:row?.deadline||null,lastGoodCommit:state.lastGood?.commit||null};}
 async hold(state,row,code){row.phase='recovery_required';row.reasonCode=code;await this.save(state);return this.statusOf(state);}
 async release(commit){return verifiedRelease(await this.call('verifyRelease',{commit}),commit,this.policy);}
 async fence(row,commit,now){
  const proof=await this.call('fence',{attemptId:row.id,commit});const at=proof?.observedAt;
  if(proof?.attemptId!==row.id||proof.commit!==commit||proof.admissionClosed!==true||proof.acceptedWork!==0||proof.activeRequests!==0||proof.activeJobs!==0||!HASH.test(proof.fenceToken||'')||!Number.isSafeInteger(at)||at<now-5000||at>this.now()+1000)throw fault('RUNTIME_RECOVERY_WORK_NOT_EXCLUDED');return proof;
 }
 // Explicit root bootstrap enrollment only after functional Native readiness.
 // A previous signed commit alone never bootstraps a last-good trust record.
 async adoptHealthy(commit,observation){return this.locked(async(state,now)=>{
  if(!healthy(observation,commit,now)||await this.call('currentCommit')!==commit)throw fault('RUNTIME_RECOVERY_HEALTH_UNPROVEN');const record=await this.release(commit),existing=state.history.find(row=>row.id===state.active);
  if(existing){if(!['healthy','rolled_back'].includes(existing.phase)||existing.servingCommit!==commit||!state.lastGood||digest(record)!==digest(state.lastGood))throw fault('RUNTIME_RECOVERY_ATTEMPT_EXISTS');await this.save(state);return this.statusOf(state);}
  if(state.history.length)throw fault('RUNTIME_RECOVERY_STATE_UNTRUSTED');
  const row={id:crypto.randomUUID(),candidate:commit,previous:null,record,startedAt:now,deadline:now+TIMEOUT,phase:'healthy',acceptedWork:false,rollbackAt:null,servingCommit:commit,reasonCode:'SAFE_BASELINE_READY'};state.history.push(row);state.active=row.id;
  try{await this.fence(row,commit,now);}catch{return this.hold(state,row,'RUNTIME_RECOVERY_WORK_NOT_EXCLUDED');}state.lastGood=record;await this.save(state);return this.statusOf(state);
 });}
 // Called before the startup gate activates candidate. Root must keep user
 // admission closed from this fence through source switch and health polling.
 async begin(candidate){return this.locked(async(state,now)=>{
  if(!SHA.test(candidate||''))throw fault('RUNTIME_RECOVERY_RELEASE_UNSAFE');const existing=state.history.find(row=>row.id===state.active);
  if(existing&&['monitoring','rollback_intent','rollback_switched','recovery_required'].includes(existing.phase)){if(existing.candidate!==candidate)throw fault('RUNTIME_RECOVERY_PENDING');return this.statusOf(state);}
  if(state.history.length>=128||state.history.some(row=>row.candidate===candidate))throw fault('RUNTIME_RECOVERY_ATTEMPT_LIMIT');
  const record=await this.release(candidate),previous=state.lastGood;if(!previous||previous.commit===candidate)throw fault('RUNTIME_RECOVERY_LAST_GOOD_REQUIRED');const checked=await this.release(previous.commit);if(digest(checked)!==digest(previous))throw fault('RUNTIME_RECOVERY_LAST_GOOD_CHANGED');
  if(await this.call('currentCommit')!==previous.commit)throw fault('RUNTIME_RECOVERY_POINTER_MISMATCH');
  const row={id:crypto.randomUUID(),candidate,previous,record,startedAt:now,deadline:now+TIMEOUT,phase:'monitoring',acceptedWork:false,rollbackAt:null,servingCommit:null,reasonCode:'NATIVE_RUNTIME_STARTING'};state.history.push(row);state.active=row.id;await this.save(state);
  try{await this.fence(row,previous.commit,now);}catch{return this.hold(state,row,'RUNTIME_RECOVERY_WORK_NOT_EXCLUDED');}return this.statusOf(state);
 });}
 async observe(id,observation){return this.locked(async(state,now)=>{
  const row=this.row(state,id);if(row.phase!=='monitoring')return this.statusOf(state);
  if(healthy(observation,row.candidate,now,row.startedAt)){
   if(await this.call('currentCommit')!==row.candidate)return this.hold(state,row,'RUNTIME_RECOVERY_POINTER_MISMATCH');
   const checked=await this.release(row.candidate);if(digest(checked)!==digest(row.record))return this.hold(state,row,'RUNTIME_RECOVERY_RELEASE_CHANGED');row.phase='healthy';row.servingCommit=row.candidate;row.reasonCode='NATIVE_RUNTIME_READY';state.lastGood=checked;await this.save(state);return this.statusOf(state);
  }
  if(now<row.deadline){await this.save(state);return this.statusOf(state);}
  if(row.acceptedWork)return this.hold(state,row,'RUNTIME_RECOVERY_USER_WORK_ACCEPTED');
  if(state.history.filter(item=>item.rollbackAt!==null&&now-item.rollbackAt<WINDOW).length>=this.policy.maxPerDay)return this.hold(state,row,'RUNTIME_RECOVERY_ATTEMPT_LIMIT');
  let proof;
  try{
   if(await this.call('currentCommit')!==row.candidate)throw fault('RUNTIME_RECOVERY_POINTER_MISMATCH');
   if(digest(await this.release(row.candidate))!==digest(row.record)||digest(await this.release(row.previous.commit))!==digest(row.previous))throw fault('RUNTIME_RECOVERY_RELEASE_CHANGED');proof=await this.fence(row,row.candidate,now);
  }catch{return this.hold(state,row,'RUNTIME_RECOVERY_PRECONDITION_UNPROVEN');}
  // Persist the consumed attempt BEFORE any pointer or process side effect.
  row.phase='rollback_intent';row.rollbackAt=now;row.reasonCode='NATIVE_RUNTIME_DEADLINE';await this.save(state);
  const intent={attemptId:row.id,from:row.candidate,to:row.previous.commit,fromDigest:row.record.digest,toDigest:row.previous.digest,fenceToken:proof.fenceToken};
  try{
   await this.call('switchRelease',intent,10000);
   if(await this.call('currentCommit')!==row.previous.commit)throw fault('RUNTIME_RECOVERY_POINTER_MISMATCH');
   row.phase='rollback_switched';row.servingCommit=row.previous.commit;await this.save(state);
   await this.call('restart',intent,10000);
   // A returned restart command is NOT functional health. Admission stays closed.
   row.reasonCode='ROLLED_BACK_RUNTIME_STARTING';await this.save(state);return this.statusOf(state);
  }catch{return this.hold(state,row,'RUNTIME_RECOVERY_OUTCOME_UNCERTAIN');}
 });}
 // A cold launcher may prove that the existing fallback can be started without
 // changing the pointer or consuming another attempt. The caller owns FD9 and
 // the process boundary. Reconciliation still requires fresh functional health.
 async fallbackForStartup(admission){return this.locked(async(state,now)=>{
  const row=state.history.find(item=>item.id===state.active),previous=row?.previous;
  if(!rollbackPending(row?.phase)||row.rollbackAt===null||row.rollbackAt>now||row.acceptedWork||
     !previous||!state.lastGood||previous.commit===row.candidate||digest(previous)!==digest(state.lastGood))
   throw fault('RUNTIME_RECOVERY_FALLBACK_UNPROVEN');
  if(admission?.version!==1||admission.open!==false||admission.epoch!==row.id||admission.acceptedWork!==0||
     ![row.candidate,previous.commit].includes(admission.sourceCommit)||!HASH.test(admission.fenceToken||''))
   throw fault('RUNTIME_RECOVERY_FALLBACK_FENCE_UNPROVEN');
  if(await this.call('currentCommit')!==previous.commit)throw fault('RUNTIME_RECOVERY_POINTER_MISMATCH');
  const checked=await this.release(previous.commit);
  if(digest(checked)!==digest(previous))throw fault('RUNTIME_RECOVERY_LAST_GOOD_CHANGED');
  return checked;
 });}

 // Only observation, never a repeated switch/restart after a controller crash.
 async reconcile(id,observation){return this.locked(async(state,now)=>{
  const row=this.row(state,id);if(!rollbackPending(row.phase)||row.rollbackAt===null)return this.statusOf(state);
  if(row.acceptedWork)return this.hold(state,row,'RUNTIME_RECOVERY_USER_WORK_ACCEPTED');
  try{if(await this.call('currentCommit')!==row.previous.commit||!healthy(observation,row.previous.commit,now,row.rollbackAt)||digest(await this.release(row.previous.commit))!==digest(row.previous))return this.hold(state,row,'RUNTIME_RECOVERY_OUTCOME_UNCERTAIN');await this.fence(row,row.previous.commit,now);}catch{return this.hold(state,row,'RUNTIME_RECOVERY_OUTCOME_UNCERTAIN');}
  row.phase='rolled_back';row.servingCommit=row.previous.commit;row.reasonCode='ROLLED_BACK_RUNTIME_READY';await this.save(state);return this.statusOf(state);
 });}
 // Every user mutation, queued/background task, API and socket enqueue must
 // pass here BEFORE dispatch under the same root admission fence protocol.
 async admitWork(id,commit){return this.locked(async(state)=>{
  const row=this.row(state,id);if(!['healthy','rolled_back'].includes(row.phase)||row.servingCommit!==commit||await this.call('currentCommit')!==commit)throw fault('RUNTIME_RECOVERY_ADMISSION_CLOSED');row.acceptedWork=true;await this.save(state);return{admitted:true,attemptId:id,commit};
 });}
 async status(){return this.locked(async state=>this.statusOf(state));}
}
function createRuntimeRecovery({root='/data/harness',policy,hooks,lockModule=new URL('../workspace/process-lock.mjs',require('node:url').pathToFileURL(__filename)).href}){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw fault('RUNTIME_RECOVERY_ROOT_REQUIRED');
 const runtime=require('./runtime-paths.cjs'),directory=runtime.control(root).privateState;
  return new RuntimeRecovery({policy,hooks,store:{read:()=>runtime.readPrivate(root,'runtime-recovery.json'),write:value=>runtime.writePrivate(root,'runtime-recovery.json',value)},exclusive:async action=>{const{acquireProcessLock}=await import(lockModule);const lock=await acquireProcessLock(path.join(directory,'runtime-recovery.lock'),{timeoutMs:2000});try{return await action();}finally{await lock.release();}}});
}
module.exports={RuntimeRecovery,createRuntimeRecovery,policyOf,verifiedRelease,healthy,rollbackPending};
