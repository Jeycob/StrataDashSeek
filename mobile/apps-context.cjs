'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const sessionPattern=/^[a-zA-Z0-9_-]{1,128}$/;
const globalRoutes=new Set(['/vault-config','/target-settings','/worker-action','/hold','/preview-settings']);
const projectRoutes=new Set(['/project-settings','/project-action','/releases','/release']);
const getRoutes=new Set(['/state','/job-log','/container-log','/releases','/release','/export-download']);
const postRoutes=new Set(['/register','/scaffold','/vault-config','/project-settings','/target-settings','/project-action','/container-action','/worker-action','/hold','/preview-settings']);
function projectIdFor(directory){return crypto.createHash('sha256').update(directory).digest('hex').slice(0,16);}
function inside(root,file){const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
async function resolveProjectContext({sessionId,scope,workspaceId,projectId,root:clientRoot},workbench,{workspaceRoot,realpath=fs.realpath}={}){
 if(clientRoot!==undefined||projectId!==undefined)throw fail('CONTEXT_AUTHORITY_REFUSED','Project identity comes from the server.',400);
 if(scope==='global'){
  if(sessionId!==undefined&&sessionId!==null||workspaceId!==undefined&&workspaceId!==null)throw fail('AMBIGUOUS_CONTEXT','Global management cannot select a session.',400);
  return Object.freeze({scope:'global',workspaceId:null,sessionId:null,projectId:null});
 }
 if(scope!==undefined&&scope!=='project'||typeof sessionId!=='string'||!sessionPattern.test(sessionId))throw fail('PROJECT_CONTEXT_REQUIRED','Open a project conversation or explicit global management.',400);
 const record=workbench?.projects?.[sessionId],rows=(workbench?.workspaces||[]).filter(row=>Array.isArray(row.sessionIds)&&row.sessionIds.includes(sessionId));
 if(!record||typeof record.root!=='string'||!path.isAbsolute(record.root)||rows.length!==1||typeof rows[0].id!=='string')throw fail('PROJECT_CONTEXT_UNAVAILABLE','The server has no unambiguous project for this conversation.',404);
 if(workbench.trash?.[sessionId])throw fail('PROJECT_ARCHIVED','Restore this conversation before managing its application.');
 if(workspaceId!==undefined&&workspaceId!==rows[0].id)throw fail('PROJECT_CONTEXT_MISMATCH','Workspace does not match this conversation.');
 const base=await realpath(workspaceRoot),directory=await realpath(record.root);
 if(!inside(base,directory))throw fail('PROJECT_OUTSIDE_WORKSPACE','This project is outside the configured application workspace.',403);
 return Object.freeze({scope:'project',workspaceId:rows[0].id,sessionId,projectId:projectIdFor(directory),directory,relativePath:path.relative(base,directory),workspaceRoot:base});
}
function publicContext(context){return{scope:context.scope,workspaceId:context.workspaceId,sessionId:context.sessionId,projectId:context.projectId};}
function scopedAppsState(state,context){
 if(context.scope==='global')return{...state,context:publicContext(context)};
 const projects=(state.projects||[]).filter(project=>project.id===context.projectId);
 if(projects.some(project=>path.normalize(project.path)!==path.normalize(context.relativePath)))throw fail('PROJECT_CONTEXT_MISMATCH','Application registration does not match the conversation.');
 const jobs=(state.jobs||[]).filter(job=>job.projectId===context.projectId),containers=(state.containers||[]).filter(container=>container.projectId===context.projectId);
 // Global administrative values and another project's operation metadata do
 // not belong to a project view. Busy remains a boolean scheduling constraint.
 const{vault,remoteTargets,deploymentRecovery:recovery,projects:ignoredProjects,jobs:ignoredJobs,containers:ignoredContainers,...common}=state;
 const recoveryProjects=(recovery?.projects||[]).filter(id=>id===context.projectId),deploymentRecovery={version:1,required:!!recovery?.required,projects:recoveryProjects,transactions:(recovery?.transactions||[]).filter(row=>row.projectId===context.projectId)};
 return{...common,busy:!!state.busy,projects,jobs,containers,deploymentRecovery,context:publicContext(context),remoteTargets:(remoteTargets||[]).map(({id,name})=>({id,name})),vault:{configured:!!vault?.configured}};
}
async function authorizeAppsOperation(route,method,payload,context,state,{realpath=fs.realpath}={}){
 const data=payload||{};
 if(!(method==='GET'&&getRoutes.has(route)||method==='POST'&&postRoutes.has(route)))throw fail('METHOD_REFUSED','Method or route refused.',405);
 if(data.sessionId!==undefined&&data.sessionId!==context.sessionId||data.workspaceId!==undefined&&data.workspaceId!==context.workspaceId)throw fail('PROJECT_CONTEXT_MISMATCH','Request identity changed after resolving its context.',403);
 if(Object.hasOwn(data,'root')||Object.hasOwn(data,'projectId')||Object.hasOwn(data,'force')||Object.hasOwn(data,'_contextProjectId'))throw fail('CONTEXT_AUTHORITY_REFUSED','Client project authority is not accepted.',400);
 if(context.scope==='global'){
  if(method==='POST'&&data.confirmGlobal!==true)throw fail('GLOBAL_CONFIRMATION_REQUIRED','Confirm the global administrative action.',400);
  return;
 }
 if(globalRoutes.has(route))throw fail('GLOBAL_SCOPE_REQUIRED','Open global management for this administrative action.',403);
 if(route==='/state')return;
 if(route==='/register'||route==='/scaffold'){
  if(method!=='POST')throw fail('METHOD_REFUSED','Method refused.',405);
  if(data.path!==undefined){
   if(typeof data.path!=='string'||!data.path||path.isAbsolute(data.path)||data.path.split(/[\\/]/).some(part=>part==='..'||part==='.'||!part))throw fail('PROJECT_PATH_MISMATCH','Use the current project path.',400);
   const requested=await realpath(path.join(context.workspaceRoot,data.path));if(requested!==context.directory)throw fail('PROJECT_PATH_MISMATCH','The requested path is not this conversation project.',403);
  }
  return;
 }
 if(projectRoutes.has(route)){
  if(data.id!==context.projectId||!(state.projects||[]).some(project=>project.id===data.id))throw fail('PROJECT_CONTEXT_MISMATCH','Application does not belong to this conversation.',403);
  return;
 }
 const collection=route==='/container-action'||route==='/container-log'?state.containers:route==='/job-log'||route==='/export-download'?state.jobs:null;
 if(!collection||!collection.some(item=>item.id===data.id&&item.projectId===context.projectId))throw fail('PROJECT_RESOURCE_MISMATCH','The requested resource is not part of this conversation.',403);
}
function createAppsContextGateway({loadWorkbench,callApps,workspaceRoot,realpath}){
 return async function execute({route,method,query=new URLSearchParams(),payload={},cookie,signal}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('INVALID_OPERATION','Expected an operation object.',400);
  const querySession=query.get('sessionId')??undefined,bodySession=payload.sessionId;
  if(querySession!==undefined&&bodySession!==undefined&&querySession!==bodySession)throw fail('PROJECT_CONTEXT_MISMATCH','Conflicting conversation targets.',400);
  const scope=query.get('scope')??undefined,selector={scope,sessionId:bodySession??querySession,workspaceId:payload.workspaceId,projectId:payload.projectId,root:payload.root};
  const context=await resolveProjectContext(selector,scope==='global'?null:await loadWorkbench({cookie,signal}),{workspaceRoot,realpath});
  const state=await callApps('/state',undefined,{signal});
  const data=method==='GET'?Object.fromEntries(query):payload;
  await authorizeAppsOperation(route,method,data,context,state,{realpath});
  if(route==='/state')return{value:scopedAppsState(state,context),context};
  if(route==='/export-download')return{exportId:data.id,context};
  let value;
  if(method==='GET'){
   const parameters=new URLSearchParams();for(const key of ['id','releaseId'])if(query.has(key))parameters.set(key,query.get(key));
   if(context.scope==='project')parameters.set('_contextProjectId',context.projectId);
   value=await callApps(route+'?'+parameters,undefined,{signal});
  }else{
   const forward={...payload};for(const key of ['sessionId','workspaceId','confirmGlobal'])delete forward[key];
   if(context.scope==='project'){
    forward._contextProjectId=context.projectId;
    if(route==='/register'||route==='/scaffold')forward.path=context.relativePath;
   }
   value=await callApps(route,forward,{signal});
  }
  return{value:{...value,context:publicContext(context)},context};
 };
}
function readWorkbench({port,publicHost,cookie,signal,deadlineMs=8000}){
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>8000)throw fail('INVALID_OPERATION','Invalid project registry deadline.',400);
 return new Promise((resolve,reject)=>{
  let request,timer,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const destroy=error=>{finish(error);request?.destroy(error);};
  try{request=http.get({hostname:'127.0.0.1',port,path:'/api/workbench',signal,headers:{Host:publicHost,...(cookie?{Cookie:cookie}:{})}},response=>{
   let size=0;const chunks=[];
   response.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>2*1024*1024){destroy(fail('WORKBENCH_RESPONSE_TOO_LARGE','Project registry response exceeded the limit.',502));return;}chunks.push(chunk);});response.on('error',finish);
   response.once('end',()=>{if(settled)return;if(response.statusCode!==200)return finish(fail('PROJECT_CONTEXT_UNAVAILABLE','Cannot verify the project registry.',response.statusCode===401?401:503));try{const state=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!state||typeof state!=='object'||Array.isArray(state))throw Error();finish(null,state);}catch{finish(fail('PROJECT_CONTEXT_UNAVAILABLE','Cannot decode the project registry.',502));}});
  });request.on('error',finish);
  timer=setTimeout(()=>destroy(fail('PROJECT_CONTEXT_UNAVAILABLE','Project registry exceeded its deadline.',504)),deadlineMs);
  }catch(error){finish(error);}
 });
}
module.exports={resolveProjectContext,publicContext,scopedAppsState,authorizeAppsOperation,projectIdFor,createAppsContextGateway,readWorkbench};
