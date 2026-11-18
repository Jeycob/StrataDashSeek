// Derived private controller. No CLI, auth, timer or effects until construction.
import {randomUUID} from 'node:crypto';
import {validateB01Primary,originalPrimaryDeadline,serviceCommit} from './policy.mjs';
import {requireB01PreviousRuns} from './prior.mjs';
const fail=code=>Object.assign(Error(code),{code});
const need=(ok,code)=>{if(!ok)throw fail(code);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export function createB01Supervisor({slot,record,previousRuns,prepare,emit},trusted={}){
 need(slot?.executionEnabled===true&&uuid(slot.authorizationReference),'DISABLED_B01_ROOT_BINDING_REQUIRED');
 const first=slot.target,sourceCommit=serviceCommit,{pairId,runId,attemptId}=record,orderPosition=record.comparison.orderPosition,settlementMs=120000,preparationMs=30000;
 validateB01Primary(record,first);
 const priorHandoff={sourceCommit,runtimeCommit:sourceCommit,orderPosition:record.comparison.orderPosition,previousRuns};
 requireB01PreviousRuns({record,target:first,handoff:priorHandoff});
const fixedCollector={version:1,scenario:'B01',variant:record.variant,pairId,runId,attemptId,sessionId:first.sessionId,workspaceId:first.workspaceId,projectId:first.projectId,sourceCommit,runtimeCommit:sourceCommit,manifestSha256:'42fd252df7390ea830b9225b08e0d3f48b49b5358b94dfc7dee4f262d02e832f',promptSha256:record.identity.promptSha256,acceptanceVersion:'paired-20261116 v1 + product-qa supplement v1',requestedProvider:first.modelSelection.provider,requestedModel:first.modelSelection.model};
function safeCollector(actual,handoffId){
 const dynamic={requestId:actual?.requestId,baselineSeq:actual?.baselineSeq,rootHandoff:handoffId},expected={...fixedCollector,...dynamic};
 need(uuid(dynamic.requestId)&&Number.isSafeInteger(dynamic.baselineSeq)&&dynamic.baselineSeq>=0&&actual?.rootHandoff===handoffId&&Object.keys(actual??{}).length===Object.keys(expected).length&&Object.entries(fixedCollector).every(([k,v])=>actual[k]===v),'COLLECTOR_IDENTITY_UNCONFIRMED');
 return expected; // construct whitelist; never spread the supplied object
}
 need(typeof prepare==='function'&&typeof emit==='function'&&Number.isSafeInteger(settlementMs)&&settlementMs>0&&settlementMs<=120000&&Number.isSafeInteger(preparationMs)&&preparationMs>0&&preparationMs<=30000,'ACTUAL_SUPERVISOR_BINDINGS_REQUIRED');
 const now=trusted.now??Date.now,timer=trusted.setTimeout??setTimeout,clear=trusted.clearTimeout??clearTimeout;
 const handoffId='n06-startup-20261117-'+(trusted.randomUUID??randomUUID)();
 need(/^n06-startup-20261117-[a-f0-9-]{36}$/.test(handoffId),'SAFE_HANDOFF_ID_REQUIRED');
 const controller=new AbortController(),cleanupController=new AbortController();
 let phase='IDLE',started=false,driver,intent,runActive=false,stopRequested=false,stopAt,cleanupDeadline,acceptUsed=false,readyAt,reason='NONE',finalStatus=null;
 let primaryTimer,preparationTimer,preparationDeadline,cleanupTimer,cleanupTask,terminal=false,resolveDone;
 const done=new Promise(resolve=>{resolveDone=resolve;});
 function snapshot(event){
  const out={version:1,event,phase,observedAtUtc:new Date(now()).toISOString(),sourceCommit,scenario:'B01',variant:record.variant,sessionId:first.sessionId,workspaceId:first.workspaceId,projectId:first.projectId,requestedModel:{provider:first.modelSelection.provider,model:first.modelSelection.model,reasoningEffort:first.modelSelection.reasoningEffort},started,acceptUsed,reason};
  if(intent){out.collectorIdentity=structuredClone(intent.collectorIdentity);out.primaryStartedAt=new Date(intent.primaryStartedAt).toISOString();out.primaryDeadlineAt=new Date(intent.primaryDeadline).toISOString();}
  if(cleanupDeadline!==undefined)out.cleanupDeadlineAt=new Date(cleanupDeadline).toISOString();
  if(readyAt!==undefined)out.implementationReadyAt=new Date(readyAt).toISOString();
  if(finalStatus)out.resultStatus=finalStatus;
  // No record/report/error/tool text/URL/headers may enter this object.
  return out;
 }
 const publish=event=>{const value=snapshot(event);try{emit(value);}catch{stop('OUTPUT_CHANNEL_UNCONFIRMED');}return value;};
 const stopDriver=()=>{try{driver?.stop({deadline:cleanupDeadline,signal:cleanupController.signal});}catch{}};
 function finishPhase(next,why){if(terminal)return;terminal=true;phase=next;reason=why;clear(primaryTimer);clear(preparationTimer);clear(cleanupTimer);publish('terminal');resolveDone(snapshot('terminal'));}
 function settledFence(value){
  return !!intent&&value?.status==='SETTLED_VISIBLE'&&value.settled===true&&value.visible===true&&value.archiveState==='visible'&&value.sourceCommit===sourceCommit&&value.requestId===intent.collectorIdentity.requestId&&Number.isSafeInteger(value.deadline)&&['sessionId','workspaceId','projectId'].every(k=>value.target?.[k]===first[k])&&/^[a-f0-9]{64}$/.test(value.tupleSha256??'')&&value.persistence?.durable===true&&uuid(value.persistence.checkpointId);
 }
 function matchingRecord(record){return !!intent&&record?.pairId===pairId&&record.runId===runId&&record.attemptId===attemptId&&record?.operator?.requestId===intent.collectorIdentity.requestId&&record.operator.baselineSeq===intent.collectorIdentity.baselineSeq&&record.operator.rootHandoff===handoffId&&['sessionId','workspaceId','projectId'].every(k=>record.identity?.[k]===first[k])&&record.identity.sourceCommit===sourceCommit&&record.identity.runtimeCommit===sourceCommit;}
 async function cleanup(){
  if(terminal||runActive||cleanupTask)return cleanupTask;
  if(!driver||!intent){finishPhase('HOLD','NO_CONFIRMED_INTENT_OR_DRIVER');return;}
  cleanupTask=(async()=>{
   try{const fence=await driver.cleanup({deadline:cleanupDeadline,signal:cleanupController.signal});
    if(terminal)return;
    if(now()<cleanupDeadline&&settledFence(fence)&&fence.deadline<=cleanupDeadline)finishPhase('STOPPED','ACTUAL_FENCE_SETTLED');
    else finishPhase('HOLD','ACTUAL_FENCE_UNCONFIRMED');
   }catch{if(!terminal)finishPhase('HOLD','CLEANUP_UNCONFIRMED');}
  })();return cleanupTask;
 }
 function stop(why='ROOT_STOP'){
  if(terminal)return snapshot('status');
  if(!stopRequested){
   stopRequested=true;stopAt=why==='ORIGINAL_PRIMARY_DEADLINE'&&intent?intent.primaryDeadline:now();reason=why;
   cleanupDeadline=Math.min(intent?intent.primaryDeadline+settlementMs:Infinity,stopAt+settlementMs);
   phase='STOPPING';clear(primaryTimer);clear(preparationTimer);stopDriver();controller.abort();
   cleanupTimer=timer(()=>{cleanupController.abort();stopDriver();finishPhase('HOLD','ORIGINAL_CLEANUP_DEADLINE');},Math.max(0,cleanupDeadline-now()));
   publish('stop-requested');
  }
  if(!started){finishPhase('STOPPED','STOP_BEFORE_START');return snapshot('status');}
  if(!runActive&&driver)void cleanup();
  return snapshot('status');
 }
 function onIntent(value){
  need(!intent,'DUPLICATE_INTENT');
  const collectorIdentity=safeCollector(value?.collectorIdentity,handoffId);
  need(Number.isSafeInteger(value.primaryStartedAt)&&Number.isSafeInteger(value.primaryDeadline)&&value.primaryDeadline===originalPrimaryDeadline(record,value.primaryStartedAt)&&value.primaryStartedAt<=now()&&now()<value.primaryDeadline,'ORIGINAL_INTENT_CLOCK_REQUIRED');
  intent={collectorIdentity,primaryStartedAt:value.primaryStartedAt,primaryDeadline:value.primaryDeadline};clear(preparationTimer);
  if(!stopRequested&&now()>=preparationDeadline)stop('PREPARATION_DEADLINE');
  if(!stopRequested)primaryTimer=timer(()=>stop('ORIGINAL_PRIMARY_DEADLINE'),Math.max(0,intent.primaryDeadline-now()));
  publish('intent');
  if(stopRequested){stopDriver();throw fail('STOP_BEFORE_PROMPT');}
 }
 function start(){
  if(started||stopRequested||terminal){publish('start-rejected');return;}
  started=true;phase='PREPARING';publish('starting');
  preparationDeadline=now()+preparationMs;preparationTimer=timer(()=>stop('PREPARATION_DEADLINE'),preparationMs);
  void(async()=>{
   try{
    driver=await prepare({handoff:{liveAuthorized:true,rootOperator:true,id:handoffId,sourceCommit,runtimeCommit:sourceCommit,orderPosition,previousRuns,settlementObservationMs:settlementMs},signal:controller.signal,onIntent});
    need(['run','finish','cleanup','stop'].every(k=>typeof driver?.[k]==='function'),'ACTUAL_DRIVER_REQUIRED');
    if(!stopRequested&&now()>=preparationDeadline)stop('PREPARATION_DEADLINE');
    if(stopRequested||terminal){stopDriver();if(!terminal)await cleanup();return;}
    phase='RUNNING';runActive=true;publish('running');
    let record;
    try{record=await driver.run();}finally{runActive=false;}
    if(terminal)return;
    if(stopRequested){const fence=record?.rootFinalization;if(now()<cleanupDeadline&&settledFence(fence)&&fence.deadline<=cleanupDeadline)finishPhase('STOPPED','ACTUAL_FENCE_SETTLED');else await cleanup();return;}
    const at=Date.parse(record?.timestampsUtc?.implementationReadyAt);
    if(matchingRecord(record)&&record?.blockingPhase==='independent_acceptance'&&record?.nativeObservation?.promptAdmission==='accepted'&&record.nativeObservation.terminal==='completed'&&record.nativeObservation.settled===true&&Number.isFinite(at)&&at>=intent.primaryStartedAt&&at<=now()&&now()<intent.primaryDeadline){
     readyAt=at;phase='AWAITING_QA';publish('implementation-ready'); // ORIGINAL timer intentionally remains armed
    }else stop('PRIMARY_UNCONFIRMED');
   }catch{runActive=false;if(!terminal){stop('PRIMARY_UNCONFIRMED');if(driver)await cleanup();else finishPhase('HOLD','PREPARATION_UNCONFIRMED');}}
  })().catch(()=>finishPhase('HOLD','SUPERVISOR_UNCONFIRMED'));
 }
 function accept(report){
  if(terminal||acceptUsed||stopRequested||phase!=='AWAITING_QA'||!intent){publish('accept-rejected');return;}
  if(now()>=intent.primaryDeadline){publish('accept-rejected');stop('ORIGINAL_PRIMARY_DEADLINE');return;}
  acceptUsed=true;phase='ACCEPTING';publish('accepting');
  void(async()=>{
   try{const record=await driver.finish(report);if(terminal)return;
    const status=record?.status;
    if(!stopRequested&&matchingRecord(record)&&now()<intent.primaryDeadline&&['PASS','FAIL','BLOCKED'].includes(status)&&record.operator?.finalized===true&&settledFence(record.rootFinalization)&&record.rootFinalization.deadline<=intent.primaryDeadline&&(status!=='PASS'||record.quality?.accepted===true)){
     finalStatus=status;finishPhase('COMPLETED','ACTUAL_ACCEPTANCE_AND_FENCE');
    }else stop('ACCEPTANCE_UNCONFIRMED');
   }catch{if(!terminal)stop('ACCEPTANCE_UNCONFIRMED');}
  })().catch(()=>finishPhase('HOLD','SUPERVISOR_UNCONFIRMED'));
 }
 return Object.freeze({
  handle(command){
   const keys=Object.keys(command??{}).sort().join(',');
   if(!command||typeof command!=='object'||Array.isArray(command)||!['start','status','accept','stop'].includes(command.op)||keys!==(command.op==='accept'?'op,report':'op'))return publish('command-rejected');
   if(command.op==='start')start();else if(command.op==='accept')accept(command.report);else if(command.op==='stop')stop('ROOT_STOP');else publish('status');
   return snapshot('status');
  },
  end(){stop('CONTROL_CHANNEL_CLOSED');return done;},
  channelFailed(){stop('CONTROL_CHANNEL_UNCONFIRMED');},
  wait:()=>done,
  status:()=>snapshot('status'),
 });
}
