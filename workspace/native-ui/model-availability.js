// Read the SDK's session directory, shared with the native model picker. A
// failed catalog is inconclusive; only a successful catalog can show absence.
function modelAvailabilityNotice(state){
 if(!state?.current||state.status!=='ready'||state.pending||state.routable!==false)return null;
 if(state.failures?.some(failure=>failure.id===state.current.provider))return null;
 return{provider:state.current.provider,model:state.current.model};
}
function installModelAvailability(ctx){
 ctx.inject(['slots','sessions','modelDirectories'],scope=>{
  const empty=Object.freeze({}),subscribeEmpty=()=>()=>{},snapshotEmpty=()=>empty;
  function ModelAvailability({directory,sessionId}){
   const language=useLanguage(),state=React.useSyncExternalStore(directory?listener=>directory.store.subscribe(listener):subscribeEmpty,directory?()=>directory.store.getSnapshot():snapshotEmpty);
   const missing=modelAvailabilityNotice(state);
   if(!missing)return null;
   const message=language==='cs'?'Vybraný model není v aktuální nabídce. Před odesláním vyber dostupný model.':'The selected model is missing from the current catalog. Choose an available model before sending.';
   return h('p',{role:'alert','data-model-availability-session':sessionId,style:{margin:'4px 0',overflowWrap:'anywhere'}},message+' '+missing.provider+' / '+missing.model);
  }
  scope.slots.inject('conversation.input.dock',()=>scope.slots.register({name:'conversation.input.dock',id:'homeai.model-availability',inject:sessionId=>({sessionId,directory:scope.sessions.subagentAddress(sessionId)===undefined?scope.modelDirectories.directoryFor(sessionId):null})},ModelAvailability));
 });
}
