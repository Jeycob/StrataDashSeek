import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {installRuntimeAdmission} from './runtime-admission-hooks.mjs';
function fixture(){const hooks=new Map(),operations=[];let allowed=false;const ctx={on(name,fn,opts){assert.equal(opts.global,true);assert.equal(opts.prepend,true);hooks.set(name,fn);}},client={required:true,async admit(operation,{signal}={}){signal?.throwIfAborted();operations.push(operation);if(!allowed)throw Error('private reason must not cross HTTP');return{enforced:true,admitted:true,expiresAt:Date.now()+3000};}},api=installRuntimeAdmission(ctx,{},client);return{hooks,operations,api,allow:()=>allowed=true};}
test('HTTP mutations, model steps and every SDK tool dispatch are held before their bodies',async()=>{
 const f=fixture();let dispatched=0;const req=Object.assign(new EventEmitter(),{method:'POST',url:'/api/workbench'}),res={headersSent:false,destroyed:false,writeHead(code){this.code=code;},end(body){this.body=body;}};
 await f.hooks.get('connection/request')(req,res,async()=>dispatched++);assert.equal(res.code,503);assert.doesNotMatch(res.body,/private reason/);assert.equal(req.listenerCount('aborted'),0);
 for(const hook of ['agent/pre-step','tools/execute'])await assert.rejects(f.hooks.get(hook)({signal:new AbortController().signal},async()=>dispatched++));assert.equal(dispatched,0);assert.deepEqual(f.operations,['start_turn','model_step','tool_dispatch']);
});
test('the exact read-only functional health probe stays usable before admission without enqueueing work',async()=>{
 const f=fixture(),req=Object.assign(new EventEmitter(),{method:'GET',url:'/api/workbench/health'});let probes=0;await f.hooks.get('connection/request')(req,{},async()=>probes++);assert.equal(probes,1);assert.deepEqual(f.operations,[]);
});
test('accepted dispatch stays counted until completion and errors cannot leave ghost jobs',async()=>{
 const f=fixture();f.allow();let finish;const promise=f.hooks.get('tools/execute')({signal:new AbortController().signal},()=>new Promise(r=>finish=r));while(!finish)await new Promise(r=>setTimeout(r,1));assert.equal(f.api.snapshot().activeTools,1);finish({ok:true});await promise;assert.equal(f.api.snapshot().activeTools,0);await assert.rejects(f.hooks.get('tools/execute')({},async()=>{throw Error('fixture body');}));assert.equal(f.api.snapshot().activeTools,0);
});
