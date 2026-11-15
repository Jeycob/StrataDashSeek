import {createRuntimeAdmission} from './runtime-admission.mjs';
// Shared guards belong to the application root, not the first optional plugin.
const installed=new WeakMap();

// Use the SDK's global asynchronous dispatch boundaries. A synchronous tool
// guard cannot await the root journal and must never return an ignored Promise.
export function installRuntimeAdmission(ctx,config={},injected){
 const owner=ctx.root??ctx;if(installed.has(owner))return installed.get(owner);
 const client=injected??createRuntimeAdmission(config);let requests=0,tools=0;
 const admit=async(operation,signal)=>{const grant=await client.admit(operation,{signal});if(grant.enforced&&grant.expiresAt<=Date.now())throw Object.assign(Error('RUNTIME_ADMISSION_EXPIRED'),{code:'RUNTIME_ADMISSION_EXPIRED'});return grant;};
 owner.on('connection/request',async(req,res,next)=>{
  if(req.method==='GET'&&req.url==='/api/workbench/health')return next();
  const abort=new AbortController(),cancel=()=>abort.abort();req.once('aborted',cancel);
  try{await admit('start_turn',abort.signal);}
  catch(error){if(!res.headersSent&&!res.destroyed){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store','Retry-After':'2'});res.end('{"code":"RUNTIME_ADMISSION_CLOSED","error":"Harness is verifying its runtime. Retry shortly."}');}return;}
  finally{req.removeListener('aborted',cancel);}
  if(res.writableEnded||res.destroyed||abort.signal.aborted)return;
  requests++;try{return await next();}finally{requests--;}
 },{prepend:true,global:true});
 owner.on('agent/pre-step',async(input,next)=>{await admit('model_step',input.signal);return next();},{prepend:true,global:true});
 owner.on('tools/execute',async(exec,next)=>{await admit('tool_dispatch',exec.signal);tools++;try{return await next();}finally{tools--;}},{prepend:true,global:true});
 const api={client,snapshot:()=>({protocol:1,enforced:client.required,activeRequests:requests,activeTools:tools})};installed.set(owner,api);return api;
}
