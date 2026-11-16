import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelSelection,registeredSelection,validateWorkspaceModel} from './model-selection.mjs';
function fixture(){
 const calls=[],writes=[],global={provider:'local',model:'base'},registered={local:[{id:'base'}],cloud:[{id:'registered/deepseek-example',name:'DeepSeek example'}]},agents=new Map();
 const ctx={llm:{listProviders:()=>Object.keys(registered).map(id=>({id})),listModels:async p=>registered[p],resolveModelInfo:async()=>({}),resolveCallConfig:async selection=>(calls.push({...selection}),selection)},agents:{get:id=>agents.get(id)}};
 const manager={data:{modelPreferences:{}},settings:()=>({...global,reasoningEffort:'medium'}),projectFor:async id=>{const a=agents.get(id);if(!a)throw Error('not found');return{header:a.session.header,live:a.session};},inOrder:fn=>fn(),save:async()=>writes.push(structuredClone(manager.data))};
 const make=id=>{let selected={...global};const events=[],a={id,session:{id,header:{},requestHeader:()=>({config:selected})},model:{current:()=>selected,select:value=>{selected={...value};events.push({...value});}},events};agents.set(id,a);return a;};
 const a=make('a'),b=make('b');return{ctx,manager,a,b,global,calls,writes,registered,api:createModelSelection(ctx,manager)};
}
test('any advertised model uses its exact provider/model, persists an override and leaves global and other chats unchanged',async()=>{
 const f=fixture(),selection={provider:'cloud',model:'registered/deepseek-example'};
 await f.api.select('a',selection);assert.deepEqual(f.a.model.current(),selection);assert.deepEqual(f.b.model.current(),f.global);assert.equal(f.writes.length,1);assert.equal(f.manager.data.modelPreferences.a.mode,'session');
 const fresh=createModelSelection(f.ctx,{...f.manager,data:structuredClone(f.writes[0])});f.a.model.select(f.global);await fresh.restore(f.a);assert.deepEqual(f.a.model.current(),selection);
 const observed=await fresh.inspect('a');assert.equal(observed.source,'session');assert.deepEqual(observed.selection,selection);assert.deepEqual(observed.lastUsed,selection);
 await fresh.select('a',null);assert.deepEqual(f.a.model.current(),f.global);assert.equal((await fresh.inspect('a')).source,'workspace');assert.deepEqual(f.b.model.current(),f.global);
});
test('unregistered labels, unavailable providers, unsupported efforts and failed persistence cannot alter the session',async()=>{
 const f=fixture();await assert.rejects(f.api.select('a',{provider:'local',model:'DeepSeek V4.1'}),{code:'MODEL_UNAVAILABLE'});assert.equal(f.writes.length,0);
 await assert.rejects(registeredSelection(f.ctx,{provider:'cloud',model:'registered/deepseek-example',reasoningEffort:'medium'}),{code:'EFFORT_UNAVAILABLE'});
 f.manager.save=async()=>{throw Error('disk failure');};await assert.rejects(f.api.select('a',{provider:'cloud',model:'registered/deepseek-example'}),/disk failure/);assert.deepEqual(f.a.model.current(),f.global);assert.deepEqual(f.manager.data.modelPreferences,{});
});
test('workspace validation does not force local generation or reasoning parameters on cloud providers',async()=>{
 const f=fixture();const selected=await validateWorkspaceModel(f.ctx,{provider:'cloud',model:'registered/deepseek-example'});assert.deepEqual(selected,{provider:'cloud',model:'registered/deepseek-example'});assert.deepEqual(f.calls.at(-1),selected);
});
test('startup, new and resumed sessions restore preferences after defaults; registry-owned Unicode IDs and efforts survive',async()=>{
 const f=fixture(),model='研究/model+preview@'+ 'x'.repeat(140),selection={provider:'cloud',model,reasoningEffort:'xhigh'};
 f.registered.cloud.push({id:model});f.ctx.llm.resolveModelInfo=async()=>({reasoning:{efforts:[{id:'xhigh',name:'Extended'}],defaultEffort:'xhigh'}});
 assert.deepEqual(await validateWorkspaceModel(f.ctx,selection),selection);await f.api.select('a',selection);
 for(const source of ['startup','new','resume']){const order=[];await f.api.restoreAfterDefaults(f.a,source,async agent=>{await Promise.resolve();order.push('defaults');agent.model.select(f.global);});assert.deepEqual(f.a.model.current(),selection);assert.deepEqual(order,['defaults']);}
 await f.api.restoreAfterDefaults(f.b,'new',async agent=>agent.model.select(f.global));assert.deepEqual(f.b.model.current(),f.global);
 f.a.model.select(f.global);f.api.observe(f.a.session,{type:'model/selection',data:f.global});await f.api.restore(f.a);assert.deepEqual(f.a.model.current(),f.global,'later native menu choice supersedes the earlier workbench preference');
});
