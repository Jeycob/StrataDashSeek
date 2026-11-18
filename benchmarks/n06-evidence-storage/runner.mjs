// SOURCE ONLY. No CLI, network client, credentials, process execution, or import
// of QA runners. Root supplies its bounded own-session transport and callbacks.
import {randomUUID,createHash} from 'node:crypto';
import {campaignOrder,b01Criteria,matchesPrimaryLimits,originalPrimaryDeadline} from '../b01-canonical-source/policy.mjs';
import {requireB01PreviousRuns} from '../b01-canonical-source/prior.mjs';
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
export const order=campaignOrder;
export const criteria=Object.freeze({B03:Array.from({length:12},(_,i)=>'B03-'+String(i+1).padStart(2,'0')),B10:['D1','D2','D3','S1','S2','S3','S4','C1','C2','C3','C4','C5','R1','R2','R3','R4','U1','U2','U3'].map(id=>'B10-'+id),B01:b01Criteria});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const contextItem=item=>item?.placement==='context'&&!Object.hasOwn(item,'rpcId');
function checkState(state){need(state&&Number.isSafeInteger(state.cursor)&&state.cursor>=0&&typeof state.running==='boolean'&&Array.isArray(state.queue)&&Array.isArray(state.pendingInput),'OWN_STATE_UNKNOWN');}

// Native's actual backwards-history contract: pinned inclusive throughSeq,
// exclusive beforeSeq, chronological event records. Never read another session.
export async function readOwnObservation({rpc,sessionId,afterSeq,signal,deadline,maxPages=256}){
 need(Number.isSafeInteger(afterSeq)&&afterSeq>=-1,'OWN_CUT_INVALID');
 const state=await rpc('session/state',{sessionId},{signal,deadline});checkState(state);
 need(state.cursor>=afterSeq,'OWN_CURSOR_REGRESSED');
 if(state.cursor===afterSeq)return{state,events:[],historyComplete:true};
 const events=[];let beforeSeq,expectedHigh=state.cursor;
 for(let pageIndex=0;pageIndex<maxPages;pageIndex++){
  const page=await rpc('session/page',{address:{kind:'session',sessionId},throughSeq:state.cursor,...(beforeSeq===undefined?{}:{beforeSeq}),maxMessages:64},{signal,deadline});
  need(page&&Array.isArray(page.records)&&typeof page.hasMore==='boolean','OWN_PAGE_UNKNOWN');
  need(page.records.length>0,'OWN_HISTORY_INCOMPLETE');
  let previous;
  for(const row of page.records){
   need(row.type==='event'&&Number.isSafeInteger(row.event?.seq),'OWN_HISTORY_INCOMPLETE');const event=row.event;
   need(event.seq>=0&&event.seq<=state.cursor&&(beforeSeq===undefined||event.seq<beforeSeq),'OWN_PAGE_OUT_OF_RANGE');
   need(previous===undefined||event.seq===previous+1,'OWN_HISTORY_INCOMPLETE');previous=event.seq;
  }
  need(previous===expectedHigh,'OWN_HISTORY_INCOMPLETE');
  const minimum=page.records[0].event.seq;
  need(!page.hasMore||minimum>0,'OWN_PAGE_INCONSISTENT');
  events.unshift(...page.records.map(row=>row.event).filter(event=>event.seq>afterSeq));
  if(minimum<=afterSeq+1){
   need(events.length===state.cursor-afterSeq&&events[0].seq===afterSeq+1&&events.at(-1).seq===state.cursor,'OWN_HISTORY_INCOMPLETE');
   return{state,events,historyComplete:true};
  }
  need(page.hasMore,'OWN_HISTORY_INCOMPLETE');beforeSeq=minimum;expectedHigh=minimum-1;
 }
 throw Object.assign(Error('OWN_PAGE_CAP'),{code:'OWN_PAGE_CAP'});
}

export function nativeEvidence(events){
 const terminal=events.filter(row=>row.type==='turn/end').at(-1),start=events.filter(row=>row.type==='turn/start').at(-1);
 return{terminal:terminal&&(!start||terminal.seq>start.seq)?terminal.data?.reason?.kind??null:null,
  steps:events.filter(row=>row.type==='step/start').length,
  requestHeaders:events.filter(row=>row.type==='request/header').map(row=>({seq:row.seq,config:row.data?.header?.config??null})),
  usage:events.filter(row=>['assistant/message','assistant/attempt'].includes(row.type)&&row.data?.usage).map(row=>({seq:row.seq,type:row.type,usage:row.data.usage})),
  usageComplete:false,auxiliaryUsage:null,note:'Raw own-event usage is evidence, not a complete billed/auxiliary ledger; do not silently total missing usage as zero.'};
}

export function acceptancePlan(record,refs){
 need(criteria[record.scenario],'SCENARIO_UNSUPPORTED');
 return{scenario:record.scenario,acceptanceVersion:'paired-20261116 v1 + product-qa supplement v1',
  api:['B10','B01'].includes(record.scenario)?{module:refs.apiAcceptance,export:'runAcceptance',args:[record.scenario,'ACTUAL_OWN_USER_PREVIEW_URL']}:null,
  browser:{module:refs.browserAcceptance,export:'runBrowser',scenario:record.scenario,viewports:[{width:1440,height:900},{width:390,height:844}],engines:'Existing QA handoff engine list; exact version and unrun branches must be recorded'},
  manualCriteria:criteria[record.scenario],manualSource:record.scenario==='B01'?refs.acceptanceCards:refs.productQA,supplement:record.scenario==='B03'?refs.supplementProtocol:null,
  restart:record.scenario==='B10'?{required:true,criterion:'B10-R3',instruction:'Root-supported restart of only this own app process; before/after saved note and version, actual process restart evidence, same user preview'}:record.scenario==='B01'?{required:true,criterion:'B01-06',commonCriterion:'B01-C05',instruction:'Root-supported restart of only this own app process; saved task id/title/due/tags/done unchanged before/after, actual process restart evidence, same user preview'}:null,
  warning:'Frozen automatic runners are only a subset. QA collects all criterion evidence; this module does not implement UI or replace its pending tool.'};
}

export function assessAcceptance(scenario,report){
 const expected=criteria[scenario];need(expected&&report&&Array.isArray(report.checks),'QA_REPORT_REQUIRED');
 need(report.checks.length===expected.length&&new Set(report.checks.map(row=>row.id)).size===expected.length&&report.checks.every(row=>expected.includes(row.id)),'QA_CRITERIA_INCOMPLETE');
 need(report.checks.every(row=>['PASS','FAIL','BLOCKED','NOT RUN'].includes(row.status)),'QA_STATUS_INVALID');
 need(report.checks.every(row=>row.status!=='PASS'||Array.isArray(row.evidence)&&row.evidence.length>0),'QA_PASS_WITHOUT_EVIDENCE');
 const status=report.checks.some(row=>row.status==='FAIL')?'FAIL':report.checks.every(row=>row.status==='PASS')?'PASS':'BLOCKED';
 if(status==='PASS'){
  let url;try{url=new URL(report.previewUrl);}catch{}
  need(url&&url.protocol==='https:'&&!url.username&&!url.password&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname),'USER_PREVIEW_REQUIRED');
  need(report.previewEvidence&&report.artifactEvidence&&report.reopenInstructions,'QA_DELIVERY_EVIDENCE_REQUIRED');
 }
 return{status,checks:structuredClone(report.checks),previewUrl:report.previewUrl??null,previewEvidence:report.previewEvidence??null,artifactEvidence:report.artifactEvidence??null,reopenInstructions:report.reopenInstructions??null};
}

// Uses only timers/AbortController; no network or live defaults.
export function realClock(){
 return{now:Date.now,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  bound(fn,deadline,outerSignal){return new Promise((resolve,reject)=>{
   const controller=new AbortController();let ended=false,timer;
   const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);outerSignal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
   const abort=()=>{controller.abort(outerSignal?.reason);finish(Object.assign(Error('USER_STOP'),{code:'USER_STOP'}));};
   const remaining=deadline-Date.now();if(remaining<=0){finish(Object.assign(Error('DEADLINE'),{code:'DEADLINE'}));return;}
   timer=setTimeout(()=>{controller.abort();finish(Object.assign(Error('DEADLINE'),{code:'DEADLINE'}));},remaining);
   if(outerSignal?.aborted){abort();return;}outerSignal?.addEventListener('abort',abort,{once:true});
   Promise.resolve().then(()=>fn({signal:controller.signal})).then(value=>finish(null,value),finish);
  });}};
}

// One PRIMARY attempt only. Root has already created/renamed its own ordinary
// session, assigned the correct workspace, copied the frozen fixture and made
// the per-session registered model selection. No repairs or session creation
// happen implicitly here. Actual QA collection stays with its existing tool.
export async function runPrimary({record,target,handoff,inputs,io,clock,signal}){
 need(record.status==='NOT RUN'&&record.attemptId&&matchesPrimaryLimits(record),'PRIMARY_NOT_PREPARED');
 need(handoff.liveAuthorized===true&&handoff.rootOperator===true&&handoff.id&&handoff.sourceCommit&&handoff.runtimeCommit,'ROOT_HANDOFF_REQUIRED');
 need(Array.isArray(handoff.previousRuns)&&handoff.previousRuns.every(row=>row.settled===true&&row.finalized===true)&&Number.isSafeInteger(handoff.settlementObservationMs)&&handoff.settlementObservationMs>0,'PRIOR_SETTLEMENT_OR_STOP_WINDOW_REQUIRED');
 need(order[handoff.orderPosition-1]===record.scenario+' '+record.variant&&handoff.previousRuns.length===handoff.orderPosition-1,'RUN_ORDER_REQUIRED');
 if(record.scenario==='B01')requireB01PreviousRuns({record,target,handoff});
 need(target.owned===true&&target.sessionId&&target.workspaceId&&target.projectId&&target.preparedFixtureEvidence&&target.modelSelection?.provider&&target.modelSelection?.model,'OWN_TARGET_REQUIRED');
 for(const name of ['rpc','preflight','observeWork','stopOwnedWork','checkpoint'])need(typeof io[name]==='function','ROOT_ADAPTER_REQUIRED');
 need(clock&&['now','sleep','bound'].every(name=>typeof clock[name]==='function'),'BOUNDED_CLOCK_REQUIRED');
 const output=structuredClone(record),sessionId=target.sessionId,requestId=randomUUID(),iso=at=>new Date(at).toISOString();
 const invoke=(fn,deadline,outerSignal)=>clock.bound(fn,deadline,outerSignal);
 const rpc=(method,data,deadline,outerSignal)=>{const bounded=Math.min(deadline,clock.now()+4000);return invoke(options=>io.rpc(method,data,{...options,deadline:bounded}),bounded,outerSignal);};
 const observationRpcRetries={attempts:[],omitted:0};
 const observationRpc=async(method,data,{deadline,signal}={})=>{
  const end=Math.min(deadline,clock.now()+4000);
  try{return await rpc(method,data,end,signal);}catch(first){
   if(first.code!=='RPC_HTTP_STATUS'||first.httpStatus!==503||first.rpcMethod!==method||!['session/state','session/page'].includes(method))throw first;
   const retry={method,firstStatus:503,attemptCount:1,retryOutcome:'not_dispatched'};
   if(observationRpcRetries.attempts.length<64)observationRpcRetries.attempts.push(retry);else observationRpcRetries.omitted++;
   if(output.nativeObservation)output.nativeObservation.observationRpcRetries=observationRpcRetries;
   try{
    need(!signal?.aborted,'USER_STOP');need(clock.now()<end,'DEADLINE');
    await invoke(()=>clock.sleep(Math.min(100,end-clock.now())),end,signal);
    need(!signal?.aborted,'USER_STOP');need(clock.now()<end,'DEADLINE');
    retry.attemptCount=2;const value=await rpc(method,data,end,signal);retry.retryOutcome='succeeded';return value;
   }catch(error){retry.retryOutcome=retry.attemptCount===2?'failed':'not_dispatched';throw error;}
  }
 };
 const verified=await inputs.verify(record);need(verified?.unchanged===true&&Buffer.isBuffer(verified.prompt)&&sha(verified.prompt)===record.identity.promptSha256,'FROZEN_INPUTS_CHANGED');
 const ready=await invoke(options=>io.preflight({record,target,handoff,...options}),clock.now()+10000);
 need(ready?.quiet===true&&ready.mode==='host-compat'&&ready.sourceCommit===handoff.sourceCommit&&ready.runtimeCommit===handoff.runtimeCommit&&ready.workspaceId===target.workspaceId&&ready.fixtureEvidence===target.preparedFixtureEvidence,'PREFLIGHT_UNCONFIRMED');
 need(ready.preview?.supported===true&&ready.preview.evidence,'HOST_PREVIEW_UNCONFIRMED');
 if(['B10','B01'].includes(record.scenario))need(ready.restart?.supported===true&&ready.restart.evidence,'HOST_RESTART_UNCONFIRMED');
 need(JSON.stringify(ready.modelSelection)===JSON.stringify(target.modelSelection)&&ready.modelSelectionEvidence,'OWN_MODEL_SELECTION_UNCONFIRMED');
 const initial=await readOwnObservation({rpc:observationRpc,sessionId,afterSeq:-1,deadline:clock.now()+10000});
 need(initial.state.active===true&&!initial.state.running&&initial.state.pendingInput.length===0&&initial.state.queue.every(contextItem),'OWN_SESSION_NOT_IDLE');
 need(!initial.events.some(row=>['user/message','turn/start','assistant/message'].includes(row.type)),'OWN_SESSION_NOT_FRESH');
 const cut=initial.state.cursor,started=clock.now(),mainDeadline=originalPrimaryDeadline(record,started);
 Object.assign(output.identity,{sessionId,workspaceId:target.workspaceId,projectId:target.projectId,sessionUrl:target.sessionUrl??null,sourceCommit:handoff.sourceCommit,runtimeCommit:handoff.runtimeCommit,requestedModel:target.modelSelection});
 output.isTemplate=false;output.slotHandoffEvidence=handoff.id;output.timestampsUtc.runSubmittedAt=output.timestampsUtc.submittedAt=iso(started);
 output.operator={requestId,baselineSeq:cut,primaryDeadlineAt:iso(mainDeadline),rootHandoff:handoff.id,finalized:false};
 output.operator.persistence={lastDurableCheckpointId:null,unknownOutcome:false};
 output.nativeObservation={promptAdmission:'unknown',cancelAcknowledged:false,settled:false,events:[],usage:[],usageComplete:false};
 if(observationRpcRetries.attempts.length||observationRpcRetries.omitted)output.nativeObservation.observationRpcRetries=observationRpcRetries;
 output.missingDataReasons=[{scope:'token totals and cost',reason:'No complete auxiliary/billing ledger is attached; raw own-event usage is retained separately and unknown values are not zero.'},{scope:'active/queue/model/tool/compaction/validation interval totals',reason:'No complete interval ledger is attached; do not derive missing waits from wall time.'},{scope:'independent acceptance',reason:'Existing QA collection has not yet finalized all required criteria.'}];
 output.status='BLOCKED';output.statusReason='Attempt entered; no acceptance yet.';
 // A timed-out callback may still be running. Quarantine that writer and never
 // issue another write or infer durability from its late resolution. Root's
 // adapter must honor abort/deadline before committing and fence checkpoint IDs.
 async function checkpoint(phase,phaseDeadline,outerSignal){
  need(!output.operator.persistenceFailed,'EVIDENCE_WRITER_QUARANTINED');
  const checkpointId=randomUUID(),deadline=Math.min(phaseDeadline,clock.now()+4000);
  try{
   const snapshot=structuredClone(output);snapshot.operator.persistence.pendingCheckpointId=checkpointId;
   const receipt=await invoke(options=>io.checkpoint(snapshot,{...options,deadline,checkpointId,phase}),deadline,outerSignal);
   need(clock.now()<deadline,'EVIDENCE_DURABILITY_UNCONFIRMED');
   // Only ordinary observations may be explicitly skipped. This is not a
   // persistence receipt and must never advance the durable checkpoint chain.
   if(phase==='observation'&&receipt?.durable===false&&receipt.skipped===true&&receipt.checkpointId===checkpointId&&['unchanged','sample_interval','observation_budget'].includes(receipt.reason)&&Object.keys(receipt).every(k=>['checkpointId','durable','skipped','reason'].includes(k)))return;
   need(receipt?.durable===true&&receipt.checkpointId===checkpointId,'EVIDENCE_DURABILITY_UNCONFIRMED');
   output.operator.persistence.lastDurableCheckpointId=checkpointId;
  }catch(error){output.operator.persistenceFailed=true;output.operator.persistence.unknownOutcome=true;output.operator.persistence.failedCheckpointId=checkpointId;throw error;}
 }
 await checkpoint('intent',mainDeadline,signal); // confirmed durable intent BEFORE prompt
 let stopping=null,stopAt=null,cancelSent=false,secondCancelSent=false,workStopSent=false,removed=false,submitted=false,explicitRejected=false;
 const beginStop=reason=>{if(!stopping){stopping=reason;stopAt=clock.now();output.stopReason=reason;output.timestampsUtc.stopRequestedAt=iso(stopAt);output.timestampsUtc.finishedAt=iso(stopAt);if(reason==='main_deadline')output.timestampsUtc.limitReachedAt=iso(mainDeadline);}return stopAt+handoff.settlementObservationMs;};
 const cleanupDeadline=()=>stopAt+handoff.settlementObservationMs;
 async function stopOwn(){
  const deadline=cleanupDeadline();
  const stops=[];
  if(!cancelSent){cancelSent=true;stops.push((async()=>{try{const ack=await rpc('session/cancel',{sessionId},deadline);output.nativeObservation.cancelAcknowledged=ack?.accepted===true;}catch{output.nativeObservation.cancelUnconfirmed=true;}})());}
  if(!workStopSent){workStopSent=true;stops.push((async()=>{try{await invoke(options=>io.stopOwnedWork({sessionId,requestId,...options}),deadline);}catch{output.nativeObservation.workStopUnconfirmed=true;}})());}
  await Promise.all(stops);
 }
 try{
  if(signal?.aborted)beginStop('user_stop');
  else try{submitted=true;const ack=await rpc('session/prompt',{sessionId,requestId,mode:'queue',content:[{type:'text',text:verified.prompt.toString('utf8')}]},mainDeadline,signal);explicitRejected=ack?.accepted===false;output.nativeObservation.promptAdmission=ack?.accepted===true?'accepted':'unconfirmed';if(ack?.accepted!==true)beginStop('prompt_admission_unconfirmed');}
  catch{beginStop(signal?.aborted?'user_stop':clock.now()>=mainDeadline?'main_deadline':'prompt_admission_unconfirmed');}
  while(true){
   if(signal?.aborted)beginStop('user_stop');if(!stopping&&clock.now()>=mainDeadline)beginStop('main_deadline');
   if(stopping&&clock.now()>=cleanupDeadline())break;
   if(stopping)await stopOwn();
   const deadline=stopping?cleanupDeadline():mainDeadline;
   try{
    const observation=await readOwnObservation({rpc:observationRpc,sessionId,afterSeq:cut,deadline,signal:stopping?undefined:signal});
    const events=observation.events,evidence=nativeEvidence(events);Object.assign(output.nativeObservation,evidence,{events,historyComplete:true});
    if(output.timestampsUtc.firstOutputAt===null&&events.some(row=>['assistant/message','assistant/attempt'].includes(row.type)))output.timestampsUtc.firstOutputAt=iso(clock.now());
    // Keep every header for QA to distinguish primary and auxiliary inference;
    // an auxiliary model is not silently labelled as the primary route.
    if(stopping){
     for(const item of observation.state.queue.filter(item=>item.rpcId===requestId)){
      const ack=await rpc('session/updateQueue',{sessionId,itemId:item.id,action:{kind:'remove'}},cleanupDeadline());need(ack?.accepted===true,'OWN_QUEUE_REMOVAL_UNCONFIRMED');removed=true;
     }
     if(removed&&!secondCancelSent){secondCancelSent=true;await rpc('session/cancel',{sessionId},cleanupDeadline());await invoke(options=>io.stopOwnedWork({sessionId,requestId,...options}),cleanupDeadline());}
    }
    const work=await invoke(options=>io.observeWork({sessionId,requestId,events,...options}),Math.min(stopping?cleanupDeadline():mainDeadline,clock.now()+4000),stopping?undefined:signal);
    const neverEntered=(!submitted||explicitRejected||removed)&&!events.some(row=>row.type==='turn/start');
    if(!observation.state.running&&observation.state.queue.length===0&&observation.state.pendingInput.length===0&&(evidence.terminal||neverEntered)&&work?.settled===true&&work.evidence){
     output.nativeObservation.settled=true;output.settledEvidence={sessionCursor:observation.state.cursor,terminal:evidence.terminal??'cancelled-before-turn',work:work.evidence};output.timestampsUtc.settledAt=iso(clock.now());break;
    }
   }catch(error){output.nativeObservation.observationError=error.code??error.message;
    if(error.code==='RPC_HTTP_STATUS'&&['session/state','session/page'].includes(error.rpcMethod)&&!output.nativeObservation.observationErrorContext)output.nativeObservation.observationErrorContext={code:'RPC_HTTP_STATUS',rpcMethod:error.rpcMethod,httpStatus:Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599?error.httpStatus:null};
    beginStop(signal?.aborted?'user_stop':clock.now()>=mainDeadline?'main_deadline':'observation_unconfirmed');}
   if(!output.operator.persistenceFailed)try{await checkpoint('observation',stopping?cleanupDeadline():mainDeadline,stopping?undefined:signal);}catch{beginStop(signal?.aborted?'user_stop':clock.now()>=mainDeadline?'main_deadline':'evidence_write_failed');await stopOwn();}
   await clock.sleep(Math.min(500,Math.max(0,(stopping?cleanupDeadline():mainDeadline)-clock.now())));
  }
  if(!output.nativeObservation.settled){output.status='BLOCKED';output.statusReason='Actual own computation settlement unconfirmed; no next run or repair.';}
  else if(stopping){output.status=stopping==='main_deadline'?'FAIL':'BLOCKED';output.statusReason=stopping;output.operator.finalized=true;}
  else if(output.nativeObservation.promptAdmission!=='accepted'||output.nativeObservation.terminal!=='completed'){
   output.status='FAIL';output.statusReason='Prompt/Native turn did not complete normally.';output.timestampsUtc.finishedAt=iso(clock.now());output.operator.finalized=true;
  }else{
   output.timestampsUtc.implementationReadyAt=iso(clock.now());output.blockingPhase='independent_acceptance';
   output.statusReason='Awaiting existing independent QA collection within the ORIGINAL deadline; not a model or app PASS.';
  }
 }finally{
  if(output.operator.finalized)output.quality.accepted=false;
  if(!output.timestampsUtc.finishedAt&&stopping)output.timestampsUtc.finishedAt=iso(clock.now());
  output.timingMs.attemptDecisionElapsed=output.timestampsUtc.finishedAt?Date.parse(output.timestampsUtc.finishedAt)-started:null;
  output.timingMs.attemptElapsedThroughSettlement=output.timestampsUtc.settledAt?Date.parse(output.timestampsUtc.settledAt)-started:null;
  output.timingMs.runSpentWall=output.timingMs.attemptElapsedThroughSettlement;
  output.timingMs.postLimitSettlement=output.timestampsUtc.settledAt?Math.max(0,Date.parse(output.timestampsUtc.settledAt)-mainDeadline):null;
  output.counts.steps=output.nativeObservation.historyComplete?output.nativeObservation.steps:null;
  if(!output.operator.persistenceFailed)try{await checkpoint('final',stopping?cleanupDeadline():mainDeadline,stopping?undefined:signal);}catch{beginStop(signal?.aborted?'user_stop':clock.now()>=mainDeadline?'main_deadline':'evidence_write_failed');if(submitted)await stopOwn();}
  if(output.operator.persistenceFailed){output.status='BLOCKED';output.quality.accepted=false;output.operator.finalized=false;output.timingMs.attemptDecisionElapsed=output.timestampsUtc.finishedAt?Date.parse(output.timestampsUtc.finishedAt)-started:null;output.statusReason='Evidence persistence unconfirmed; writer quarantined. Retain own state and refer to Root.';}
 }
 return output;
}

// Collect the existing QA tool's report; this function runs no tests/UI or
// restart itself. All manual criteria, identity and actual QA-job settlement
// are required. The original primary deadline never resets at model completion.
// Root captures this envelope FROM THE ACTUAL TARGET before collection and
// carries it alongside the unchanged frozen QA results. Do not relabel results
// from another target/attempt after collection. This is correlation, not a
// signature or a substitute for the trusted collector's evidence provenance.
export function collectorIdentity(record){
 const identity={version:1,scenario:record.scenario,variant:record.variant,pairId:record.pairId,runId:record.runId,attemptId:record.attemptId,
  sessionId:record.identity?.sessionId,workspaceId:record.identity?.workspaceId,projectId:record.identity?.projectId,
  requestId:record.operator?.requestId,baselineSeq:record.operator?.baselineSeq,rootHandoff:record.operator?.rootHandoff,
  sourceCommit:record.identity?.sourceCommit,runtimeCommit:record.identity?.runtimeCommit,manifestSha256:record.identity?.manifestSha256,
  promptSha256:record.identity?.promptSha256,acceptanceVersion:record.identity?.acceptanceVersion,
  requestedProvider:record.identity?.requestedModel?.provider,requestedModel:record.identity?.requestedModel?.model};
 need(Object.entries(identity).every(([key,value])=>key==='version'||key==='baselineSeq'?Number.isSafeInteger(value)&&value>=0:typeof value==='string'&&value.length>0),'COLLECTOR_TARGET_IDENTITY_REQUIRED');
 return Object.freeze(identity);
}
function checkCollectorIdentity(record,report){
 const expected=collectorIdentity(record),actual=report?.collectorIdentity;
 need(actual&&Object.keys(actual).length===Object.keys(expected).length&&Object.entries(expected).every(([key,value])=>Object.hasOwn(actual,key)&&actual[key]===value),'QA_COLLECTOR_IDENTITY_MISMATCH');
 // Reject contradictory legacy flat/nested labels even when the envelope is
 // correct. The frozen criterion records themselves remain unchanged.
 for(const labels of [report,report.identity])if(labels)for(const [key,value]of Object.entries(expected))
  if(key!=='version'&&key!=='requestedModel'&&Object.hasOwn(labels,key))need(labels[key]===value,'QA_COLLECTOR_IDENTITY_MISMATCH');
}
export function finishAcceptance({record,report,now=Date.now()}){
 const timestamp=value=>typeof value==='string'?Date.parse(value):NaN;
 const output=structuredClone(record),started=timestamp(output.timestampsUtc.runSubmittedAt),submitted=timestamp(output.timestampsUtc.submittedAt),ready=timestamp(output.timestampsUtc.implementationReadyAt),deadline=timestamp(output.operator?.primaryDeadlineAt);
 need([started,submitted,ready,deadline,now].every(Number.isFinite)&&submitted===started&&matchesPrimaryLimits(output)&&deadline===originalPrimaryDeadline(output,started)&&ready>=started&&ready<=deadline&&now>=ready,'ORIGINAL_DEADLINE_INVALID');
 need(output.nativeObservation?.historyComplete===true&&output.nativeObservation?.settled===true&&output.nativeObservation.promptAdmission==='accepted'&&output.nativeObservation.terminal==='completed'&&!output.stopReason&&!output.operator.persistenceFailed&&!output.operator.finalized,'ATTEMPT_NOT_READY_FOR_QA');
 checkCollectorIdentity(output,report);
 const assessed=assessAcceptance(output.scenario,report),validation=timestamp(report.validationStartedAt),finished=timestamp(report.finishedAt),settled=timestamp(report.qaWorkSettledAt);
 need([validation,finished,settled].every(Number.isFinite)&&validation>=ready&&finished>=validation&&settled>=finished&&settled<=now&&report.qaWorkSettlementEvidence,'QA_SETTLEMENT_REQUIRED');
 output.timestampsUtc.validationStartedAt=new Date(validation).toISOString();output.timestampsUtc.finishedAt=new Date(finished).toISOString();output.timestampsUtc.settledAt=new Date(settled).toISOString();output.settledEvidence.qaWork=report.qaWorkSettlementEvidence;
 output.quality.checks=assessed.checks;output.quality.accepted=false;output.status=assessed.status;output.blockingPhase=null;output.operator.finalized=true;
 output.missingDataReasons=output.missingDataReasons.filter(row=>row.scope!=='independent acceptance');
 output.statusReason='Existing independent QA collection: '+assessed.status;
 output.quality.mandatoryCriteriaCount=criteria[output.scenario].length;
 for(const [field,status]of Object.entries({passed:'PASS',failed:'FAIL',blocked:'BLOCKED',notRun:'NOT RUN'}))output.quality[field]=assessed.checks.filter(row=>row.status===status).length;
 if(assessed.status==='PASS'){
  need(report.effectiveInferenceEvidence&&report.effectiveModel&&report.provider,'EFFECTIVE_INFERENCE_IDENTITY_REQUIRED');
  need(report.provider===output.identity.requestedModel.provider&&report.effectiveModel===output.identity.requestedModel.model,'PRIMARY_MODEL_ROUTE_UNCONFIRMED');
  need(report.sourceCommit===output.identity.sourceCommit&&report.runtimeCommit===output.identity.runtimeCommit,'PAIR_RUNTIME_CHANGED');
  if(settled>deadline){output.status='FAIL';output.statusReason='ACCEPTANCE_AFTER_DEADLINE';output.timestampsUtc.limitReachedAt=new Date(deadline).toISOString();}
  else{output.quality.accepted=true;output.timestampsUtc.acceptedAt=new Date(settled).toISOString();output.statusReason='All existing QA criteria evidenced within original limit.';}
 }
 Object.assign(output.identity,{previewUrl:assessed.previewUrl,previewReopenInstructions:assessed.reopenInstructions,effectiveModel:report.effectiveModel??null,provider:report.provider??null,identityEvidence:report.effectiveInferenceEvidence??null});
 output.timingMs.runTimeToAcceptance=output.timestampsUtc.acceptedAt?settled-started:null;output.timingMs.runSpentWall=output.timingMs.attemptElapsedThroughSettlement=settled-started;output.timingMs.attemptDecisionElapsed=finished-started;output.timingMs.postLimitSettlement=Math.max(0,settled-deadline);
 // Retain all schema nulls for unobserved auxiliary usage, active/queue/tool
 // interval unions and prices. Raw Native usage does not make billing complete.
 return output;
}
