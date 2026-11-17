// Real pinned Cordis/ToolsService dispatch; all executors and bindings are
// explicit synthetic fixtures. No guest, policy publication or model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createProjectExecutionMode,installClosedProjectExecutionSlot,installProjectExecutionMode,requireProjectExecutionMode} from './execution-mode-service.mjs';
import {apply as applyRoot,inject as rootInject} from './runtime-admission-plugin.mjs';
import {apply as applyEfficiency,inject as efficiencyInject} from '../efficiency/plugin.mjs';
import {apply as applyQuality,inject as qualityInject,executeVerification} from '../quality/plugin.mjs';
import {registerWorkspaceHeavyAdmission} from '../efficiency/heavy-admission.mjs';
import {retainHeavyToolLease} from '../efficiency/heavy-tool-lease.mjs';
const {canonical}=createRequire(import.meta.url)('../vast/project-execution-mode.cjs');
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)));
const [{Context},{default:SystemPrompt},{default:Tools},{ToolExecutionPipeline,executeToolBatch},{createScope}]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js'),load('dsh-scope')]);
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function binding(mode='host-compat'){
 const policy={version:1,contract:'project-execution-v1',mode,policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)};
 const snapshot=Object.freeze({...policy,policySha256:createHash('sha256').update(canonical(policy)).digest('hex'),sourceCommit:'b'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'});
 let valid=true;return{snapshot,assertUnchanged(){if(!valid)throw Object.assign(Error('PROJECT_EXECUTION_BINDING_CHANGED'),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});return snapshot;},change(){valid=false;}};
}
const report={passed:true,complete:true,stale:false,checks:[{passed:true,checksPassed:3,checksTotal:3,artifactPaths:[]}]};
const result=(extra={})=>({exitCode:0,timedOut:false,aborted:false,stdout:{text:JSON.stringify(report),truncated:false},stderr:{text:'',truncated:false},...extra});

async function fixture(t,{mode='host-compat',efficiency=false,quality=false,schedule=true}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'project-execution-sdk-')),ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);
 const state={hostCalls:0,hostResolves:0,nativeBodies:0,guestBodies:0,reviews:0,reports:[],guestChecks:0};
 const agents=new Map(),scopes=[],removers=[],source=binding(mode);
 const agent={id:'owner',session:{id:'owner',header:{}},status:'idle'},scope=createScope(ctx,agent);agent.ctx=scope.ctx;agents.set(agent.id,agent);scopes.push(scope);
 let review=async()=>({root:path.join(directory,'project'),sourceHash:'source-1',legacy:false}),host=async()=>({result:async()=>result()});
 ctx.provide('agents',{list:()=>[...agents.values()],get:id=>agents.get(id)});ctx.provide('llm',{});ctx.provide('sessionQuery',{readSession:async()=>({events:[]})});
 ctx.provide('shellEnv',{collect:()=>({DSH_APP_PORT:'21000'})});
 ctx.provide('shell',{sandboxMode:'workspace-write',resolve:spec=>{state.hostResolves++;return spec;},execute:async spec=>{state.hostCalls++;return host(spec);}});
 ctx.on('workspace-runtime/review',async input=>{state.reviews++;return review(input);});
 ctx.on('workspace-runtime/verification',value=>{state.reports.push(value);});
 let service;
 const provider=ctx.plugin({name:'trusted-execution-provider',inject:['tools'],apply(owner){service=installProjectExecutionMode(owner,source);}});await provider.await();
 for(const name of ['read','bash','project_exec','write'])ctx.tools.register({name,description:'Inert native '+name,parameters:{type:'object',additionalProperties:true},isConcurrencySafe:()=>true,output:{schema:{type:'object'},render:()=>[{type:'text',text:'native'}]},execute:async()=>{state.nativeBodies++;return{exitCode:0};}});
 if(efficiency)await ctx.plugin({name:'actual-efficiency',apply:applyEfficiency,inject:efficiencyInject},{stateDirectory:path.join(directory,'efficiency'),engineMetrics:false,schedule}).await();
 if(quality)await ctx.plugin({name:'actual-quality',apply:applyQuality,inject:qualityInject}).await();
 const pipeline=new ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>executeToolBatch(input,pipeline,()=>2)});
 const admit=()=>ctx.tools.resolve({agent,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal});
 async function call(name='read',args={},options={}){const toolSet=options.toolSet??await admit();try{const batch=await ctx.tools.execute({agent,toolSet,signal:options.signal??new AbortController().signal,calls:[{id:randomUUID(),name,arguments:JSON.stringify(args)}]});return batch.results[0].result;}finally{if(!options.toolSet)toolSet.dispose();}}
 function workspace({shadow=[],accept=[],beforeHeavy=async()=>{state.guestChecks++;}}={}){
  const accepted=new WeakSet(accept),dispose=[];
  for(const name of shadow){const definition={name,description:'Inert guest '+name,parameters:{type:'object',additionalProperties:true},isConcurrencySafe:()=>true,output:{schema:{type:'object'},render:()=>[{type:'text',text:'guest'}]},execute:async()=>{state.guestBodies++;return{exitCode:0};}};dispose.push(agent.ctx.tools.register(definition));accepted.add(definition);}
  const close=service.registerWorkspace({handles:execution=>accepted.has(ctx.tools.get(execution.name,execution.agent,execution.toolSet)),beforeHeavy});
  let closed=false;const remove=()=>{if(closed)return;closed=true;close();dispose.forEach(fn=>fn());};removers.push(remove);return remove;
 }
 t.after(async()=>{removers.reverse().forEach(fn=>fn());for(const item of scopes)await item.dispose();await ctx.fiber.dispose();const actual=await fs.realpath(directory);assert.equal(path.dirname(actual),await fs.realpath(os.tmpdir()));assert(path.basename(actual).startsWith('project-execution-sdk-'));assert.equal((await fs.lstat(actual)).isSymbolicLink(),false);await fs.rm(actual,{recursive:true,force:true});});
 return{ctx,agent,state,service,source,provider,call,admit,workspace,setReview:fn=>{review=fn;},setHost:fn=>{host=fn;}};
}

test('production root plugin has no development/config mode fallback; fixtures require an explicit complete binding',async()=>{
 assert(rootInject.includes('tools'));assert(efficiencyInject.includes('sessionQuery'));assert(efficiencyInject.includes('projectExecutionMode'));assert(qualityInject.includes('projectExecutionMode'));
 assert.throws(()=>createProjectExecutionMode(),/BINDING_REQUIRED/);assert.throws(()=>createProjectExecutionMode({snapshot:{mode:'host-compat'},assertUnchanged(){}}),/PROJECTION_INVALID/);
 await assert.rejects(applyRoot({tools:{guard(){}},on(){}}),/IMMUTABLE_RELEASE_REQUIRED/);
 await assert.rejects(executeVerification({}, {}, {signal:new AbortController().signal}),/BINDING_REQUIRED/);
});
test('real sibling provider requires declared inject, and the binding-compatible service is immutable',async t=>{
 const f=await fixture(t);let declared=false,undeclared=false;
 await f.ctx.plugin({name:'declared-mode-consumer',inject:['projectExecutionMode'],apply(ctx){assert.equal(requireProjectExecutionMode(ctx),f.service);assert(Object.isFrozen(ctx.projectExecutionMode));assert(Object.isFrozen(ctx.projectExecutionMode.snapshot));declared=true;}}).await();
 await f.ctx.plugin({name:'undeclared-mode-consumer',apply(ctx){assert.throws(()=>requireProjectExecutionMode(ctx),/cannot get property "projectExecutionMode" without inject/);undeclared=true;}}).await();
 assert(declared&&undeclared);assert.equal(f.service.assertUnchanged(),f.service.snapshot);
});
test('a failed binding initialization leaves an actual root ToolsService slot closed',async t=>{
 const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);t.after(()=>ctx.fiber.dispose());let bodies=0;
 ctx.tools.register({name:'read',description:'Inert native read',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[{type:'text',text:'native'}]},execute(){bodies++;return{};}});
 const pipeline=new ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>executeToolBatch(input,pipeline,()=>1)});
 assert.equal(installClosedProjectExecutionSlot(ctx),undefined);assert.throws(()=>installProjectExecutionMode(ctx,undefined),/BINDING_REQUIRED/);
 const value=await ctx.tools.execute({agent:{id:'not-enrolled',session:{id:'not-enrolled'}},signal:new AbortController().signal,calls:[{id:'closed-init',name:'read',arguments:'{}'}]});assert.equal(value.results[0].result.isError,true);assert.equal(bodies,0);
});
test('isolated slot is closed before workspace load and after unload, including captured native/guest snapshots',async t=>{
 const f=await fixture(t,{mode:'isolated-guest'}),native=await f.admit();t.after(()=>native.dispose());
 assert.equal((await f.call('read')).isError,true);assert.equal(f.state.nativeBodies,0);
 const unload=f.workspace({shadow:['read']}),guest=await f.admit();t.after(()=>guest.dispose());
 assert.equal((await f.call('read',{}, {toolSet:native})).isError,true);assert.equal((await f.call('read',{}, {toolSet:guest})).isError,false);assert.equal(f.state.guestBodies,1);
 unload();for(const toolSet of [native,guest])assert.equal((await f.call('read',{}, {toolSet})).isError,true);
 assert.equal((await f.call('read')).isError,true);assert.equal(f.state.nativeBodies,0);assert.equal(f.state.guestBodies,1);
 f.workspace({shadow:['read']});for(const toolSet of [native,guest])assert.equal((await f.call('read',{}, {toolSet})).isError,true);assert.equal((await f.call('read')).isError,false);
});
test('mandatory provider unload leaves the root guard closed and rejects native fallback',async t=>{
 const f=await fixture(t),captured=await f.admit();t.after(()=>captured.dispose());assert.equal((await f.call('read',{}, {toolSet:captured})).isError,false);
 await f.provider.dispose();const denied=await f.call('read',{}, {toolSet:captured});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/PROJECT_EXECUTION_SERVICE_CLOSED/);assert.equal(f.state.nativeBodies,1);
});
test('host compatibility needs no guest and does not call guest readiness or reconciliation even with AppsOFF',async t=>{
 const f=await fixture(t,{efficiency:true});f.workspace({beforeHeavy:async()=>{throw Error('guest must remain dormant');}});
 assert.equal((await f.call('read')).isError,false);assert.equal((await f.call('project_exec',{command:'npm test'})).isError,false);assert.equal(f.state.nativeBodies,2);assert.equal(f.state.guestChecks,0);
 f.source.change();assert.equal((await f.call('read')).isError,true);assert.equal(f.state.nativeBodies,2);
});
for(const schedule of [true,false])test('required reconciliation runs twice before tool effects, schedule='+schedule,async t=>{
 const f=await fixture(t,{mode:'isolated-guest',efficiency:true,schedule});let checks=0;
 f.workspace({shadow:['project_exec'],beforeHeavy:async()=>{checks++;}});
 assert.equal((await f.call('project_exec',{command:'npm test'})).isError,false);assert.equal(checks,2);assert.equal(f.state.guestBodies,1);
});
for(const change of ['policy','workspace'])test('queued tool rechecks '+change+' after the original retained FairGate lease settles',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',efficiency:true}),queued=defer();let release,checks=0,bodies=0;
 const definition={name:'project_exec',description:'Inert retained process fixture',parameters:{type:'object',additionalProperties:true},output:{schema:{type:'object'},render:()=>[{type:'text',text:'owned acknowledgement'}]},async execute(_args,execution){bodies++;if(bodies===1)release=retainHeavyToolLease(execution);return{exitCode:0};}};
 const dispose=f.agent.ctx.tools.register(definition);t.after(dispose);const unload=f.workspace({accept:[definition],beforeHeavy:async()=>{if(++checks===3)queued.resolve();}});
 assert.equal((await f.call('project_exec',{command:'npm test'})).isError,false);
 const pending=f.call('project_exec',{command:'npm test'});await queued.promise;await tick();
 if(change==='policy')f.source.change();else unload();release();
 const denied=await pending;assert.equal(denied.isError,true);assert.equal(bodies,1);assert.match(JSON.stringify(denied),/PROJECT_EXECUTION_/);
});
test('scheduling disabled still refuses a policy change during the second reconciliation await',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',efficiency:true,schedule:false}),entered=defer(),resume=defer();let checks=0;
 f.workspace({shadow:['project_exec'],beforeHeavy:async()=>{if(++checks===2){entered.resolve();await resume.promise;}}});
 const pending=f.call('project_exec',{command:'npm test'});await entered.promise;f.source.change();resume.resolve();assert.equal((await pending).isError,true);assert.equal(f.state.guestBodies,0);
});
test('isolated focus/explain/overwrite refuse unavailable guest helpers with zero host shell or review reads',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',efficiency:true});
 f.workspace({accept:['focus_context','explain_rewrite','write'].map(name=>f.ctx.tools.get(name,f.agent))});
 const focus=await f.call('focus_context',{}),explain=await f.call('explain_rewrite',{path:'private.txt',sha256:'a'.repeat(64),reason:'An explicit synthetic rewrite explanation for the fixture.',validationPlan:'Run the synthetic regression check before accepting this rewrite.'}),write=await f.call('write',{file_path:'private.txt',content:'changed'});
 assert.equal(focus.isError,true);assert.match(JSON.stringify(focus),/GUEST_CONTEXT_UNAVAILABLE/);assert.equal(explain.isError,true);assert.match(JSON.stringify(explain),/GUEST_REWRITE_UNAVAILABLE/);assert.equal(write.isError,true);assert.match(JSON.stringify(write),/GUEST_REWRITE_UNAVAILABLE/);
 assert.equal(f.state.hostCalls,0);assert.equal(f.state.hostResolves,0);assert.equal(f.state.reviews,0);assert.equal(f.state.nativeBodies,0);
});
test('trusted guest helper seams are rechecked after waits and never fall through to host helpers',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',efficiency:true}),entered=defer(),resume=defer();
 f.workspace({accept:[f.ctx.tools.get('focus_context',f.agent)]});
 f.ctx.on('workspace-runtime/focus-context',async()=>{entered.resolve();await resume.promise;return{value:{sourceHash:'synthetic'}};});
 const pending=f.call('focus_context',{});await entered.promise;f.source.change();resume.resolve();assert.equal((await pending).isError,true);assert.equal(f.state.hostCalls,0);assert.equal(f.state.reviews,0);
});
test('isolated quality with an unavailable guest callback reports failure with zero host effects',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',quality:true});f.workspace({accept:[f.ctx.tools.get('verify_project',f.agent)]});
 const value=await f.call('verify_project',{kind:'all'});assert.equal(value.isError,false,JSON.stringify(value));assert.equal(value.value.passed,false);assert.match(value.value.error,/PROJECT_RUNTIME_ISOLATION_UNAVAILABLE/);assert.equal(f.state.hostCalls,0);assert.equal(f.state.hostResolves,0);assert.equal(f.state.reports.length,1);
});
test('isolated quality accepts the trusted prepared verifier result without any host executor',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',quality:true});f.workspace({accept:[f.ctx.tools.get('verify_project',f.agent)]});let calls=0;
 f.ctx.on('workspace-runtime/verify-command',async input=>{calls++;assert.equal(input.execution.agent,f.agent);assert.equal(input.sourceHash,'source-1');return{result:result()};});
 const value=await f.call('verify_project',{kind:'test'});assert.equal(value.isError,false,JSON.stringify(value));assert.equal(value.value.passed,true);assert.equal(value.value.complete,true);assert.equal(f.state.hostCalls,0);assert.equal(f.state.hostResolves,0);assert.equal(calls,1);assert.equal(f.state.reports[0].exitCode,0);
});
test('isolated quality rejects a binding change while the guest verifier callback is awaited',async t=>{
 const f=await fixture(t,{mode:'isolated-guest',quality:true}),entered=defer(),resume=defer();f.workspace({accept:[f.ctx.tools.get('verify_project',f.agent)]});
 f.ctx.on('workspace-runtime/verify-command',async()=>{entered.resolve();await resume.promise;return{result:result()};});
 const pending=f.call('verify_project',{});await entered.promise;f.source.change();resume.resolve();assert.equal((await pending).isError,true);assert.equal(f.state.hostCalls,0);assert.equal(f.state.reports.length,0);
});
for(const mode of ['host-compat','isolated-guest'])test('quality preserves source staleness and actual nonzero exits in '+mode,async t=>{
 const f=await fixture(t,{mode,quality:true});if(mode==='isolated-guest'){f.workspace({accept:[f.ctx.tools.get('verify_project',f.agent)]});f.ctx.on('workspace-runtime/verify-command',async()=>({result:result({exitCode:7})}));}else f.setHost(async()=>({result:async()=>result({exitCode:7})}));
 let calls=0;f.setReview(async()=>({root:'/synthetic/project',sourceHash:++calls===1?'first':'changed',legacy:false}));
 const value=await f.call('verify_project',{kind:'test'});assert.equal(value.isError,false,JSON.stringify(value));assert.equal(value.value.passed,false);assert.equal(value.value.complete,false);assert.equal(value.value.stale,true);assert.equal(value.value.code,'STALE_SOURCE');assert.equal(f.state.reports[0].exitCode,1);assert.equal(f.state.reports[0].sourceHash,'first');assert.equal(f.state.hostCalls,mode==='host-compat'?1:0);
});
for(const mode of ['host-compat','isolated-guest'])test('quality refuses a changed binding after review before any executor in '+mode,async t=>{
 const f=await fixture(t,{mode,quality:true}),entered=defer(),resume=defer();if(mode==='isolated-guest')f.workspace({accept:[f.ctx.tools.get('verify_project',f.agent)]});
 f.setReview(async()=>{entered.resolve();await resume.promise;return{root:'/synthetic/project',sourceHash:'source',legacy:false};});
 const pending=f.call('verify_project',{});await entered.promise;f.source.change();resume.resolve();assert.equal((await pending).isError,true);assert.equal(f.state.hostCalls,0);assert.equal(f.state.reports.length,0);
});
test('quality waits for a started host process to settle after policy changes, then refuses acceptance',async t=>{
 const f=await fixture(t,{quality:true}),entered=defer(),finished=defer();let settled=false;
 f.setHost(async()=>({result:async()=>{entered.resolve();await finished.promise;return result();}}));
 const pending=f.call('verify_project',{}).then(value=>{settled=true;return value;});await entered.promise;f.source.change();await tick();assert.equal(settled,false);finished.resolve();assert.equal((await pending).isError,true);assert.equal(f.state.hostCalls,1);assert.equal(f.state.reports.length,0);
});
