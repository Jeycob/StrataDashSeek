import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './manager.mjs';
import { DEFAULTS } from './policy.mjs';

test('workspace overrides persist sparsely, reset by replacement and resolve effective defaults after reload',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-settings-')),calls=[],workspace={id:'w1',sessionIds:['s1']};t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const ctx={workspaceRegistry:{get:id=>id==='w1'?workspace:null,list:()=>[workspace]},llm:{resolveCallConfig:async value=>{calls.push(value);}}},manager=new WorkspaceManager(ctx,{stateRoot:root});manager.data={workspaces:{}};
 const result=await manager.updateSettings('w1',{model:'own-model'});assert.equal(result.temperature,DEFAULTS.temperature);assert.deepEqual(manager.data.workspaces.w1.settings,{model:'own-model'});assert.deepEqual(JSON.parse(await fs.readFile(manager.file,'utf8')).workspaces.w1.settings,{model:'own-model'});assert.equal(calls[0].reasoningEffort,DEFAULTS.reasoningEffort);
 await manager.updateSettings('w1',{});const reloaded=new WorkspaceManager(ctx,{stateRoot:root});reloaded.data=JSON.parse(await fs.readFile(manager.file,'utf8'));assert.deepEqual(reloaded.data.workspaces.w1.settings,{});assert.equal(reloaded.settings({id:'s1',header:{cwd:root}}).model,DEFAULTS.model);
});
test('invalid or unavailable settings do not alter saved overrides and failed persistence restores memory',async()=>{
 const ctx={workspaceRegistry:{get:()=>({id:'w1'})},llm:{resolveCallConfig:async value=>{if(value.model==='unavailable')throw Error('MODEL_UNAVAILABLE');}}},manager=new WorkspaceManager(ctx);manager.data={workspaces:{w1:{settings:{model:'original'}}}};let saves=0;manager.save=async()=>{saves++;throw Error('DISK_FULL');};
 await assert.rejects(manager.updateSettings('w1',{temperature:3}),/Invalid temperature/);await assert.rejects(manager.updateSettings('w1',{model:'unavailable'}),/MODEL_UNAVAILABLE/);assert.equal(saves,0);await assert.rejects(manager.updateSettings('w1',{model:'valid-model'}),/DISK_FULL/);assert.deepEqual(manager.data.workspaces.w1.settings,{model:'original'});
 delete manager.data.workspaces.w1;await assert.rejects(manager.updateSettings('w1',{}),/DISK_FULL/);assert.equal(Object.hasOwn(manager.data.workspaces,'w1'),false);
});
