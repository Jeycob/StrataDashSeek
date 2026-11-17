import {isolatedExecutionBinding,hostExecutionBinding,executionBindingFixture} from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runtimeContext} from './runtime-authority.mjs';

test('host mode refuses guest authority before project lookup and stale awaited identity cannot mint context',async t=>{
 const f=await fixture(t);f.manager.execution=hostExecutionBinding();f.manager.projectFor=()=>assert.fail('No host-mode project lookup');await assert.rejects(runtimeContext(f.ctx,f.manager,f.input),{code:'PROJECT_RUNTIME_MODE_UNAVAILABLE'});
 const g=await fixture(t),binding=executionBindingFixture('isolated-guest'),lookup=g.manager.projectFor;g.manager.execution=binding.binding;g.manager.projectFor=async(...args)=>{const project=await lookup(...args);binding.fail();return project;};await assert.rejects(runtimeContext(g.ctx,g.manager,g.input),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
});
async function fixture(t){const base=await fs.mkdtemp(path.join(os.tmpdir(),'runtime-authority-')),root=path.join(base,'project');await fs.mkdir(path.join(root,'.git'),{recursive:true});t.after(()=>fs.rm(base,{recursive:true,force:true}));const owner={id:'owner',mode:'workspace-write'},child={id:'child',session:{id:'child',mode:'read-only'}};const ctx={workspaceRegistry:{archivedSessionIds:new Set()},agents:{list:()=>[child]},sandboxPolicy:{resolve:({session})=>({mode:session.mode})}},record={root,independentRepository:true,ports:[21000,21001,21002,21003]},manager={execution:isolatedExecutionBinding(),projectsRoot:base,data:{sessions:{owner:record},trash:{}},projectFor:async()=>({root,header:{},live:owner}),ownerAgent:()=>({id:'owner'})},input={sessionId:'owner',op:'ensure',kind:'editor',generation:'a'.repeat(32)};return{base,root,ctx,manager,input,record};}
test('runtime authority derives canonical project ports and conservatively combines owner and child permissions',async t=>{
 const f=await fixture(t),value=await runtimeContext(f.ctx,f.manager,f.input);assert.equal(value.projectRoot,f.root);assert.deepEqual(value.ports,f.record.ports);assert.equal(value.readOnly,false);
 assert.equal((await runtimeContext(f.ctx,f.manager,{...f.input,accessSessionId:'child'})).readOnly,true);
 for(const key of ['projectRoot','readOnly','ports'])await assert.rejects(runtimeContext(f.ctx,f.manager,{...f.input,[key]:true}),/REQUEST_INVALID/);
 await assert.rejects(runtimeContext(f.ctx,f.manager,{...f.input,accessSessionId:'foreign'}),/ACCESS_SESSION_INVALID/);
 f.ctx.sandboxPolicy.resolve=()=>({});await assert.rejects(runtimeContext(f.ctx,f.manager,f.input),/POLICY_UNAVAILABLE/);
});
test('archived, shared, legacy, alternate Git stores and overlapping ports cannot receive runtime authority',async t=>{
 const f=await fixture(t);f.ctx.workspaceRegistry.archivedSessionIds.add('owner');await assert.rejects(runtimeContext(f.ctx,f.manager,f.input));f.ctx.workspaceRegistry.archivedSessionIds.clear();
 f.record.nativeWorktree=true;await assert.rejects(runtimeContext(f.ctx,f.manager,f.input));delete f.record.nativeWorktree;
 f.manager.data.sessions.other={root:f.root};await assert.rejects(runtimeContext(f.ctx,f.manager,f.input),/SHARED/);f.manager.data.sessions.other={root:path.join(f.base,'other'),ports:[21000]};await assert.rejects(runtimeContext(f.ctx,f.manager,f.input),/PORTS_INVALID/);delete f.manager.data.sessions.other;
 await fs.writeFile(path.join(f.root,'.git','commondir'),'elsewhere');await assert.rejects(runtimeContext(f.ctx,f.manager,f.input),/GIT_SHARED/);
});
