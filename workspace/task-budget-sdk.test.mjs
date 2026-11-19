import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTaskBudgets,taskLimit} from './task-budget.mjs';
import {createProjectProcessStarter} from './project-process.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=name=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib/index.js')));
const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:SystemPrompt},{default:Tools},{default:AgentLoop},{NativeToolExecutor},{default:LocalJobs},{apply:jobTools}]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-tool-executor-native','dsh-jobs-local','dsh-tool-jobs'].map(load));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){const end=performance.now()+2000;while(!check()){assert(performance.now()<end,'SDK fixture did not reach its observed state');await tick();}}
function *response(total=12){yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'Synthetic response'}};if(total!==null)yield{type:'usage',usage:{inputTokens:7,outputTokens:5,...(total===undefined?{}:{totalTokens:total})}};yield{type:'finish',reason:{kind:'stop'}};}
const input=id=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic task '+id}]});
async function fixture(t,{stream,beforeStep}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'task-budget-sdk-')),file=path.join(directory,'budget.json'),ctx=new Context(),events=new Map(),durable=new Map(),calls=[],timers=new Set();let now=1700000000000,save=Promise.resolve(),fiber,controller;
 t.mock.timers.enable({apis:['Date'],now});
 const services=[Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{}));await until(()=>services.every(f=>f.state===2));
 const loop=ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});await until(()=>loop.state===2);ctx.tools.setExecutor(new NativeToolExecutor(ctx));
 new LocalJobs(ctx,{maxConcurrentJobsPerOwner:4,retainBytes:65536,settledRetainBytes:16384,pumpPollMs:2});jobTools(ctx,{completionDelivery:'wakeup'});
 ctx.on('session/event',(session,event)=>{const list=events.get(session.id)??[];list.push(structuredClone(event));events.set(session.id,list);},{global:true});
 ctx.on('session/flush',session=>durable.set(session.id,structuredClone(events.get(session.id)??[])),{global:true});
 ctx.provide('sessionQuery',{readSession:async id=>({events:structuredClone(durable.get(id)??[])})});
 const manager={data:{taskBudgets:{},sessions:{}},ownerAgent(agent){while(agent?.session.header.origin==='subagent')agent=ctx.agents.get(agent.session.header.parentSession);return agent;},async projectFor(id){const agent=ctx.agents.get(id);if(!agent)throw Object.assign(Error('Unknown session'),{code:'SESSION_NOT_FOUND'});return{live:agent.session,header:agent.session.header,root:directory};},inOrder:action=>action(),save(){const snapshot=JSON.stringify(manager.data);save=save.then(()=>fs.writeFile(file,snapshot));return save;}};
 class Scripted extends LlmAdapter{async *stream(options){calls.push(String(options.sessionId));if(stream)yield* stream(options,calls);else yield* response();}}
 ctx.llm.registerAdapter(['budget-fixture'],new Scripted());
 async function install(){fiber=ctx.plugin({name:'optional-task-budget-fixture',inject:['agents','tools','jobs','sessions','sessionQuery','llm'],apply(pluginCtx){controller=createTaskBudgets(pluginCtx,manager,{now:()=>now,setTimer(fn,ms){const timer={fn,ms,unref(){}};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});pluginCtx.on('agent/pre-step',async(input,next)=>{await beforeStep?.(input);await controller.beforeStep(input);return next();},{prepend:true,global:true});}});await until(()=>fiber.state===2);}
 await install();
 async function agent(id){const value=(await ctx.agents.create({sessionId:id,meta:{cwd:directory},agentOptions:{provider:'budget-fixture',model:'synthetic'}})).agent;manager.data.sessions[id]={lastVerification:{kind:'test',accepted:true,at:1}};return value;}
 t.after(async()=>{for(const agent of ctx.agents.list())agent.cancel({kind:'user'});await ctx.fiber.dispose();await save;await fs.rm(directory,{recursive:true,force:true});});
 return{ctx,manager,directory,calls,events,timers,agent,input,now:()=>now,advance:ms=>{now+=ms;t.mock.timers.setTime(now);},get budget(){return controller;},async reload(){await save;await fiber.dispose();manager.data=JSON.parse(await fs.readFile(file,'utf8'));await install();}};
}

test('task limits are explicit and bounded; null preserves the no-limit default',()=>{
 assert.equal(taskLimit(null),null);assert.deepEqual(taskLimit({kind:'elapsed',minutes:1}),{kind:'elapsed',minutes:1});
 for(const value of [{kind:'tokens',totalTokens:0},{kind:'elapsed',minutes:1.5},{kind:'elapsed',minutes:2,sessionId:'other'},{kind:'money',usd:1}])assert.throws(()=>taskLimit(value),{code:'INVALID_TASK_LIMIT'});
});

test('a reported-token limit stops only its one human task, retains files/checks, and fresh input is unlimited',{timeout:10000},async t=>{
 const f=await fixture(t),a=await f.agent('budget-owner'),b=await f.agent('other');await fs.writeFile(path.join(f.directory,'saved.txt'),'retained work');
 assert.equal((await f.budget.inspect(a.id)).nextTaskLimit,null);
 await f.budget.configure(a.id,{kind:'tokens',totalTokens:10});a.followup(input('limited-task'));await a.whenIdle();
 const stopped=await f.budget.inspect(a.id);assert.equal(stopped.current.reason.code,'TASK_TOKEN_LIMIT');assert.equal(stopped.current.usedTokens,12);assert.equal(stopped.nextTaskLimit,null);
 assert.equal(await fs.readFile(path.join(f.directory,'saved.txt'),'utf8'),'retained work');assert.deepEqual(f.manager.data.sessions[a.id].lastVerification,{kind:'test',accepted:true,at:1});
 const before=f.calls.length;a.followup({id:'late-notice',role:'user',source:{kind:'tool-jobs',form:'notice'},content:[{type:'text',text:'Late synthetic completion'}]});await a.whenIdle();assert.equal(f.calls.length,before,'An internal followup cannot renew the budget');
 b.followup(input('other-task'));await b.whenIdle();assert.equal(f.calls.at(-1),b.id);
 a.followup(input('fresh-human-task'));await a.whenIdle();assert.equal(f.calls.at(-1),a.id);assert.equal((await f.budget.inspect(a.id)).current,null);
});

test('missing exact reported totals stop a token-limited request with an explicit reason',{timeout:10000},async t=>{
 const f=await fixture(t,{stream:async function*(){yield* response(null);}}),a=await f.agent('owner');
 await f.budget.configure(a.id,{kind:'tokens',totalTokens:100});a.followup(input('missing-usage'));await a.whenIdle();
 const value=await f.budget.inspect(a.id);assert.equal(value.current.reason.code,'TASK_BUDGET_USAGE_UNAVAILABLE');assert.equal(value.current.usageAvailable,false);assert.equal(f.calls.length,1);
});

test('elapsed limit uses actual Agent.cancel, stops the active call and keeps other sessions usable',{timeout:10000},async t=>{
 const entered=Promise.withResolvers();
 const f=await fixture(t,{stream:async function*(options){if(options.sessionId==='owner'){entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));return;}yield* response();}}),a=await f.agent('owner'),b=await f.agent('other');
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('timed-task'));await entered.promise;
 await assert.rejects(f.budget.configure(a.id,{kind:'tokens',totalTokens:1}),{code:'TASK_ALREADY_RUNNING'});
 assert.equal(f.timers.size,1);const timer=[...f.timers][0];assert.equal(timer.ms,60000);f.advance(60000);timer.fn();await a.whenIdle();
 assert.equal((await f.budget.inspect(a.id)).current.reason.code,'TASK_TIME_LIMIT');assert.equal(f.events.get(a.id).find(event=>event.type==='turn/end').data.reason.reason.kind,'user');assert.equal(f.timers.size,0);
 b.followup(input('independent'));await b.whenIdle();assert.equal(f.calls.at(-1),b.id);
});

test('an armed limit survives plugin reload and is consumed only by its first post-arm human input',{timeout:10000},async t=>{
 const f=await fixture(t),a=await f.agent('owner');a.followup(input('old-human'));await a.whenIdle();
 await f.budget.configure(a.id,{kind:'tokens',totalTokens:10});await f.reload();
 a.followup({id:'internal',role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'Synthetic internal notice'}]});await a.whenIdle();
 assert.deepEqual((await f.budget.inspect(a.id)).nextTaskLimit,{kind:'tokens',totalTokens:10});
 a.followup(input('new-human'));await a.whenIdle();assert.equal((await f.budget.inspect(a.id)).current.reason.code,'TASK_TOKEN_LIMIT');
 await f.reload();const count=f.calls.length;a.followup({id:'internal-after-reload',role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'Synthetic continuation'}]});await a.whenIdle();assert.equal(f.calls.length,count);
 a.followup(input('next-human'));await a.whenIdle();assert.equal(f.calls.length,count+1);assert.equal((await f.budget.inspect(a.id)).current,null);
});

for(const delivered of [false,true])test(`elapsed budget ${delivered?'releases a delivered preview after task completion':'collects only its unfinished owned job without a late wakeup'}`,{timeout:10000},async t=>{
 const processDone=Promise.withResolvers();t.after(()=>processDone.resolve());
 const f=await fixture(t,{stream:async function*(options,calls){
  if(calls.length===1){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'start',name:'project_exec',arguments:'{}'}};yield{type:'finish',reason:{kind:'tool-calls'}};}else yield* response();
 }}),a=await f.agent('owner'),b=await f.agent('other'),settlements=[];
 const process={status:'running',exitCode:null,done:processDone.promise,kills:0,observed:Object.fromEntries(['stdout','stderr'].map(channel=>[channel,{readFrom:from=>({text:from?'':'Retained output',nextOffset:15,lossy:false})}])),kill(){process.kills++;process.status='killed';}};
 const starter=createProjectProcessStarter(f.ctx,{execute:async()=>process});t.after(()=>starter.dispose());
 f.ctx.jobs.events.subscribe({owners:'scope'},event=>{if(event.type==='settled')settlements.push(event);});
 f.ctx.tools.register({name:'project_exec',description:'Start one synthetic owned build',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'Started'}]},execute:async(_args,exec)=>{
  const job=await starter.start({cwd:f.directory,spec:{}},exec,{description:'Synthetic background',timeoutMs:600000});
  if(delivered)f.ctx.emit('workspace/project-preview-delivered',job.jobId,a.id);
  return job;
 }});
 const independentDone=Promise.withResolvers(),independent=f.ctx.jobs.start({kind:'fixture',owner:b.id,label:'Other session job',run:()=>({done:independentDone.promise,cancel:()=>independentDone.resolve({status:'killed'})})});
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('limited-background'));await a.whenIdle();const own=f.ctx.jobs.list(a.id)[0];assert(own);assert.equal(process.status,'running');assert.equal(f.calls.length,2);
 if(delivered){assert.equal(f.timers.size,0,'A delivered preview must not keep the completed task timer alive');assert.equal(process.kills,0);processDone.resolve();}
 else{
  assert.equal(f.timers.size,1);const timer=[...f.timers][0];f.advance(60000);timer.fn();assert.equal(process.kills,1);assert.equal((await f.budget.inspect(a.id)).current.reason.code,'TASK_TIME_LIMIT');
  a.followup(input('fresh-before-old-settles'));await a.whenIdle();assert.equal(f.calls.length,3);processDone.resolve();
  await until(()=>settlements.some(e=>e.job.id===own.id));await a.whenIdle();await tick();
  assert.equal(f.calls.length,3);assert.equal(f.events.get(a.id).filter(e=>e.type==='turn/start').length,2,'The native jobs publisher must not open a late turn');assert.equal(settlements.find(e=>e.job.id===own.id).awaited,true);
  assert.equal(f.ctx.jobs.get(own.id,a.id).status,'killed');assert(f.events.get(a.id).some(e=>e.type==='job/settled'));assert.match(JSON.stringify(f.ctx.jobs.read(own.id,a.id)),/Retained output/);
 }
 assert.equal(f.ctx.jobs.get(independent,b.id).status,'running');independentDone.resolve({status:'completed'});
});

test('interrupted token accounting survives reload and cannot move its limit to a new request',{timeout:10000},async t=>{
 const f=await fixture(t),a=await f.agent('owner');await f.budget.configure(a.id,{kind:'tokens',totalTokens:100});a.followup(input('original'));await a.whenIdle();
 f.manager.data.taskBudgets[a.id].current.pendingUsage=1;await f.manager.save();await f.reload();const count=f.calls.length;
 a.followup({id:'continue',role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'Resume'}]});await a.whenIdle();assert.equal(f.calls.length,count);assert.equal((await f.budget.inspect(a.id)).current.reason.code,'TASK_BUDGET_USAGE_INTERRUPTED');
 a.followup(input('new'));await a.whenIdle();assert.equal(f.calls.length,count+1);assert.equal((await f.budget.inspect(a.id)).current,null);
});

for(const delivered of [true,false])test(delivered?'an old preview settlement cannot cancel the new task timer':'an earlier unfinished task keeps its deadline without cancelling a newer inference',{timeout:10000},async t=>{
 const processDone=Promise.withResolvers(),entered=Promise.withResolvers();t.after(()=>processDone.resolve());let inferenceSignal;
 const f=await fixture(t,{stream:async function*(options,calls){
  if(calls.length===1){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'start-old',name:'project_exec',arguments:'{}'}};yield{type:'finish',reason:{kind:'tool-calls'}};}
  else if(calls.length===3){inferenceSignal=options.signal;entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
  else yield* response();
 }}),a=await f.agent('owner'),settlements=[];
 const process={status:'running',exitCode:null,done:processDone.promise,kills:0,observed:Object.fromEntries(['stdout','stderr'].map(channel=>[channel,{readFrom:from=>({text:'',nextOffset:from,lossy:false})}])),kill(){process.kills++;process.status='killed';}};
 const starter=createProjectProcessStarter(f.ctx,{execute:async()=>process});t.after(()=>starter.dispose());
 f.ctx.jobs.events.subscribe({owners:'scope'},event=>{if(event.type==='settled')settlements.push(event);});
 f.ctx.tools.register({name:'project_exec',description:'Synthetic original task job',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'Started'}]},execute:async(_args,exec)=>{
  const job=await starter.start({cwd:f.directory,spec:{}},exec,{description:'Original job',timeoutMs:600000});
  if(delivered)f.ctx.emit('workspace/project-preview-delivered',job.jobId,a.id);
  return job;
 }});
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('first-task'));await a.whenIdle();
 const oldTask=f.manager.data.taskBudgets[a.id].current,oldJob=f.ctx.jobs.list(a.id)[0],oldTimer=[...f.timers][0];assert(oldJob);assert.equal(f.timers.size,delivered?0:1);
 f.advance(1000);await f.budget.configure(a.id,{kind:'elapsed',minutes:2});a.followup(input('new-task'));await entered.promise;
 const newTask=f.manager.data.taskBudgets[a.id].current,newTimer=[...f.timers].find(timer=>timer!==oldTimer);assert(newTimer);assert.equal(newTimer.ms,120000);assert.equal(f.timers.size,delivered?1:2);
 if(delivered){
  // Budget observes the genuine settled event after an independently awaited
  // synthetic preview expiry, just as the preview's own TTL collector does.
  const collected=f.ctx.jobs.wait(oldJob.id,1000,a.id);f.ctx.jobs.kill(oldJob.id,a.id,'synthetic preview expiry');processDone.resolve();await collected;
 }else{
  assert(f.timers.has(oldTimer),'The first task retains its own original timer');assert.equal(f.manager.data.taskBudgets[a.id].background[0],oldTask);
  f.advance(59000);oldTimer.fn();assert.equal(process.kills,1);assert.equal(inferenceSignal.aborted,false,'Old intent cancellation must not abort the current inference');
  const snapshot=await f.budget.inspect(a.id);assert.equal(snapshot.current.turn,newTask.turn);assert.equal(snapshot.current.reason,null);assert.equal(snapshot.previousStop.turn,oldTask.turn);assert.equal(snapshot.previousStop.startedAt,oldTask.startedAt);assert.equal(snapshot.previousStop.reason.code,'TASK_TIME_LIMIT');
  processDone.resolve();
 }
 await until(()=>settlements.some(event=>event.job.id===oldJob.id));assert.equal(settlements.find(event=>event.job.id===oldJob.id).awaited,true);
 assert(f.timers.has(newTimer),'The old job settlement cannot release a newer intent timer');assert.equal(f.timers.size,1);assert.equal(inferenceSignal.aborted,false);assert.equal(a.status,'running');assert.equal(f.calls.length,3);
 assert.equal((await f.budget.inspect(a.id)).current.reason,null);assert.equal(f.manager.data.taskBudgets[a.id].background?.length??0,0);
 f.advance(newTask.deadlineAt-f.now());newTimer.fn();await a.whenIdle();assert.equal(inferenceSignal.aborted,true);assert.equal((await f.budget.inspect(a.id)).current.reason.code,'TASK_TIME_LIMIT');assert.equal((await f.budget.inspect(a.id)).current.turn,newTask.turn);assert.equal(f.timers.size,0);
});

test('budget Stop preserves an already accepted next human request through native keepInbox',{timeout:10000},async t=>{
 const entered=Promise.withResolvers();
 const f=await fixture(t,{stream:async function*(options,calls){if(calls.length===1){entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}else yield* response();}}),a=await f.agent('owner');
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('limited'));await entered.promise;
 a.followup(input('accepted-next'));assert(a.inbox.nextTurn.some(message=>message.id==='accepted-next'));
 f.advance(60000);[...f.timers][0].fn();await a.whenIdle();
 assert.equal(f.calls.length,1);assert(a.inbox.nextTurn.some(message=>message.id==='accepted-next'),'Native Stop keeps already accepted input pending');
 assert.equal(f.events.get(a.id).filter(event=>event.type==='agent/inbox/spliced'&&event.data.outcome==='canceled').length,0);
 // Normal SDK behavior leaves pre-abort input pending; a later user wake
 // consumes it. The budget layer must not silently replay or duplicate it.
 a.followup(input('fresh-wake'));await a.whenIdle();
 for(const id of ['accepted-next','fresh-wake'])assert.equal(f.events.get(a.id).filter(event=>event.type==='user/message'&&event.data.id===id).length,1);
 assert.equal((await f.budget.inspect(a.id)).current,null);assert.equal((await f.budget.inspect(a.id)).previousStop.reason.code,'TASK_TIME_LIMIT');assert.equal(f.calls.length,3,'Each distinct later human request runs once');
});

for(const queuedMs of [45000,61000])test(`elapsed budget includes ${queuedMs}ms before its first step from the durable SDK acceptance receipt`,{timeout:10000},async t=>{
 const queued=Promise.withResolvers(),release=Promise.withResolvers(),entered=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await fixture(t,{beforeStep:async()=>{queued.resolve();await release.promise;},stream:async function*(options){entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}),a=await f.agent('owner');
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('accepted-before-wait'));await queued.promise;
 const receipt=f.events.get(a.id).find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id==='accepted-before-wait'));assert(receipt);assert.equal(f.calls.length,0);
 f.advance(queuedMs);release.resolve();
 if(queuedMs<60000){await entered.promise;const timer=[...f.timers][0];assert.equal(timer.ms,60000-queuedMs);f.advance(60000-queuedMs);timer.fn();}
 await a.whenIdle();const state=(await f.budget.inspect(a.id)).current;assert.equal(state.timeBasis,'accepted');assert.equal(state.startedAt,receipt.time);assert.equal(state.deadlineAt,receipt.time+60000);assert.equal(state.reason.code,'TASK_TIME_LIMIT');assert.equal(f.calls.length,queuedMs<60000?1:0);
});

test('a receipt without a usable timestamp explicitly reports the first-step clock fallback',{timeout:10000},async t=>{
 const queued=Promise.withResolvers(),release=Promise.withResolvers(),entered=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await fixture(t,{beforeStep:async()=>{queued.resolve();await release.promise;},stream:async function*(options){entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}),a=await f.agent('owner');
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('legacy-receipt'));await queued.promise;
 // Synthetic older persisted record; the actual live SDK event stays intact.
 for(const event of f.events.get(a.id))if(event.type==='agent/inbox/spliced')delete event.time;
 f.advance(45000);release.resolve();await entered.promise;const value=(await f.budget.inspect(a.id)).current;
 assert.equal(value.timeBasis,'first-step');assert.equal(value.startedAt,f.now());assert.equal([...f.timers][0].ms,60000);
 f.advance(60000);[...f.timers][0].fn();await a.whenIdle();assert.equal((await f.budget.inspect(a.id)).current.reason.code,'TASK_TIME_LIMIT');
});

test('other SDK producers receive owned cancellation and retain native completion notification semantics',{timeout:10000},async t=>{
 const done=Promise.withResolvers();t.after(()=>done.resolve({status:'killed'}));let jobId,cancelReason;
 const f=await fixture(t,{stream:async function*(options,calls){
  if(calls.length===1){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'generic-job',name:'other_exec',arguments:'{}'}};yield{type:'finish',reason:{kind:'tool-calls'}};}else yield* response();
 }}),a=await f.agent('owner'),settlements=[];
 f.ctx.jobs.events.subscribe({owners:'scope'},event=>{if(event.type==='settled')settlements.push(event);});
 f.ctx.tools.register({name:'other_exec',description:'Another SDK producer',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'Started'}]},execute:()=>{
  jobId=f.ctx.jobs.start({kind:'workflow',owner:a.id,label:'Synthetic SDK producer',run:()=>({done:done.promise,cancel:reason=>{cancelReason=reason;}})});return{jobId};
 }});
 await f.budget.configure(a.id,{kind:'elapsed',minutes:1});a.followup(input('generic-background'));await a.whenIdle();assert.equal(f.calls.length,2);
 f.advance(60000);[...f.timers][0].fn();assert.equal(cancelReason,'TASK_TIME_LIMIT');assert.equal(f.ctx.jobs.get(jobId,a.id).status,'stopping');
 done.resolve({status:'killed'});await until(()=>settlements.length===1);await a.whenIdle();assert.equal(settlements[0].awaited,false,'No unsupported promise of silent delivery for arbitrary producers');assert.equal(f.ctx.jobs.get(jobId,a.id).status,'killed');
 assert.equal(f.calls.length,2,'The original stopped intent still refuses another model request');assert(f.events.get(a.id).some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.source?.kind==='tool-jobs')));
});
