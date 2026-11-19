// Actual pinned AgentLoop/SessionStore/NativeToolExecutor; inert local adapter.
// No external model, server or production workspace is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceManager } from './manager.mjs';
import { RepairBudget, DEFAULTS } from './policy.mjs';
import { taskUndoOperation } from './task-undo.mjs';
import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
const SDK=process.env.EFFICIENCY_SDK_ROOT??'/data/harness/runtime/node_modules';
const load=name=>import(pathToFileURL(path.join(SDK,'@deepseek-ai',name,'lib/index.js')).href);
const [{Context},{default:Sessions},{default:Agents},{default:Projections},{default:Llm,LlmAdapter},{default:SystemPrompt},{default:Tools},{default:AgentLoop},{NativeToolExecutor}]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent-loop','dsh-tool-executor-native'].map(load));
async function active(fibers){const end=Date.now()+3000;while(fibers.some(f=>f.state!==2)){await Promise.all(fibers.map(f=>f.await()));assert(Date.now()<end);await new Promise(resolve=>setImmediate(resolve));}}

test('real SDK request snapshots undo only one task, preserve later edits and retain owner/read-only fences',{timeout:15000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'task-undo-sdk-')),root=path.join(directory,'project'),ctx=new Context();await fs.mkdir(root);
 t.after(async()=>{await ctx.fiber.dispose();assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
 await fs.writeFile(path.join(root,'app.js'),'original');await fs.writeFile(path.join(root,'removed.js'),'restore me');await fs.writeFile(path.join(root,'personal.txt'),'existing user edit');
 await active([Sessions,Agents,Projections,Llm,SystemPrompt,Tools].map(plugin=>ctx.plugin(plugin,{})));
 const loop=ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});await ctx.plugin({name:'task-undo-sdk-ready',inject:['sessions','agents','sessionProjections','llm','tools','systemPrompt','agentLoop'],apply(){}}).await();await active([loop]);
 ctx.tools.setExecutor(new NativeToolExecutor(ctx));let calls=0,mode='workspace-write',jobs=[];ctx.provide('sandboxPolicy',{resolve:()=>({mode})});ctx.provide('jobs',{list:()=>jobs});
 class Inert extends LlmAdapter{async *stream(){calls++;assert(calls<=4);if(calls%2)yield{type:'block-end',index:0,block:{type:'tool-call',id:'fixture-'+calls,name:'fixture_edit',arguments:JSON.stringify({task:Math.ceil(calls/2)})}};else yield{type:'text-delta',index:0,text:'Local fixture complete.'};yield{type:'finish',reason:{kind:'stop'},replayState:{response:{stopReason:'stop'}}};}}
 ctx.llm.registerAdapter(['task-undo-fixture'],new Inert());
 ctx.tools.register({name:'fixture_edit',description:'Synthetic local task mutation',parameters:{type:'object',properties:{task:{type:'integer'}},required:['task'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:()=>[{type:'text',text:'Local fixture updated.'}]},async execute({task}){
  await fs.writeFile(path.join(root,'app.js'),task===1?'first task':'later task');
  if(task===1){await fs.writeFile(path.join(root,'created.js'),'first task created');await fs.unlink(path.join(root,'removed.js'));jobs=[{owner:'owner',status:'running'}];}else await fs.writeFile(path.join(root,'later.js'),'later task only');return{exitCode:0};
 }});
 const {agent}=await ctx.agents.create({sessionId:'owner',meta:{cwd:root},agentOptions:{provider:'task-undo-fixture',model:'inert'}});
 const manager=new WorkspaceManager(ctx,{stateRoot:path.join(directory,'state')},hostExecutionBinding()),budget=new RepairBudget(),record={root,legacy:false,budget,firstCheckGuided:true};
 manager.data={sessions:{owner:record},trash:{},workspaces:{}};manager.budgets.set('owner',budget);manager.settings=()=>({...DEFAULTS,maxStageSteps:60});manager.ensureProject=async()=>record;manager.changes.list=async()=>({files:[]});
 ctx.on('agent/pre-step',async(input,next)=>{await manager.preStep(input);return next();},{prepend:true,global:true});ctx.tools.guard(exec=>manager.toolGuard(exec));ctx.on('tools/result',(exec,result)=>manager.observeToolResult(exec,result),{global:true});
 const call=async(op,extra={})=>(await taskUndoOperation(manager,{op,sessionId:'owner',...extra})).value;
 const run=async id=>{agent.followup({id,role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic task '+id}]});await agent.whenIdle();await manager.releaseIfIdle('owner');};
 await run('first');let list=await call('task-undo-list');assert.equal(calls,2);assert.equal(list.tasks.length,1);assert.equal(list.tasks[0].status,'active');assert.equal(manager.running.has('owner'),true,'a remaining job retains the task boundary and writer lease');jobs=[];await manager.releaseIfIdle('owner');list=await call('task-undo-list');assert.equal(list.tasks[0].status,'ready');const first=list.tasks[0].id;
 await fs.writeFile(path.join(root,'personal.txt'),'later manual edit');await run('second');list=await call('task-undo-list');assert.equal(calls,4);assert.equal(list.tasks.length,2);assert.equal(list.tasks[0].turn,2);assert.equal(list.tasks[1].turn,1);
 const preview=await call('task-undo-preview',{taskId:first});assert.deepEqual(preview.taskUndo.conflicts,['app.js']);assert.deepEqual(preview.writes,['removed.js']);assert.deepEqual(preview.deletes,['created.js']);
 await assert.rejects(call('task-undo-apply',{taskId:first}),{code:'RESTORE_PREVIEW_REQUIRED'});
 mode='read-only';await assert.rejects(call('task-undo-apply',{taskId:first,expectedSourceHash:preview.sourceHash,skipConflicts:true}),{code:'READ_ONLY'});mode='workspace-write';
 await assert.rejects(call('task-undo-apply',{taskId:first,expectedSourceHash:preview.sourceHash}),{code:'TASK_UNDO_CONFLICT'});
 await assert.rejects(call('task-undo-preview',{taskId:first,root:'/untrusted'}),{code:'TASK_UNDO_INVALID'});
 const result=await call('task-undo-apply',{taskId:first,expectedSourceHash:preview.sourceHash,skipConflicts:true});assert.equal(result.recovery.status,'committed');assert.equal(calls,4);
 assert.equal(await fs.readFile(path.join(root,'app.js'),'utf8'),'later task');assert.equal(await fs.readFile(path.join(root,'later.js'),'utf8'),'later task only');assert.equal(await fs.readFile(path.join(root,'personal.txt'),'utf8'),'later manual edit');assert.equal(await fs.readFile(path.join(root,'removed.js'),'utf8'),'restore me');await assert.rejects(fs.stat(path.join(root,'created.js')),{code:'ENOENT'});
 const retained=JSON.parse(await fs.readFile(manager.file,'utf8'));assert.equal(retained.sessions.owner.taskUndo.tasks.length,2);assert.equal(budget.automatic.taskSteps,2,'undo does not reset task accounting');
});
