// Real SDK maintenance, inbox, AgentLoop, SessionStore and native tool executor.
// Local inert adapter and explicitly synthetic readonly workspace projection;
// production budgeting functions admit every step. No sockets/model requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createIncompleteContinuation,apply} from './continue-incomplete.mjs';
import {RepairBudget} from '../workspace/policy.mjs';
import {prepareAutomaticRequest,admitAutomaticStep} from '../workspace/automatic-review.mjs';
import {beginUserRequest} from '../workspace/turn-budget.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)).href);
const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:SystemPrompt},{default:Tools},{default:AgentLoop},{NativeToolExecutor},{subagentCatalogProjectionDefinition}]=await Promise.all([...['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-tool-executor-native'].map(name=>load(name)),load('dsh-subagent','types/catalog.js')]);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const progress='WebGL2 funguje i v headless Chromium (SwiftShader) — můžu tedy ověřit render reálnými screenshoty. Teď napíšu samotnou hru.';
const human=id=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text:'Implement the original synthetic game, then test it.'}]});
const isOwn=message=>message?.source?.kind==='workspace-runtime';
async function active(fibers){const deadline=Date.now()+2000;while(fibers.some(f=>f.state!==2)){await Promise.all(fibers.map(f=>f.await()));assert(Date.now()<deadline);await new Promise(resolve=>setImmediate(resolve));}}
async function eventually(predicate){const deadline=Date.now()+2000;while(!predicate()){assert(Date.now()<deadline,'SDK admission did not arrive');await new Promise(resolve=>setImmediate(resolve));}}
async function fixture(t,options={}){
  const {reasoning=false,...recoveryConfig}=options;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'continue-incomplete-')),registryPath=path.join(directory,'registry.json'),journalRoot=path.join(directory,'journals'),ctx=new Context(),events=[],durable=[],admissions=[];
  let calls=0,reviewCount=0,onReview=()=>{},onFlush=()=>{},jobs=[],terminals=[],holdSeventh;
  t.after(async()=>{await ctx.fiber.dispose();assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));assert(path.basename(directory).startsWith('continue-incomplete-'));await fs.rm(directory,{recursive:true,force:true});});
  await active([Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{})));
  await active([ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1})]);
  await ctx.sessionProjections.register(subagentCatalogProjectionDefinition);
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  ctx.tools.register({name:'fixture_probe',description:'Inert successful probe',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:()=>[{type:'text',text:'Synthetic probe succeeded.'}]},execute:()=>({})});
  class Inert extends LlmAdapter{async *stream(){calls++;assert(calls<=8,'No duplicate model dispatch');if(calls<=5)yield{type:'block-end',index:0,block:{type:'tool-call',id:'fixture-'+calls,name:'fixture_probe',arguments:'{}'}};else{if(calls===7)await holdSeventh;if(reasoning)yield{type:'reasoning-delta',index:0,text:'Synthetic reasoning from the inert adapter.'};yield{type:'text-delta',index:reasoning?1:0,text:calls===6?progress:'Done. The synthetic original task is complete.'};}yield{type:'finish',reason:{kind:'stop'},replayState:{response:{stopReason:'stop'}}};}}
  ctx.llm.registerAdapter(['strata-vast'],new Inert());
  const budget=new RepairBudget(),record={root:directory,legacy:false,budget},registry={sessions:{owner:record},trash:{}};
  const save=()=>fs.writeFile(registryPath,JSON.stringify(registry));
  ctx.on('session/event',(session,event)=>{if(session.id==='owner')events.push(structuredClone(event));},{global:true});
  ctx.on('session/flush',async session=>{if(session.id==='owner'){await onFlush();durable.splice(0,durable.length,...structuredClone(events));}},{global:true});
  ctx.provide('sessionQuery',{readSession:async id=>{assert.equal(id,'owner');return{events:structuredClone(durable)};}});
  ctx.provide('jobs',{list:()=>jobs});ctx.provide('terminalController',{list:()=>terminals});
  ctx.on('workspace-runtime/review',async({sessionId})=>{assert.equal(sessionId,'owner');await onReview(++reviewCount);return{sessionId,root:directory,sourceHash:'a'.repeat(64),legacy:false,budget,restoreRecovery:{pending:false}};},{global:true});
  ctx.on('agent/pre-step',async(input,next)=>{
    prepareAutomaticRequest(record,budget,{turn:input.turn,messages:input.messages,owner:true},60);
    beginUserRequest(record,budget,input);assert.equal(admitAutomaticStep(budget,{}),true);
    admissions.push({steps:budget.steps,taskSteps:budget.automatic.taskSteps,original:record.automaticRequest.messageId});await save();return next();
  },{global:true});
  const {agent}=await ctx.agents.create({sessionId:'owner',meta:{cwd:directory},agentOptions:{provider:'strata-vast',model:'inert-fixture'}});
  agent.followup(human('original-human'));await agent.whenIdle();await ctx.sessions.flush(agent.session);
  assert.equal(calls,6);assert.equal(budget.steps,6);assert.equal(budget.automatic.taskSteps,6);
  const ended=events.findLast(e=>e.type==='turn/end');assert.equal(ended.data.reason.kind,'completed');
  const request={sessionId:'owner',requestId:'fixed-request-r',expectedTurnEndSeq:ended.seq},prefix=structuredClone(events),beforeBudget=hash(budget);
  const continuation=createIncompleteContinuation(ctx,{registryPath,journalRoot,...recoveryConfig});
  return{ctx,agent,events,durable,record,budget,registry,request,prefix,beforeBudget,admissions,registryPath,journalRoot,continuation,save,calls:()=>calls,setFlush:fn=>onFlush=fn,setReview:fn=>onReview=fn,setJobs:rows=>jobs=rows,setTerminals:rows=>terminals=rows,hold:promise=>holdSeventh=promise};
}
test('actual SDK recovery retains six steps until admission seven and dispatches fixed R once',{timeout:10000},async t=>{
  const f=await fixture(t,{reasoning:true});let release;f.hold(new Promise(resolve=>release=resolve));
  assert.deepEqual(f.events.findLast(e=>e.type==='assistant/message').data.message.content.map(block=>block.type),['reasoning','text']);
  try{
  const result=await f.continuation.recover(f.request);assert.equal(result.accepted,true);assert.equal(result.state,'queued');
  await eventually(()=>f.admissions.length===7);assert.equal(f.admissions[6].steps,7);assert.equal(f.admissions[6].taskSteps,7);assert.equal(f.admissions[6].original,'original-human');
  const replay=await f.continuation.recover(f.request);assert.equal(replay.accepted,true);assert.equal(replay.reconciled,true);
  await assert.rejects(f.continuation.recover({...f.request,requestId:'different-r'}),{code:'CONTINUE_REQUEST_CONFLICT'});
  release();await f.agent.whenIdle();
  assert.equal(f.calls(),7);assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.id==='original-human').length,1);
  assert.equal(f.events.filter(e=>e.type==='user/message'&&isOwn(e.data)).length,1);
  assert.equal(hash(f.events.slice(0,f.prefix.length)),hash(f.prefix));
  assert.equal(f.budget.automatic.checks,0);assert.equal(f.budget.automatic.nextCheckAt,60);assert.equal(f.budget.stage,1);
  }finally{release();}
});
test('new human input during readonly recheck prevents own dispatch and preserves the human queue',{timeout:10000},async t=>{
  const f=await fixture(t);f.setReview(n=>{if(n===2)f.agent.followup(human('new-human'));});
  await assert.rejects(f.continuation.recover(f.request),{code:'CONTINUE_PENDING_INPUT'});await f.agent.whenIdle();
  assert.equal(f.events.filter(e=>e.type==='user/message'&&isOwn(e.data)).length,0);
  assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.id==='new-human').length,1);
  assert.equal((await f.continuation.recover(f.request)).accepted,false);assert.equal(f.calls(),7);
});
for(const failure of ['abort','flush'])test('own insertion is withdrawn before maintenance wake on '+failure,{timeout:10000},async t=>{
  const f=await fixture(t),controller=new AbortController();let fired=false;
  f.setFlush(()=>{if(!fired&&f.events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(isOwn))){fired=true;if(failure==='abort')controller.abort();else throw Object.assign(Error('inert flush failure'),{code:'INERT_FLUSH_FAILURE'});}});
  await assert.rejects(f.continuation.recover(f.request,controller.signal));await f.agent.whenIdle();
  assert.equal(fired,true);assert.equal(f.calls(),6);assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(hash(f.budget),f.beforeBudget);
  const replay=await f.continuation.recover(f.request);assert.equal(replay.accepted,false);assert.equal(replay.state,'withdrawn');assert.equal(f.calls(),6);
});
test('a failed native withdrawal cannot enter budgeting or the model and does not poison later human input',{timeout:10000},async t=>{
  const f=await fixture(t),controller=new AbortController();let fired=false;
  const remove=f.agent.inbox.remove.bind(f.agent.inbox);f.agent.inbox.remove=()=>{throw Error('inert native queue-write failure');};
  f.setFlush(()=>{if(!fired&&f.events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(isOwn))){fired=true;controller.abort();}});
  await assert.rejects(f.continuation.recover(f.request,controller.signal));await f.agent.whenIdle();
  assert.equal(f.calls(),6);assert.equal(hash(f.budget),f.beforeBudget);assert.equal(f.admissions.length,6);
  f.agent.inbox.remove=remove;f.agent.followup(human('later-human'));await f.agent.whenIdle();
  assert.equal(f.calls(),7);assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.id==='later-human').length,1);
  assert.equal(f.events.filter(e=>e.type==='user/message'&&isOwn(e.data)).length,0);
});
test('mixed human steering survives an orphan notice without admitting that notice',{timeout:10000},async t=>{
  const f=await fixture(t),controller=new AbortController();let fired=false;
  const remove=f.agent.inbox.remove.bind(f.agent.inbox);f.agent.inbox.remove=()=>{throw Error('inert native queue-write failure');};
  f.setFlush(()=>{if(!fired&&f.events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(isOwn))){fired=true;f.agent.steer(human('steering-human'));controller.abort();}});
  await assert.rejects(f.continuation.recover(f.request,controller.signal));await f.agent.whenIdle();f.agent.inbox.remove=remove;
  assert.equal(f.calls(),7);assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.id==='steering-human').length,1);
  assert.equal(f.events.filter(e=>e.type==='user/message'&&isOwn(e.data)).length,0);
  assert.equal(f.admissions[6].original,'steering-human');
});

test('a new human task supersedes even an accepted continuation in the same SDK claim',{timeout:10000},async t=>{
  const f=await fixture(t),maintenance=f.agent.runMaintenance.bind(f.agent);
  f.agent.runMaintenance=callback=>maintenance(async signal=>{const result=await callback(signal);f.agent.steer(human('scope-changed'));return result;});
  assert.equal((await f.continuation.recover(f.request)).accepted,true);await f.agent.whenIdle();
  assert.equal(f.calls(),7);assert.equal(f.admissions[6].original,'scope-changed');
  assert.equal(f.events.filter(e=>e.type==='user/message'&&e.data.id==='scope-changed').length,1);
  assert.equal(f.events.filter(e=>e.type==='user/message'&&isOwn(e.data)).length,0);
});

test('late accepted rename cannot admit orphan input after timeout and component reload',{timeout:10000},async t=>{
  const f=await fixture(t,{timeoutMs:500}),rename=fs.rename,remove=f.agent.inbox.remove.bind(f.agent.inbox);
  let release,finished,delayed=false,reloaded=false;
  const held=new Promise(resolve=>release=resolve),lateDone=new Promise(resolve=>finished=resolve),keepAlive=setTimeout(()=>{},3000);
  f.agent.inbox.remove=()=>{throw Error('inert native queue-write failure');};
  fs.rename=async(from,to)=>{
    if(path.dirname(to)!==f.journalRoot)return rename(from,to);
    const value=JSON.parse(await fs.readFile(from,'utf8'));
    if(value.state==='accepted'){
      delayed=true;await held;await rename(from,to);finished();return;
    }
    await rename(from,to);
    if(value.state==='cancelled'&&delayed){
      release();await lateDone;
      f.continuation.dispose();
      f.continuation=createIncompleteContinuation(f.ctx,{registryPath:f.registryPath,journalRoot:f.journalRoot});
      reloaded=true;
    }
  };
  try{
    await assert.rejects(f.continuation.recover(f.request),{name:'TimeoutError'});await f.agent.whenIdle();
    assert.equal(delayed,true);assert.equal(reloaded,true);
    const journal=JSON.parse(await fs.readFile(path.join(f.journalRoot,(await fs.readdir(f.journalRoot)).find(name=>name.endsWith('.json'))),'utf8'));
    assert.equal(journal.state,'accepted','The test forced the late write over the cancellation record');
    assert.equal(f.calls(),6);assert.equal(f.admissions.length,6);assert.equal(hash(f.budget),f.beforeBudget);
    assert.equal((await f.continuation.recover(f.request)).accepted,false);
    f.agent.inbox.remove=remove;f.agent.followup(human('human-after-reload'));await f.agent.whenIdle();assert.equal(f.calls(),7);
    assert.equal(f.events.filter(e=>e.type==='user/message'&&isOwn(e.data)).length,0);
  }finally{release();fs.rename=rename;f.agent.inbox.remove=remove;clearTimeout(keepAlive);}
});
test('blocked work, active jobs and invalid original-task metadata cannot dispatch',{timeout:10000},async t=>{
  const f=await fixture(t);
  f.budget.blocked={code:'REPAIR_NO_PROGRESS'};await f.save();await assert.rejects(f.continuation.recover(f.request),{code:'CONTINUE_WORK_UNRESOLVED'});
  f.budget.blocked=null;await f.save();f.setJobs([{owner:'owner',status:'running'}]);await assert.rejects(f.continuation.recover(f.request),{code:'CONTINUE_ACTIVE_JOBS'});f.setJobs([]);
  f.record.automaticRequest.messageId='different-human';await f.save();await assert.rejects(f.continuation.recover(f.request),{code:'CONTINUE_ORIGINAL_TASK_CHANGED'});
  assert.equal(f.calls(),6);assert.equal(f.budget.steps,6);
});
test('a hung pre-dispatch history flush releases maintenance at the finite deadline',{timeout:10000},async t=>{
  const f=await fixture(t,{timeoutMs:100});let release;
  const held=new Promise(resolve=>release=resolve),keepAlive=setTimeout(()=>{},1000);f.setFlush(()=>held);
  try{
    await assert.rejects(f.continuation.recover(f.request),{name:'TimeoutError'});
    assert.equal(f.calls(),6);assert.equal(hash(f.budget),f.beforeBudget);
    assert.equal(await f.agent.runMaintenance(async()=>true),true,'The real SDK maintenance reservation was released');
  }finally{release();clearTimeout(keepAlive);}
});
test('the authenticated connection route adds a same-origin fence before admission',async()=>{
  let route;const ctx={on(){},effect:fn=>fn(),connection:{fetch:{register:value=>{route=value;return()=>{};}}}};
  apply(ctx,{registryPath:path.resolve('synthetic-registry.json'),journalRoot:path.resolve('synthetic-journals')});
  const response=await route.fetch(new Request('http://dsh.internal/api/homeai/continue-incomplete',{method:'POST',headers:{host:'homeai.test',origin:'https://other.test'},body:'{}'}));
  assert.equal(response.status,403);assert.deepEqual(await response.json(),{code:'ORIGIN_REFUSED'});
});
