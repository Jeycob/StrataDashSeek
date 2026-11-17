// Actual pinned provider subclass + sandbox Bash + SDK Jobs/OutputCollector;
// base spawn is an inert handle. No child process, signal, probe or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runtimeRequire} from '../runtime/require.cjs';
import OwnedRangeSubprocess from './owned-range-subprocess.mjs';
import {hasOwnedRangeProvider} from './owned-range-state.mjs';
import {createProjectCommandRunner} from './project-tool.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import {bindHeavyToolLease} from '../efficiency/heavy-tool-lease.mjs';
import protocol from '../development/project-custody.cjs';
const {Context}=runtimeRequire('@deepseek-ai/cordis'),{LocalSubprocessRuntime}=runtimeRequire('@deepseek-ai/dsh-subprocess-local'),{SandboxBashExecutor}=runtimeRequire('@deepseek-ai/dsh-bash-sandbox'),{default:Sandbox}=runtimeRequire('@deepseek-ai/dsh-sandbox-local'),{default:Jobs}=runtimeRequire('@deepseek-ai/dsh-jobs-local'),{createScope}=runtimeRequire('@deepseek-ai/dsh-scope'),{default:SystemPrompt}=runtimeRequire('@deepseek-ai/dsh-system-prompt'),{default:Tools}=runtimeRequire('@deepseek-ai/dsh-tools');
const deferred=()=>{let resolve,reject;return{promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let n=0;n<200;n++){if(check())return;await tick();}assert.fail('bounded source fixture wait');}
test('actual Cordis plugin registration provides one provenance-checked SDK subprocess implementation',async()=>{
 const ctx=new Context(),plugin=ctx.plugin(OwnedRangeSubprocess);await plugin.await();assert(hasOwnedRangeProvider(ctx.subprocess));assert((ctx.subprocess[Symbol.for('cordis.original')]??ctx.subprocess) instanceof LocalSubprocessRuntime);await plugin.dispose();assert.equal(ctx.get('subprocess'),undefined);await ctx.fiber.dispose();
});
async function fixture(t,{range='normal'}={}){
 const ctx=new Context(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'owned-range-sdk-')),direct=deferred(),quiescent=deferred(),calls=[],warnings=[];let signals=0,waits=0;
 new SystemPrompt(ctx,{});new Tools(ctx);const agent={id:'owner',status:'idle',session:{id:'owner',header:{},append(type,data){return{seq:1,type,data};}},inject(){},followup(){},inbox:{nextStep:[]}};
 ctx.provide('agents',{get:id=>id===agent.id?agent:undefined,list:()=>[agent]});ctx.provide('shellEnv',{collect:()=>({})});ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>({mode:'workspace-write',workspaceRoot:directory})});
 const sandbox=new Sandbox(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:2000});sandbox.internals={platform:'linux',chain:['landlock']};
 let stdout=Buffer.alloc(0);const reader={readFrom:offset=>({text:stdout.subarray(offset).toString(),nextOffset:stdout.length,lossy:false})},empty={readFrom:offset=>({text:'',nextOffset:offset,lossy:false})};
 const original={stdin:undefined,stdout:undefined,stderr:undefined,control:undefined,collected:{stdout:reader,stderr:empty},done:direct.promise,terminate(){assert.equal(this,original);signals++;},waitForExit:range==='missing'?undefined:function(){assert.equal(this,original);waits++;if(range==='reject')return Promise.reject(Error('synthetic observation failure'));if(range==='false')return Promise.resolve(false);return quiescent.promise;}};
 t.mock.method(LocalSubprocessRuntime.prototype,'spawn',function(spec){calls.push(spec);if(typeof spec.stdio.stdin==='object'){const control=JSON.parse(spec.stdio.stdin.data);stdout=protocol.frame(control,{pid:1234,ppid:12,pgrp:12,startTicks:'987654',pidNamespace:'pid:[12345]'});}return original;});
 const provider=new OwnedRangeSubprocess(ctx);t.mock.method(ctx.logger,'warn',text=>warnings.push(text));
 const cell=value=>({get:()=>value});new SandboxBashExecutor(ctx,Object.fromEntries(Object.entries({cwd:directory,timeoutMs:60000,maxTimeoutMs:600000,maxOutputBytes:65536,maxSpillBytes:1048576,graceMs:20}).map(([k,v])=>[k,cell(v)])));
 new Jobs(ctx,{maxConcurrentJobsPerOwner:2,retainBytes:65536,settledRetainBytes:16000,pumpPollMs:2});ctx.jobs.attachController('inert range fixture');const scope=createScope(ctx,agent);agent.ctx=scope.ctx;
 t.after(async()=>{direct.resolve({exitCode:0,signal:null});quiescent.resolve(true);await scope.dispose();await ctx.fiber.dispose();assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('owned-range-sdk-'));await fs.rm(directory,{recursive:true,force:true});});
 return{ctx,provider,agent,directory,direct,quiescent,calls,warnings,original,get signals(){return signals;},get waits(){return waits;}};
}
test('actual confined ShellExecution keeps done/result/running and kill authority until its same owned range exits',async t=>{
 const f=await fixture(t);assert(f.provider instanceof LocalSubprocessRuntime);assert(hasOwnedRangeProvider(f.ctx.subprocess));
 const process=await f.ctx.shell.execute(f.ctx.shell.resolve({command:'inert command',workdir:f.directory,onExpiry:'none',sandboxPolicy:{mode:'workspace-write',workspaceRoot:f.directory}}));let settled=false,resultSettled=false;void process.done.then(()=>{settled=true;});void process.result().then(()=>{resultSettled=true;});await tick();assert.equal(f.waits,0);
 f.direct.resolve({exitCode:0,signal:null});await until(()=>f.waits===1);assert.equal(process.status,'running');assert.equal(settled,false);assert.equal(resultSettled,false);assert.equal(process.kill(),true);assert.equal(f.signals,1);assert.equal(settled,false);
 f.quiescent.resolve(true);await process.done;assert.equal(settled,true);assert.equal((await process.result()).exitCode,0);assert.equal(resultSettled,true);assert.equal(process.kill(),false);assert.equal(f.signals,1);
});
test('actual SDK job producer and retained heavy permit wait for range exit after direct wrapper outcome',async t=>{
 const f=await fixture(t),manager={ownerAgent:a=>a,data:{sessions:{owner:{root:f.directory,workspaceId:'own'}}}},run=createProjectCommandRunner(f.ctx,manager,{},hostExecutionBinding()),execution={agent:f.agent,callId:'range',signal:new AbortController().signal};let released=0;const release=bindHeavyToolLease(execution,{release(){released++;}});
 const background=await run.startWithCustody({command:'inert app & wait',description:'inert owned descendants',run_in_background:true,timeoutMs:60000},execution),lease=await run.custodyFor(background.jobId,f.agent.id);release();let producerDone=false;void lease.done.then(()=>{producerDone=true;});
 f.direct.resolve({exitCode:0,signal:null});await until(()=>f.waits===1);assert.equal(producerDone,false);assert.equal(released,0);
 let stopped=false;const stop=run.stopOwned(background.jobId,f.agent.id).then(()=>{stopped=true;});await until(()=>f.signals===1);assert.equal(stopped,false);assert.equal(producerDone,false);assert.equal(released,0);
 f.quiescent.resolve(true);await stop;await lease.done;assert.equal(stopped,true);assert.equal(released,1);await run.dispose();
});
for(const range of ['missing','false','reject'])test('unknown range '+range+' remains pending rather than becoming Bash false settlement',async t=>{
 const f=await fixture(t,{range}),process=await f.ctx.shell.execute(f.ctx.shell.resolve({command:'inert',workdir:f.directory,onExpiry:'none',sandboxPolicy:{mode:'workspace-write',workspaceRoot:f.directory}}));let settled=false;void process.done.then(()=>{settled=true;});f.direct.resolve({exitCode:0,signal:null});await until(()=>f.warnings.some(text=>text.includes('HOMEAI_RANGE_EXIT_UNOBSERVABLE')));assert.equal(settled,false);assert.equal(process.status,'running');assert(f.signals>=1);assert.equal(process.kill(),true);
});
test('direct provider rejection is reflected first, then waits for exact range before publishing failure',async t=>{
 const f=await fixture(t),process=await f.ctx.shell.execute(f.ctx.shell.resolve({command:'inert',workdir:f.directory,onExpiry:'none',sandboxPolicy:{mode:'workspace-write',workspaceRoot:f.directory}}));let settled=false;void process.done.then(()=>{settled=true;});const expected=Error('synthetic direct failure');f.direct.reject(expected);await until(()=>f.waits===1);assert.equal(settled,false);f.quiescent.resolve(true);await process.done;await assert.rejects(process.result(),expected);assert.equal(process.status,'killed');
});
