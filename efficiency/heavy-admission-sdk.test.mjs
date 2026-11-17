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
import {isolatedExecutionBinding} from '../workspace/fixtures/execution-binding.mjs';
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
