// Portable first-B03 composition. No CLI, runtime loader or import-time I/O.
// A trusted caller supplies and binds one fixed target before any effects.
import {randomUUID} from 'node:crypto';
import {createFinalizerWriter,createDriverFinalization} from './finalization.mjs';
import {createStopScope} from './stop-scope.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const freezeTree=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value;};
export function validateHandoff(handoff,sourceCommit){
 need(handoff?.liveAuthorized===true&&handoff.rootOperator===true&&typeof handoff.id==='string'&&handoff.id.length>0&&handoff.id.length<=256,'ROOT_LIVE_HANDOFF_REQUIRED');
 need(handoff.sourceCommit===sourceCommit&&handoff.runtimeCommit===sourceCommit&&handoff.orderPosition===1&&Array.isArray(handoff.previousRuns)&&handoff.previousRuns.length===0,'FIRST_B03_STARTUP_HANDOFF_REQUIRED');
 need(Number.isSafeInteger(handoff.settlementObservationMs)&&handoff.settlementObservationMs>0&&handoff.settlementObservationMs<=120000,'BOUNDED_SETTLEMENT_WINDOW_REQUIRED');
 return structuredClone(handoff);
}
// Runtime adapters and authorization evidence are the caller's responsibility;
// these explicit inputs do not grant access or create successful proof defaults.
export function composeFirstB03({target:fixedTarget,sourceCommit,checkpointDirectory,handoff,record,inputs,runtime,modules,signal,onIntent},trusted={}){
 need(typeof sourceCommit==='string'&&/^[0-9a-f]{40}$/.test(sourceCommit)&&typeof checkpointDirectory==='string'&&checkpointDirectory.length>0,'FIXED_CONFIGURATION_REQUIRED');
 need(fixedTarget?.owned===true&&fixedTarget.scenario==='B03'&&fixedTarget.variant==='HomeAI'&&['sessionId','workspaceId','projectId','projectRoot','preparedFixtureEvidence'].every(key=>typeof fixedTarget[key]==='string'&&fixedTarget[key].length>0)&&['provider','model'].every(key=>typeof fixedTarget.modelSelection?.[key]==='string'&&fixedTarget.modelSelection[key].length>0),'FIXED_FIRST_TARGET_REQUIRED');
 const target=freezeTree(structuredClone(fixedTarget));
 const actualHandoff=validateHandoff(handoff,sourceCommit);
 need(record?.status==='NOT RUN'&&record.scenario==='B03'&&record.variant==='HomeAI'&&record.attemptId==='planned-b03-homeai-primary','EXACT_FIRST_RECORD_REQUIRED');
 need(inputs&&typeof inputs.verify==='function'&&['attest','preflight','assertTarget','previewStatus'].every(k=>typeof runtime?.[k]==='function'),'ACTUAL_RUNTIME_REQUIRED');
 const {createRootIOAdapter,createNativeLifecycleTransport,createRootBindings,createRootLifecycle,bindLifecycleClock,realClock,runPrimary,finishAcceptance}=modules;
 const clock=bindLifecycleClock(realClock()),controller=new AbortController();
 const stopScope=createStopScope({now:clock.now,settlementMs:actualHandoff.settlementObservationMs},trusted);
 const current={...runtime};
 for(const key of ['attest','preflight','assertTarget','previewStatus','assertArchiveRuntime','previewClose'])current[key]=input=>stopScope.effect(input,bounded=>runtime[key](bounded));
 current.archiveRPC=(method,args,input)=>stopScope.effect(input,bounded=>runtime.archiveRPC(method,args,bounded));
 const io=createRootIOAdapter({target,attemptId:record.attemptId,ownerHost:runtime.ownerHost,ownerCookie:runtime.ownerCookie,checkpointDirectory,checkpointBudgetBytes:67108864,checkpointBudgetCount:2048});
 let finalization;
 const rpc=(method,data,options)=>{if(['session/cancel','session/updateQueue'].includes(method))stopScope.noteStop();return stopScope.effect(options,async bounded=>{
  if(['session/prompt','session/cancel','session/updateQueue'].includes(method)){const input={...target,...bounded};if(method!=='session/prompt'&&finalization?.state().phase==='archived')await current.assertArchiveRuntime(input);else await current.assertTarget(input);}
  // Rebind after the asynchronous runtime assertion before dispatching effects.
  return stopScope.effect(bounded,latest=>io.rpc(method,data,latest));
 });};
 const rawNative=createNativeLifecycleTransport({target,ownerHost:runtime.ownerHost,ownerCookie:runtime.ownerCookie,WebSocket:runtime.WebSocket}),native={target:rawNative.target};
 for(const key of ['jobsSnapshot','projections','terminals'])native[key]=options=>stopScope.effect(options,bounded=>rawNative[key](bounded));
 for(const key of ['killJob','followJob'])native[key]=(row,options)=>stopScope.effect(options,bounded=>rawNative[key](row,bounded));
 const bound=createRootBindings({target,sourceCommit},{native,attest:current.attest,cancelOwned:input=>rpc('session/cancel',{sessionId:target.sessionId},input)});
 const life=createRootLifecycle({target,sourceCommit},{native,assertTarget:current.assertTarget,...bound,previewStatus:current.previewStatus});
 const writer=createFinalizerWriter({checkpoint:(snapshot,options)=>stopScope.effect(options,bounded=>io.checkpoint(snapshot,bounded)),now:clock.now});
 finalization=createDriverFinalization({target,sourceCommit,native,rpc,runtime:current,modules,writer,now:clock.now,settlementMs:actualHandoff.settlementObservationMs,stopScope});
 const abort=()=>{stopScope.stop();controller.abort(signal?.reason);};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let invoked=false,result=null,acceptanceAttempted=false;
 const checkpoint=async(snapshot,options)=>{if(options.phase==='intent')stopScope.bindIntent(Date.parse(snapshot.operator.primaryDeadlineAt));const receipt=await writer.runner(snapshot,options);if(options.phase==='intent'){life.bindIntent(snapshot);finalization.bindIntent(snapshot);if(onIntent)onIntent({collectorIdentity:modules.collectorIdentity(snapshot),primaryStartedAt:Date.parse(snapshot.timestampsUtc.runSubmittedAt),primaryDeadline:Date.parse(snapshot.operator.primaryDeadlineAt)});}return receipt;};
 const observeWork=options=>stopScope.effect(options,bounded=>{const state=finalization.state();return state.phase==='archived'||state.result?.status==='HOLD'?{settled:false,evidence:{unknown:['ROOT_FINALIZER_HOLD']}}:life.observeWork(bounded);});
 const stopOwnedWork=async options=>{const fence=await finalization.stop(stopScope.finalization(options));need(fence.status==='SETTLED_VISIBLE'&&fence.persistence?.durable===true,'ROOT_FINALIZER_HOLD');return{settled:false,evidence:{rootFinalization:fence,requiresFreshOrdinaryObservation:true}};};
 return Object.freeze({
  // No session, prompt, model, project or URL argument can select another target.
  async run(){need(!invoked,'DRIVER_ONCE_ONLY');invoked=true;try{result=await runPrimary({record:structuredClone(record),target,handoff:actualHandoff,inputs,clock,signal:controller.signal,io:{rpc,checkpoint,preflight:current.preflight,observeWork,stopOwnedWork}});const fence=finalization.state().result;if(fence)result.rootFinalization=fence;return structuredClone(result);}finally{signal?.removeEventListener('abort',abort);}},
  stop(options={}){stopScope.stop(options);controller.abort('ROOT_STOP');},
  // Root's existing outer600s/QA supervisor must call this at the original
  // deadline if run() already returned waiting for QA. No new budget is inferred.
  cleanup:options=>finalization.cleanup(stopScope.finalization(options,{externalSignal:true})),
  async finish(report){
   need(result&&!acceptanceAttempted,'ACTUAL_PRIMARY_REQUIRED');acceptanceAttempted=true;
   finishAcceptance({record:result,report,now:clock.now()}); // validate actual collector before effects
   const deadline=Date.parse(result.operator.primaryDeadlineAt),fence=await finalization.finish({signal:controller.signal});
   need(clock.now()<deadline&&fence.status==='SETTLED_VISIBLE'&&fence.persistence?.durable===true,'ROOT_FINALIZER_HOLD');
   // The real finalizer's after_restore phase already repeats actual history,
   // known queue/pending, children/PTY, terminal/follow and owned-range proof.
   const output=finishAcceptance({record:result,report,now:clock.now()}),checkpointId=randomUUID();output.rootFinalization=fence;
   need(clock.now()<deadline&&!controller.signal.aborted,'ORIGINAL_QA_DEADLINE_EXPIRED');
   const snapshot=structuredClone(output);snapshot.operator.persistence.pendingCheckpointId=checkpointId;
   const receipt=await checkpoint(snapshot,{deadline:Math.min(deadline,clock.now()+4000),checkpointId,phase:'final',signal:controller.signal});
   need(clock.now()<deadline&&receipt?.durable===true&&receipt.checkpointId===checkpointId,'QA_CHECKPOINT_UNCONFIRMED');
   output.operator.persistence.lastDurableCheckpointId=checkpointId;result=output;return structuredClone(output);
  },
 });
}
