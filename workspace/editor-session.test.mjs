import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEditorSessions,installEditorSessions} from './editor-session.mjs';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'editor-sessions-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const projectsRoot=await fs.realpath(root),sessions={};
 for(const id of['A','B']){const dir=path.join(projectsRoot,id);await fs.mkdir(dir);sessions[id]={root:dir};}
 const calls=[],ctx={on:()=>{},workspaceRegistry:{archivedSessionIds:new Set()},sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}},manager={projectsRoot,data:{sessions,trash:{}},async projectFor(id){if(!sessions[id])throw Error('no session');return{root:sessions[id].root,header:{},live:{id,header:{}}};}};
 const adapter={async ensureEditor(input){calls.push({op:'ensure',...input});return{ready:true,generation:'g-'+input.sessionId,socketPath:'/synthetic/'+input.sessionId+'.sock',readOnly:input.readOnly,isolation:{enforced:true,sessionId:input.sessionId,projectRoot:input.projectRoot,readOnly:input.readOnly}};},async stopEditor(input){calls.push({op:'stop',...input});}};
 const origins={allocate:id=>({origin:'https://owner.test:'+(id==='A'?19443:19444),listenerPort:id==='A'?29443:29444})},brokers=[];
 const options={adapter,origins,ownerOrigin:'https://owner.test',bind:async()=>{},brokerFactory:input=>{const broker={...input,closed:false,issue:()=>({version:1,sessionId:input.sessionId,generation:input.generation,state:'ready',url:input.origin+'/fixture#synthetic'}),close(){this.closed=true;}};brokers.push(broker);return broker;}};
 const api=createEditorSessions(ctx,manager,options);t.after(()=>api.dispose());return{ctx,manager,adapter,options,api,calls,brokers};
}
test('editor API binds to the server project and retains separate broker lifetimes across sessions',async t=>{
 const f=await fixture(t),a=await f.api.run({op:'open',sessionId:'A'}),b=await f.api.run({op:'open',sessionId:'B'});assert.equal(a.sessionId,'A');assert.equal(b.sessionId,'B');assert.notEqual(new URL(a.url).origin,new URL(b.url).origin);
 assert.equal(f.calls[0].projectRoot,f.manager.data.sessions.A.root);await f.api.run({op:'open',sessionId:'A'});assert.equal(f.brokers.length,2);await f.api.run({op:'close',sessionId:'A'});assert.equal(f.brokers[0].closed,true);assert.equal(f.brokers[1].closed,false);assert.deepEqual(f.calls.filter(c=>c.op==='stop'),[{op:'stop',sessionId:'A',generation:'g-A'}]);
 await assert.rejects(f.api.run({op:'open',sessionId:'A',root:'/private'}),{code:'EDITOR_REQUEST_INVALID'});
});
test('revocation closes browser channels synchronously and prevents an in-flight open from minting a new grant',async t=>{
 const f=await fixture(t);await f.api.run({op:'open',sessionId:'A'});f.api.revoke('A');assert.equal(f.brokers[0].closed,true);
 const base=f.adapter.ensureEditor;f.adapter.ensureEditor=async input=>{const result=await base(input);f.api.revoke(input.sessionId);return result;};await assert.rejects(f.api.run({op:'open',sessionId:'B'}),{code:'EDITOR_ACCESS_CHANGED'});assert.equal(f.brokers.length,1);
});
test('archive, read-only changes during launch, shared roots and unproven OS isolation never issue an editor grant',async t=>{
 const f=await fixture(t);f.ctx.workspaceRegistry.archivedSessionIds.add('A');await assert.rejects(f.api.run({op:'open',sessionId:'A'}),{code:'EDITOR_PROJECT_NOT_ISOLATED'});assert.equal(f.calls.length,0);f.ctx.workspaceRegistry.archivedSessionIds.clear();
 const base=f.adapter.ensureEditor;f.adapter.ensureEditor=async input=>{const result=await base(input);f.ctx.sandboxPolicy.resolve=()=>({mode:'read-only'});return result;};await assert.rejects(f.api.run({op:'open',sessionId:'A'}),{code:'EDITOR_ISOLATION_UNPROVEN'});assert.equal(f.brokers.length,0);
 f.adapter.ensureEditor=async input=>({...await base(input),isolation:{enforced:false}});await assert.rejects(f.api.run({op:'open',sessionId:'A'}),{code:'EDITOR_ISOLATION_UNPROVEN'});assert.equal(f.brokers.length,0);
 f.manager.data.sessions.B.root=f.manager.data.sessions.A.root;await assert.rejects(f.api.run({op:'open',sessionId:'A'}),{code:'EDITOR_PROJECT_SHARED'});
});
test('owner route rejects cross-origin callers and reports missing OS configuration explicitly',async t=>{
 const f=await fixture(t),routes=[];f.ctx.effect=fn=>fn();f.ctx.connection={fetch:{register:route=>{routes.push(route);return()=>{};}}};installEditorSessions(f.ctx,f.manager);const route=routes[0];
 const send=origin=>route.fetch(new Request('http://native.internal/api/workbench/editor',{method:'POST',headers:{host:'owner.test',origin,'content-type':'application/json'},body:JSON.stringify({op:'open',sessionId:'A'})}));
 assert.equal((await send('https://owner.test:19443')).status,403);const response=await send('https://owner.test');assert.equal(response.status,200);assert.deepEqual(await response.json(),{version:1,sessionId:'A',state:'unavailable',code:'EDITOR_ISOLATION_NOT_CONFIGURED'});
});

test('browser activity rechecks project policy and closes a revoked editor before renewal',async t=>{
 const f=await fixture(t);let touches=0;f.adapter.touchEditor=async()=>{touches++;};
 await f.api.run({op:'open',sessionId:'A'});await f.brokers[0].onActivity();assert.equal(touches,1);
 f.api.revoke('A');await assert.rejects(f.brokers[0].onActivity());assert.equal(touches,1);assert.equal(f.brokers[0].closed,true);
 await f.api.run({op:'open',sessionId:'B'});f.ctx.sandboxPolicy.resolve=()=>({mode:'read-only'});
 await assert.rejects(f.brokers[1].onActivity(),{code:'EDITOR_ACCESS_CHANGED'});assert.equal(touches,1);assert.equal(f.brokers[1].closed,true);
});

test('close aborts the in-flight adapter RPC without waiting for admission to finish',async t=>{
 const f=await fixture(t);let entered;const pending=new Promise(resolve=>entered=resolve);
 f.adapter.ensureEditor=async({signal})=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const opening=f.api.run({op:'open',sessionId:'A'});await pending;const closing=f.api.run({op:'close',sessionId:'A'});
 await assert.rejects(opening,{code:'EDITOR_CLOSED'});assert.equal((await closing).state,'closed');assert.equal(f.brokers.length,0);
});
