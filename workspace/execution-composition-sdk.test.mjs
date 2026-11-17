// Actual pinned Cordis/ToolsService/scopes/jobs, with explicit synthetic guest
// responses. No product process, policy publication, guest, model or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {composeProjectExecution} from './execution-composition.mjs';
import {installProjectExecutionMode} from './execution-mode-service.mjs';
import {executionBindingFixture} from './fixtures/execution-binding.mjs';
import {createGuestProjectCommandRunner} from './project-guest-runner.mjs';
import {createProjectRuntimeReceiptStore} from './project-runtime-receipts.mjs';
import {createProjectAppsTools} from './project-apps-tools.mjs';
import {installEditorSessions} from './editor-session.mjs';
import {createProjectCommandRunner} from './project-tool.mjs';
import {bindHeavyToolLease,retainHeavyToolLease} from '../efficiency/heavy-tool-lease.mjs';
import {apply as applyEfficiency,inject as efficiencyInject} from '../efficiency/plugin.mjs';
import {WorkspaceManager} from './manager.mjs';
import {inject as workspaceInject} from './plugin.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)));
const [{Context},{default:SystemPrompt},{default:Tools},{ToolExecutionPipeline,executeToolBatch},{createScope},{default:LocalJobs}]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js'),load('dsh-scope'),load('dsh-jobs-local')]);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),signal=()=>new AbortController().signal;
const result=text=>({exitCode:0,signal:null,timedOut:false,aborted:false,stdout:{text,truncated:false},stderr:{text:'',truncated:false}});
const reply=value=>({cwd:'/workspace',spec:{timeoutMs:30000},result:result(JSON.stringify(value))});
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
function receipts(){const rows=new Map(),claims=new Set();return{async list(){return[...rows.values()];},async save(row){rows.set(row.generation??row.requestId,{...row});},async remove(id){rows.delete(id);},claim(id){assert(!claims.has(id));claims.add(id);return()=>claims.delete(id);},isLive:id=>claims.has(id)};}

async function fixture(t,{mode='isolated-guest',off=false,guest,hostPreview,editorBrowser,extraFactories={}}={}){
 const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);
 const agents=new Map(),scopes=[],routes=new Map(),source=executionBindingFixture(mode),state={native:0,hostRunner:0,guestRunner:0,guestFactories:0,rpc:0,reviews:0,hostShell:0,commands:[],files:new Map([['a.js','const original = true;\n']])};
 ctx.provide('agents',{list:()=>[...agents.values()],get:id=>agents.get(id)});
 ctx.provide('llm',{});ctx.provide('sessionQuery',{readSession:async()=>({events:[]})});
 ctx.provide('connection',{fetch:{register:route=>{routes.set(route.path,route);return()=>routes.delete(route.path);}}});
 ctx.provide('workspaceRegistry',{archivedSessionIds:new Set()});ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write'})});
 ctx.provide('shellEnv',{collect:()=>({})});ctx.provide('shell',{execute(){state.hostShell++;throw Error('HOST_SHELL_TRIPWIRE');}});
 new LocalJobs(ctx,{maxConcurrentJobsPerOwner:4,retainBytes:65536,settledRetainBytes:16000,pumpPollMs:2});
 let execution;
 await ctx.plugin({name:'explicit-mode',inject:['tools'],apply(owner){execution=installProjectExecutionMode(owner,source.binding);}}).await();
 const manager={ctx,execution,root:'/synthetic-private-state',existing:new Set(['owner']),budgets:new Map(),independentRecord:record=>record?.independentRepository===true&&!record.legacy&&!record.nativeWorktree,data:{installedAt:1000,sessions:{},trash:{}},ownerAgent:agent=>agent?.owner??agent,async review(){state.reviews++;return{root:'/projects/owner',sourceHash:'source-v1',legacy:false,checkpoints:manager.data.sessions.owner.checkpoints};},async withProjectRuntimeAuthority(_input,action){return action('synthetic-private-authority');}};
 function agent(id,options={}){const value={id,owner:options.owner,status:'idle',session:{id,header:{createdAt:options.seeded?0:2000,isSeeded:options.seeded===true},append(){}}},scope=createScope(ctx,value);value.ctx=scope.ctx;agents.set(id,value);scopes.push(scope);if(!options.owner)manager.data.sessions[id]={root:'/projects/'+id,independentRepository:true,legacy:options.legacy===true,ports:[21000,21001,21002,21003],checkpoints:{}};return value;}
 const owner=agent('owner');
 for(const name of ['bash','read','write','edit','apply_patch','glob','grep','read_image','str_replace_editor','shell_alias'])ctx.tools.register({name,description:'Inert native '+name,parameters:{type:'object',additionalProperties:true},output:{schema:{type:'object',additionalProperties:true},render:()=>[{type:'text',text:'native'}]},execute(){state.native++;return{};}});
 ctx.on('workspace-runtime/review',async({execution:actual,sessionId})=>({...await manager.review(actual?manager.ownerAgent(actual.agent).id:sessionId),sessionId:'owner'}));ctx.on('workspace-runtime/verification',()=>{});
 const pipeline=new ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>executeToolBatch(input,pipeline,()=>2)});
 const admit=(actual=owner)=>ctx.tools.resolve({agent:actual,modelSelection:{provider:'fixture',model:'fixture'},signal:signal()});
 async function call(name,args={},options={}){const actual=options.agent??owner,toolSet=options.toolSet??await admit(actual);try{return(await ctx.tools.execute({agent:actual,toolSet,signal:options.signal??signal(),calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]})).results[0].result;}finally{if(!options.toolSet)toolSet.dispose();}}
 let composition;
 const guestRun=async(args,actual)=>{
  guestRun.assertAvailable();state.commands.push(args);actual.signal.throwIfAborted();execution.assertUnchanged();
  if(guest)return guest(args,actual,{state,source,execution});
  if(args.command.startsWith('HARNESS_QUALITY_'))return reply({passed:true,complete:true,stale:false,checks:[{passed:true,checksPassed:1,checksTotal:1}]});
  const match=/'([A-Za-z0-9+/=]+)'$/.exec(args.command);if(!match)return{cwd:'/workspace',spec:{timeoutMs:1000},result:result('guest')};
  const input=JSON.parse(Buffer.from(match[1],'base64').toString()),text=state.files.get(input.path??input.operations?.[0]?.path??input.arguments?.file_path);
  if(input.kind==='focus')return reply({excerpts:input.files.map(file=>({path:file.path,sha256:hash(state.files.get(file.path)),content:state.files.get(file.path)}))});
  if(input.kind==='hash')return reply({path:input.path,sha256:hash(text)});
  if(input.kind==='admit')return reply({checks:[{path:input.operations[0].path,sha256:text===undefined?null:hash(text),large:text!==undefined&&text.length>100}]});
  if(input.name==='write'){if(input.expectedSha256!==(text===undefined?null:hash(text)))throw Error('REWRITE_SOURCE_CHANGED');state.files.set(input.arguments.file_path,input.arguments.content);}
  return reply({text:input.name==='read'?text:'completed',truncated:false});
 };
 guestRun.assertAvailable=()=>{execution.assertUnchanged();if(off)throw Object.assign(Error('PROJECT_RUNTIME_ISOLATION_UNAVAILABLE'),{code:'PROJECT_RUNTIME_ISOLATION_UNAVAILABLE'});};
 guestRun.beforeHeavy=async()=>guestRun.assertAvailable();guestRun.dispose=async()=>{};
 const factories={hostRunner(){state.hostRunner++;const run=async()=>({cwd:'/host-project',spec:{timeoutMs:1000},result:result('host compatibility')});run.dispose=async()=>{};return run;},guestRunner(){state.guestFactories++;state.guestRunner++;return guestRun;},runtimeReceipts(){state.guestFactories++;return receipts();},appsReceipts(){state.guestFactories++;return receipts();},projectApps:createProjectAppsTools,editorSessions:installEditorSessions,editorAdapter(){throw Error('OFF_EDITOR_ADAPTER_MUST_NOT_BE_CONSTRUCTED');},...extraFactories};
 const appsConfig={enabled:!off,vm:{enabled:!off},projectRuntime:{enabled:!off,...(editorBrowser?{editorBrowser}:{})},workspaceRoot:'/projects',hostPreview};
 const native=await admit();
 function compose({context=ctx}={}){composition=composeProjectExecution(context,manager,{appsConfig,callApps:async()=>{state.rpc++;throw Error('NO_LIVE_APPS');}},factories);ctx.tools.guard(actual=>WorkspaceManager.prototype.toolGuard.call(manager,composition.managerExecution(actual)));return composition;}
 t.after(async()=>{await composition?.dispose();native.dispose();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();});
 async function efficiency(config={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-composition-efficiency-'));t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-composition-efficiency-'));await fs.rm(real,{recursive:true,force:true});});await ctx.plugin({name:'actual-efficiency-consumer',inject:efficiencyInject,apply:applyEfficiency},{stateDirectory:directory,engineMetrics:false,...config}).await();}
 return{ctx,manager,state,source,execution,owner,agent,admit,call,compose,native,routes,guestRun,efficiency};
}

test('host AppsOFF preserves native legacy tools and managed shell; constructs no guest factories or editor route',async t=>{
 const f=await fixture(t,{mode:'host-compat',off:true}),composition=f.compose();composition.install(f.owner);
 assert.equal((await f.call('read')).isError,false);assert.equal((await f.call('bash',{command:'pwd',description:'Inspect project'})).isError,false);
 const legacy=f.agent('legacy',{legacy:true});composition.install(legacy);assert.equal((await f.call('bash',{command:'pwd',description:'Inspect retained workspace'},{agent:legacy})).isError,false);
 assert.equal(f.state.native,2);assert.equal(f.state.hostRunner,1);assert.equal(f.state.guestFactories,0);assert.equal(f.state.rpc,0);assert.equal(f.routes.has('/api/workbench/editor'),false);
 f.source.fail();assert.equal((await f.call('read')).isError,true);assert.equal(f.state.native,2);
});

test('explicit supported HOST preview configuration enables custody with AppsOFF without constructing guest components',async t=>{
 const config={enabled:true,ownerOrigin:'https://owner.test',endpoints:[{origin:'https://owner.test:8443',listenerPort:18190}]};let options,received,installed=0;
 const f=await fixture(t,{mode:'host-compat',off:true,hostPreview:config,extraFactories:{previewSupported:()=>true,hostRunner(_ctx,_manager,value){options=value;const run=async()=>({cwd:'/host-project',spec:{timeoutMs:1000},result:result('host')});run.dispose=async()=>{};return run;},hostPreview(_ctx,_manager,_run,value){received=value;return{install(){installed++;},remove(){},handles:()=>false,async dispose(){}};}}});
 const composition=f.compose();composition.install(f.owner);assert.deepEqual(options,{captureBackgroundCustody:true});assert.deepEqual(received,config);assert.equal(installed,1);assert.equal(f.state.guestFactories,0);assert.equal(f.state.rpc,0);
});

for(const conflict of ['origin','listener','malformed'])test('editor '+conflict+' configuration disables HOST preview custody before any capture',async t=>{
 const endpoint={origin:'https://owner.test:8443',listenerPort:18190},config={enabled:true,ownerOrigin:'https://owner.test',endpoints:[endpoint]};let options,received;
 const editor=conflict==='origin'?{...endpoint,listenerPort:18191}:conflict==='listener'?{...endpoint,origin:'https://owner.test:8444'}:null;
 const f=await fixture(t,{mode:'host-compat',off:true,hostPreview:config,editorBrowser:{ownerOrigin:'https://owner.test',endpoints:[editor]},extraFactories:{previewSupported:()=>true,hostRunner(_ctx,_manager,value){options=value;const run=async()=>{};run.dispose=async()=>{};return run;},hostPreview(_ctx,_manager,_run,value){received=value;return{install(){},remove(){},handles:()=>false,async dispose(){}};}}});
 f.compose();assert.deepEqual(options,{});assert.equal(received,null);
});
test('isolated actual scoped definitions reject captured native sets and unknown shell aliases; unload remains closed',async t=>{
 const f=await fixture(t),composition=f.compose();
 assert.equal((await f.call('read',{file_path:'a.js'},{toolSet:f.native})).isError,true);
 assert.equal((await f.call('read',{file_path:'a.js'})).isError,false);
 assert.equal((await f.call('shell_alias',{})).isError,true);
 const captured=await f.admit();t.after(()=>captured.dispose());await composition.dispose();
 for(const toolSet of [f.native,captured])assert.equal((await f.call('read',{file_path:'a.js'},{toolSet})).isError,true);
 assert.equal(f.state.native,0);assert.equal(f.state.hostShell,0);assert.equal(f.state.hostRunner,0);
});
test('real sibling composition consumes the declared root binding and unloading its fiber leaves the permanent slot closed',async t=>{
 const f=await fixture(t);assert.equal((await f.call('read',{file_path:'a.js'})).isError,true);const consumer=f.ctx.plugin({name:'actual-workspace-composition-consumer',inject:['agents','tools','projectExecutionMode','sessionQuery','connection','workspaceRegistry','sandboxPolicy','shell','shellEnv'],apply(owner){const composition=f.compose({context:owner});owner.effect(()=>()=>composition.dispose());}});await consumer.await();assert.equal((await f.call('read',{file_path:'a.js'})).isError,false);await consumer.dispose();assert.equal((await f.call('read',{file_path:'a.js'})).isError,true);assert.equal(f.state.native,0);assert.equal(f.state.hostShell,0);
});
for(const mode of ['host-compat','isolated-guest'])test('exact workspace inject preserves AppsOFF startup with missing optional conversation services in '+mode,async t=>{
 const f=await fixture(t,{mode,off:true});for(const name of workspaceInject)if(f.ctx.get(name)===undefined)f.ctx.provide(name,{});let ready=false;
 const consumer=f.ctx.plugin({name:'exact-workspace-inject-missing-optionals-'+mode,inject:workspaceInject,async apply(owner){assert.equal(owner.get('sessionProjections'),undefined);assert.equal(owner.get('userQuestions'),undefined);const composition=f.compose({context:owner});owner.effect(()=>()=>composition.dispose());if(composition.isolated)await composition.ready;ready=true;}});await consumer.await();assert.equal(ready,true);assert.equal(f.ctx.tools.get('todo_write',f.owner),undefined);assert.equal(f.ctx.tools.get('ask_user_question',f.owner),undefined);assert.equal((await f.call('read',{file_path:'a.js'})).isError,mode==='isolated-guest');if(mode==='host-compat'){assert.equal(f.state.guestFactories,0);assert.equal(f.state.hostRunner,1);}assert.equal(f.state.rpc,0);assert.equal(f.state.hostShell,0);await consumer.dispose();
});
test('new, seeded, legacy and child scopes are shadowed before resolution, including their earlier native snapshots',async t=>{
 const f=await fixture(t),composition=f.compose();
 for(const[id,options]of [['seeded',{seeded:true}],['legacy',{legacy:true}],['child',{owner:f.owner}]]){
  const actual=f.agent(id,options),before=await f.admit(actual);composition.install(actual);const after=await f.admit(actual);
  assert.equal((await f.call('read',{file_path:'a.js'},{agent:actual,toolSet:before})).isError,true);
  assert.equal((await f.call('read',{file_path:'a.js'},{agent:actual,toolSet:after})).isError,id==='legacy');before.dispose();after.dispose();
 }
 assert.equal(f.state.native,0);assert.equal(f.state.hostShell,0);
});
test('isolated AppsOFF loads editor unavailable and refuses every guest route with no host or RPC effects',async t=>{
 const f=await fixture(t,{off:true});f.compose();
 for(const[name,args]of [['bash',{command:'pwd',description:'Inspect project'}],['project_exec',{command:'pwd',description:'Inspect project'}],['read',{file_path:'a.js'}],['write',{file_path:'a.js',content:'replacement'}],['focus_context',{}],['explain_rewrite',{path:'a.js',sha256:'a'.repeat(64),reason:'A concrete synthetic reason requiring this rewrite.',validationPlan:'Run a focused synthetic regression check after the change.'}],['verify_project',{kind:'test'}],['project_apps',{operation:'verify_deploy'}]])assert.equal((await f.call(name,args)).isError,true,name);
 const response=await f.routes.get('/api/workbench/editor').fetch(new Request('http://native.internal/api/workbench/editor',{method:'POST',headers:{host:'owner.test',origin:'https://owner.test','content-type':'application/json'},body:JSON.stringify({op:'open',sessionId:'owner'})}));
 assert.equal((await response.json()).state,'unavailable');assert.equal(f.state.native,0);assert.equal(f.state.hostShell,0);assert.equal(f.state.rpc,0);assert.equal(f.state.reviews,0);
});
test('focus/explain/write are confined guest callbacks with exact-hash one-use rewrite admission',async t=>{
 const f=await fixture(t);f.state.files.set('a.js','old source\n'.repeat(70));f.manager.data.sessions.owner.checkpoints={working:{}};f.compose();
 const initial=f.state.files.get('a.js');assert.equal((await f.call('write',{file_path:'a.js',content:'replacement'})).isError,true);
 const context=await f.call('focus_context',{files:[{path:'/projects/owner/a.js',lines:4}]});assert.equal(context.isError,false,JSON.stringify(context));assert.equal(context.value.excerpts[0].sha256,hash(initial));
 const args={path:'a.js',sha256:hash(initial),reason:'Replace this source because the synthetic contract changed.',validationPlan:'Run the focused regression fixture and inspect its real exit.'};
 assert.equal((await f.call('explain_rewrite',args)).isError,false);assert.equal((await f.call('write',{file_path:'a.js',content:'replacement'})).isError,false);
 f.state.files.set('a.js',initial);assert.equal((await f.call('write',{file_path:'a.js',content:'replacement'})).isError,true,'grant was consumed');
 assert.equal((await f.call('focus_context',{files:[{path:'../other/private'}]})).isError,true);
 assert.equal((await f.call('explain_rewrite',{...args,sha256:'b'.repeat(64)})).isError,true);
 assert.equal(f.state.native,0);assert.equal(f.state.hostShell,0);
});
test('guest focus retains the owner human objective and latest request from canonical history when called by a child',async t=>{
 const f=await fixture(t),reads=[];f.ctx.sessionQuery.readSession=async id=>{reads.push(id);return{events:[{type:'user/message',data:{id:'original',role:'user',source:{kind:'user'},content:[{type:'text',text:'Preserve the original objective.'}]}},{type:'agent/inbox/spliced',data:{inserted:[{id:'latest',role:'user',source:{kind:'user'},content:[{type:'text',text:'Also preserve the latest correction.'}]}]}}]};};const composition=f.compose(),child=f.agent('child',{owner:f.owner});composition.install(child);const context=await f.call('focus_context',{files:[{path:'a.js'}]},{agent:child});assert.equal(context.isError,false,JSON.stringify(context));assert.equal(context.value.task,'Preserve the original objective.');assert.equal(context.value.latestRequest,'Also preserve the latest correction.');assert.equal(context.value.sourceHash,'source-v1');assert.deepEqual(reads,['owner']);assert.equal(f.state.hostShell,0);
});
test('pre-step hydrates the original objective before applying a newer visible correction',async t=>{
 const f=await fixture(t);f.ctx.sessionQuery.readSession=async()=>({events:[{type:'user/message',data:{id:'original',role:'user',source:{kind:'user'},content:[{type:'text',text:'The original human objective.'}]}}]});f.compose();await f.ctx.waterfall('agent/pre-step',{agent:f.owner,signal:signal(),messages:[{id:'latest',role:'user',source:{kind:'user'},content:[{type:'text',text:'The visible later correction.'}]}]},()=>({kind:'enter',messages:[]}));const value=await f.call('focus_context',{files:[{path:'a.js'}]});assert.equal(value.isError,false,JSON.stringify(value));assert.equal(value.value.task,'The original human objective.');assert.equal(value.value.latestRequest,'The visible later correction.');
});
test('hash proof rejects a change between admission and the guest worker mutation',async t=>{
 let writes=0;const f=await fixture(t,{guest:async(args,_execution,{state})=>{const input=JSON.parse(Buffer.from(/'([A-Za-z0-9+/=]+)'$/.exec(args.command)[1],'base64').toString());if(input.kind==='admit'){const before=state.files.get('a.js');state.files.set('a.js','concurrently changed');return reply({checks:[{path:'a.js',sha256:hash(before),large:false}]});}if(input.name==='write'){writes++;assert.notEqual(input.expectedSha256,hash(state.files.get('a.js')));throw Error('REWRITE_SOURCE_CHANGED');}throw Error('Unexpected guest operation');}});f.compose();
 assert.equal((await f.call('write',{file_path:'a.js',content:'replacement'})).isError,true);assert.equal(writes,1);assert.equal(f.state.files.get('a.js'),'concurrently changed');assert.equal(f.state.native,0);
});
test('guest /workspace targets retain immutable admitted arguments while the existing manager guard sees the same confined project',async t=>{
 const f=await fixture(t);f.compose();const write=await f.call('write',{file_path:'/workspace/a.js',content:'replacement'});assert.equal(write.isError,false,JSON.stringify(write));assert.equal(f.state.files.get('a.js'),'replacement');assert.equal((await f.call('write',{file_path:'/workspace/../outside',content:'no'})).isError,true);assert.equal(f.state.files.get('a.js'),'replacement');assert.equal(f.state.native,0);
});
test('current source change during awaited guest context refuses output and every later effect',async t=>{
 const entered=deferred(),resume=deferred();const f=await fixture(t,{guest:async()=>{entered.resolve();await resume.promise;return reply({excerpts:[]});}});f.compose();const pending=f.call('focus_context',{});await entered.promise;f.source.fail();resume.resolve();assert.equal((await pending).isError,true);assert.equal((await f.call('bash',{command:'pwd',description:'Inspect project'})).isError,true);assert.equal(f.state.hostShell,0);assert.equal(f.state.native,0);
});
test('actual efficiency T06 middleware and the scoped file body share one execution-bound mutation proof',async t=>{
 const f=await fixture(t);f.state.files.set('a.js','old source\n'.repeat(70));f.manager.data.sessions.owner.checkpoints={working:{}};f.compose();await f.efficiency({schedule:false});
 const initial=f.state.files.get('a.js'),args={path:'a.js',sha256:hash(initial),reason:'Replace this source because the synthetic contract changed.',validationPlan:'Run the focused regression fixture and inspect its real exit.'};
 assert.equal((await f.call('write',{file_path:'a.js',content:'replacement'})).isError,true);assert.equal((await f.call('explain_rewrite',args)).isError,false);
 assert.equal((await f.call('write',{file_path:'a.js',content:'replacement'})).isError,false);assert.equal(f.state.files.get('a.js'),'replacement');
 assert.equal(f.state.commands.filter(command=>command.description==='Inspect bounded guest project context').length,3,'one denied inspection, one hash check, one admitted inspection; body reuses admission');assert.equal(f.state.hostShell,0);assert.equal(f.state.native,0);
});
test('actual efficiency queue rechecks the same binding after retained lease release, before any second guest effect',async t=>{
 let release;const queued=deferred(),f=await fixture(t,{guest:async(_args,actual)=>{release=retainHeavyToolLease(actual);return{cwd:'/workspace',spec:{timeoutMs:1000},result:result('started')};}});f.compose();let checks=0;f.guestRun.beforeHeavy=async()=>{if(++checks===3)queued.resolve();};await f.efficiency();
 assert.equal((await f.call('project_exec',{command:'npm test',description:'Run synthetic heavy check'})).isError,false);const pending=f.call('project_exec',{command:'npm test',description:'Run queued synthetic heavy check'});await queued.promise;await pause();f.source.fail();release();assert.equal((await pending).isError,true);assert.equal(f.state.commands.length,1);assert.equal(f.state.hostShell,0);
});
test('schedule=false still rechecks after the second awaited reconciliation before guest effects',async t=>{
 const f=await fixture(t);f.compose();let checks=0;f.guestRun.beforeHeavy=async()=>{if(++checks===2)f.source.fail();};await f.efficiency({schedule:false});assert.equal((await f.call('project_exec',{command:'npm test',description:'Run bounded check'})).isError,true);assert.equal(checks,2);assert.equal(f.state.commands.length,0);assert.equal(f.state.native,0);
});
test('scoped job tools serve actual child owners and strip foreign jobs without native callbacks',async t=>{
 const f=await fixture(t),composition=f.compose(),child=f.agent('child',{owner:f.owner});composition.install(child);
 const own=f.ctx.jobs.start({kind:'fixture',owner:child.id,label:'owned child job',run(handle){handle.append('bounded own output',{channel:'stdout'});return{done:Promise.resolve({status:'completed',result:'own result'}),cancel(){}};}});
 const foreign=f.ctx.jobs.start({kind:'fixture',owner:f.owner.id,label:'foreign parent job',run(){return{done:Promise.resolve({status:'completed'}),cancel(){}};}});await f.ctx.jobs.wait(own,1000,child.id,signal());await f.ctx.jobs.wait(foreign,1000,f.owner.id,signal());
 const list=await f.call('job_list',{}, {agent:child});assert.equal(list.isError,false,JSON.stringify(list));assert.deepEqual(list.value.jobs.map(job=>job.id),[own]);const output=await f.call('job_output',{job_id:own},{agent:child});assert.equal(output.isError,false,JSON.stringify(output));assert.match(output.value.text,/bounded own output/);assert.equal((await f.call('job_output',{job_id:foreign},{agent:child})).isError,true);assert.equal(f.state.native,0);assert.equal(f.state.hostShell,0);
});
test('isolated verification retains real guest exit codes and source staleness',async t=>{
 const f=await fixture(t);f.manager.data.sessions.owner.root=path.resolve('/projects/owner');f.manager.review=async()=>({root:f.manager.data.sessions.owner.root,sourceHash:'source-v1',checkpoints:{}});f.compose();const value=await f.call('verify_project',{kind:'test'});assert.equal(value.isError,false,JSON.stringify(value));assert.equal(value.value.passed,true,JSON.stringify(value));assert.equal(value.value.sourceHash,'source-v1');assert(f.state.commands[0].command.includes('/opt/homeai/quality/cli.mjs'));assert.equal(f.state.hostShell,0);
});
test('guest verification refuses reported success with a real nonzero exit, and detects source changes after execution',async t=>{
 for(const change of ['exit','source']){
  const f=await fixture(t,{guest:async()=>{const value=reply({passed:true,complete:true,stale:false,checks:[{passed:true,checksPassed:1,checksTotal:1}]});if(change==='exit')value.result.exitCode=19;return value;}});f.manager.data.sessions.owner.root=path.resolve('/projects/owner');let reviews=0;f.manager.review=async()=>({root:f.manager.data.sessions.owner.root,sourceHash:++reviews>=3&&change==='source'?'source-v2':'source-v1',checkpoints:{}});f.compose();const value=await f.call('verify_project',{kind:'test'});assert.equal(value.isError,false,JSON.stringify(value));assert.equal(value.value.passed,false);assert.equal(value.value.complete,false);if(change==='source'){assert.equal(value.value.stale,true);assert.equal(value.value.code,'STALE_SOURCE');}assert.equal(f.state.hostShell,0);
 }
});
test('guest background uses trusted executor and keeps the SDK lease until exact guest stop settles',async t=>{
 const f=await fixture(t);let running=true,releaseStop,admitted,host=0;const settled=deferred(),rows=receipts();
 const real=createGuestProjectCommandRunner(f.ctx,f.manager,{appsConfig:{enabled:true,vm:{enabled:true},projectRuntime:{enabled:true}},receiptStore:rows,pollMs:1,wait:pause,async callApps(route,data){
  if(data?.op==='execute'){admitted={version:1,state:'running',sessionId:data.sessionId,generation:data.generation,jobId:'b'.repeat(16),operationId:'c'.repeat(32),stopToken:data.stopToken};return admitted;}
  if(data?.op==='stop'){await new Promise(resolve=>releaseStop=resolve);running=false;settled.resolve();return{version:1,state:'stopped',sessionId:data.sessionId,generation:data.generation,operationId:admitted.operationId};}
  if(route.startsWith('/job-status'))return{version:1,job:{id:admitted.jobId,action:'project-executor',status:running?'running':'interrupted',terminal:!running}};
  if(route.startsWith('/job-log'))return{text:'synthetic guest server'};throw Error('Unexpected route');
 }},f.execution);
 f.ctx.shell.execute=()=>{host++;throw Error('HOST_BACKGROUND_TRIPWIRE');};
 // A serving real SDK controller must precede start().
 const removeController=f.ctx.jobs.attachController('explicit-guest-background-fixture');t.after(removeController);
 const execution={agent:f.owner,signal:signal(),callId:'guest-bg'},release=bindHeavyToolLease(execution,{release(){settled.lease=true;}});
 const value=await real({command:'node server.mjs',description:'Run synthetic guest server',run_in_background:true,timeoutMs:1000},execution);release();assert.equal(value.background.kind,'background');assert.equal(settled.lease,undefined);
 for(let i=0;i<100&&!admitted;i++)await pause();assert(admitted);f.ctx.jobs.kill(value.background.jobId,f.owner.id,'stop owned guest');for(let i=0;i<100&&!releaseStop;i++)await pause();assert(releaseStop);assert.equal(settled.lease,undefined);releaseStop();await settled.promise;await f.ctx.jobs.wait(value.background.jobId,1000,f.owner.id,signal());assert.equal(settled.lease,true);assert.equal(host,0);await real.dispose();
});
