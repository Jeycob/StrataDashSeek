import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {bindProjectExecution} from './execution-mode.mjs';
const fail=code=>Object.assign(Error(code),{code});
// Cordis exports symbols.original for comparing the underlying service, since
// each ctx.get() may return a fresh caller-context proxy.
const original=value=>value?.[Symbol.for('cordis.original')]??value;
const reviewed=Object.freeze({
 todo:{package:'dsh-tool-todo',sha256:'7391f77f8933e5bfee65b92b121b0979d7a16fe7d55a00033698392cd3703d11'},
 ask:{package:'dsh-tool-ask-user',sha256:'bd67c94dcecde5c8c0211a5f347fd28ae9c650d631a5d7f4d6f285dd13250438'},
});
// Lazy, fixed production SDK source. A trusted direct fixture may supply its
// pinned SDK directory; plugin/HTTP configuration never selects this path.
export async function loadReviewedConversationConsumers(sdkRoot='/data/harness/runtime/node_modules'){
 return Object.fromEntries(await Promise.all(Object.entries(reviewed).map(async([key,spec])=>{
  const file=path.join(sdkRoot,'@deepseek-ai',spec.package,'lib/index.js'),stat=await fs.stat(file);
  if(!stat.isFile()||stat.size>65536)throw fail('PROJECT_CONVERSATION_SDK_UNREVIEWED');
  const source=await fs.readFile(file);if(crypto.createHash('sha256').update(source).digest('hex')!==spec.sha256)throw fail('PROJECT_CONVERSATION_SDK_UNREVIEWED');
  return[key,await import(pathToFileURL(file))];
 })));
}

// Only two explicit consumer factories are invoked. No current registry read
// grants trust, and the global ToolsService/SDK modules are never patched.
export function createConversationTools(ctx,binding,{loadConsumers=loadReviewedConversationConsumers,setWatch=setInterval,clearWatch=clearInterval}={}){
 const mode=bindProjectExecution(binding);if(mode.snapshot.mode!=='isolated-guest')throw fail('PROJECT_EXECUTION_MODE_MISMATCH');
 if(typeof binding.assertTool!=='function')throw fail('PROJECT_CONVERSATION_SERVICE_REQUIRED');
 const projections=ctx.get('sessionProjections'),questions=ctx.get('userQuestions'),registrations=new Map(),definitions=new WeakSet(),pending=new Set();
 let disposed=false,disposal,todoTemplate,askTemplate,consumers,projectionHandle;
 function check(execution){
  execution?.signal?.throwIfAborted();mode.assertUnchanged();
  if(disposed)throw fail('PROJECT_CONVERSATION_CLOSED');
  if(execution){if(!registrations.has(execution.agent)||!definitions.has(ctx.tools.get(execution.name,execution.agent,execution.toolSet)))throw fail('PROJECT_CONVERSATION_DEFINITION_CHANGED');binding.assertTool(execution);}
 }
 const sameService=(name,expected)=>{if(original(ctx.get(name))!==original(expected))throw fail('PROJECT_CONVERSATION_SERVICE_CHANGED');};
 function capture(consumer,facade,config){const captured=[];const result=consumer.apply({...facade,tools:{register:definition=>{captured.push(definition);return()=>{};}}},config);return{captured,result};}
 function one(captured){if(captured.length!==1||typeof captured[0].execute!=='function')throw fail('PROJECT_CONVERSATION_CONSUMER_CHANGED');return captured[0];}
 function guardedTodo(args,execution,template){
  check(execution);sameService('sessionProjections',projections);const actual=execution.agent;
  // Native todo validates/canonicalizes synchronously, then calls this exact
  // append. Bind the real Session method; only the private effect view differs.
  const session=new Proxy(actual.session,{get(target,key){if(key==='append')return(...values)=>{check(execution);sameService('sessionProjections',projections);return Reflect.apply(target.append,target,values);};return Reflect.get(target,key,target);}});
  const agent=new Proxy(actual,{get(target,key){return key==='session'?session:Reflect.get(target,key,target);}});
  return template.execute(args,{...execution,agent});
 }
 async function guardedAsk(args,execution){
  check(execution);sameService('userQuestions',questions);const controller=new AbortController(),entry={agent:execution.agent,controller,done:null};
  const abort=reason=>{if(!controller.signal.aborted)controller.abort(reason??fail('PROJECT_CONVERSATION_CLOSED'));};
  const cancelled=()=>abort(execution.signal.reason),inspect=()=>{try{check(execution);sameService('userQuestions',questions);}catch(error){abort(error);}};
  execution.signal.addEventListener('abort',cancelled,{once:true});
  const watch=setWatch(inspect,100);watch?.unref?.();
  entry.done=Promise.resolve().then(async()=>{
   const facade={userQuestions:{ask(request){
    check(execution);sameService('userQuestions',questions);controller.signal.throwIfAborted();
    if(request.agent!==execution.agent||request.signal!==execution.signal||request.wait!==undefined)throw fail('PROJECT_CONVERSATION_QUESTION_SCOPE_CHANGED');
    // The ordinary SDK service validates the exact live non-child caller.
    // No timed/continued reply, steer, approval intent or plan transition is
    // introduced. Await the provider's real settlement even after revocation.
    return questions.ask({...request,signal:controller.signal});
   }}};
   const native=one(capture(consumers.ask,facade,{mode:'legacy'}).captured),value=await native.execute(args,execution);
   controller.signal.throwIfAborted();check(execution);sameService('userQuestions',questions);return value;
  });pending.add(entry);
  try{return await entry.done;}finally{pending.delete(entry);clearWatch(watch);execution.signal.removeEventListener('abort',cancelled);}
 }
 function install(agent){
  check();if(registrations.has(agent))return;const entries=[];registrations.set(agent,entries);
  for(const[kind,template]of [['todo',todoTemplate],['ask',askTemplate]]){
   if(!template)continue;
   const definition={...template,async execute(args,execution){check(execution);const value=await(kind==='todo'?guardedTodo(args,execution,template):guardedAsk(args,execution));check(execution);return value;}};
   definitions.add(definition);entries.push({definition,remove:agent.ctx.tools.register(definition)});
  }
 }
 function remove(agent){
  for(const entry of pending)if(entry.agent===agent)entry.controller.abort(fail('PROJECT_CONVERSATION_SCOPE_CLOSED'));
  for(const entry of registrations.get(agent)??[]){definitions.delete(entry.definition);entry.remove();}registrations.delete(agent);
 }
 const ready=(async()=>{
  check();if(!projections&&!questions)return;
  consumers=await loadConsumers();check();
  if(projections){const registration=capture(consumers.todo,{sessionProjections:{async register(definition){check();sameService('sessionProjections',projections);projectionHandle=await projections.register(definition);check();sameService('sessionProjections',projections);return projectionHandle;}}},{allowParallelInProgress:true});await registration.result;check();todoTemplate=one(registration.captured);}
  if(questions){sameService('userQuestions',questions);askTemplate=one(capture(consumers.ask,{userQuestions:{ask(){throw fail('PROJECT_CONVERSATION_CALL_REQUIRED');}}},{mode:'legacy'}).captured);}
  check();const agents=[...registrations.keys()];for(const agent of agents){remove(agent);install(agent);}
 })();
 return{ready,install,remove,handles:execution=>!disposed&&definitions.has(ctx.tools.get(execution.name,execution.agent,execution.toolSet)),dispose(){if(disposal)return disposal;disposed=true;for(const agent of [...registrations.keys()])remove(agent);for(const entry of pending)entry.controller.abort(fail('PROJECT_CONVERSATION_CLOSED'));disposal=(async()=>{await Promise.allSettled([ready,...[...pending].map(entry=>entry.done)]);await projectionHandle?.dispose?.();})();return disposal;}};
}
