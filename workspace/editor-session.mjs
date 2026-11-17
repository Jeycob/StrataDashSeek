import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {sameRequestOrigin,boundedJSON} from './http.mjs';
import {WorkbenchError} from './policy.mjs';
import {bindProjectExecution} from './execution-mode.mjs';
const{createEditorBroker}=createRequire(import.meta.url)('./editor-broker.cjs');
const fail=code=>new WorkbenchError(code,'The isolated editor is unavailable for this conversation.',409);

async function editorProject(ctx,manager,sessionId){
 const mode=bindProjectExecution(manager.execution??ctx.projectExecutionMode),check=()=>mode.assertUnchanged();check();
 const project=await manager.projectFor(sessionId);check();const record=manager.data.sessions[sessionId];
 if(!record||record.legacy||record.nativeWorktree||record.independentRepository!==true||manager.data.trash?.[sessionId]||ctx.workspaceRegistry.archivedSessionIds.has(sessionId)||project.header.origin==='subagent')throw fail('EDITOR_PROJECT_NOT_ISOLATED');
 const root=await fs.realpath(record.root);check();const base=await fs.realpath(manager.projectsRoot);check();
 if(root!==record.root||root!==project.root||root===base||!root.startsWith(base+path.sep))throw fail('EDITOR_PROJECT_NOT_ISOLATED');
 for(const[id,other]of Object.entries(manager.data.sessions))if(id!==sessionId&&other.root&&(root===other.root||root.startsWith(other.root+path.sep)||other.root.startsWith(root+path.sep)))throw fail('EDITOR_PROJECT_SHARED');
 if(!project.live)throw fail('EDITOR_SESSION_NOT_LIVE');
 const readOnly=ctx.sandboxPolicy.resolve({session:project.live}).mode==='read-only';
 return{sessionId,projectRoot:root,readOnly};
}
async function listen(broker,endpoint){await new Promise((resolve,reject)=>{broker.server.once('error',reject);broker.server.listen(endpoint.listenerPort,'127.0.0.1',()=>{broker.server.removeListener('error',reject);resolve();});});}

// Only a trusted OS launcher may supply the adapter. No client path, port,
// command, provider credential or caller-supplied isolation claim is accepted.
export function createEditorSessions(ctx,manager,{adapter,origins,ownerOrigin,brokerFactory=createEditorBroker,bind=listen}={},binding=manager.execution??ctx.projectExecutionMode){
 const mode=bindProjectExecution(binding),check=()=>{if(mode.assertUnchanged().mode!=='isolated-guest')throw fail('PROJECT_EXECUTION_MODE_MISMATCH');};check();
 const active=new Map(),queues=new Map(),epochs=new Map(),openings=new Map();let disposed=false;
 function ordered(id,action){const before=queues.get(id)??Promise.resolve(),next=before.catch(()=>{}).then(action);queues.set(id,next);void next.finally(()=>{if(queues.get(id)===next)queues.delete(id);}).catch(()=>{});return next;}
 async function close(sessionId){const current=active.get(sessionId);if(current){active.delete(sessionId);current.broker.close();await adapter.stopEditor({sessionId,generation:current.generation});}return{version:1,sessionId,state:'closed'};}
 function activity(sessionId,generation){
  const entry=active.get(sessionId);try{check();}catch(error){entry?.broker.close();void ordered(sessionId,()=>close(sessionId)).catch(()=>{});return Promise.reject(error);}if(disposed||!entry||entry.generation!==generation||entry.epoch!==(epochs.get(sessionId)??0))return Promise.reject(fail('EDITOR_ACCESS_CHANGED'));
  if(entry.activity)return entry.activity;
  if(entry.nextActivity>Date.now())return Promise.resolve();
  const epoch=epochs.get(sessionId)??0;
  entry.activity=ordered(sessionId,async()=>{
   try{check();const project=await editorProject(ctx,manager,sessionId);check();if(disposed||(epochs.get(sessionId)??0)!==epoch||active.get(sessionId)!==entry||project.readOnly!==entry.readOnly)throw fail('EDITOR_ACCESS_CHANGED');
    await adapter.touchEditor?.({...project,generation});
    check();
    if((epochs.get(sessionId)??0)!==epoch||active.get(sessionId)!==entry)throw fail('EDITOR_ACCESS_CHANGED');entry.nextActivity=Date.now()+30000;
   }catch(error){entry.broker.close();await close(sessionId).catch(()=>{});throw error;}
  }).finally(()=>{entry.activity=null;});return entry.activity;
 }
 async function open(sessionId,requestSignal){
  const controller=new AbortController();openings.set(sessionId,controller);const signal=requestSignal?AbortSignal.any([requestSignal,controller.signal]):controller.signal;
  try{
  check();if(disposed)throw fail('EDITOR_CLOSED');
  if(!adapter||!origins)return{version:1,sessionId,state:'unavailable',code:'EDITOR_ISOLATION_NOT_CONFIGURED'};
  const epoch=epochs.get(sessionId)??0,project=await editorProject(ctx,manager,sessionId);check();
  const endpoint=origins.allocate(sessionId),process=await adapter.ensureEditor({...project,signal});
  if(!process?.ready){check();return{version:1,sessionId,state:process?.state==='starting'?'starting':'unavailable',code:process?.code??'EDITOR_START_UNCONFIRMED'};}
  try{
   check();
   signal?.throwIfAborted();if((epochs.get(sessionId)??0)!==epoch)throw fail('EDITOR_ACCESS_CHANGED');const after=await editorProject(ctx,manager,sessionId),proof=process.isolation;check();
   if(after.projectRoot!==project.projectRoot||after.readOnly!==project.readOnly||proof?.enforced!==true||proof.sessionId!==sessionId||proof.projectRoot!==project.projectRoot||proof.readOnly!==project.readOnly||process.readOnly!==project.readOnly||typeof process.generation!=='string'||!process.generation)throw fail('EDITOR_ISOLATION_UNPROVEN');
   const prior=active.get(sessionId);
   if(prior&&(prior.generation!==process.generation||prior.socketPath!==process.socketPath||prior.readOnly!==project.readOnly)){prior.broker.close();active.delete(sessionId);}
   let entry=active.get(sessionId);
   if(!entry){const broker=brokerFactory({sessionId,generation:process.generation,origin:endpoint.origin,ownerOrigin,socketPath:process.socketPath,runtimeDeadline:process.hardDeadline,onActivity:()=>activity(sessionId,process.generation)});try{await bind(broker,endpoint);}catch(error){broker.close();throw error;}entry={broker,generation:process.generation,socketPath:process.socketPath,readOnly:project.readOnly,epoch};active.set(sessionId,entry);}
   check();return{...entry.broker.issue(),readOnly:project.readOnly};
  }catch(error){await close(sessionId).catch(()=>{});await adapter.stopEditor({sessionId,generation:process.generation}).catch(()=>{});throw error;}
  }finally{if(openings.get(sessionId)===controller)openings.delete(sessionId);}
 }
 return{revoke(sessionId){epochs.set(sessionId,(epochs.get(sessionId)??0)+1);openings.get(sessionId)?.abort(fail('EDITOR_ACCESS_CHANGED'));active.get(sessionId)?.broker.close();void ordered(sessionId,()=>close(sessionId)).catch(()=>ctx.logger?.warn('Editor shutdown needs reconciliation.'));},run(input,signal){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['op','sessionId'].includes(k))||!['open','close'].includes(input.op)||typeof input.sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId))return Promise.reject(fail('EDITOR_REQUEST_INVALID'));
  if(input.op==='close')openings.get(input.sessionId)?.abort(fail('EDITOR_CLOSED'));
  return ordered(input.sessionId,()=>input.op==='close'?close(input.sessionId):open(input.sessionId,signal));
 },async dispose(){disposed=true;for(const controller of openings.values())controller.abort(fail('EDITOR_CLOSED'));await Promise.allSettled([...queues.values()]);await Promise.allSettled([...active.keys()].map(close));await adapter?.dispose?.();}};
}
export function installEditorSessions(ctx,manager,options,binding=manager.execution??ctx.projectExecutionMode){
 const editors=createEditorSessions(ctx,manager,options,binding),reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 ctx.on('workspace/session-archived',({sessionId})=>{editors.revoke(sessionId);});
 ctx.on('session/event',(session,event)=>{if(event.type==='sandbox/mode')editors.revoke(session.id);});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/editor',methods:['POST'],requestBody:'buffered',async fetch(request){
  try{if(!sameRequestOrigin(request))return reply({code:'ORIGIN_REFUSED'},403);return reply(await editors.run(await boundedJSON(request,2048),request.signal));}
  catch(error){return reply({code:error instanceof WorkbenchError?error.code:'EDITOR_UNAVAILABLE',error:'The isolated editor could not be opened. Reconnect from this conversation.'},error.status??503);}
 }}));
 ctx.effect(()=>()=>editors.dispose());return editors;
}
export{editorProject};
