import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createQaReceipts,projectQaEvents} from './qa-receipt.mjs';
import {projectSmokeRun} from '../benchmarks/strata-profiles/qa.mjs';
import {profileComparisons} from './profile-comparisons.mjs';
const source='b'.repeat(40),epoch='00000000-0000-4000-8000-000000000001';
const root=path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI??'/data/harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),'../..');
const load=name=>import(pathToFileURL(path.join(root,name,'lib/index.js')).href);
async function ready(check){const deadline=performance.now()+2000;while(!check()){assert(performance.now()<deadline,'SDK services did not become ready');await new Promise(resolve=>setImmediate(resolve));}}
test('real SDK admission and matching completed turn yield bounded metadata; shared memory keeps its scope and separate acceptance time',{timeout:10000},async t=>{
 const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:Loop},{default:SystemPrompt},{default:Tools},{NativeToolExecutor}]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-agent-loop','dsh-system-prompt','dsh-tools','dsh-tool-executor-native'].map(load));
 t.mock.timers.enable({apis:['Date'],now:1800000000000});const ctx=new Context(),events=[];t.after(()=>ctx.fiber.dispose());
 const services=[Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{}));await ready(()=>services.every(fiber=>fiber.state===2));const loop=ctx.plugin(Loop,{agents:[],maxParallelToolCalls:1});await ready(()=>loop.state===2);ctx.tools.setExecutor(new NativeToolExecutor(ctx));
 let streams=0;class Fixture extends LlmAdapter{async *stream(){streams++;t.mock.timers.setTime(1800000005000);yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block:{type:'text',text:'Synthetic result'}};yield{type:'finish',reason:{kind:'stop'}};}}
 ctx.llm.registerAdapter(['receipt-fixture'],new Fixture());ctx.on('session/event',(_session,event)=>events.push(event),{global:true});
 const agent=(await ctx.agents.create({sessionId:'qa-owner',meta:{cwd:'/synthetic'},agentOptions:{provider:'receipt-fixture',model:'fixture-model'}})).agent;
 // Actual public query signatures; backing data is the real emitted SDK log.
 const query={listEvents:async id=>{assert.equal(id,agent.id);return events.map(({seq,type,time})=>({sessionId:id,seq,type,time}));},readEvent:async({sessionId,seq})=>({session:{id:sessionId},target:events.find(event=>event.seq===seq)})};
 const manager={projectFor:async id=>{assert.equal(id,agent.id);return{live:agent.session,header:agent.session.header};},workspaceFor:()=>({id:'workspace'})};
 let monitorStartedAt=1799999990000,sampleAt=1800000000000;
 const read=createQaReceipts({sessionQuery:query},manager,{sourceCommit:source,readStatus:name=>name==='runtime-admission.json'?{enabled:true,sourceCommit:source,epoch,observedAt:Date.now()}:{at:sampleAt,monitorStartedAt,ram:{scope:'container',used:8192},gpu:{vramUsedMiB:0},model:{loaded:true,id:'observed-service',contextMax:131072}}});
 const before=await read(agent.id);t.mock.timers.setTime(1800000000100);agent.followup({id:'original-prompt',role:'user',source:{kind:'user'},content:[{type:'text',text:'Private synthetic original prompt'}]});await agent.whenIdle();
 sampleAt=1800000005500;t.mock.timers.setTime(1800000006000);const after=await read(agent.id,before.cursor);
 assert.equal(after.request.state,'completed');assert.equal(after.request.admittedAt,1800000000100);assert.equal(after.request.finishedAt,1800000005000);assert.equal(streams,1);assert.doesNotMatch(JSON.stringify(after),/Private synthetic|Synthetic result|\/synthetic/);
 const begin={sessionId:agent.id,pairId:'pair',scenario:'counter',start:before,definition:{promptSha256:after.request.promptSha256,inputSha256:'a'.repeat(64),acceptanceSha256:'c'.repeat(64)},budget:{mainSeconds:600,maxRepairs:0},cacheCondition:'cold'};
 const row=projectSmokeRun(begin,after,{passed:true},'sha256:'+'d'.repeat(64));row.arm='A';const projected=profileComparisons({version:1,runs:[row]},'workspace').pairs[0].rows[0];
 assert.equal(projected.acceptedMs,5900);assert.equal(projected.modelFinishedMs,4900);assert.equal(projected.memory,null);assert.equal(projected.sharedMemory.ramScope,'container');assert.equal(projected.sharedMemory.ramUsedBytes,8192);assert.equal(projected.sharedMemory.gpuUsedBytes,0);assert.equal(projected.serving,null);
 monitorStartedAt++;const restarted=await read(agent.id,before.cursor);assert.equal(projectSmokeRun(begin,restarted,{passed:true},'source').sharedMemory,null);
 const foreign=structuredClone(after);foreign.sessionId='other';assert.throws(()=>projectSmokeRun(begin,foreign,{passed:true},'source'),/QA_RUNTIME_CHANGED/);
 sampleAt=1799999990000;assert.equal(projectSmokeRun(begin,await read(agent.id,before.cursor),{passed:true},'source').sharedMemory,null);
 const extra=structuredClone(events);extra.push({...extra.find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length),seq:1000});assert.equal(projectQaEvents(extra).state,'unconfirmed');
 const bad=structuredClone(events);bad.find(event=>event.type==='turn/end').data.turn++;assert.equal(projectQaEvents(bad).state,'unconfirmed');
 let appended=false;const originalRead=query.readEvent;query.readEvent=async request=>{const value=await originalRead(request);if(!appended){appended=true;agent.session.append('turn/start',{turn:2});}return value;};
 await assert.rejects(read(agent.id,before.cursor),{code:'QA_RECEIPT_CHANGED'},'a new actual turn during sequential reads cannot produce an old completed receipt');
});
