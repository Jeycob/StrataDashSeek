'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const reject=(message,status=409)=>Object.assign(new Error(message),{status,code:'PROJECT_CONTEXT_MISMATCH'});
const idFor=directory=>crypto.createHash('sha256').update(directory).digest('hex').slice(0,16);
async function guardAppsTarget(manager,route,data={}){
 const expected=data._contextProjectId;
 // Existing authenticated loopback administration/CLI remains available.
 // The paired gateway always supplies this server-derived binding for project requests.
 if(expected===undefined)return;
 if(typeof expected!=='string'||!/^[a-f0-9]{16}$/.test(expected))throw reject('Invalid project binding.',400);
 if(route==='/state')return;
 if(route==='/register'||route==='/scaffold'){
  if(typeof data.path!=='string'||!data.path||path.isAbsolute(data.path)||data.path.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))throw reject('Invalid project path.',400);
  const root=await fs.realpath(manager.cfg.workspaceRoot),directory=await fs.realpath(path.join(root,data.path)),relative=path.relative(root,directory);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||idFor(directory)!==expected)throw reject('The application path no longer matches the conversation.');
  return;
 }
 if(['/project-settings','/project-action','/releases','/release'].includes(route)){
  if(data.id!==expected)throw reject('The application does not match this conversation.',403);
  const record=manager.project(data.id),directory=await fs.realpath(record.directory||path.join(manager.cfg.workspaceRoot,record.path));
  if(idFor(directory)!==expected)throw reject('The registered project directory changed.');return;
 }
 if(['/job-status','/job-log','/export-download'].includes(route)){
  if(!manager.store.jobs.some(job=>job.id===data.id&&job.projectId===expected))throw reject('The operation does not match this conversation.',403);return;
 }
 if(['/container-action','/container-log'].includes(route)){
  const state=await manager.state();if(!state.containers.some(container=>container.id===data.id&&container.projectId===expected))throw reject('The container does not match this conversation.',403);return;
 }
 throw reject('Project binding is not valid for a global administrative action.',403);
}
module.exports={guardAppsTarget};
