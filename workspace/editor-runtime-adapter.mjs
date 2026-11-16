import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {createEditorBridge}=createRequire(import.meta.url)('./editor-bridge.cjs');
const fail=code=>Object.assign(Error(code),{code,status:409});
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
export function validateEditorProof(value,{sessionId,projectRoot,readOnly,generation},now=Date.now()){
 const scope=crypto.createHash('sha256').update(sessionId+'\0'+projectRoot).digest('hex').slice(0,32),p=value?.isolation,t=value?.transport;
 if(value?.version!==1||value.state!=='ready'||value.sessionId!==sessionId||value.projectRoot!==projectRoot||value.readOnly!==readOnly||value.generation!==generation||value.scopeId!==scope||p?.enforced!==true||p.sessionId!==sessionId||p.projectRoot!==projectRoot||p.readOnly!==readOnly||t?.host!=='127.0.0.1'||t.guestAddress!=='10.0.2.15'||!Number.isInteger(t.hostPort)||t.hostPort<19180||t.hostPort>19243||t.guestPort!==t.hostPort||!Number.isSafeInteger(t.bootPid)||t.bootPid<1||t.mtls!==true||t.serverName!==scope+'.'+generation+'.editor.homeai.invalid'||!['editor','relay'].every(k=>/^[a-f0-9]{64}$/.test(value.containerIds?.[k]||''))||value.containerIds.editor===value.containerIds.relay||!/^[a-f0-9]{32}$/.test(value.operationId||'')||!tokenPattern.test(value.stopToken||'')||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+301000||!Number.isSafeInteger(value.hardDeadline)||value.hardDeadline<value.expiresAt||value.hardDeadline>now+1801000)throw fail('EDITOR_ISOLATION_UNPROVEN');
 return value;
}
export function createProjectEditorAdapter(manager,{appsConfig,callApps,socketDirectory,transportIdentity,bridgeFactory=createEditorBridge,now=Date.now}){
 const entries=new Map(),queues=new Map();
 const rpc=(data,signal)=>callApps('/project-runtime',data,{...appsConfig,timeoutMs:125000,signal});
 function ordered(id,action){const next=(queues.get(id)??Promise.resolve()).catch(()=>{}).then(action);queues.set(id,next);void next.finally(()=>{if(queues.get(id)===next)queues.delete(id);}).catch(()=>{});return next;}
 async function stopEditor({sessionId,generation}){
  const entry=entries.get(sessionId);if(!entry||entry.generation!==generation)return;
  entry.stopping=true;await entry.bridge?.close();
  const result=await rpc({op:'stop',sessionId,generation,stopToken:entry.stopToken});
  if(result?.version!==1||result.state!=='stopped'||result.sessionId!==sessionId||result.generation!==generation||!/^[a-f0-9]{32}$/.test(result.operationId||'')||entry.operationId&&result.operationId!==entry.operationId)throw fail('EDITOR_STOP_UNCONFIRMED');
  if(entries.get(sessionId)===entry)entries.delete(sessionId);
 }
 async function renew(entry,signal){
  const {sessionId,generation,projectRoot,readOnly}=entry;
  const value=await manager.withProjectRuntimeAuthority({sessionId,op:'ensure',kind:'editor',generation},token=>rpc({op:'touch',sessionId,generation,stopToken:entry.stopToken,token},signal));
  validateEditorProof(value,{sessionId,generation,projectRoot,readOnly},now());signal?.throwIfAborted();
  if(value.transport.bootPid!==entry.bootPid||value.transport.hostPort!==entry.hostPort||value.operationId!==entry.operationId||value.stopToken!==entry.stopToken||value.containerIds.editor!==entry.containerIds.editor||value.containerIds.relay!==entry.containerIds.relay||value.hardDeadline!==entry.hardDeadline)throw fail('EDITOR_RUNTIME_CHANGED');
  entry.expiresAt=value.expiresAt;entry.lastTouch=now();return entry;
 }
 const publicValue=entry=>({ready:true,state:'ready',generation:entry.generation,readOnly:entry.readOnly,socketPath:entry.bridge.socketPath,isolation:entry.isolation,hardDeadline:entry.hardDeadline});
 async function ensureEditor({sessionId,projectRoot,readOnly,signal}){
  if(!appsConfig?.projectRuntime?.enabled||typeof manager.withProjectRuntimeAuthority!=='function')return{ready:false,state:'unavailable',code:'EDITOR_ISOLATION_NOT_CONFIGURED'};
  signal?.throwIfAborted();let prior=entries.get(sessionId);
  if(prior&&(prior.stopping||prior.projectRoot!==projectRoot||prior.readOnly!==readOnly||prior.expiresAt<=now()||prior.hardDeadline<=now())){await stopEditor({sessionId,generation:prior.generation});prior=null;}
  if(prior){try{return publicValue(await renew(prior,signal));}catch(error){await stopEditor(prior).catch(()=>{});throw error;}}
  const generation=crypto.randomBytes(16).toString('hex'),stopToken=crypto.randomBytes(32).toString('base64url'),context={sessionId,projectRoot,readOnly,generation};let value,bridge;
  // Own the cancellation capability before the request can be admitted. A
  // missing response cannot prove that the editor was never started.
  const entry={...context,stopToken,stopping:true};entries.set(sessionId,entry);
  try{
   value=await manager.withProjectRuntimeAuthority({sessionId,op:'ensure',kind:'editor',generation},token=>rpc({op:'ensure',kind:'editor',sessionId,generation,token,stopToken},signal));
   validateEditorProof(value,context,now());signal?.throwIfAborted();
   if(value.stopToken!==stopToken)throw fail('EDITOR_ISOLATION_UNPROVEN');
   entry.operationId=value.operationId;
   const identity=await transportIdentity({sessionId,generation,scopeId:value.scopeId});signal?.throwIfAborted();
   if(identity?.serverName!==value.transport.serverName)throw fail('EDITOR_TRANSPORT_IDENTITY_REQUIRED');
   bridge=await bridgeFactory({directory:socketDirectory,sessionId,generation,hostPort:value.transport.hostPort,transportIdentity:identity});
   Object.assign(entry,{bridge,bootPid:value.transport.bootPid,hostPort:value.transport.hostPort,containerIds:value.containerIds,isolation:value.isolation,expiresAt:value.expiresAt,hardDeadline:value.hardDeadline,lastTouch:now(),stopping:false});
   signal?.throwIfAborted();return publicValue(entry);
  }catch(error){
   // Retain stop capability until an observed stop, including late admission
   // replies after cancellation. Never expose it to the browser or model.
   entry.bridge=bridge;entry.stopping=true;
   await stopEditor({sessionId,generation}).catch(()=>{});
   throw error;
  }
 }
 async function touchEditor({sessionId,generation,projectRoot,readOnly,signal}){
  const entry=entries.get(sessionId);
  if(!entry||entry.stopping||entry.generation!==generation||entry.projectRoot!==projectRoot||entry.readOnly!==readOnly)throw fail('EDITOR_RUNTIME_CHANGED');
  try{
   if(entry.expiresAt<=now()||entry.hardDeadline<=now())throw fail('EDITOR_RUNTIME_EXPIRED');
   // Only browser activity enters here. No timer renews runtime authority,
   // and the Apps hard deadline remains non-extendable.
   if(now()-entry.lastTouch>=30000)await renew(entry,signal);
   return publicValue(entry);
  }catch(error){await stopEditor(entry).catch(()=>{});throw error;}
 }
 return{ensureEditor:input=>ordered(input.sessionId,()=>ensureEditor(input)),touchEditor:input=>ordered(input.sessionId,()=>touchEditor(input)),stopEditor:input=>ordered(input.sessionId,()=>stopEditor(input)),async dispose(){await Promise.allSettled([...queues.values()]);await Promise.allSettled([...entries.values()].map(entry=>ordered(entry.sessionId,()=>stopEditor(entry))));}};
}
