import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {apply} from './plugin.mjs';
import {FairGate,heavyTool} from './gate.mjs';
import {retainHeavyToolLease} from './heavy-tool-lease.mjs';
import {registerWorkspaceHeavyAdmission} from './heavy-admission.mjs';
import {createProjectAppsTools} from '../workspace/project-apps-tools.mjs';
import {createProjectAppsReceiptStore} from '../workspace/project-apps-receipts.mjs';
import {installProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
import {isolatedExecutionBinding,hostExecutionBinding} from '../workspace/fixtures/execution-binding.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)));
const [{Context},{default:SystemPrompt},{default:Tools},{ToolExecutionPipeline,executeToolBatch},{createScope}]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js'),load('dsh-scope')]);
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(t,{schedule=true,registerFirst=false,orphan=false,liveBody}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-heavy-sdk-')),ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);
 const a={id:'sdk-heavy',session:{id:'sdk-heavy',header:{}}},scope=createScope(ctx,a);a.ctx=scope.ctx;
 const root=path.join(directory,'project');await fs.mkdir(root);let mutations=0,reads=0,checks=0,acquires=0;const requests=[];
 ctx.provide('agents',{get:id=>id===a.id?a:undefined,list:()=>[a]});ctx.provide('llm',{});ctx.provide('shell',{});ctx.provide('shellEnv',{});
 // Apps is a guest-only consumer; use the actual root mode guard, not a host
 // fixture or a replacement service. Only the exact synthetic tools below
 // are accepted by this fixture's workspace consumer.
 const mode=installProjectExecutionMode(ctx,isolatedExecutionBinding());
 ctx.on('workspace-runtime/review',async()=>({root,sourceHash:'synthetic',checkpoints:{},legacy:false}));
 const manager={ownerAgent:value=>value,data:{sessions:{[a.id]:{root,independentRepository:true}}},withProjectRuntimeAuthority:async(_input,action)=>action('unused')};
 const store=createProjectAppsReceiptStore(path.join(directory,'private'));const row={requestId:'a'.repeat(32),ownerId:a.id,projectId:'b'.repeat(16),appsJobId:null,startedAt:1};if(orphan)await store.save(row);
 const apps=createProjectAppsTools(ctx,manager,{appsConfig:{enabled:true,vm:{enabled:true},projectRuntime:{enabled:true},workspaceRoot:directory},receiptStore:store,retainHeavyToolLease,callApps:async(route,data)=>{requests.push({route,data});if(data){mutations++;throw Error('unexpected Apps mutation');}if(route.startsWith('/project-request'))return{version:1,requestId:row.requestId,state:'unknown'};if(route.startsWith('/state'))return{enabled:true,available:true,busy:null,projects:[],jobs:[]};throw Error('unexpected route');}});
 let remove;const register=()=>{remove=registerWorkspaceHeavyAdmission(a.ctx,async execution=>{assert.equal(execution.agent,a);checks++;await apps.beforeHeavy();});};
 if(registerFirst)register();
 await apply(ctx,{stateDirectory:path.join(directory,'efficiency'),engineMetrics:false,schedule});if(!registerFirst)register();
 const prior=FairGate.prototype.acquire;FairGate.prototype.acquire=function(input){acquires++;return prior.call(this,input);};
 ctx.tools.register({name:'project_exec',description:'Synthetic actual tool body',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},output:{schema:{type:'object'},render:()=>[{type:'text',text:'synthetic complete'}]},async execute(_args,exec){mutations++;if(liveBody)await liveBody(exec);return{exitCode:0};}});
 ctx.tools.register({name:'read',description:'Synthetic lightweight read',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'synthetic read'}]},execute(){reads++;return{};}});
 const accepted=new Set(['project_exec','read'].map(name=>ctx.tools.get(name,a)));
 if(accepted.size!==2||accepted.has(undefined))throw Error('Exact synthetic workspace definitions are required');
 const closeModeWorkspace=mode.registerWorkspace({handles:execution=>apps.handles(execution)||accepted.has(ctx.tools.get(execution.name,execution.agent,execution.toolSet)),beforeHeavy:()=>apps.beforeHeavy()});
 const pipeline=new ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:definitions=>({schemas:definitions.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>executeToolBatch(input,pipeline,()=>2)});
 async function call(name='project_exec',args={command:'npm test'}){const toolSet=await ctx.tools.resolve({agent:a,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal});try{const batch=await ctx.tools.execute({agent:a,toolSet,signal:new AbortController().signal,calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});return batch.results[0].result;}finally{toolSet.dispose();}}
 t.after(async()=>{remove();FairGate.prototype.acquire=prior;await apps.dispose();closeModeWorkspace();await scope.dispose();await ctx.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});});
 return{call,register,unload:()=>remove(),counts:()=>({mutations,reads,checks,acquires}),requests,store};
}
test('project Apps deploy alone is heavy; read-only status and job observations stay light',()=>{
 assert(heavyTool({name:'project_apps',arguments:{operation:'verify_deploy'}}));for(const operation of ['register','status','job_status','job_log'])assert.equal(heavyTool({name:'project_apps',arguments:{operation}}),false);
});
for(const registerFirst of [true,false])test('actual SDK orphan check precedes acquire and mutation regardless registration order '+registerFirst,async t=>{
 const f=await fixture(t,{orphan:true,registerFirst});const denied=await f.call();assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/PROJECT_APPS_RECONCILIATION_REQUIRED/);assert.equal(f.counts().acquires,0);assert.equal(f.counts().mutations,0);
 const deploy=await f.call('project_apps',{operation:'verify_deploy'});assert.equal(deploy.isError,true);assert.equal(f.counts().acquires,0);assert.equal(f.counts().mutations,0);
 const before=f.counts().checks;assert.equal((await f.call('read',{})).isError,false);const status=await f.call('project_apps',{operation:'status'});assert.equal(status.isError,false,JSON.stringify(status));assert.equal(f.counts().checks,before);assert.equal(f.counts().acquires,0);
});
test('orphan policy is enforced even when scheduling is disabled',async t=>{
 const f=await fixture(t,{orphan:true,schedule:false});assert.equal((await f.call()).isError,true);assert.equal(f.counts().mutations,0);assert.equal(f.counts().acquires,0);assert.equal((await f.call('project_apps',{operation:'status'})).isError,false);
});
test('closed workspace slot fails closed after unload and re-registration restores heavy work',async t=>{
 const f=await fixture(t);assert.equal((await f.call()).isError,false);const prior=f.counts().acquires;f.unload();const denied=await f.call();assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/WORKSPACE_HEAVY_ADMISSION_UNAVAILABLE/);assert.equal(f.counts().acquires,prior);assert.equal((await f.call('project_apps',{operation:'status'})).isError,false);f.register();assert.equal((await f.call()).isError,false);
});
test('live retained admission remains on the original gate while another heavy request queues and status reads proceed',async t=>{
 let release,first=true;
 const f=await fixture(t,{liveBody:async exec=>{if(first){first=false;release=retainHeavyToolLease(exec);}}});
 assert.equal((await f.call()).isError,false);let settled=false;const second=f.call().then(result=>{settled=true;return result;});await tick();await tick();assert.equal(settled,false);assert.equal(f.counts().mutations,1);
 assert.equal((await f.call('project_apps',{operation:'status'})).isError,false);assert.equal((await f.call('read',{})).isError,false);release();assert.equal((await second).isError,false);assert.equal(f.counts().mutations,2);
});
test('workspace unload while queued is rechecked after acquire before the tool body',async t=>{
 let release,first=true;const f=await fixture(t,{liveBody:async exec=>{if(first){first=false;release=retainHeavyToolLease(exec);}}});
 assert.equal((await f.call()).isError,false);const queued=f.call();await tick();await tick();assert.equal(f.counts().mutations,1);f.unload();release();const result=await queued;assert.equal(result.isError,true);assert.match(JSON.stringify(result),/WORKSPACE_HEAVY_ADMISSION_UNAVAILABLE/);assert.equal(f.counts().mutations,1);
});

test('real Agent.cancel removes a queued heavy command without releasing another session or entering its body',{timeout:10000},async t=>{
 const [{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:AgentLoop},{NativeToolExecutor}]=await Promise.all(['dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-agent-loop','dsh-tool-executor-native'].map(name=>load(name)));
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'heavy-cancel-sdk-')),ctx=new Context(),release=Promise.withResolvers(),entered=Promise.withResolvers(),bodies=[],events=[],streams=new Map();
 let a,b;
 t.after(async()=>{release.resolve();a?.cancel({kind:'user'});b?.cancel({kind:'user'});await ctx.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});});
 const services=[Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{}));
 await Promise.all(services.map(fiber=>fiber.await()));
 await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1}).await();
 ctx.tools.setExecutor(new NativeToolExecutor(ctx));
 installProjectExecutionMode(ctx,hostExecutionBinding());
 ctx.provide('shell',{});ctx.provide('shellEnv',{});
 await apply(ctx,{stateDirectory:path.join(directory,'efficiency'),engineMetrics:false});
 ctx.on('session/event',(session,event)=>events.push({sessionId:session.id,...event}),{global:true});
 class Scripted extends LlmAdapter {
  async *stream(options){
   const id=String(options.sessionId),count=(streams.get(id)??0)+1;streams.set(id,count);
   const block=count===1?{type:'tool-call',id:'call-'+id,name:'project_exec',arguments:JSON.stringify({command:'synthetic heavy work'})}:{type:'text',text:'Synthetic completion'};
   yield{type:'block-start',index:0,blockType:block.type};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:count===1?'tool-calls':'stop'}};
  }
 }
 ctx.llm.registerAdapter(['heavy-cancel-fixture'],new Scripted());
 ctx.tools.register({name:'project_exec',description:'Local cancellable fixture',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},output:{schema:{type:'object'},render:()=>[{type:'text',text:'complete'}]},async execute(_args,exec){bodies.push(exec.agent.id);entered.resolve();await release.promise;return{exitCode:0};}});
 a=(await ctx.agents.create({sessionId:'holder',meta:{cwd:directory},agentOptions:{provider:'heavy-cancel-fixture',model:'synthetic'}})).agent;
 b=(await ctx.agents.create({sessionId:'waiting',meta:{cwd:directory},agentOptions:{provider:'heavy-cancel-fixture',model:'synthetic'}})).agent;
 const status=sessionId=>ctx.waterfall('efficiency/session-status',{sessionId},()=>undefined);
 const input=id=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic local command'}]});
 a.followup(input('holder-input'));await entered.promise;
 const holder=await status(a.id);assert.equal(holder.heavyTools.phase,'admitted');assert.equal(holder.heavyTools.active,1);assert(Number.isSafeInteger(holder.heavyTools.since));
 const before=Date.now();b.followup(input('waiting-input'));
 let queued;const deadline=performance.now()+2000;
 do{queued=await status(b.id);if(queued.heavyTools.phase==='waiting')break;assert(performance.now()<deadline,'Actual SDK command must reach the heavy queue');await tick();}while(true);
 assert.deepEqual(queued,{version:1,sessionId:b.id,enabled:true,model:{phase:'idle',since:null,active:0,waiting:0},heavyTools:{phase:'waiting',since:queued.heavyTools.since,active:0,waiting:1}});
 assert(queued.heavyTools.since>=before&&queued.heavyTools.since<=Date.now());assert.deepEqual(await status(b.id),queued,'Repeated reads preserve the original phase start');
 assert.equal(await status('unknown'),undefined);assert(!JSON.stringify(queued).includes(a.id));
 b.cancel({kind:'user'});await b.whenIdle();
 assert.deepEqual((await status(b.id)).heavyTools,{phase:'idle',since:null,active:0,waiting:0});
 assert.deepEqual((await status(a.id)).heavyTools,holder.heavyTools,'Cancel cannot release the actual holder');
 assert.deepEqual(bodies,[a.id]);assert.equal(b.status,'idle');assert.equal(a.status,'running');
 const ended=events.find(event=>event.sessionId===b.id&&event.type==='turn/end');assert.equal(ended.data.reason.kind,'aborted');assert.equal(ended.data.reason.reason.kind,'user');
 release.resolve();await a.whenIdle();await tick();
 assert.deepEqual(bodies,[a.id],'Releasing capacity later cannot resurrect the cancelled command');
 assert.equal(streams.get(b.id),1,'Cancel must not create a followup model request');
 assert.deepEqual((await status(a.id)).heavyTools,{phase:'idle',since:null,active:0,waiting:0});
});
