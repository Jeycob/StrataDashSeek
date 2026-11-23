(function(root,factory){
 'use strict';const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else{root.HarnessAvailability=api;api.install(root);}
})(typeof window==='undefined'?globalThis:window,function(){
 'use strict';
 const phases=new Set(['offline','authentication_required','capacity_wait','verifying_update','starting_services','model_loading','ready','sleeping','failed']);
 const OBSERVATION_MAX_AGE_MS=30000;
 // A cold start can restore weights from disk before the engine can load them.
 const MODEL_LOADING_BUDGET_MS=(15*60+90)*1000;
 const code=value=>/^[A-Z][A-Z0-9_]{0,79}$/.test(value||'')?value:'STATUS_UNKNOWN';
 function normalizeAvailability(data={},now=Date.now()){
  const sourceReady=data.sourceReady===true,runtimeReady=data.runtimeReady===true,modelReady=data.modelReady===true;
  let phase=phases.has(data.phase)?data.phase:'starting_services';
  if(phase==='ready'&&!(sourceReady&&runtimeReady&&modelReady))phase=sourceReady&&runtimeReady?'model_loading':'starting_services';
  const observed=Date.parse(data.observedAt);
  return{phase,reasonCode:code(data.reasonCode),sourceReady,runtimeReady,modelReady,
   observedAt:Number.isFinite(observed)?new Date(observed).toISOString():null,lastCheckedAt:new Date(now).toISOString(),
   stale:data.stale===true||!Number.isFinite(observed)||now-observed>OBSERVATION_MAX_AGE_MS||observed>now+5000,
   retryAfterSeconds:Math.min(60,Math.max(1,Number(data.retryAfterSeconds)||2)),
   sourceCommit:/^[a-f0-9]{7,64}$/i.test(data.sourceCommit||'')?data.sourceCommit:null,
   sourcePhase:phases.has(data.sourcePhase)?data.sourcePhase:null,runtimePhase:phases.has(data.runtimePhase)?data.runtimePhase:null};
 }
 function deviceDTO(value){
  if(!value||value.version!==2||typeof value.credential!=='string'||value.credential.length<16||value.credential.length>8192||
   !/^[A-Za-z0-9_-]{8,128}$/.test(value.deviceId||'')||!Array.isArray(value.scope)||
   value.scope.length!==2||!value.scope.includes('status')||!value.scope.includes('wake'))throw Object.assign(Error('AUTH_UPGRADE_REQUIRED'),{code:'AUTH_UPGRADE_REQUIRED'});
  let url;try{url=new URL(value.wakeUrl);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Object.assign(Error('AUTH_UPGRADE_REQUIRED'),{code:'AUTH_UPGRADE_REQUIRED'});
  const expiresAt=typeof value.expiresAt==='number'?value.expiresAt:Date.parse(value.expiresAt);
  if(!Number.isFinite(expiresAt))throw Object.assign(Error('AUTH_UPGRADE_REQUIRED'),{code:'AUTH_UPGRADE_REQUIRED'});
  return{version:2,wakeUrl:url.origin,credential:value.credential,deviceId:value.deviceId,expiresAt,scope:['status','wake']};
 }
 function createWakeCredentials({storage,request,now=Date.now}){
  const key='harness.wake.device.v2',metaKey=key+'.meta';let pending=null,epoch=0;
  const read=name=>{try{return JSON.parse(storage.getItem(name)||'null');}catch{return null;}};
  const write=(name,value)=>{try{storage.setItem(name,JSON.stringify(value));}catch{}};
  function get(){if(read(metaKey)?.reason==='DEVICE_REVOKED')return null;const raw=read(key);if(!raw)return null;try{return deviceDTO(raw);}catch{return null;}}
  function clear(reason='DEVICE_REVOKED',serverDeviceId){
   epoch++;
   const old=get(),meta=read(metaKey),verifiedId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(serverDeviceId||'')?serverDeviceId:null;write(metaKey,{deviceId:verifiedId||old?.deviceId||meta?.deviceId||null,reason});
   try{storage.removeItem(key);}catch{}
  }
  async function provision({signal,allowOwnerEntry=true}={}){
   const meta=read(metaKey);if(meta?.reason==='DEVICE_REVOKED')throw Object.assign(Error('DEVICE_REVOKED'),{code:'DEVICE_REVOKED'});
   if(pending)return pending;
   const ticket=epoch;
   pending=(async()=>{const prior=get(),options={method:'POST',body:JSON.stringify({deviceId:prior?.deviceId||meta?.deviceId||null}),signal};let response;
    try{response=await request('/phone/api/wake-credential',options);}catch(error){
     if(error.code==='DEVICE_REVOKED'){clear('DEVICE_REVOKED',error.deviceId);throw error;}
     if(!allowOwnerEntry||error.status!==401||!['PAIRING_REQUIRED','STATUS_UNKNOWN',undefined].includes(error.code)||prior||meta?.deviceId)throw error;
     // Only a new device can use the existing Tailscale-owner entry once.
     // Revoked/expired identities never pass through this fresh-enrolment path.
     await request('/phone/api/tailscale-login',{method:'POST',body:'{}',signal});
     if(signal?.aborted)throw signal.reason||new Error('Aborted');if(ticket!==epoch)throw Object.assign(Error('DEVICE_REVOKED'),{code:'DEVICE_REVOKED'});
     try{response=await request('/phone/api/wake-credential',options);}catch(retryError){if(retryError.code==='DEVICE_REVOKED')clear('DEVICE_REVOKED',retryError.deviceId);throw retryError;}
    }
    const result=deviceDTO(response);
    if(signal?.aborted)throw signal.reason||new Error('Aborted');
    if(ticket!==epoch)throw Object.assign(Error('DEVICE_REVOKED'),{code:'DEVICE_REVOKED'});
    if(result.expiresAt<=now())throw Object.assign(Error('DEVICE_EXPIRED'),{code:'DEVICE_EXPIRED'});
    write(key,result);write(metaKey,{deviceId:result.deviceId,reason:null});
    // The account-wide legacy key is never read or sent to the edge.
    try{storage.removeItem('harness.wake.key');}catch{}return result;
   })().finally(()=>{pending=null;});return pending;
  }
  async function claimReenrollment({signal}={}){
   const meta=read(metaKey),ticket=epoch;if(!meta?.deviceId)throw Object.assign(Error('PAIRING_REQUIRED'),{code:'PAIRING_REQUIRED'});
   const result=await request('/phone/api/devices/claim-reenrollment',{method:'POST',body:JSON.stringify({deviceId:meta.deviceId}),signal}),device=deviceDTO(result),approval=result.reenrollment;
   const confirmedAt=typeof approval?.confirmedAt==='number'?approval.confirmedAt:Date.parse(approval?.confirmedAt);
   if(device.deviceId!==meta.deviceId||approval?.deviceId!==meta.deviceId||!Number.isSafeInteger(approval?.generation)||approval.generation<1||!Number.isFinite(confirmedAt))throw Object.assign(Error('DEVICE_REENROLLMENT_REQUIRED'),{code:'DEVICE_REENROLLMENT_REQUIRED'});
   if(signal?.aborted)throw signal.reason||new Error('Aborted');
   if(ticket!==epoch)throw Object.assign(Error('DEVICE_REVOKED'),{code:'DEVICE_REVOKED'});
   if(device.expiresAt<=now())throw Object.assign(Error('DEVICE_EXPIRED'),{code:'DEVICE_EXPIRED'});
   write(key,device);write(metaKey,{deviceId:device.deviceId,reason:null,generation:approval.generation,confirmedAt});try{storage.removeItem('harness.wake.key');}catch{}return device;
  }
  function identity(){const device=get(),meta=read(metaKey);return{deviceId:device?.deviceId||meta?.deviceId||null,revoked:meta?.reason==='DEVICE_REVOKED'};}
  async function provisionAfterPairing(){
   if(pending)await pending.catch(()=>{});
   const current=identity();
   if(!current.deviceId&&!current.revoked)await provision({allowOwnerEntry:false});
  }
  return{get,clear,provision,provisionAfterPairing,claimReenrollment,identity};
 }
 function createAvailabilityController({health,status,wake,credentials,onChange=()=>{},visible=()=>true,online=()=>true,now=Date.now,sleep,budgetMs=360000}){
  let state=normalizeAvailability({phase:'offline',reasonCode:'NOT_CHECKED'},now()),pending=null,controller=null,epoch=0,manuallyPaused=false;
  const pause=sleep||((ms,signal)=>new Promise((resolve,reject)=>{const done=()=>{signal.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason||new Error('Aborted'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}));
  function publish(data){state=normalizeAvailability(data,now());onChange({...state});return state;}
  function cancel(reason='WAIT_CANCELLED'){
   if(reason==='WAIT_CANCELLED')manuallyPaused=true;
   epoch++;controller?.abort();controller=null;pending=null;
   return publish({...state,phase:reason==='NETWORK_OFFLINE'?'offline':state.phase==='ready'?'ready':'offline',reasonCode:reason,stale:true});
  }
  function start({retry=false}={}){
   if(retry)manuallyPaused=false;
   if(manuallyPaused||!visible()||!online())return Promise.resolve(state);
   if(pending)return pending;
   const id=++epoch,abort=new AbortController();controller=abort;const signal=abort.signal;
   const active=()=>{if(signal.aborted||id!==epoch)throw Object.assign(new Error('Aborted'),{name:'AbortError'});if(!visible()||!online()){cancel(!online()?'NETWORK_OFFLINE':'WAIT_HIDDEN');throw Object.assign(new Error('Aborted'),{name:'AbortError'});}};
   pending=(async()=>{
    let accepted=false,nextWake=0,nextEdge=0,attempt=0,renewed=false,provisioned=false;const deadline=now()+budgetMs;
    let pollDeadline=deadline,modelDeadline=null,modelFreshUntil=0;
    while(now()<pollDeadline){
     active();let data=null;
     const extended=pollDeadline>deadline&&now()>=deadline;
     try{data=await health(extended?{signal,timeoutMs:Math.min(10000,pollDeadline-now())}:{signal});active();}catch(error){
      active();if(error.code==='DEVICE_REVOKED'){credentials.clear();return publish({phase:'authentication_required',reasonCode:error.code});}
      if(pollDeadline>deadline&&now()>=deadline&&(error.status===undefined||error.status>=500)){
       // A missed health poll can use the last verified observation until it expires.
       pollDeadline=Math.min(pollDeadline,modelFreshUntil);
       const remaining=pollDeadline-now();if(remaining<=0)break;
       await pause(Math.min(2000,remaining),signal);continue;
      }
     }
     if(extended&&now()>=pollDeadline)break;
     const result=data?publish(data):null;
     if(result?.phase==='ready'){
      // Provision only through a reachable paired backend; a revocation tombstone prevents silent reenrolment.
      try{await credentials.provision({signal});active();}catch(error){active();if(['DEVICE_REVOKED','AUTH_UPGRADE_REQUIRED'].includes(error.code))return publish({...result,reasonCode:error.code});}
      return state;
     }
     if(['failed','authentication_required'].includes(result?.phase))return result;
     if(data?.phase==='model_loading'&&data.modelReady===false&&result.sourceReady&&result.runtimeReady&&!result.stale){
      modelDeadline??=now()+MODEL_LOADING_BUDGET_MS;
      modelFreshUntil=Math.min(now(),Date.parse(result.observedAt))+OBSERVATION_MAX_AGE_MS;
      pollDeadline=Math.max(deadline,modelDeadline);
      const remaining=pollDeadline-now();if(remaining<=0)break;
      await pause(Math.min(result.retryAfterSeconds*1000,remaining),signal);continue;
     }
     if(pollDeadline>deadline){
      pollDeadline=deadline;if(now()>=deadline)break;
     }
     // A reachable starting service is not a sleeping GPU. Do not send another wake.
     if(result&&result.phase!=='sleeping'&&result.phase!=='capacity_wait'){await pause(result.retryAfterSeconds*1000,signal);continue;}
     if(now()<nextEdge){await pause(Math.min(5000,nextEdge-now()),signal);continue;}
     let device=credentials.get();
     if(!device||device.expiresAt<=now()){
      if(provisioned)return publish({...state,phase:'authentication_required',reasonCode:device?'DEVICE_EXPIRED':'PAIRING_REQUIRED'});
      provisioned=true;
      try{device=await credentials.provision({signal});active();}catch(error){active();return publish({...state,phase:'authentication_required',reasonCode:code(error.code||'PAIRING_REQUIRED')});}
     }
     try{
      const remote=await status(device,{signal});active();
      const stopped=remote.status==='stopped'||remote.status==='exited'&&remote.intended==='stopped';
      if(stopped&&!accepted&&now()>=nextWake){
       publish({...state,phase:'sleeping',reasonCode:'INSTANCE_STOPPED',observedAt:remote.observedAt});
       active();const result=await wake(device,{signal});active();
       if(result.queued){nextWake=now()+Math.max(1000,Math.min(60000,(Number(result.retryAfterSeconds)||15)*1000));publish({...state,phase:'capacity_wait',reasonCode:'CAPACITY_UNAVAILABLE',observedAt:result.observedAt,retryAfterSeconds:(nextWake-now())/1000});}
       else{accepted=true;publish({...state,phase:'starting_services',reasonCode:'WAKE_ACCEPTED',observedAt:result.observedAt});}
      }else if(!stopped){accepted=true;publish({...state,phase:'starting_services',reasonCode:'INSTANCE_RUNNING',observedAt:remote.observedAt});}
     }catch(error){
      active();if(error.code==='DEVICE_REVOKED'){credentials.clear();return publish({...state,phase:'authentication_required',reasonCode:error.code});}
      if(error.code==='DEVICE_EXPIRED'&&!renewed){renewed=true;try{await credentials.provision({signal});active();continue;}catch(renewError){active();return publish({...state,phase:'authentication_required',reasonCode:code(renewError.code||'DEVICE_EXPIRED')});}}
      if(error.status===401||error.status===403)return publish({...state,phase:'authentication_required',reasonCode:code(error.code||'PAIRING_REQUIRED')});
      nextEdge=now()+Math.min(60000,Math.max(1000,(Number(error.retryAfterSeconds)||2)*1000));
      publish({...state,phase:'offline',reasonCode:'WAKE_SERVICE_UNREACHABLE',stale:true});
     }
     // Keep checking the source even while a wake retry is throttled. Another
     // client may already have acquired capacity; its work must not wait 15s.
     await pause(Math.max(1000,Math.min(5000,800*1.35**attempt++)),signal);
    }
    active();return publish({...state,phase:'failed',reasonCode:'WAIT_TIMEOUT'});
   })().catch(error=>{if(id!==epoch||signal.aborted)return state;return publish({...state,phase:'failed',reasonCode:code(error.code||'CONNECTION_FAILED')});}).finally(()=>{if(id===epoch){pending=null;controller=null;}});
   return pending;
  }
  return{start,cancel,get state(){return{...state};},get waiting(){return!!pending;}};
 }
 const copy={en:{offline:'Cannot reach the server. Check Tailscale and your connection.',authentication_required:'This device needs pairing or renewed access.',capacity_wait:'Waiting for GPU capacity. Your files remain stored.',verifying_update:'Verifying the server update…',starting_services:'Starting Harness services…',model_loading:'Harness is open. The model is still loading…',ready:'Harness and model are ready.',sleeping:'The instance is stopped. Requesting a wake…',failed:'Connection could not be completed.',retry:'Retry',cancel:'Stop waiting',details:'Connection details',stale:'Last observation may be out of date',unchecked:'No verified observation yet'},cs:{offline:'Server není dostupný. Zkontroluj Tailscale a připojení.',authentication_required:'Toto zařízení potřebuje propojení nebo obnovit přístup.',capacity_wait:'Čekám na volnou GPU. Soubory zůstávají uložené.',verifying_update:'Ověřuji aktualizaci serveru…',starting_services:'Spouštím služby Harnessu…',model_loading:'Harness je otevřený. Model se ještě načítá…',ready:'Harness i model jsou připravené.',sleeping:'Instance je zastavená. Žádám o probuzení…',failed:'Připojení se nepodařilo dokončit.',retry:'Zkusit znovu',cancel:'Přestat čekat',details:'Podrobnosti připojení',stale:'Poslední pozorování může být zastaralé',unchecked:'Zatím bez ověřeného pozorování'}};
 copy.en.WAIT_CANCELLED='Stopped waiting on this device. Server jobs continue.';
 copy.cs.WAIT_CANCELLED='Čekání na tomto zařízení zastaveno. Úlohy na serveru pokračují.';
 function install(win) {
  const doc = win.document;
  const header = doc.getElementById('setup-header');
  const label = doc.getElementById('status');
  if (!header || !label) return;

  let lastState = null;
  win.harnessBackendReady = false;
  win.harnessModelReady = false;

  const controls = doc.createElement('div');
  const retry = doc.createElement('button');
  const cancel = doc.createElement('button');
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  const detail = doc.createElement('p');
  controls.id = 'availability-controls';
  controls.style.cssText = 'width:100%;display:flex;gap:8px;flex-wrap:wrap';
  retry.type = 'button';
  retry.id = 'availability-retry';
  cancel.type = 'button';
  cancel.id = 'availability-cancel';
  details.id = 'availability-details';
  details.style.cssText = 'width:100%;font-size:12px;overflow-wrap:anywhere';
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  label.setAttribute('aria-atomic', 'true');
  controls.append(retry, cancel);
  details.append(summary, detail);
  header.append(controls, details);

  async function request(url, {signal, timeoutMs = 10000, ...options} = {}) {
   const abort = new AbortController();
   const relayAbort = () => abort.abort(signal.reason);
   signal?.addEventListener('abort', relayAbort, {once: true});
   if (signal?.aborted) relayAbort();
   const timer = setTimeout(() => abort.abort(), timeoutMs);
   try {
    const response = await win.fetch(url, {
     cache: 'no-store',
     ...options,
     signal: abort.signal,
     headers: {
      ...(options.body ? {'Content-Type': 'application/json'} : {}),
      ...options.headers
     }
    });
    let data;
    try {
     data = await response.json();
    } catch {
     data = {};
    }
    if (abort.signal.aborted) throw new Error('Aborted');
    if (!response.ok) {
     const validDeviceId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.deviceId || '');
     throw Object.assign(new Error('Request failed'), {
      status: response.status,
      code: code(data.code),
      ...(validDeviceId ? {deviceId: data.deviceId} : {}),
      retryAfterSeconds: Number(response.headers.get('retry-after')) || data.retryAfterSeconds
     });
    }
    return data;
   } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
   }
  }

  const credentials = createWakeCredentials({storage: win.localStorage, request});
  win.HarnessWakeCredentials = credentials;

  function render(state) {
   lastState = state;
   const ready = state.phase === 'ready';
   win.harnessBackendReady = state.sourceReady && state.runtimeReady;
   win.harnessModelReady = ready;
   win.harnessAvailabilityState = state;

   const strings = copy[win.HarnessI18n?.language === 'cs' ? 'cs' : 'en'];
   label.textContent = strings[state.reasonCode] || strings[state.phase];
   summary.textContent = strings.details;
   retry.textContent = strings.retry;
   cancel.textContent = strings.cancel;
   detail.textContent = [
    state.reasonCode,
    state.observedAt || strings.unchecked,
    state.stale ? strings.stale : ''
   ].filter(Boolean).join(' · ');

   header.hidden = ready;
   controls.hidden = ready;
   retry.hidden = ready;
   cancel.hidden = ['ready', 'failed', 'authentication_required'].includes(state.phase) ||
    ['WAIT_CANCELLED', 'WAIT_HIDDEN', 'NETWORK_OFFLINE'].includes(state.reasonCode);
   win.dispatchEvent(new win.CustomEvent('harness-availability', {detail: state}));
  }

  const controller = createAvailabilityController({
   health: options => request('/phone/health', options),
   credentials,
   visible: () => !doc.hidden,
   online: () => win.navigator.onLine !== false,
   onChange: render,
   status: (device, options) => request(device.wakeUrl + '/api/status', {
    ...options,
    headers: {Authorization: 'Bearer ' + device.credential}
   }),
   wake: (device, options) => request(device.wakeUrl + '/api/wake', {
    ...options,
    method: 'POST',
    headers: {Authorization: 'Bearer ' + device.credential},
    body: '{}'
   })
  });

  win.harnessPrepare = options => controller.start(options);
  win.harnessCancelWait = () => controller.cancel();
  retry.onclick = () => controller.start({retry: true});
  cancel.onclick = () => controller.cancel();
  doc.addEventListener('visibilitychange', () => doc.hidden ? controller.cancel('WAIT_HIDDEN') : controller.start());
  win.addEventListener('offline', () => controller.cancel('NETWORK_OFFLINE'));
  win.addEventListener('online', () => controller.start());
  win.addEventListener('harness-language-change', () => lastState && render(lastState));
  render(controller.state);
 }
 return{normalizeAvailability,deviceDTO,createWakeCredentials,createAvailabilityController,install};
});
