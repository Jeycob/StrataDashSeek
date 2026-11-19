import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {WorkbenchError,validateSettings} from './policy.mjs';
import {sameRequestOrigin,boundedJSON} from './http.mjs';
import {profileComparisons} from './profile-comparisons.mjs';
const {protectedJSON}=createRequire(import.meta.url)('../mobile/runtime-readiness.cjs');
const keys=['maxTokens','thinkingBudget','temperature','topP'];
const fail=(code,message)=>new WorkbenchError(code,message,409);
const label=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
function sampling(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(input,key)))throw fail('INVALID_PROFILE','Provide all four sampling controls.');
 const checked=validateSettings(input);return Object.fromEntries(keys.map(key=>[key,checked[key]]));
}
export function selectedSampling(data,sessionId){
 const selected=data.generationProfiles?.selected?.[sessionId];return selected?sampling(selected.sampling):{};
}
export function freezeGenerationSettings(manager,agent){const session=manager.ownerAgent(agent).session;return{...manager.settings(session),profileSampling:!!manager.data.generationProfiles?.selected?.[session.id]};}
export function generationControls(settings){return{topP:settings.topP,temperature:settings.temperature,maxTokens:settings.maxTokens,thinkingBudget:settings.thinkingBudget,effort:settings.reasoningEffort,...(settings.profileSampling?{profileSampling:true}:{})};}

export function createGenerationProfiles(ctx,manager,{readHistory=()=>protectedJSON('/data/harness/runtime-status','strata-profile-runs.json')}={}){
 async function scope(sessionId){
  const {header,live}=await manager.projectFor(sessionId),session=live??{id:sessionId,header};
  if(header.origin==='subagent')throw fail('PROFILE_SESSION_REQUIRED','Open an ordinary conversation.');
  const workspace=manager.workspaceFor(session);if(!workspace)throw fail('PROFILE_WORKSPACE_REQUIRED','Open a conversation in a workspace.');
  return{session,workspaceId:workspace.id};
 }
 async function inspect(sessionId){
  const {session,workspaceId}=await scope(sessionId),data=manager.data.generationProfiles;
  let history={pairs:[],state:'unavailable'};try{history=profileComparisons(await readHistory(),workspaceId);}catch{}
  const selection=ctx.agents.get(sessionId)?.model.current?.()??null;
  return{version:1,sessionId,profiles:Object.values(data?.profiles??{}).filter(row=>row.workspaceId===workspaceId),selected:data?.selected?.[sessionId]??null,effectiveSampling:Object.fromEntries(keys.map(key=>[key,manager.settings(session)[key]])),selection:selection?{provider:selection.provider,model:selection.model}:null,history};
 }
 async function mutate(sessionId,operation){
  const {workspaceId}=await scope(sessionId);
  return manager.inOrder(async()=>{
   const old=manager.data.generationProfiles,data=structuredClone(old??{profiles:{},selected:{}});let savedProfileId;
   if(operation.op==='save'){
    if(!label(operation.name,80)||operation.expectedQuantization!==undefined&&operation.expectedQuantization!==''&&!label(operation.expectedQuantization,80))throw fail('INVALID_PROFILE','Use a short profile name and requested quantization.');
    const id=operation.id??crypto.randomUUID(),prior=data.profiles[id];
    if(operation.id&&(!prior||prior.workspaceId!==workspaceId))throw fail('PROFILE_NOT_FOUND','Profile not found in this workspace.');
    if(!prior&&Object.values(data.profiles).filter(row=>row.workspaceId===workspaceId).length>=20)throw fail('PROFILE_LIMIT','This workspace already has 20 saved profiles.');
    data.profiles[id]={id,workspaceId,name:operation.name.trim(),version:(prior?.version??0)+1,sampling:sampling(operation.sampling),expectedQuantization:operation.expectedQuantization?.trim()||null,savedAt:Date.now()};
    savedProfileId=id;
   }else if(operation.op==='select'){
    if(operation.id===null)delete data.selected[sessionId];
    else{
     const profile=data.profiles[operation.id];if(!profile||profile.workspaceId!==workspaceId)throw fail('PROFILE_NOT_FOUND','Profile not found in this workspace.');
     const current=ctx.agents.get(sessionId)?.model.current?.();
     if(current?.provider!=='strata-vast')throw fail('STRATA_SELECTION_REQUIRED','Select a registered Strata model for this conversation before applying a sampling profile.');
     data.selected[sessionId]={profileId:profile.id,profileVersion:profile.version,name:profile.name,sampling:sampling(profile.sampling),expectedQuantization:profile.expectedQuantization,selectedAt:Date.now()};
    }
   }else throw fail('INVALID_PROFILE_OPERATION','Unknown profile operation.');
   manager.data.generationProfiles=data;try{await manager.save();}catch(error){if(old===undefined)delete manager.data.generationProfiles;else manager.data.generationProfiles=old;throw error;}
   return{...await inspect(sessionId),...(savedProfileId?{savedProfileId}:{})};
  });
 }
 return{inspect,mutate};
}
export function installGenerationProfiles(ctx,manager){
 const profiles=createGenerationProfiles(ctx,manager),reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/model-profiles',methods:['GET','POST'],requestBody:'buffered',async fetch(request){
  try{
   if(request.method==='GET')return reply(await profiles.inspect(new URL(request.url).searchParams.get('sessionId')));
   if(!sameRequestOrigin(request))return reply({code:'ORIGIN_REFUSED',error:'Same-origin request required.'},403);
   const input=await boundedJSON(request,8192);if(Object.keys(input).some(key=>!['sessionId','op','id','name','sampling','expectedQuantization'].includes(key)))throw fail('INVALID_PROFILE','Unknown profile field.');
   return reply(await profiles.mutate(input.sessionId,input));
  }catch(error){return reply({code:error.code??'PROFILE_FAILED',error:error instanceof WorkbenchError?error.message:'The profile operation could not be confirmed.'},error.status??400);}
 }}));return profiles;
}
