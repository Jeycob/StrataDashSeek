// B10 composition derived from the canonical Git04b driver. No import-time I/O.
// A trusted caller supplies and binds one fixed target before any effects.
import {randomUUID} from 'node:crypto';
import {createFinalizerWriter,createDriverFinalization} from '../n06-evidence-storage/finalization.mjs';
import {createStopScope} from '../n06-evidence-storage/stop-scope.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const freezeTree=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value;};
import {validateFixedSlot,validateRuntimeBindings,validateAuthority,serviceCommit} from './spec.mjs';
import {requireBoundPreviousRuns,readActualPreviousRuns} from './prior.mjs';
import {validateB10ReportRestart} from './restart.mjs';
export function composeB10({slot,handoff,previousRuns,record,inputs,runtime,modules,signal,onIntent},trusted={}){
 validateFixedSlot(slot);validateAuthority(slot,handoff);
 const sourceCommit=serviceCommit,checkpointDirectory=slot.checkpointDirectory,target=freezeTree(structuredClone(slot.target));
 const actualHandoff={...structuredClone(handoff),previousRuns:requireBoundPreviousRuns(slot,previousRuns)};
 need(record?.status==='NOT RUN'&&['scenario','variant','pairId','runId','attemptId'].every(k=>record[k]===slot[k])&&record.comparison?.orderPosition===slot.orderPosition,'EXACT_B10_RECORD_REQUIRED');
 need(inputs&&typeof inputs.verify==='function'&&['attest','preflight','assertTarget','previewStatus','restartPreview'].every(k=>typeof runtime?.[k]==='function'),'ACTUAL_RUNTIME_REQUIRED');
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
 let invoked=false,result=null,acceptanceAttempted=false,restartOperation;
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
  restart(){
   need(result?.blockingPhase==='independent_acceptance'&&!acceptanceAttempted,'ACTUAL_QA_PHASE_REQUIRED');
   if(!restartOperation){const deadline=Date.parse(result.operator.primaryDeadlineAt);need(clock.now()<deadline&&!controller.signal.aborted,'ORIGINAL_QA_DEADLINE_EXPIRED');restartOperation=stopScope.effect({deadline:Math.min(deadline,clock.now()+4000),signal:controller.signal},bounded=>runtime.restartPreview({...target,...bounded}));}
   return restartOperation;
  },
  async finish(report){
   need(result&&!acceptanceAttempted,'ACTUAL_PRIMARY_REQUIRED');acceptanceAttempted=true;
   need(clock.now()<Date.parse(result.operator.primaryDeadlineAt)&&!controller.signal.aborted,'ORIGINAL_QA_DEADLINE_EXPIRED');
   const actualRestart=restartOperation?await restartOperation:null;
   validateB10ReportRestart(slot,report,actualRestart);
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

export async function prepareB10(slot,{handoff,signal,onIntent}){
 validateRuntimeBindings(slot);validateAuthority(slot,handoff); // before runtime/auth/FS
 const {createRuntimeSource}=await import('./runtime.mjs');
 const actual=await createRuntimeSource(slot).openActualRuntime({signal});
 const previousRuns=readActualPreviousRuns(slot,actual.protectedRead);
 return composeB10({slot,handoff,signal,onIntent,previousRuns,...actual});
}
