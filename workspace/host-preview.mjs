import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {WorkbenchError} from './policy.mjs';
import {sameRequestOrigin,boundedJSON} from './http.mjs';
import {bindProjectExecution} from './execution-mode.mjs';
import {createOwnPeerConnector} from './host-peer-connector.mjs';
import {createPreviewRelay} from './host-preview-relay.mjs';
import {projectBackgroundSchema} from './project-process.mjs';
import {hasOwnedRangeProvider} from './owned-range-state.mjs';
const {EditorOrigins}=createRequire(import.meta.url)('./editor-origins.cjs');
const {createEditorBroker}=createRequire(import.meta.url)('./editor-broker.cjs');
const fail=code=>new WorkbenchError(code,'The application preview is unavailable. Check its own job and reopen it from this conversation.',409);
const need=(value,code)=>{if(!value)throw fail(code);};
const ID=/^[a-zA-Z0-9_-]{1,128}$/;
const contained=(base,file)=>file!==base&&file.startsWith(base+path.sep);
export const previewSupported=ctx=>process.platform==='linux'&&os.endianness()==='LE'&&typeof process.getuid==='function'&&hasOwnedRangeProvider(ctx?.subprocess);
export function previewSettings(config){
 if(config?.enabled!==true)return null;
 try{
  need(Object.keys(config).every(k=>['enabled','ownerOrigin','endpoints'].includes(k)),'PREVIEW_CONFIG_INVALID');
  const owner=new URL(config.ownerOrigin);need(owner.protocol==='https:'&&owner.origin===config.ownerOrigin,'PREVIEW_CONFIG_INVALID');
  need(Array.isArray(config.endpoints)&&config.endpoints.length>0&&config.endpoints.length<=64,'PREVIEW_CONFIG_INVALID');
  const origins=new Set(),ports=new Set();
  for(const endpoint of config.endpoints){const u=new URL(endpoint.origin);need(Object.keys(endpoint).sort().join(',')==='listenerPort,origin'&&u.protocol==='https:'&&u.origin===endpoint.origin&&u.origin!==owner.origin&&Number.isInteger(endpoint.listenerPort)&&endpoint.listenerPort>=1024&&endpoint.listenerPort<=65535&&!origins.has(u.origin)&&!ports.has(endpoint.listenerPort),'PREVIEW_CONFIG_INVALID');origins.add(u.origin);ports.add(endpoint.listenerPort);}
  return structuredClone(config);
 }catch{return null;}
}
async function bindBroker(broker,endpoint){await new Promise((resolve,reject)=>{broker.server.once('error',reject);broker.server.listen(endpoint.listenerPort,'127.0.0.1',()=>{broker.server.removeListener('error',reject);resolve();});});}
const defaults={supported:previewSupported,uid:()=>process.getuid(),connector:createOwnPeerConnector,relay:createPreviewRelay,broker:createEditorBroker,origins:(file,config)=>new EditorOrigins(file,config),bind:bindBroker,now:Date.now,operationMs:10000};

// Trusted source-test factories are never supplied by plugin/browser config.
export function createHostPreview(ctx,manager,run,config,binding=manager.execution??ctx.projectExecutionMode,trusted={}){
 const f={...defaults,...trusted},mode=bindProjectExecution(binding),settings=previewSettings(config),entries=new Map(),queues=new Map(),registrations=new Map();
 let disposed=false,origins;
 const check=()=>{need(!disposed&&mode.assertUnchanged().mode==='host-compat','PREVIEW_MODE_UNAVAILABLE');};check();
 const available=!!settings&&f.supported(ctx)&&['custodyFor','startCaptured','producerFor','stopOwned'].every(name=>typeof run[name]==='function');
 function ordered(id,action){const before=queues.get(id)??Promise.resolve(),next=before.catch(()=>{}).then(action);queues.set(id,next);void next.finally(()=>{if(queues.get(id)===next)queues.delete(id);}).catch(()=>{});return next;}
 async function bounded(action,deadline,outer){
  const controller=new AbortController(),signal=outer?AbortSignal.any([outer,controller.signal]):controller.signal;let timer;
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return action(signal);}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('PREVIEW_OPERATION_TIMEOUT'));},Math.max(0,deadline-f.now()));signal.addEventListener('abort',()=>reject(fail('PREVIEW_OPERATION_ABORTED')),{once:true});})]);}
  finally{clearTimeout(timer);controller.abort();}
 }
 function liveContext(sessionId,access){
  check();need(ID.test(sessionId),'PREVIEW_SESSION_INVALID');
  const agent=ctx.agents.get(sessionId),record=manager.data.sessions[sessionId];
  need(agent&&manager.ownerAgent(agent)===agent&&record&&!record.legacy&&!manager.data.trash?.[sessionId]&&!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),'PREVIEW_PROJECT_UNAVAILABLE');
  if(access)need(ctx.agents.get(access.id)===access&&manager.ownerAgent(access)===agent,'PREVIEW_ACCESS_CHANGED');
  const workspaces=ctx.workspaceRegistry.list().filter(w=>w.sessionIds.includes(sessionId));need(workspaces.length===1&&(!record.workspaceId||workspaces[0].id===record.workspaceId),'PREVIEW_WORKSPACE_CHANGED');
  for(const subject of [agent,access].filter(Boolean))need(['workspace-write','danger-full-access'].includes(ctx.sandboxPolicy.resolve({session:subject.session})?.mode),'PREVIEW_READ_ONLY');
  const ports=record.ports;need(Array.isArray(ports)&&ports.length===4&&new Set(ports).size===4&&ports.every(p=>Number.isInteger(p)&&p>=1024&&p<=65535),'PREVIEW_PORTS_INVALID');
  for(const [id,other]of Object.entries(manager.data.sessions))if(id!==sessionId){need(!other.ports?.some(p=>ports.includes(p)),'PREVIEW_PORTS_SHARED');if(other.root)need(record.root!==other.root&&!contained(record.root,other.root)&&!contained(other.root,record.root),'PREVIEW_PROJECT_SHARED');}
  return{agent,record,workspaceId:workspaces[0].id};
 }
 async function context(sessionId,access){
  const before=liveContext(sessionId,access),project=await manager.projectFor(sessionId),root=await fs.realpath(before.record.root),base=await fs.realpath(manager.projectsRoot),stat=await fs.stat(root);
  const after=liveContext(sessionId,access);need(before.record===after.record&&root===after.record.root&&project.root===root&&project.live===after.agent.session&&contained(base,root)&&stat.isDirectory(),'PREVIEW_PROJECT_CHANGED');
  return{...after,root,dev:stat.dev,ino:stat.ino,projectId:createHash('sha256').update(root).digest('hex').slice(0,16),port:after.record.ports[0]};
 }
 function assertEntry(entry){
  const current=liveContext(entry.sessionId,entry.access);
  need(entries.get(entry.sessionId)===entry&&['opening','ready'].includes(entry.state)&&!entry.openSignal?.aborted&&f.now()<entry.deadline&&!entry.abort.signal.aborted&&current.record===entry.project.record&&current.record.root===entry.project.root&&current.workspaceId===entry.project.workspaceId&&current.record.ports[0]===entry.project.port,'PREVIEW_BINDING_CHANGED');
  need(ctx.agents.get(entry.owner)===entry.access,'PREVIEW_OWNER_CHANGED');entry.capture.assertCurrent();
 }
 async function validateEntry(entry){
  assertEntry(entry);const fresh=await context(entry.sessionId,entry.access);assertEntry(entry);
  need(fresh.root===entry.project.root&&fresh.projectId===entry.project.projectId&&fresh.dev===entry.project.dev&&fresh.ino===entry.project.ino,'PREVIEW_PROJECT_CHANGED');return fresh;
 }
 function connector(entry){return f.connector({custodyFor:run.custodyFor,binding:async()=>{
  await validateEntry(entry);const capture=entry.capture,target=entry.target;
  need(!target.signal.aborted,'PREVIEW_BINDING_REVOKED');
  return Object.freeze({jobId:entry.jobId,owner:entry.owner,generation:capture.identity.generation,projectSessionId:entry.sessionId,workspaceId:entry.project.workspaceId,projectId:entry.project.projectId,projectRoot:entry.project.root,uid:f.uid(),port:entry.project.port,signal:target.signal,assertCurrent(){assertEntry(entry);need(entry.capture===capture&&entry.target===target&&!target.signal.aborted,'PREVIEW_GENERATION_CHANGED');}});
 }});}
 const view=entry=>({version:1,state:entry.state,sessionId:entry.sessionId,previewId:entry.id,jobId:entry.jobId,generation:entry.generation,url:entry.endpoint.origin+'/',expiresAt:entry.deadline,workSettled:entry.workSettled===true,reopenInstructions:'Use project_preview open with this own job ID to obtain a fresh link before the displayed expiry.'});
 const issue=entry=>{const grant=entry.broker.issue();return{...view(entry),url:grant.url,grantExpiresAt:grant.grantExpiresAt};};
 const ownerStatus=entry=>({...view(entry),correlation:{version:1,sessionId:entry.sessionId,ownerAgentId:entry.owner,jobId:entry.jobId,previewId:entry.id,generation:entry.generation,expiresAt:entry.deadline,originalCall:entry.originalCall??null,producerCall:entry.producerCall??null}});
 function revoke(entry){entry.abort.abort();entry.target.abort();entry.relay?.destroyConnections();try{entry.broker?.close();}catch{}if(entry.broker?.server.listening){entry.broker.server.closeAllConnections();entry.broker.server.close();}clearTimeout(entry.timer);}
 async function closeEntry(entry){
  entry.state='closing';revoke(entry);
  try{await bounded(async()=>{try{await run.stopOwned(entry.jobId,entry.owner);}catch{}await entry.producerDone;},f.now()+f.operationMs);entry.workSettled=true;entry.state='closed';}
  catch{entry.state='blocked';entry.workSettled=false;}
  await entry.relay?.close();return view(entry);
 }
 function watch(entry,capture){void Promise.resolve(capture.done).then(()=>{if(entry.capture===capture&&!['restarting','closing','closed'].includes(entry.state))void ordered(entry.sessionId,()=>closeEntry(entry));},()=>{if(entry.capture===capture)void ordered(entry.sessionId,()=>closeEntry(entry));});}
 async function open(sessionId,jobId,access,signal){
  need(available,'PREVIEW_NOT_CONFIGURED');const project=await context(sessionId,access),owner=access.id;
  const prior=entries.get(sessionId);
  if(prior&&prior.state!=='closed'){
   need(prior.owner===owner&&prior.jobId===jobId,'PREVIEW_FOREIGN_JOB');await validateEntry(prior);return issue(prior);
  }
  const capture=await run.custodyFor(jobId,owner);signal?.throwIfAborted();
  // Custody may await asynchronous SDK startup. Recheck before ANY persistent
  // allocation or entry publication, including after controller disposal.
  const fresh=await context(sessionId,access);signal?.throwIfAborted();check();
  need(fresh.record===project.record&&fresh.workspaceId===project.workspaceId&&fresh.port===project.port&&fresh.root===project.root&&fresh.dev===project.dev&&fresh.ino===project.ino,'PREVIEW_PROJECT_CHANGED');
  need(capture.context.projectSessionId===sessionId&&capture.context.workspaceId===project.workspaceId&&capture.context.projectRoot===project.root&&Number.isSafeInteger(capture.expiresAt)&&capture.expiresAt>f.now()&&capture.restartSeed,'PREVIEW_CUSTODY_MISMATCH');
  if(!origins)origins=f.origins(path.join(manager.root,'host-preview-origins.json'),settings);
  const endpoint=origins.allocate(project.projectId),entry={id:randomBytes(16).toString('hex'),sessionId,owner,access,project,capture,producerDone:capture.done,originalCall:capture.call,producerCall:capture.call,generation:capture.identity.generation,seed:capture.restartSeed,jobId,deadline:capture.expiresAt,endpoint,state:'opening',openSignal:signal,abort:new AbortController(),target:new AbortController(),restarts:new Map()};entries.set(sessionId,entry);
  const abortOpen=()=>revoke(entry);signal?.addEventListener('abort',abortOpen,{once:true});if(signal?.aborted)abortOpen();
  try{
   const own=connector(entry),probe=await own.connect({deadline:Math.min(entry.deadline,f.now()+2500),signal});probe.close();await probe.done;await validateEntry(entry);
   const relayDirectory=path.join(manager.root,'preview-relays');await fs.mkdir(relayDirectory,{recursive:true,mode:0o700});need(await fs.realpath(relayDirectory)===relayDirectory,'PREVIEW_RELAY_DIRECTORY_INVALID');
   const socketPath=process.platform==='win32'?'\\\\.\\pipe\\homeai-preview-'+entry.id:path.join(relayDirectory,entry.id+'.sock');
   entry.relay=await f.relay({socketPath,assertCurrent:()=>assertEntry(entry),connect:options=>connector(entry).connect({...options,deadline:Math.min(options.deadline,entry.deadline)})});assertEntry(entry);
   entry.broker=f.broker({purpose:'preview',sessionId,generation:entry.id,origin:endpoint.origin,ownerOrigin:settings.ownerOrigin,socketPath,runtimeDeadline:entry.deadline,now:f.now,onActivity:()=>bounded(()=>validateEntry(entry),Math.min(entry.deadline,f.now()+2500))});
   await f.bind(entry.broker,endpoint);await validateEntry(entry);entry.openSignal=null;entry.state='ready';
   entry.timer=setTimeout(()=>{revoke(entry);void ordered(sessionId,()=>closeEntry(entry));},Math.max(1,entry.deadline-f.now()));entry.timer.unref?.();watch(entry,capture);
   return issue(entry);
  }catch(error){revoke(entry);await entry.relay?.close();entry.state='closed';throw error;}
  finally{signal?.removeEventListener('abort',abortOpen);}
 }
 async function restart(entry,input,signal){
  need(ID.test(input.requestId??'')&&input.previewId===entry.id,'PREVIEW_RESTART_INVALID');
  if(entry.restarts.has(input.requestId))return entry.restarts.get(input.requestId);
  need(entry.restarts.size<16&&input.generation===entry.generation,'PREVIEW_RESTART_STALE');
  await validateEntry(entry);const operation=bounded(async restartSignal=>{
   entry.state='restarting';entry.target.abort();entry.relay.destroyConnections();
   try{
    try{await run.stopOwned(entry.jobId,entry.owner);}catch{}await entry.producerDone;restartSignal.throwIfAborted();
    const fresh=await context(entry.sessionId,entry.access);need(fresh.record===entry.project.record&&fresh.workspaceId===entry.project.workspaceId&&fresh.port===entry.project.port&&fresh.root===entry.project.root&&fresh.dev===entry.project.dev&&fresh.ino===entry.project.ino&&!entry.abort.signal.aborted&&entry.deadline-f.now()>=1000,'PREVIEW_RESTART_CHANGED');
    const background=await executeRestart(entry,restartSignal);restartSignal.throwIfAborted();const capture=await run.custodyFor(background.jobId,entry.owner);restartSignal.throwIfAborted();
    need(capture.expiresAt<=entry.deadline&&capture.context.projectRoot===entry.project.root,'PREVIEW_RESTART_CHANGED');
    entry.capture=capture;entry.generation=capture.identity.generation;entry.jobId=background.jobId;entry.target=new AbortController();entry.state='opening';
    const peer=await connector(entry).connect({deadline:Math.min(entry.deadline,f.now()+2500),signal:restartSignal});peer.close();await peer.done;await validateEntry(entry);restartSignal.throwIfAborted();entry.state='ready';watch(entry,capture);return view(entry);
   }catch(error){entry.state='blocked';entry.target.abort();entry.relay.destroyConnections();throw error;}
  },Math.min(entry.deadline,f.now()+f.operationMs),signal?AbortSignal.any([signal,entry.abort.signal]):entry.abort.signal).catch(error=>{entry.state='blocked';entry.target.abort();entry.relay.destroyConnections();void run.stopOwned(entry.jobId,entry.owner).catch(()=>{});throw error;});entry.restarts.set(input.requestId,operation);return operation;
 }
 async function executeRestart(entry,signal){
  // A one-use server ticket enters the actual SDK guard/approval/heavy-tool
  // pipeline. Ordinary model resolves cannot admit this definition.
  const agent=ctx.agents.get(entry.owner);need(agent===entry.access,'PREVIEW_OWNER_CHANGED');
  const modelSelection=agent.model?.current();need(modelSelection?.provider&&modelSelection?.model,'PREVIEW_MODEL_CONTEXT_REQUIRED');
  const resolveContext={agent,modelSelection,signal:signal??new AbortController().signal},tickets=new WeakSet([resolveContext]);let used=false;
  const remove=agent.ctx.tools.register({name:'project_preview_restart',description:'Internal exact admitted application restart.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:projectBackgroundSchema,render:(_args,value)=>[{type:'text',text:'Owned application restart job: '+value.jobId}]},async execute(args,actual){need(!used&&actual.agent===agent&&Object.keys(args).length===0,'PREVIEW_RESTART_TICKET_INVALID');used=true;return run.startCaptured(entry.seed,actual,{deadline:entry.deadline,onAdmitted(background,producer){entry.jobId=background.jobId;entry.producerDone=producer.done;entry.producerCall=producer.call;need(!entry.abort.signal.aborted,'PREVIEW_RESTART_CHANGED');}});}},{when:value=>tickets.has(value)});
  let toolSet;
  try{toolSet=await ctx.tools.resolve(resolveContext);const report=await ctx.tools.execute({agent,signal:resolveContext.signal,toolSet,calls:[{id:randomUUID(),name:'project_preview_restart',arguments:'{}'}]});const result=report.results?.[0]?.result;need(result&&!result.isError&&result.value?.kind==='background','PREVIEW_RESTART_ADMISSION_FAILED');return result.value;}
  finally{toolSet?.dispose();remove();}
 }
 async function operation(input,{agent,ownerControl=false,signal}={}){
  check();need(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['operation','sessionId','jobId','previewId','generation','requestId'].includes(k))&&['open','status','close','restart'].includes(input.operation),'PREVIEW_REQUEST_INVALID');
  const allowed={open:['operation','sessionId','jobId'],status:['operation','sessionId'],close:['operation','sessionId'],restart:['operation','sessionId','previewId','generation','requestId']}[input.operation];need(Object.keys(input).every(key=>allowed.includes(key)),'PREVIEW_REQUEST_INVALID');
  if(!ownerControl)need(input.sessionId===undefined&&input.operation!=='restart'&&agent,'PREVIEW_REQUEST_INVALID');
  const sessionId=ownerControl?input.sessionId:manager.ownerAgent(agent)?.id;need(ID.test(sessionId??''),'PREVIEW_SESSION_INVALID');
  if(input.operation==='close'){const current=entries.get(sessionId);if(current&&(ownerControl||current.owner===agent?.id))revoke(current);}
  return ordered(sessionId,async()=>{
   const entry=entries.get(sessionId),access=ownerControl?(entry?ctx.agents.get(entry.owner):ctx.agents.get(sessionId)):agent;
   if(!ownerControl&&entry)need(entry.owner===agent.id,'PREVIEW_FOREIGN_JOB');
   if(input.operation==='close'){if(!entry)return{version:1,sessionId,state:'closed',workSettled:true};return closeEntry(entry);}
   if(!available)return{version:1,sessionId,state:'unavailable',code:'PREVIEW_NOT_CONFIGURED'};
   if(input.operation==='open'){need(typeof input.jobId==='string'&&input.jobId.length<=256,'PREVIEW_JOB_REQUIRED');return bounded(s=>open(sessionId,input.jobId,access,s),f.now()+f.operationMs,signal);}
   if(input.operation==='restart'){need(entry,'PREVIEW_NOT_OPEN');return restart(entry,input,signal);}
   await context(sessionId,access);if(!entry)return{version:1,sessionId,state:'closed',workSettled:true};if(entry.state==='ready')await validateEntry(entry);return ownerControl?ownerStatus(entry):view(entry);
  });
 }
 function install(agent){
  if(registrations.has(agent))return;
  const definition={name:'project_preview',description:'Register this conversation’s own managed background app job as an application preview. Use open with its jobId, status, or close. Preview has a fixed lifetime; unavailable configuration never exposes arbitrary host ports.',parameters:{type:'object',properties:{operation:{type:'string',enum:['open','status','close']},jobId:{type:'string'}},required:['operation'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:value.url?'[Open application preview]('+value.url+')\nExpires: '+new Date(value.expiresAt).toISOString()+'\n'+value.reopenInstructions:JSON.stringify(value)}]},execute:(args,actual)=>operation(args,{agent:actual.agent,signal:actual.signal})};
  registrations.set(agent,{definition,remove:agent.ctx.tools.register(definition,{when:({agent:actual})=>{const record=manager.data.sessions[manager.ownerAgent(actual)?.id];return !!record&&!record.legacy;}})});
 }
 function remove(agent){registrations.get(agent)?.remove();registrations.delete(agent);for(const entry of entries.values())if(entry.owner===agent.id||entry.sessionId===agent.id){revoke(entry);void ordered(entry.sessionId,()=>closeEntry(entry));}}
 const revokeSession=sessionId=>{const entry=entries.get(sessionId);if(entry){revoke(entry);void ordered(sessionId,()=>closeEntry(entry));}};
 ctx.on('workspace/session-archived',({sessionId})=>revokeSession(sessionId));
 ctx.on('session/event',(session,event)=>{if(event.type==='sandbox/mode')for(const entry of entries.values())if(entry.sessionId===session.id||entry.owner===session.id)revokeSession(entry.sessionId);});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/preview',methods:['POST'],requestBody:'buffered',async fetch(request){try{if(!sameRequestOrigin(request))return new Response('{"code":"ORIGIN_REFUSED"}',{status:403});return Response.json(await operation(await boundedJSON(request,2048),{ownerControl:true,signal:request.signal}),{headers:{'Cache-Control':'no-store'}});}catch(error){return Response.json({code:error.code??'PREVIEW_UNAVAILABLE'},{status:error.status??503,headers:{'Cache-Control':'no-store'}});}}}));
 const poll=setInterval(()=>{for(const entry of entries.values())if(entry.state==='ready')void validateEntry(entry).catch(()=>{if(entries.get(entry.sessionId)===entry)revokeSession(entry.sessionId);});},1000);poll.unref?.();
 return{install,remove,operation,available,handles:actual=>registrations.get(actual.agent)?.definition===ctx.tools.get(actual.name,actual.agent,actual.toolSet),async dispose(){disposed=true;clearInterval(poll);for(const registration of registrations.values())registration.remove();registrations.clear();for(const entry of entries.values())revoke(entry);await Promise.allSettled([...entries.values()].map(closeEntry));}};
}
