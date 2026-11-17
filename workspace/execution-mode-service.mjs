import {createRequire} from 'node:module';
const {canonical,validateProjection}=createRequire(import.meta.url)('../vast/project-execution-mode.cjs');
const services=new WeakSet(),roots=new WeakMap();
const fail=code=>Object.assign(Error(code),{code});
const denial=error=>({reason:'Project execution is unavailable until its trusted workspace integration is ready.',info:{code:/^PROJECT_EXECUTION_[A-Z_]+$/.test(error?.code||'')?error.code:'PROJECT_EXECUTION_BINDING_UNAVAILABLE'}});

// Explicit trusted fixture/integration seam. No config, browser value, default
// mode, environment read or filesystem operation occurs here or at import.
export function createProjectExecutionMode(binding){
 if(!binding||typeof binding.assertUnchanged!=='function')throw fail('PROJECT_EXECUTION_BINDING_REQUIRED');
 const snapshot=validateProjection(binding.snapshot),identity=canonical(snapshot);
 let workspace=null,active=true;
 function assertUnchanged(){
  if(!active)throw fail('PROJECT_EXECUTION_SERVICE_CLOSED');
  if(canonical(validateProjection(binding.snapshot))!==identity||canonical(validateProjection(binding.assertUnchanged()))!==identity)throw fail('PROJECT_EXECUTION_BINDING_CHANGED');
  return snapshot;
 }
 function assertTool(execution){
  assertUnchanged();
  if(snapshot.mode==='isolated-guest'&&execution?.agent){
   const entry=workspace;if(!entry)throw fail('PROJECT_EXECUTION_WORKSPACE_UNAVAILABLE');
   if(entry.handles(execution)!==true)throw fail('PROJECT_EXECUTION_TOOL_UNHANDLED');
   assertUnchanged();if(workspace!==entry)throw fail('PROJECT_EXECUTION_WORKSPACE_CHANGED');
  }
  return snapshot;
 }
 const service=Object.freeze({snapshot,assertUnchanged,assertTool,
  registerWorkspace(input){
   assertUnchanged();
   if(!input||Object.keys(input).length!==2||typeof input.handles!=='function'||typeof input.beforeHeavy!=='function')throw fail('PROJECT_EXECUTION_WORKSPACE_CONSUMER_REQUIRED');
   if(workspace)throw fail('PROJECT_EXECUTION_WORKSPACE_ALREADY_REGISTERED');
   const entry={handles:input.handles,beforeHeavy:input.beforeHeavy};workspace=entry;
   return()=>{if(workspace===entry)workspace=null;};
  },
  async beforeHeavy(execution){
   assertTool(execution);execution.signal?.throwIfAborted();
   // Dormant compatibility must not construct or call the guest reconciler.
   // Explicit legacy heavy-admission checks remain independently supported.
   if(snapshot.mode==='host-compat')return;
   const entry=workspace;if(!entry)throw fail('PROJECT_EXECUTION_WORKSPACE_UNAVAILABLE');
   await entry.beforeHeavy(execution);
   execution.signal?.throwIfAborted();assertTool(execution);
   if(workspace!==entry)throw fail('PROJECT_EXECUTION_WORKSPACE_CHANGED');
  },
 });
 assertUnchanged();services.add(service);
 return Object.freeze({service,close(){active=false;workspace=null;}});
}

export function requireProjectExecutionMode(ctx){
 const service=ctx.projectExecutionMode;
 if(!services.has(service))throw fail('PROJECT_EXECUTION_BINDING_REQUIRED');
 service.assertUnchanged();return service;
}

// The guard is attached to the SDK root, not to the optional workspace fiber.
// Its slot survives workspace/provider unload and rejects captured native tool
// sets. A replacement provider may reopen only the SAME root launch binding.
function rootSlot(ctx){
 const owner=ctx.root??ctx;
 let record=roots.get(owner);
 if(!record){
  record={identity:null,current:null};roots.set(owner,record);
  owner.tools.guard(execution=>{try{if(!record.current)throw fail('PROJECT_EXECUTION_SERVICE_CLOSED');record.current.service.assertTool(execution);}catch(error){return denial(error);}});
  owner.on('tools/execute',async(execution,next)=>{
   execution.signal?.throwIfAborted();
   if(!record.current)throw fail('PROJECT_EXECUTION_SERVICE_CLOSED');
   record.current.service.assertTool(execution);return next();
  },{prepend:true,global:true});
 }
 return record;
}
export function installClosedProjectExecutionSlot(ctx){rootSlot(ctx);}
export function installProjectExecutionMode(ctx,binding){
 // Establish the closed guard before validating or reading a supplied binding.
 const record=rootSlot(ctx),created=createProjectExecutionMode(binding),identity=canonical(created.service.snapshot);
 if(record.identity!==null&&record.identity!==identity)throw fail('PROJECT_EXECUTION_ROOT_BINDING_CHANGED');
 if(record.current)throw fail('PROJECT_EXECUTION_SERVICE_ALREADY_REGISTERED');
 record.identity=identity;
 record.current=created;
 try{ctx.provide('projectExecutionMode',created.service);}
 catch(error){record.current=null;created.close();throw error;}
 ctx.effect(()=>()=>{created.close();if(record.current===created)record.current=null;});
 return created.service;
}
