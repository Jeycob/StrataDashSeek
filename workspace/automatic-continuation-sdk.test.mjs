// Real pinned SessionStore/AgentLoop/inbox with an inert model and memory flush.
// No Native server, sockets, prompts to a provider, or production data are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {WorkspaceManager} from './manager.mjs';
import {RepairBudget,DEFAULTS} from './policy.mjs';
import {continueAutomaticTask} from './automatic-continuation.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import {createHash} from 'node:crypto';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=name=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib/index.js')).href);
const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:SystemPrompt},{default:Tools},{default:AgentLoop},{NativeToolExecutor}]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-tool-executor-native'].map(load));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function active(fibers){const end=Date.now()+2000;while(fibers.some(f=>f.state!==2)){await Promise.all(fibers.map(f=>f.await()));assert(Date.now()<end,'Actual SDK services must finish initializing');await new Promise(resolve=>setImmediate(resolve));}}
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'automatic-continuation-sdk-')),ctx=new Context(),events=[],durable=[];let modelCalls=0,flushBarrier;
 t.after(async()=>{await ctx.fiber.dispose();assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));assert(path.basename(directory).startsWith('automatic-continuation-sdk-'));await fs.rm(directory,{recursive:true,force:true});});
 const services=[Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{}));
 await active(services);
 const loop=ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
 await ctx.plugin({name:'continuation-sdk-ready',inject:['sessions','agents','sessionProjections','llm','tools','systemPrompt','agentLoop'],apply(){}}).await();
 await active([loop]);
 ctx.tools.setExecutor(new NativeToolExecutor(ctx));
 class Inert extends LlmAdapter{async *stream(){modelCalls++;throw Error('This local fixture must never enter a model');}}
 ctx.llm.registerAdapter(['continuation-fixture'],new Inert());
 ctx.on('session/event',(session,event)=>{if(session.id==='owner')events.push(structuredClone(event));},{global:true});
 ctx.on('session/flush',async session=>{if(session.id==='owner'){await flushBarrier;durable.splice(0,durable.length,...structuredClone(events));}},{global:true});
 // The real SessionStore owns flush. Only persistence is a bounded memory sink;
 // its readSession DTO is the exact raw-event contract used by SessionQuery.
 ctx.provide('sessionQuery',{readSession:async id=>{assert.equal(id,'owner');return{events:structuredClone(durable)};}});
 const handle=await ctx.agents.create({sessionId:'owner',meta:{cwd:directory},agentOptions:{provider:'continuation-fixture',model:'synthetic'}}),agent=handle.agent;
 const manager=new WorkspaceManager(ctx,{stateRoot:path.join(directory,'state')},hostExecutionBinding()),task={turn:1,messageId:'original-human'},receipt={version:1,callId:'automatic-review-synthetic',ownerId:'owner',root:directory,sourceHash:'a'.repeat(64),at:1,isError:false,report:{passed:false,complete:false,stale:false,checks:[]}};
 const budget=new RepairBudget({steps:80}),a=budget.automatic={version:1,interval:60,taskSteps:80,checks:3,proofSerial:0,proofs:{},nextCheckAt:100,admitted:{},phase:'repairing',terminalAcknowledged:true,reconciledCallId:receipt.callId,accountedCallId:receipt.callId,receipt,operation:{ownerId:'owner',callId:receipt.callId,root:directory,sourceHash:receipt.sourceHash,task},continuationNeeded:true,recovery:{state:'recovered',code:'AUTOMATIC_RESULT_RECONCILED',canContinue:true}};
 const record={root:directory,legacy:false,budget,automaticRequest:task,budgetRequest:task,firstCheckGuided:true};manager.data={sessions:{owner:record},trash:{},workspaces:{}};manager.budgets.set('owner',budget);manager.settings=()=>({...DEFAULTS,maxStageSteps:60});manager.ensureProject=async()=>record;manager.locks.acquire=async()=>{};manager.changes.list=async()=>({files:[]});
 return{ctx,agent,manager,record,budget,a,events,durable,modelCalls:()=>modelCalls,holdFlush:promise=>flushBarrier=promise,hash};
}
test('real SDK insertion at Session.nextSeq survives synchronous wake/claim and owner pre-step singleflight',{timeout:10000},async t=>{
 const f=await fixture(t);let entered=0,admitted=0,gateError;
 f.ctx.on('agent/pre-step',async input=>{entered++;try{await f.manager.preStep(input);admitted++;}catch(e){gateError=e;throw e;}return{kind:'reject'};},{prepend:true,global:true});
 const baseline=f.agent.session.seq;
 // Hold the same owner singleflight while followup synchronously opens its
 // real driver and claims input, exactly as owner automaticReconcile does.
 let release,releaseFlush,waiting=false;const pending=new Promise(resolve=>release=resolve),flush=new Promise(resolve=>releaseFlush=resolve);f.holdFlush(flush);f.manager.automaticReconciliations=new Map([['owner',pending]]);
 const reconcile=f.manager.reconcileAutomatic.bind(f.manager);f.manager.reconcileAutomatic=id=>{if(f.manager.automaticReconciliations.get(id)===pending)waiting=true;return reconcile(id);};
 const accepted=continueAutomaticTask(f.manager,'owner');
 try{
  const end=Date.now()+2000;while(!waiting){assert(Date.now()<end,'Actual pre-step must wait on the owner reconciliation');await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(entered,1);assert.equal(admitted,0);assert.equal(f.agent.inbox.nextTurn.length,0,'The real loop has already claimed the queued message');assert.equal(f.a.continuation.state,'dispatching');
  releaseFlush();assert.equal(await accepted,true);release(true);await f.agent.whenIdle();
 }finally{releaseFlush();release(false);}
 const insertion=f.events.find(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.id===f.a.continuation.message.id));
 assert.equal(f.a.continuation.baselineSeq,baseline);assert.equal(insertion.seq,baseline,'Session.seq is the NEXT append sequence, not the last event');
 assert.equal(f.a.continuation.state,'accepted');assert.equal(f.a.continuationNeeded,false);assert.equal(entered,1);assert.equal(admitted,1,gateError?.message);assert.equal(gateError,undefined);
 assert(f.events.some(e=>e.type==='agent/inbox/spliced'&&e.data.removedCount===1));assert.equal(f.modelCalls(),0);assert.equal(f.agent.status,'idle');assert.equal(f.a.taskSteps,81,'Only the admitted next step is charged; the original task survives');
});
test('existing unknown intent accepts actual durable boundary insertion without another followup or waking an idle SDK agent',{timeout:10000},async t=>{
 const f=await fixture(t),message={id:'old-continuation',role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'Synthetic retained continuation'}]},baseline=f.agent.session.seq;
 const insertion=f.agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]});
 f.agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});await f.ctx.sessions.flush(f.agent.session);
 f.a.continuation={version:1,state:'unknown',callId:f.a.receipt.callId,root:f.record.root,sourceHash:f.a.operation.sourceHash,task:{...f.record.automaticRequest},receiptSha256:hash(f.a.receipt),message,messageSha256:hash(message),baselineSeq:baseline};f.a.recovery={state:'blocked',code:'AUTOMATIC_CONTINUATION_UNCONFIRMED',canContinue:false};
 let sends=0;f.agent.followup=()=>{sends++;throw Error('Historical admission must not be dispatched again');};const before=f.agent.session.seq;
 assert.equal(insertion.seq,baseline);assert.equal(await continueAutomaticTask(f.manager,'owner'),true);assert.equal(f.a.continuation.state,'accepted');assert.equal(f.a.continuationNeeded,false);assert.equal(sends,0);assert.equal(f.agent.status,'idle');assert.equal(f.agent.session.seq,before);assert.equal(f.modelCalls(),0);assert.equal(f.a.taskSteps,80);assert.equal(f.a.checks,3);
});
