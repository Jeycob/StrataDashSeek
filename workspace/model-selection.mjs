import {WorkbenchError,DEFAULTS} from './policy.mjs';
import {sameRequestOrigin,boundedJSON} from './http.mjs';

const routeKeys=['provider','model','reasoningEffort'];
const route=value=>Object.fromEntries(routeKeys.filter(key=>typeof value?.[key]==='string').map(key=>[key,value[key]]));
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
const unavailable=()=>new WorkbenchError('MODEL_UNAVAILABLE','This model is not available in the current model registry. Refresh Models and choose an available model.',409);

/** Registry identity, never the display label, owns routing. */
export async function registeredSelection(ctx,input,{defaultEffort=false}={}){
 if(!identity(input?.provider)||!identity(input?.model))throw unavailable();
 if(!ctx.llm.listProviders().some(p=>p.id===input.provider))throw unavailable();
 let models;try{models=await ctx.llm.listModels(input.provider);}catch{throw unavailable();}
 if(!models.some(m=>m.id===input.model))throw unavailable();
 const info=await ctx.llm.resolveModelInfo(input.provider,input.model),selection={provider:input.provider,model:input.model};
 const efforts=info.reasoning?.efforts??[];
 if(input.reasoningEffort!==undefined){
  if(efforts.some(e=>e.id===input.reasoningEffort))selection.reasoningEffort=input.reasoningEffort;
  else if(!defaultEffort)throw new WorkbenchError('EFFORT_UNAVAILABLE','This reasoning level is unavailable for the selected model.',409);
 }
 // Omitted effort follows the selected adapter, not the local model's default.
 await ctx.llm.resolveCallConfig(selection);
 return selection;
}

export async function modelCatalog(ctx){
 const groups=[],failures=[];
 await Promise.all(ctx.llm.listProviders().map(async provider=>{
  try{const models=await ctx.llm.listModels(provider.id);groups.push({id:provider.id,name:provider.name||provider.id,models:await Promise.all(models.map(async model=>{
   const info=await ctx.llm.resolveModelInfo(provider.id,model.id);
   return{id:model.id,name:model.name||model.id,...(info.reasoning?{reasoning:{efforts:info.reasoning.efforts.map(e=>({id:e.id,name:e.name||e.id})),defaultEffort:info.reasoning.defaultEffort}}:{})};
  }))});}catch{failures.push({id:provider.id,code:'CATALOG_UNAVAILABLE'});}
 }));
 return{groups,failures};
}

export function createModelSelection(ctx,manager){
 const ownSelections=new Set();
 async function agentFor(sessionId){
  await manager.projectFor(sessionId); // Existing server-owned session validation.
  let agent=ctx.agents.get(sessionId);
  if(!agent){const controller=ctx.sessionController??ctx.get?.('sessionController');if(controller){const result=await controller.resolveAgent(sessionId);if(result.error)throw result.error;agent=result.agent;}}
  if(!agent||agent.session.header.origin==='subagent')throw new WorkbenchError('SESSION_NOT_EDITABLE','Open an ordinary conversation before changing its model.',409);
  return agent;
 }
 const workspaceRoute=session=>route(manager.settings(session));
 async function inspect(sessionId,{catalog=true}={}){
  const {header,live}=await manager.projectFor(sessionId),session=live??{id:sessionId,header},agent=ctx.agents.get(sessionId);
  const preference=manager.data.modelPreferences?.[sessionId];
  const selected=agent?.model.current?.()??preference?.selection??workspaceRoute(session);
  const last=live?.requestHeader?.()?.config;
  const defaults=workspaceRoute(session),source=preference?.mode??(selected.provider===defaults.provider&&selected.model===defaults.model?'workspace':'session');
  return{version:1,sessionId,source,selection:route(selected),workspaceDefault:defaults,lastUsed:last?route(last):null,...(catalog?await modelCatalog(ctx):{})};
 }
 async function select(sessionId,input){
  const agent=await agentFor(sessionId);
  return manager.inOrder(async()=>{
   const selection=await registeredSelection(ctx,input===null?workspaceRoute(agent.session):input,{defaultEffort:input===null});
   const preferences=manager.data.modelPreferences??={},old=preferences[sessionId];
   preferences[sessionId]={mode:input===null?'workspace':'session',selection,at:Date.now()};
   try{await manager.save();}catch(error){if(old===undefined)delete preferences[sessionId];else preferences[sessionId]=old;throw error;}
   // This appends the SDK's durable session selection, without changing the
   // account-wide default or any other session. A running request keeps its
   // already fixed model; the next step observes this selection.
   ownSelections.add(sessionId);try{agent.model.select(selection);}finally{ownSelections.delete(sessionId);}
   return inspect(sessionId,{catalog:false});
  });
 }
 async function restore(agent){
  if(agent.session.header.origin==='subagent')return;
  const preference=manager.data.modelPreferences?.[agent.session.id];
  if(preference){const selected=await registeredSelection(ctx,preference.mode==='session'?preference.selection:workspaceRoute(agent.session),{defaultEffort:preference.mode!=='session'});ownSelections.add(agent.session.id);try{agent.model.select(selected);}finally{ownSelections.delete(agent.session.id);}}
 }
 function observe(session,event){
  // Native /model remains a supported entry point. Its newer durable choice
  // must not be overwritten by an older workbench preference after reload.
  if(event.type!=='model/selection'||ownSelections.has(session.id)||!manager.data.modelPreferences?.[session.id])return;
  delete manager.data.modelPreferences[session.id];
  void manager.save().catch(()=>ctx.logger?.warn('Model preference reconciliation was not persisted.'));
 }
 async function restoreAfterDefaults(agent,source,applyDefaults){await applyDefaults(agent,source);await restore(agent);}
 return{inspect,select,restore,restoreAfterDefaults,observe};
}

/** Called by the existing workspace settings path before committing overrides. */
export async function validateWorkspaceModel(ctx,input){
 return registeredSelection(ctx,{...DEFAULTS,...input},{defaultEffort:!Object.hasOwn(input,'reasoningEffort')});
}

export function installModelSelection(ctx,manager,{lifecycle=true}={}){
 const models=createModelSelection(ctx,manager);
 if(lifecycle)ctx.on('agent/created',({agent})=>models.restore(agent),{global:true});
 ctx.on('session/event',(session,event)=>models.observe(session,event));
 const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/models',methods:['GET','POST'],requestBody:'buffered',async fetch(request){
  try{
   if(request.method!=='GET'&&!sameRequestOrigin(request))return reply({code:'ORIGIN_REFUSED',error:'Same-origin request required.'},403);
   if(request.method==='GET')return reply(await models.inspect(new URL(request.url).searchParams.get('sessionId')));
   const data=await boundedJSON(request);if(!Object.hasOwn(data,'selection'))throw unavailable();
   return reply(await models.select(data.sessionId,data.selection));
  }catch(error){return reply({code:error.code??'MODEL_SELECTION_FAILED',error:error instanceof WorkbenchError?error.message:'The model change could not be confirmed. Refresh before retrying.'},error.status??400);}
 }}));
 return models;
}
