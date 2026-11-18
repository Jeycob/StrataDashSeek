// Actual pinned AgentLoop/SessionStore/native executor/maintenance/inbox only.
// Resource rosters and persistence reads are explicit inert fixture providers.
// No server, socket, real model stream, production project or credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {WorkspaceManager} from './manager.mjs';
import {RepairBudget,DEFAULTS,WorkbenchError} from './policy.mjs';
import {sourceManifest} from './storage.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=(name,file='index.js')=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib',file)).href);
const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:SystemPrompt},{default:Tools},{default:AgentLoop},{NativeToolExecutor},{subagentCatalogProjectionDefinition}]=await Promise.all([...['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-tool-executor-native'].map(name=>load(name)),load('dsh-subagent','types/catalog.js')]);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),defer=()=>Promise.withResolvers();
const knownError='The recorded continuation has no confirmed durable acceptance. It will not be submitted again.';
async function active(fibers){const end=Date.now()+2000;while(fibers.some(f=>f.state!==2)){await Promise.all(fibers.map(f=>f.await()));assert(Date.now()<end,'Actual SDK services must initialize');await new Promise(resolve=>setImmediate(resolve));}}
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'automatic-consumed-sdk-')),root=path.join(directory,'project'),ctx=new Context(),events=[],durable=[];let modelCalls=0,admitted=0,mode='seed',onFlush=async()=>{},manager;
 t.after(async()=>{await ctx.fiber.dispose();assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));assert(path.basename(directory).startsWith('automatic-consumed-sdk-'));await fs.rm(directory,{recursive:true,force:true});});
 await fs.mkdir(root);await fs.writeFile(path.join(root,'app.mjs'),'export const value=1;\n');
 const services=[Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{}));await active(services);
 const loop=ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});await active([loop]);ctx.tools.setExecutor(new NativeToolExecutor(ctx));
 await ctx.sessionProjections.register(subagentCatalogProjectionDefinition);
 class Inert extends LlmAdapter{async *stream(){modelCalls++;throw Error('The local consumed-recovery fixture must never enter a model');}}
 ctx.llm.registerAdapter(['consumed-fixture'],new Inert());
 ctx.on('session/event',(session,event)=>{if(session.id==='owner')events.push(structuredClone(event));},{global:true});
 ctx.on('session/flush',async session=>{if(session.id==='owner'){await onFlush();durable.splice(0,durable.length,...structuredClone(events));}},{global:true});
 ctx.provide('sessionQuery',{readSession:async id=>{assert.equal(id,'owner');return{events:structuredClone(durable)};}});
 ctx.provide('jobs',{list:()=>[]});ctx.provide('terminalController',{list:()=>[]});
 ctx.on('agent/pre-step',async input=>{if(mode==='legacy')throw new WorkbenchError('AUTOMATIC_CONTINUATION_UNCONFIRMED',knownError);if(mode==='recover'){await manager.preStep(input);admitted++;}return{kind:'reject'};},{prepend:true,global:true});
 const {agent}=await ctx.agents.create({sessionId:'owner',meta:{cwd:root},agentOptions:{provider:'consumed-fixture',model:'synthetic'}});
 const task={turn:1,messageId:randomUUID()},human={id:task.messageId,role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic existing task'}]};
 agent.followup(human);await agent.whenIdle();
 const message={id:randomUUID(),role:'user',source:{kind:'workspace-runtime'},content:[{type:'text',text:'Synthetic same-task continuation'}]},baselineSeq=agent.session.seq;
 mode='legacy';agent.followup(message);await agent.whenIdle();mode='recover';
 const sourceHash=(await sourceManifest(root)).sha256,receipt={version:1,callId:'automatic-review-'+randomUUID(),ownerId:'owner',root,sourceHash,at:Date.now(),isError:false,report:{sourceHash,passed:false,complete:false,stale:false,checks:[]}},budget=new RepairBudget({steps:80});
 const old={version:1,state:'unknown',callId:receipt.callId,root,sourceHash,task:{...task},receiptSha256:hash(receipt),message,messageSha256:hash(message),baselineSeq};
 const a=budget.automatic={version:1,interval:60,taskSteps:80,checks:3,proofSerial:0,proofs:{},admitted:{},nextCheckAt:100,phase:'repairing',receipt,operation:{ownerId:'owner',callId:receipt.callId,root,sourceHash,task:{...task},rangeRequired:true,rangeQualified:true,rangeSettled:true},terminalAcknowledged:true,reconciledCallId:receipt.callId,accountedCallId:receipt.callId,continuation:old,continuationNeeded:true,recovery:{state:'blocked',code:'AUTOMATIC_CONTINUATION_UNCONFIRMED',canContinue:false}};
 const record={root,legacy:false,budget,automaticRequest:task,budgetRequest:task,firstCheckGuided:true};
 manager=new WorkspaceManager(ctx,{stateRoot:path.join(directory,'state')},hostExecutionBinding());manager.data={sessions:{owner:record},trash:{},workspaces:{}};manager.budgets.set('owner',budget);manager.settings=()=>({...DEFAULTS,maxStageSteps:60});manager.ensureProject=async()=>record;manager.locks.acquire=async()=>{};manager.changes.list=async()=>({files:[]});await manager.save();
 assert.equal((await sourceManifest(root)).sha256,sourceHash,'Sibling registry writes must not change application source');
 return{ctx,agent,manager,record,budget,a,old:structuredClone(old),events,durable,modelCalls:()=>modelCalls,admitted:()=>admitted,setFlush:fn=>onFlush=fn};
}
test('actual maintenance holds a new followup unclaimed until durable proof then wakes through the same owner gate',{timeout:10000},async t=>{
 const f=await fixture(t),entered=defer(),release=defer(),cut=f.agent.session.seq;let held=false;
 f.setFlush(async()=>{if(f.a.continuation?.recoveryOf&&f.agent.inbox.nextTurn.some(m=>m.id===f.a.continuation.message.id)&&!held){held=true;entered.resolve();await release.promise;}});
 const pending=f.manager.automaticResumeConsumed('owner');
 try{
  await entered.promise;assert.equal(f.agent.status,'idle','Maintenance is externally idle, not an unreserved phase');
  assert.throws(()=>f.agent.runMaintenance(async()=>{}),/already has active work/);
  assert.equal(f.agent.inbox.nextTurn.length,1);assert.equal(f.agent.inbox.nextTurn[0].id,f.a.continuation.message.id);assert.equal(f.events.slice(cut).filter(e=>e.type==='turn/start').length,0);assert.equal(f.admitted(),0);assert.equal(f.modelCalls(),0);assert(f.manager.automaticReconciliations.has('owner'));
 }finally{release.resolve();}
 const result=await pending;assert.equal(result.continued,true);await f.agent.whenIdle();
 assert.equal(f.admitted(),1);assert.equal(f.modelCalls(),0);assert.equal(f.events.slice(cut).filter(e=>e.type==='turn/start').length,1);assert.equal(f.events.slice(cut).filter(e=>e.type==='step/start').length,0);
 assert.deepEqual(f.a.consumedPrestepRecoveries[0].oldIntent,f.old);assert.equal(f.a.continuation.recoveryOf,f.old.message.id);assert.equal(f.a.continuation.state,'accepted');assert.equal(f.a.checks,3);assert.equal(f.a.proofSerial,0);assert.equal(f.a.taskSteps,81);
});
test('real SDK Stop during maintenance removes only its new input and preserves unrelated pending input',{timeout:10000},async t=>{
 const f=await fixture(t),beforeExit=defer(),releaseExit=defer(),maintenance=f.agent.runMaintenance.bind(f.agent),cut=f.agent.session.seq;let stopped=false;
 f.agent.runMaintenance=job=>maintenance(async signal=>{let result,error;try{result=await job(signal);}catch(e){error=e;}beforeExit.resolve();await releaseExit.promise;if(error)throw error;return result;});
 const foreign={id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Unrelated synthetic pending input'}]};
 f.setFlush(async()=>{if(f.a.continuation?.recoveryOf&&f.agent.inbox.nextTurn.some(m=>m.id===f.a.continuation.message.id)&&!stopped){stopped=true;f.agent.inject(foreign);f.agent.cancel({kind:'user'},{keepInbox:true});}});
 const pending=f.manager.automaticResumeConsumed('owner');void pending.catch(()=>{});
 try{
  await beforeExit.promise;assert.equal(stopped,true);assert.equal(f.a.operation.cancelledByCaller,true);assert.equal(f.a.continuation.state,'cancelled');assert.equal(f.agent.inbox.nextTurn.length,0);assert.deepEqual(f.agent.inbox.nextStep,[foreign]);assert.equal(f.events.slice(cut).filter(e=>e.type==='turn/start').length,0);assert.equal(f.modelCalls(),0);assert.equal(f.admitted(),0);
  // Test-owned cleanup only: do not wake the unrelated synthetic input.
  assert.equal(f.agent.inbox.remove(foreign.id),true);
 }finally{releaseExit.resolve();}
 await assert.rejects(pending);await f.agent.whenIdle();await f.manager.persistQueue;
 assert.equal(f.a.continuation.removal.durable,true);assert(f.durable.some(e=>e.seq>=f.a.continuation.baselineSeq&&e.type==='agent/inbox/spliced'&&e.data.target==='next-turn'&&e.data.removedCount===1&&e.data.inserted.length===0),'Owned withdrawal must reach the actual SessionStore flush sink');
 assert.equal(f.events.slice(cut).filter(e=>e.type==='turn/start').length,0);assert.equal(f.agent.status,'idle');assert.equal(f.a.continuationNeeded,false);assert.deepEqual(f.a.consumedPrestepRecoveries[0].oldIntent,f.old);assert.equal(f.modelCalls(),0);
});
