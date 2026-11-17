import { hostExecutionBinding } from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './manager.mjs';
import { DEFAULTS } from './policy.mjs';
import { createModelSelection } from './model-selection.mjs';
function registry(resolveCallConfig = async value => value) {
 return {listProviders:()=>[{id:'strata-vast'},{id:'cloud'}],listModels:async provider=>(provider==='cloud'?['研究/model+preview@'+'x'.repeat(140)]:['strata','own-model','valid-model']).map(id=>({id})),resolveModelInfo:async provider=>({reasoning:{efforts:(provider==='cloud'?['off','high','max']:['off','low','medium','high']).map(id=>({id})),defaultEffort:provider==='cloud'?'high':'medium'}}),resolveCallConfig};
}

test('workspace overrides persist sparsely, reset by replacement and resolve effective defaults after reload',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-settings-')),calls=[],workspace={id:'w1',sessionIds:['s1']};t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const ctx={workspaceRegistry:{get:id=>id==='w1'?workspace:null,list:()=>[workspace]},llm:registry(async value=>{calls.push(value);})},manager=new WorkspaceManager(ctx,{stateRoot:root}, hostExecutionBinding());manager.data={workspaces:{}};
 const result=await manager.updateSettings('w1',{model:'own-model'});assert.equal(result.temperature,DEFAULTS.temperature);assert.deepEqual(manager.data.workspaces.w1.settings,{model:'own-model'});assert.deepEqual(JSON.parse(await fs.readFile(manager.file,'utf8')).workspaces.w1.settings,{model:'own-model'});assert.equal(calls[0].reasoningEffort,DEFAULTS.reasoningEffort);
 await manager.updateSettings('w1',{});const reloaded=new WorkspaceManager(ctx,{stateRoot:root}, hostExecutionBinding());reloaded.data=JSON.parse(await fs.readFile(manager.file,'utf8'));assert.deepEqual(reloaded.data.workspaces.w1.settings,{});assert.equal(reloaded.settings({id:'s1',header:{cwd:root}}).model,DEFAULTS.model);
});
test('invalid or unavailable settings do not alter saved overrides and failed persistence restores memory',async()=>{
 const ctx={workspaceRegistry:{get:()=>({id:'w1'})},llm:registry()},manager=new WorkspaceManager(ctx, {}, hostExecutionBinding());manager.data={workspaces:{w1:{settings:{model:'original'}}}};let saves=0;manager.save=async()=>{saves++;throw Error('DISK_FULL');};
 await assert.rejects(manager.updateSettings('w1',{temperature:3}),/Invalid temperature/);await assert.rejects(manager.updateSettings('w1',{model:'unavailable'}),{code:'MODEL_UNAVAILABLE'});assert.equal(saves,0);await assert.rejects(manager.updateSettings('w1',{model:'valid-model'}),/DISK_FULL/);assert.deepEqual(manager.data.workspaces.w1.settings,{model:'original'});
 delete manager.data.workspaces.w1;await assert.rejects(manager.updateSettings('w1',{}),/DISK_FULL/);assert.equal(Object.hasOwn(manager.data.workspaces,'w1'),false);
});
test('real manager validates advertised identities and restores a scoped choice without applying the workspace route first',async()=>{
 const calls=[],workspace={id:'w1',sessionIds:['s1','s2']},ctx={workspaceRegistry:{get:()=>workspace,list:()=>[workspace]},llm:registry(async value=>(calls.push(value),value)),agents:{get:()=>null}},manager=new WorkspaceManager(ctx, {}, hostExecutionBinding());
 manager.data={workspaces:{},modelPreferences:{}};manager.save=async()=>{};
 const model='研究/model+preview@'+'x'.repeat(140),selection={provider:'cloud',model,reasoningEffort:'max'};
 await manager.updateSettings('w1',selection);assert.deepEqual(calls.at(-1),selection);
 await assert.rejects(manager.updateSettings('w1',{...selection,reasoningEffort:'medium'}),{code:'EFFORT_UNAVAILABLE'});
 await manager.updateSettings('w1',{provider:'cloud',model});assert.deepEqual(calls.at(-1),{provider:'cloud',model});
 const observed=[],agent={id:'s1',session:{id:'s1',header:{cwd:'/fixture'}},model:{select:value=>observed.push(value)}};
 await manager.applyDefaults(agent,'startup');assert.deepEqual(observed.pop(),{provider:'cloud',model});
 manager.data.modelPreferences.s1={mode:'session',selection:{provider:'strata-vast',model:'strata',reasoningEffort:'high'}};
 const models=createModelSelection(ctx,manager);calls.length=0;await models.restoreAfterDefaults(agent,'startup',(a,s)=>manager.applyDefaults(a,s));
 assert.deepEqual(calls,[{provider:'strata-vast',model:'strata',reasoningEffort:'high'}]);assert.deepEqual(observed,[{provider:'strata-vast',model:'strata',reasoningEffort:'high'}]);
});
