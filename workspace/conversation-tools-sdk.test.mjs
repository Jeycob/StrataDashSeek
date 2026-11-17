// Pinned real SDK consumers, Sessions, projections, question service and Tools
// pipeline. Question answerers are inert local fixtures, never a UI/remote.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createConversationTools,loadReviewedConversationConsumers} from './conversation-tools.mjs';
import {installProjectExecutionMode} from './execution-mode-service.mjs';
import {executionBindingFixture} from './fixtures/execution-binding.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)));
const [{Context},{default:SystemPrompt},{default:Tools},{ToolExecutionPipeline,executeToolBatch},{createScope,bindScopeParent},{Session},{default:Projections},{default:UserQuestions}]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js'),load('dsh-scope'),load('dsh-session'),load('dsh-session-projection'),load('dsh-user-questions')]);
const consumers=await loadReviewedConversationConsumers(SDK),defer=()=>{let resolve,reject;return{promise:new Promise((r,j)=>{resolve=r;reject=j;}),resolve:value=>resolve(value),reject:error=>reject(error)};},tick=()=>new Promise(resolve=>setImmediate(resolve));
const question={questions:[{id:'choice',question:'Which synthetic option should be used?',options:[{label:'A'},{label:'B'}]}]},answer={answers:[{id:'choice',selected:['A'],custom:'synthetic'}]};
async function fixture(t,{mode='isolated-guest',initial=true,missing=false}={}){
 const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);new Projections(ctx);
 const agents=new Map(),scopes=[],events=new Map(),watchers=new Set(),state={native:0,questions:[],settled:0,appends:[]},source=executionBindingFixture(mode);
 ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});new UserQuestions(ctx);
 await consumers.todo.apply(ctx,{allowParallelInProgress:true});consumers.ask.apply(ctx,{mode:'legacy'});
 const nativeTodo=ctx.tools.get('todo_write'),nativeAsk=ctx.tools.get('ask_user_question');
 for(const name of ['read','create_goal','subagent','session_search','exit_plan_mode'])ctx.tools.register({name,description:'Unreviewed inert fixture '+name,parameters:{type:'object',additionalProperties:true},output:{schema:{type:'object'},render:()=>[{type:'text',text:'native'}]},execute(){state.native++;return{};}});
 let service;const provider=ctx.plugin({name:'trusted-mode-provider',inject:['tools'],apply(owner){service=installProjectExecutionMode(owner,source.binding);}});await provider.await();
 function agent(id,{child=false}={}){const session=new Session(id,undefined,{version:4,id,createdAt:1,isSeeded:false,...(child?{origin:'subagent',parentSession:'owner'}:{})}),value={id,session,status:'idle'},scope=createScope(ctx,value),rows=[];value.ctx=scope.ctx;scopes.push(scope);agents.set(id,value);events.set(id,rows);const append=session.append.bind(session);session.append=(type,data)=>{state.appends.push({id,type});const event=append(type,data);rows.push(event);ctx.emit('session/event',session,event);return event;};return value;}
 const owner=agent('owner'),pipeline=new ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>executeToolBatch(input,pipeline,()=>2)});
 const admit=(actual=owner)=>ctx.tools.resolve({agent:actual,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal}),native=await admit();
 let helper,close,consumer;
 function create(){
  helper=createConversationTools(ctx,service,{loadConsumers:async()=>consumers,setWatch:fn=>{watchers.add(fn);return{fn,unref(){}};},clearWatch:value=>watchers.delete(value.fn)});
  for(const value of agents.values())helper.install(value);return helper;
 }
 async function mount(){if(missing)return;create();await helper.ready;close=service.registerWorkspace({handles:helper.handles,beforeHeavy:async()=>{}});}
 if(initial)await mount();
 async function call(name,args={},options={}){const actual=options.agent??owner,toolSet=options.toolSet??await admit(actual);try{return(await ctx.tools.execute({agent:actual,toolSet,signal:options.signal??new AbortController().signal,calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]})).results[0].result;}finally{if(!options.toolSet)toolSet.dispose();}}
 let answerer=async()=>answer;ctx.on('user-questions/request',async request=>{state.questions.push(request);try{return await answerer(request);}finally{state.settled++;}},{global:true});
 t.after(async()=>{close?.();await helper?.dispose();native.dispose();for(const scope of scopes)await scope.dispose();await provider.dispose();await ctx.fiber.dispose();});
 return{ctx,owner,agent,events,state,service,source,provider,helper:()=>helper,mount,create,admit,native,nativeTodo,nativeAsk,call,setAnswerer:fn=>answerer=fn,poll(){for(const fn of [...watchers])fn();},watchers,close:()=>close?.(),setClose:fn=>close=fn};
}

test('reviewed consumers retain exact SDK input/output schemas, rendering and ordinary event effects',async t=>{
 const f=await fixture(t),todo=f.ctx.tools.get('todo_write',f.owner),ask=f.ctx.tools.get('ask_user_question',f.owner);
 assert.deepEqual(todo.parameters,f.nativeTodo.parameters);assert.deepEqual(todo.output.schema,f.nativeTodo.output.schema);assert.deepEqual(ask.parameters,f.nativeAsk.parameters);assert.deepEqual(ask.output.schema,f.nativeAsk.output.schema);
 const todos=[{content:'  Do the synthetic task  ',status:'in_progress'},{content:'Parallel task',status:'in_progress'}],value=await f.call('todo_write',{todos});assert.equal(value.isError,false,JSON.stringify(value));assert.deepEqual(value.value.todos,[{content:'Do the synthetic task',status:'in_progress'},{content:'Parallel task',status:'in_progress'}]);assert.deepEqual(todo.output.render({},value.value),f.nativeTodo.output.render({},value.value));assert.deepEqual(f.ctx.sessionProjections.snapshot(f.owner.session,['todos']).values.todos,value.value.todos);assert.equal(f.events.get('owner').filter(event=>event.type==='todo/write').length,1);
 const asked=await f.call('ask_user_question',question);assert.equal(asked.isError,false,JSON.stringify(asked));assert.deepEqual(asked.value,answer);assert.deepEqual(ask.output.render({},asked.value),f.nativeAsk.output.render({},asked.value));assert.equal(f.state.questions[0].agent,f.owner);assert.notEqual(f.state.questions[0].signal,undefined);assert.equal(f.watchers.size,0);
});
test('captured native definitions and foreign replacement definitions never gain admission; unrelated tools remain closed',async t=>{
 const f=await fixture(t);assert.equal((await f.call('todo_write',{todos:[]},{toolSet:f.native})).isError,true);assert.equal((await f.call('ask_user_question',question,{toolSet:f.native})).isError,true);
 const original=f.ctx.tools.get('todo_write',f.owner),guest=await f.admit();t.after(()=>guest.dispose());f.helper().remove(f.owner);const remove=f.owner.ctx.tools.register({...original,execute(){f.state.native++;return{todos:[],counts:{pending:0,inProgress:0,completed:0}};}});assert.equal((await f.call('todo_write',{todos:[]})).isError,true);assert.equal((await f.call('todo_write',{todos:[]},{toolSet:guest})).isError,true);remove();f.helper().install(f.owner);
 for(const name of ['read','create_goal','subagent','session_search','exit_plan_mode'])assert.equal((await f.call(name,{})).isError,true);assert.equal(f.state.native,0);assert.equal(f.state.questions.length,0);assert.equal(f.events.get('owner').length,0);
});
test('actual SDK preset-ancestor definitions are shadowed in the agent layer before fresh resolution',async t=>{
 const f=await fixture(t,{initial:false}),key={},preset=createScope(f.ctx,key);t.after(()=>preset.dispose());await consumers.todo.apply(preset.ctx,{allowParallelInProgress:true});consumers.ask.apply(preset.ctx,{mode:'legacy'});bindScopeParent(f.owner,key);const inherited=f.ctx.tools.get('todo_write',f.owner);assert.notEqual(inherited,f.nativeTodo);const captured=await f.admit();t.after(()=>captured.dispose());await f.mount();assert.notEqual(f.ctx.tools.get('todo_write',f.owner),inherited);assert.equal((await f.call('todo_write',{todos:[]},{toolSet:captured})).isError,true);assert.equal((await f.call('todo_write',{todos:[]})).isError,false);assert.equal(f.events.get('owner').filter(event=>event.type==='todo/write').length,1);
});
test('todo respects the actual child Session; ordinary SDK questions still reject delegated callers',async t=>{
 const f=await fixture(t),child=f.agent('child',{child:true});f.helper().install(child);
 assert.equal((await f.call('todo_write',{todos:[{content:'Child task',status:'pending'}]},{agent:child})).isError,false);assert.equal(f.events.get('child').at(-1).type,'todo/write');assert.equal(f.events.get('owner').length,0);
 const asked=await f.call('ask_user_question',question,{agent:child});assert.equal(asked.isError,true);assert.match(JSON.stringify(asked),/DELEGATED_CALLER|owned by another live agent/);assert.equal(f.state.questions.length,0);
});
test('invalid native todo values append nothing and stale binding blocks every new helper effect',async t=>{
 const f=await fixture(t);for(const todos of [[{content:' ',status:'pending'}],[{content:'same',status:'pending'},{content:'same',status:'completed'}],[{content:'invalid',status:'unknown'}]])assert.equal((await f.call('todo_write',{todos})).isError,true);assert.equal(f.state.appends.length,0);
 f.source.fail();assert.equal((await f.call('todo_write',{todos:[]})).isError,true);assert.equal((await f.call('ask_user_question',question)).isError,true);assert.equal(f.state.appends.length,0);assert.equal(f.state.questions.length,0);
});
test('todo rechecks binding immediately at the native Session.append effect',async t=>{
 const f=await fixture(t,{initial:false}),counts={checks:0,atAppend:0};const service={snapshot:f.service.snapshot,assertUnchanged(){counts.checks++;return f.service.assertUnchanged();},assertTool:execution=>f.service.assertTool(execution)};
 const helper=createConversationTools(f.ctx,service,{loadConsumers:async()=>consumers});helper.install(f.owner);await helper.ready;const close=f.service.registerWorkspace({handles:helper.handles,beforeHeavy:async()=>{}});f.setClose(close);t.after(()=>helper.dispose());const append=f.owner.session.append.bind(f.owner.session);f.owner.session.append=(...args)=>{counts.atAppend=counts.checks;return append(...args);};
 const before=counts.checks;assert.equal((await f.call('todo_write',{todos:[]})).isError,false);assert(counts.atAppend>=before+3,'entry/body/effect checks occurred before append');assert(counts.checks>counts.atAppend,'result check follows the effect');
});
test('binding revocation cancels the owned ordinary question and drains delayed provider cleanup',async t=>{
 const f=await fixture(t),entered=defer(),cleanup=defer();let aborted=false,returned=false;
 f.setAnswerer(request=>{entered.resolve();return new Promise((resolve,reject)=>request.signal.addEventListener('abort',async()=>{aborted=true;await cleanup.promise;reject(request.signal.reason);},{once:true}));});
 const pending=f.call('ask_user_question',question).then(value=>{returned=true;return value;});await entered.promise;f.source.fail();f.poll();await tick();assert.equal(aborted,true);assert.equal(returned,false);assert.equal(f.state.settled,0);cleanup.resolve();assert.equal((await pending).isError,true);assert.equal(f.state.settled,1);assert.equal(f.watchers.size,0);
});
test('a late answer after binding revocation cannot become a successful tool result or start a new session effect',async t=>{
 const f=await fixture(t),entered=defer(),late=defer();let request;
 f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const pending=f.call('ask_user_question',question);await entered.promise;f.source.fail();f.poll();assert.equal(request.signal.aborted,true);late.resolve(answer);const result=await pending;assert.equal(result.isError,true);assert.equal(f.state.questions.length,1);assert.equal(f.state.appends.length,0);assert.equal(f.watchers.size,0);
});
test('scope removal cancels only its owned question, drains settlement, and captured sets stay closed',async t=>{
 const f=await fixture(t),entered=defer(),late=defer();let request;f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const guest=await f.admit();t.after(()=>guest.dispose());const pending=f.call('ask_user_question',question,{toolSet:guest});await entered.promise;f.helper().remove(f.owner);assert.equal(request.signal.aborted,true);late.resolve(answer);assert.equal((await pending).isError,true);assert.equal((await f.call('todo_write',{todos:[]},{toolSet:guest})).isError,true);assert.equal(f.state.appends.length,0);
});
test('consumer disposal cancels and waits for the original question even when its answerer ignores abort',async t=>{
 const f=await fixture(t),entered=defer(),late=defer();let request,closed=false;f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const pending=f.call('ask_user_question',question);await entered.promise;f.close();const original=f.helper().dispose();assert.equal(f.helper().dispose(),original);const closing=original.then(()=>{closed=true;});await tick();assert.equal(request.signal.aborted,true);assert.equal(closed,false);assert.equal((await f.call('todo_write',{todos:[]})).isError,true);late.resolve(answer);await closing;assert.equal((await pending).isError,true);assert.equal(f.watchers.size,0);assert.equal(f.state.appends.length,0);
});
test('caller abort uses the owned signal and does not return before actual provider settlement',async t=>{
 const f=await fixture(t),entered=defer(),late=defer(),controller=new AbortController();let request,done=false;f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const pending=f.call('ask_user_question',question,{signal:controller.signal}).then(value=>{done=true;return value;});await entered.promise;controller.abort(Error('synthetic caller abort'));await tick();assert.equal(request.signal.aborted,true);assert.equal(done,false);late.resolve(answer);assert.equal((await pending).isError,true);assert.equal(f.watchers.size,0);
});
test('mandatory binding provider close aborts an owned question and no late answer restores admission',async t=>{
 const f=await fixture(t),entered=defer(),late=defer();let request;f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const pending=f.call('ask_user_question',question);await entered.promise;await f.provider.dispose();f.poll();assert.equal(request.signal.aborted,true);late.resolve(answer);assert.equal((await pending).isError,true);assert.equal((await f.call('todo_write',{todos:[]})).isError,true);assert.equal(f.state.appends.length,0);
});
test('a different underlying question service cancels its pending request without treating fresh Cordis proxies as a reload',async t=>{
 const f=await fixture(t,{initial:false}),entered=defer(),late=defer();let replacement,watch,request;const facade={tools:f.ctx.tools,get:name=>name==='userQuestions'&&replacement?replacement:f.ctx.get(name)},helper=createConversationTools(facade,f.service,{loadConsumers:async()=>consumers,setWatch:fn=>{watch=fn;return{unref(){}};},clearWatch(){}});helper.install(f.owner);await helper.ready;f.setClose(f.service.registerWorkspace({handles:helper.handles,beforeHeavy:async()=>{}}));t.after(()=>helper.dispose());
 f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const pending=f.call('ask_user_question',question);await entered.promise;watch();assert.equal(request.signal.aborted,false);replacement={ask(){assert.fail('replacement must never receive this request');}};watch();assert.equal(request.signal.aborted,true);late.resolve(answer);assert.equal((await pending).isError,true);assert.equal((await f.call('ask_user_question',question)).isError,true);assert.equal(f.state.questions.length,1);assert.equal((await f.call('todo_write',{todos:[]})).isError,false);await helper.dispose();
});
test('real sibling helper fiber unload closes admission before draining its pending question',async t=>{
 const f=await fixture(t,{initial:false}),entered=defer(),late=defer();let helper,request,closed=false;const consumer=f.ctx.plugin({name:'owned-conversation-consumer',inject:['tools','projectExecutionMode','sessionProjections','userQuestions'],async apply(owner){helper=createConversationTools(owner,owner.projectExecutionMode,{loadConsumers:async()=>consumers});helper.install(f.owner);await helper.ready;const close=owner.projectExecutionMode.registerWorkspace({handles:helper.handles,beforeHeavy:async()=>{}});owner.effect(()=>()=>{close();return helper.dispose();});}});await consumer.await();assert.equal((await f.call('todo_write',{todos:[]})).isError,false);
 f.setAnswerer(value=>{request=value;entered.resolve();return late.promise;});const pending=f.call('ask_user_question',question);await entered.promise;const closing=consumer.dispose().then(()=>{closed=true;});await tick();assert.equal(request.signal.aborted,true);assert.equal(closed,false);assert.equal((await f.call('todo_write',{todos:[]})).isError,true);late.resolve(answer);await closing;assert.equal((await pending).isError,true);assert.equal(f.state.questions.length,1);
});
test('late SDK readiness after unload cannot publish scoped helper definitions or projection ownership',async t=>{
 const f=await fixture(t,{initial:false}),loaded=defer();const helper=createConversationTools(f.ctx,f.service,{loadConsumers:()=>loaded.promise});helper.install(f.owner);let closed=false;const closing=helper.dispose().then(()=>{closed=true;});await tick();assert.equal(closed,false);loaded.resolve(consumers);await closing;await assert.rejects(helper.ready,/CONVERSATION_CLOSED/);assert.equal(f.ctx.tools.get('todo_write',f.owner),f.nativeTodo);assert.equal((await f.call('todo_write',{todos:[]})).isError,true);
});
test('host compatibility never constructs this isolated registrar or loads SDK consumers',async t=>{
 const f=await fixture(t,{mode:'host-compat',initial:false});let loaded=0;assert.throws(()=>createConversationTools(f.ctx,f.service,{loadConsumers(){loaded++;return consumers;}}),/MODE_MISMATCH/);assert.equal(loaded,0);assert.equal((await f.call('todo_write',{todos:[]})).isError,false);assert.equal((await f.call('ask_user_question',question)).isError,false);
});
test('missing optional services leave their definitions closed and a changed SDK consumer fails before import/admission',async t=>{
 const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);const source=executionBindingFixture('isolated-guest');let service;await ctx.plugin({name:'only-mode',inject:['tools'],apply(owner){service=installProjectExecutionMode(owner,source.binding);}}).await();let loads=0;const helper=createConversationTools(ctx,service,{loadConsumers:async()=>{loads++;return consumers;}});await helper.ready;assert.equal(loads,0);await helper.dispose();await ctx.fiber.dispose();
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-conversation-review-'));t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-conversation-review-'));await fs.rm(real,{recursive:true,force:true});});for(const name of ['dsh-tool-todo','dsh-tool-ask-user']){const folder=path.join(directory,'@deepseek-ai',name,'lib');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'index.js'),'throw Error("UNREVIEWED_MODULE_WAS_IMPORTED");\n');}await assert.rejects(loadReviewedConversationConsumers(directory),{code:'PROJECT_CONVERSATION_SDK_UNREVIEWED'});
});
