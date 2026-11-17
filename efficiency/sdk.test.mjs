// Explicit integration suite for the pinned Harness SDK (not a Linux sandbox test).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {apply,inject} from './plugin.mjs';
import {digest} from '../quality/core.mjs';
import {createHash} from 'node:crypto';
import {createProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
function hostMode(){const policy={version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)},policySha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'),snapshot={...policy,policySha256,sourceCommit:'a'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'};return createProjectExecutionMode({snapshot,assertUnchanged:()=>snapshot}).service;}

const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const yaml=createRequire(path.join(path.dirname(SDK),'package.json'))('yaml');
const {installEfficiency}=createRequire(import.meta.url)('./install.cjs');
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)).href);
const [{Context},{default:SystemPrompt,renderPrompt,renderContextSections},{default:Tools},{ToolExecutionPipeline,executeToolBatch}]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js')]);
test('real YAML parser preserves unrelated configuration and never installs two schedulers',()=>{
  const source='- insert:\n  - id: cloud-homeai-turn-queue-v1\n    name: file:///data/harness/app/vast/turn-queue/plugin.mjs\n  - id: untouched\n    name: example\n    config:\n      value: keep-this-configuration\n';
  const installed=installEfficiency(source,yaml);assert.equal(installEfficiency(installed,yaml),installed);assert.match(installed,/keep-this-configuration/);assert.doesNotMatch(installed,/cloud-homeai-turn-queue-v1/);assert.equal((installed.match(/id: cloud-qwen-efficiency-v1/gu)??[]).length,1);
  assert.throws(()=>installEfficiency(source.replace('/vast/turn-queue/plugin.mjs','/unexpected.mjs'),yaml));assert.throws(()=>installEfficiency(source,yaml,{schedule:false}));
});

async function fixture(t,{throughPlugin=false,declaredInject=inject,events=[]}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'eff-sdk-'));const ctx=new Context();
  t.after(async()=>{await ctx.fiber.dispose();await fs.rm(directory,{recursive:true,force:true});});
  new SystemPrompt(ctx,{});new Tools(ctx);
  const agent={id:'sdk-agent',session:{id:'sdk-agent',header:{}}};ctx.provide('agents',{get:id=>id===agent.id?agent:undefined});ctx.provide('llm',{});ctx.provide('shell',{});ctx.provide('shellEnv',{});
  if(throughPlugin)await ctx.plugin({name:'explicit-execution-mode-fixture',apply(owner){owner.provide('projectExecutionMode',hostMode());}}).await();
  else ctx.provide('projectExecutionMode',hostMode());
  const historyReads=[],queryService={async readSession(id){historyReads.push(id);return{events};}};
  // Native owns sessionQuery in a sibling plugin, not on the root context.
  // A root-owned provision would bypass Cordis's declared dependency check.
  if(throughPlugin)await ctx.plugin({name:'canonical-query-fixture',apply(owner){owner.provide('sessionQuery',queryService);}}).await();
  else ctx.provide('sessionQuery',queryService);
  ctx.on('workspace-runtime/review',async()=>({root:directory,sourceHash:'current-source',checkpoints:{test:{}},legacy:false}));
  const config={stateDirectory:path.join(directory,'.state'),engineMetrics:false};
  if(throughPlugin)await ctx.plugin({name:'efficiency-injection-fixture',apply,inject:declaredInject},config).await();
  else await apply(ctx,config);
  const pipeline=new ToolExecutionPipeline(ctx);
  ctx.tools.setExecutor({describe:definitions=>({schemas:definitions.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>executeToolBatch(input,pipeline,()=>2)});
  const call=async(name,args)=>{const batch=await ctx.tools.execute({agent,signal:new AbortController().signal,calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}]});return batch.results[0].result;};
  return{directory,ctx,agent,call,historyReads};
}

test('real SDK plugin dependency enforcement permits canonical request hydration and rejects an undeclared query service',async t=>{
  const message=(id,text)=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text}]});
  const original=message('original','Create the synthetic note and preserve its first line.'),correction=message('correction','Keep the original goal and append the exact correction marker.');
  const events=[{type:'user/message',data:original},{type:'agent/inbox/spliced',data:{inserted:[correction]}}];
  const f=await fixture(t,{throughPlugin:true,events}),selection={provider:'strata-vast',model:'strata'},signal=new AbortController().signal;
  const step=state=>state.ctx.waterfall('agent/pre-step',{agent:state.agent,modelSelection:selection,messages:[original],signal},async()=>({kind:'enter',messages:[original]}));
  await step(f);await step(f);
  const assembled=await f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent,modelSelection:selection,signal});
  const rendered=JSON.stringify(renderContextSections(assembled));assert.match(rendered,/preserve its first line/);assert.match(rendered,/exact correction marker/);assert.deepEqual(f.historyReads,['sdk-agent']);
  const missing=await fixture(t,{throughPlugin:true,declaredInject:inject.filter(name=>name!=='sessionQuery'),events});
  await assert.rejects(()=>step(missing),/cannot get property "sessionQuery" without inject/);assert.deepEqual(missing.historyReads,[]);
});

test('real SDK validates output schemas, preserves canonical status and enforces one-use rewrite policy',async t=>{
  const f=await fixture(t);const before=Array.from({length:100},(_,i)=>'old'+i).join('\n'),after=Array.from({length:100},(_,i)=>'new'+i).join('\n');await fs.writeFile(path.join(f.directory,'cart.js'),before);
  f.ctx.tools.register({name:'write',description:'SDK fixture write',parameters:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},required:['file_path','content']},output:{schema:{type:'object',properties:{written:{type:'boolean'}},required:['written']},render:()=>[{type:'text',text:'written'}]},execute:async args=>{await fs.writeFile(args.file_path,args.content);return{written:true};}});
  const denied=await f.call('write',{file_path:path.join(f.directory,'cart.js'),content:after});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/REWRITE_EXPLANATION_REQUIRED/);assert.equal(await fs.readFile(path.join(f.directory,'cart.js'),'utf8'),before);
  const explanation=await f.call('explain_rewrite',{path:'cart.js',sha256:digest(before),reason:'The synthetic SDK fixture replaces a large table to exercise the exact native policy.',validationPlan:'Run the unchanged arithmetic test and the full current-source quality contract.'});assert.equal(explanation.isError,false,JSON.stringify(explanation));
  const written=await f.call('write',{file_path:path.join(f.directory,'cart.js'),content:after});assert.equal(written.isError,false);assert.equal(await fs.readFile(path.join(f.directory,'cart.js'),'utf8'),after);
  const nativeOutput='noise '.repeat(3000)+'\n# tests 19\n# pass 7\n# fail 12\n'
    +Array.from({length:12},(_,i)=>'Error: fixture diagnostic '+i+' '+'x'.repeat(600)).join('\n');
  f.ctx.tools.register({name:'project_exec',description:'SDK command output fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{exitCode:{type:'integer'},stdout:{type:'string'}},required:['exitCode','stdout']},render:(_args,value)=>[{type:'text',text:value.stdout}]},execute:async()=>({exitCode:7,stdout:nativeOutput})});
  const log=await f.call('project_exec',{});assert.equal(log.isError,false);assert.equal(log.value.exitCode,7);assert.match(log.content[0].text,/exitCode=7/);assert.ok(log.content[0].text.length<6500);
  assert.doesNotMatch(log.content[0].text,/# fail 12/);assert.equal(log.value.stdout,nativeOutput);
});
test('real SDK appends changing work context without changing the reusable system text or tool order',async t=>{
  const f=await fixture(t),selection={provider:'strata-vast',model:'strata'},signal=new AbortController().signal;
  const assemble=()=>f.ctx.systemPrompt.assemble({agent:f.agent,scope:f.agent,modelSelection:selection,signal});
  const before=await assemble();
  const messages=[{role:'user',source:{kind:'user'},content:[{type:'text',text:'Implement checkout and preserve keyboard access.'}]}];
  await f.ctx.waterfall('agent/pre-step',{agent:f.agent,modelSelection:selection,messages,signal},async()=>({kind:'enter',messages}));
  const after=await assemble();assert.equal(renderPrompt(before),renderPrompt(after));assert.match(JSON.stringify(renderContextSections(after)),/keyboard access/);
  assert.deepEqual(before.tools.map(x=>x.name),after.tools.map(x=>x.name));assert.equal(messages[0].content[0].text,'Implement checkout and preserve keyboard access.');
});
test('real SDK can infer for another task during a heavy tool while serializing provider streams',async t=>{
  const f=await fixture(t);let releaseTool,toolStarted,toolActive=false,activeModels=0,maxModels=0;
  const started=new Promise(r=>toolStarted=r),holdTool=new Promise(r=>releaseTool=r);
  f.ctx.tools.register({name:'project_exec',description:'SDK controlled heavy tool',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},output:{schema:{type:'object'},render:()=>[{type:'text',text:'done'}]},execute:async()=>{toolActive=true;toolStarted();await holdTool;toolActive=false;return{exitCode:0};}});
  const runningTool=f.call('project_exec',{command:'npm test'});await started;
  const request=async id=>{const stream=f.ctx.waterfall('llm/stream',{provider:'strata-vast',sessionId:id,messages:[],signal:new AbortController().signal},()=>async function*(){activeModels++;maxModels=Math.max(activeModels,maxModels);assert.equal(toolActive,true);try{yield{type:'text-delta',index:0,text:'OK'};await new Promise(r=>setTimeout(r,30));yield{type:'finish',reason:{kind:'stop'}};}finally{activeModels--;}}());for await(const _ of await stream){}};
  await Promise.all([request('B'),request('C')]);assert.equal(maxModels,1);assert.equal(toolActive,true);releaseTool();assert.equal((await runningTool).isError,false);
});
