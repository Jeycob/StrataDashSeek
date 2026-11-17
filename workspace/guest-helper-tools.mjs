import {executeVerification} from '../quality/plugin.mjs';
import {bindProjectExecution} from './execution-mode.mjs';
const fail=code=>Object.assign(Error(code),{code});
const object={type:'object',additionalProperties:true};
// Definitions are constructed here, never accepted by name from a refreshed
// SDK registry. All three helpers use the same bound guest callbacks as T03/T06.
export function createGuestHelperTools(ctx,manager,context,binding,assertAvailable){
 const mode=bindProjectExecution(binding),registrations=new Map(),definitions=new WeakSet();let disposed=false;
 const check=execution=>{execution.signal.throwIfAborted();if(disposed||mode.assertUnchanged().mode!=='isolated-guest')throw fail('PROJECT_EXECUTION_GUEST_CONTEXT_UNAVAILABLE');assertAvailable?.();};
 const files={type:'array',maxItems:6,items:{type:'object',properties:{path:{type:'string'},start:{type:'integer',minimum:1},lines:{type:'integer',minimum:1,maximum:120}},required:['path'],additionalProperties:false}};
 const specs=[
  ['focus_context',{type:'object',properties:{files},additionalProperties:false},async(args,execution)=>(await context.focus({arguments:args,execution})).value],
  ['explain_rewrite',{type:'object',properties:{path:{type:'string'},sha256:{type:'string'},reason:{type:'string',minLength:30,maxLength:1500},validationPlan:{type:'string',minLength:30,maxLength:1500}},required:['path','sha256','reason','validationPlan'],additionalProperties:false},async(args,execution)=>(await context.explain({arguments:args,execution})).value],
  ['verify_project',{type:'object',properties:{kind:{type:'string',enum:['all','build','test','browser','acceptance']}},additionalProperties:false},(args,execution)=>executeVerification(ctx,args,execution)],
 ];
 function install(agent){mode.assertUnchanged();if(disposed||registrations.has(agent))return;const entries=[];registrations.set(agent,entries);for(const[name,parameters,execute]of specs){const definition={name,parameters,description:'Bound isolated project '+name+'. Uses only the trusted guest executor; unavailable guest services fail closed. Verification contract: /opt/homeai/quality/README.md. Rewrite explanations are exact-hash, single-use grants after a working milestone.',isConcurrencySafe:()=>name==='focus_context',output:{schema:object,render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,execution){check(execution);const value=await execute(args,execution);check(execution);return value;}};definitions.add(definition);entries.push({definition,remove:agent.ctx.tools.register(definition)});}}
 function remove(agent){for(const entry of registrations.get(agent)??[]){definitions.delete(entry.definition);entry.remove();}registrations.delete(agent);}
 return{install,remove,handles:execution=>definitions.has(ctx.tools.get(execution.name,execution.agent,execution.toolSet)),dispose(){disposed=true;for(const agent of [...registrations.keys()])remove(agent);}};
}

// Job IDs are always scoped to the actual executing conversation, including
// children. The native job callbacks are not retained; output is bounded here.
export function createGuestJobTools(ctx,binding){
 const mode=bindProjectExecution(binding),registrations=new Map(),definitions=new WeakSet();let disposed=false,controller;
 const check=execution=>{execution.signal.throwIfAborted();if(disposed||mode.assertUnchanged().mode!=='isolated-guest')throw fail('PROJECT_EXECUTION_BINDING_CHANGED');};
 const registry=()=>{const jobs=ctx.get('jobs');if(!jobs||typeof jobs.list!=='function')throw fail('PROJECT_JOBS_UNAVAILABLE');if(!controller)controller=jobs.attachController('workspace-isolated-jobs');return jobs;};
 // SDK requires a serving controller BEFORE jobs.start(), not after the first
 // job_output call. Missing jobs remain a supported explicit unavailable state.
 if(ctx.get('jobs'))registry();
 const view=job=>{if(!job)return null;return Object.fromEntries(['id','kind','label','status','detail','startedAt','finishedAt'].filter(k=>job[k]!==undefined).map(k=>[k,typeof job[k]==='string'?job[k].slice(0,500):job[k]]));};
 const specs=[['job_list',{type:'object',properties:{},additionalProperties:false},async(_args,execution)=>({jobs:registry().list(execution.agent.id).slice(-100).map(view)})],
 ['job_output',{type:'object',properties:{job_id:{type:'string'},wait_ms:{type:'integer',minimum:0,maximum:30000}},required:['job_id'],additionalProperties:false},async(args,execution)=>{const jobs=registry(),owner=execution.agent.id;if(args.wait_ms)await jobs.wait(args.job_id,Math.min(30000,args.wait_ms),owner,execution.signal);check(execution);const value=jobs.read(args.job_id,owner);return{job:view(value.job),text:value.chunks.map(chunk=>chunk.text).join('').slice(-16000),lossy:value.lossy===true,result:value.result===undefined?undefined:JSON.stringify(value.result).slice(-16000)};}],
 ['job_kill',{type:'object',properties:{job_id:{type:'string'}},required:['job_id'],additionalProperties:false},async(args,execution)=>{registry().kill(args.job_id,execution.agent.id,'Stopped by the owning conversation');return{requested:true};}]];
 function install(agent){mode.assertUnchanged();if(disposed||registrations.has(agent))return;const entries=[];registrations.set(agent,entries);for(const[name,parameters,execute]of specs){const definition={name,parameters,description:'Inspect or stop only this executing conversation\'s SDK-owned background jobs. Output is bounded; no process adoption or host shell fallback.',isConcurrencySafe:()=>name!=='job_kill',output:{schema:object,render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,execution){check(execution);const value=await execute(args,execution);check(execution);return value;}};definitions.add(definition);entries.push({definition,remove:agent.ctx.tools.register(definition)});}}
 function remove(agent){for(const entry of registrations.get(agent)??[]){definitions.delete(entry.definition);entry.remove();}registrations.delete(agent);}
 return{install,remove,handles:execution=>definitions.has(ctx.tools.get(execution.name,execution.agent,execution.toolSet)),dispose(){disposed=true;controller?.();for(const agent of [...registrations.keys()])remove(agent);}};
}
