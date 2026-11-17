import {hostExecutionBinding,executionBindingFixture} from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registryBarrier,installDockerCleanup} from './docker-cleanup.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('host cleanup composition cannot mint guest authority or enter its queue',async t=>{
 const f=await ownerFixture(t,()=>assert.fail('No Apps mutation'));f.manager.inOrder=()=>assert.fail('No authority queue');assert.throws(()=>f.manager.withProjectRuntimeAuthority({},()=>assert.fail('No guest action')),{code:'PROJECT_RUNTIME_MODE_UNAVAILABLE'});await assert.rejects(fs.stat(path.join(f.dir,'docker-cleanup-authority.json')),{code:'ENOENT'});
});
test('changed isolated binding after queue wait prevents authority publication and RPC',async t=>{
 const binding=executionBindingFixture('isolated-guest'),f=await ownerFixture(t,()=>assert.fail('No Apps mutation'),binding.binding);let entered,release,effects=0;const ready=new Promise(resolve=>entered=resolve);f.manager.inOrder=async action=>{entered();await new Promise(resolve=>release=resolve);return action();};
 const pending=f.manager.withProjectRuntimeAuthority({sessionId:'owner'},()=>{effects++;});await ready;binding.fail();release();await assert.rejects(pending,{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(effects,0);await assert.rejects(fs.stat(path.join(f.dir,'docker-cleanup-authority.json')),{code:'ENOENT'});
});
test('registry write queue serializes unarchive behind deletion and refuses uncertain durable intents',async()=>{let chain=Promise.resolve(),release,operation=null;const registry={enqueueOperation(action){const p=chain.then(action);chain=p.catch(()=>{});return p;}},barrier=registryBarrier(registry,async()=>operation),events=[];
 const deletion=barrier.run(async()=>{events.push('deleting');await new Promise(r=>release=r);operation={state:'reconciliation_required'};events.push('uncertain');});await Promise.resolve();const unarchive=registry.enqueueOperation(()=>events.push('unarchived'));release();await deletion;await assert.rejects(unarchive,/CLEANUP_RECONCILIATION_REQUIRED/);assert.deepEqual(events,['deleting','uncertain']);operation={state:'completed'};await registry.enqueueOperation(()=>events.push('unarchived'));assert.equal(events.at(-1),'unarchived');barrier.dispose();});
test('unsupported registry serialization contract fails closed',()=>assert.throws(()=>registryBarrier({},async()=>null),/CLEANUP_UNAVAILABLE/));
async function ownerFixture(t,rpc,executionBinding=hostExecutionBinding(),preferences={enabled:false}){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cleanup-owner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const events=new Map(),routes=new Map(),dispose=[];let chain=Promise.resolve(),writes=Promise.resolve();const registry={archivedSessionIds:[],pinnedSessionIds:[],list:()=>[],enqueueOperation(fn){const p=chain.then(fn);chain=p.catch(()=>{});return p;}},manager={execution:executionBinding,root:dir,data:{sessions:{}},inOrder(fn){const p=writes.then(fn);writes=p.catch(()=>{});return p;}},ctx={workspaceRegistry:registry,agents:{list:()=>[]},sessionPersistence:{list:async()=>[]},waterfall:async(_name,_value,next)=>next(),logger:{warn(){}},on(name,fn){const list=events.get(name)||[];list.push(fn);events.set(name,list);return()=>events.set(name,(events.get(name)||[]).filter(x=>x!==fn));},effect(fn){const out=fn();if(typeof out==='function')dispose.push(out);},connection:{fetch:{register(route){routes.set(route.path,route.fetch);return()=>routes.delete(route.path);}}}};ctx.root=ctx;
 const api=installDockerCleanup(ctx,manager,{stateDir:dir},async(_route,input)=>input.op==='preferences'?preferences:rpc(input));t.after(async()=>{for(const fn of dispose.reverse())await fn();});return{dir,ctx,manager,api,events,handler:routes.get('/api/workbench/docker-cleanup')};}
test('automatic cleanup rechecks binding after fresh asynchronous census before reservation or apply',async t=>{
 const binding=executionBindingFixture('host-compat'),calls=[];let previewed=false,captures=0;
 const f=await ownerFixture(t,async input=>{calls.push(input.op);assert.equal(input.op,'preview');previewed=true;return{availability:'ready',plan:{id:'a'.repeat(32),hash:'b'.repeat(64),selection:[{kind:'container',id:'c'.repeat(64)}],rows:[{kind:'container',id:'c'.repeat(64),sessionIds:['owner']}]}};},binding.binding,{enabled:true,availability:'ready'});
 f.ctx.sessionPersistence.list=async()=>{captures++;if(previewed)binding.fail();return[];};
 await f.api.runAuto('periodic');assert.equal(captures,2);assert.deepEqual(calls,['preview']);await assert.rejects(fs.stat(path.join(f.dir,'docker-cleanup-authority.json')),{code:'ENOENT'});
});
test('owner Settings mutation rejects cross-origin and ignores client authority/automatic fields',async t=>{const calls=[],f=await ownerFixture(t,async input=>{calls.push(input);return{version:1,enabled:input.enabled,availability:'deferred',operation:null};});const request=(origin,body)=>new Request('https://owner.test/api/workbench/docker-cleanup',{method:'POST',headers:{host:'owner.test',origin,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal((await f.handler(request('https://foreign.test',{op:'settings',enabled:false}))).status,403);assert.equal(calls.length,0);const r=await f.handler(request('https://owner.test',{op:'settings',enabled:false,token:'forged',automatic:true}));assert.equal(r.status,200);assert.deepEqual(calls,[{op:'settings',enabled:false}]);});
test('manual apply reserves its owner before RPC; unrelated chats and later turns continue',async t=>{let release,entered;const started=new Promise(r=>entered=r),sid='session-reserved',f=await ownerFixture(t,async input=>{assert.equal(input.op,'apply');entered();return new Promise(r=>release=()=>r({version:1,enabled:true,availability:'ready',operation:{state:'completed',results:[]}}));});await fs.writeFile(path.join(f.dir,'archived-docker-cleanup.json'),JSON.stringify({plans:{plan:{rows:[{kind:'container',id:'a'.repeat(64),sessionIds:[sid]}]}}}));const response=f.handler(new Request('https://owner.test/api/workbench/docker-cleanup',{method:'POST',headers:{host:'owner.test',origin:'https://owner.test'},body:JSON.stringify({op:'apply',planId:'plan',planHash:'hash',selections:[{kind:'container',id:'a'.repeat(64)}]})}));await started;const guard=f.events.get('agent/pre-step')[0];await assert.rejects(guard({agent:{id:sid}},()=>assert.fail('reserved')),/CLEANUP_RECONCILIATION_REQUIRED/);let continued=false;await guard({agent:{id:'session-unrelated'}},()=>{continued=true;});assert.equal(continued,true);release();assert.equal((await response).status,200);await guard({agent:{id:sid}},()=>{});});
test('official archive follow-up registers synchronously and disabled preference prevents automatic work',async t=>{let calls=0;const f=await ownerFixture(t,async()=>{calls++;assert.fail('disabled auto');});const callback=f.events.get('workspace/session-archived')[0];assert.equal(callback({sessionId:'session-one'}),undefined);await new Promise(r=>setImmediate(r));await f.api.runAuto('periodic');assert.equal(calls,0);});

test('GET requested A remains A through queue admission; replacement B cannot be returned',async t=>{
 const {ArchivedDockerCleanup}=await import('../vast/apps-archived-cleanup.cjs');let controller,lastInput;
 const f=await ownerFixture(t,async input=>{lastInput=input;return controller.handle(input);});
 const backend={execution:hostExecutionBinding(),cfg:{stateDir:f.dir,workbenchStateRoot:f.dir,enabled:true},busy:null};
 controller=new ArchivedDockerCleanup(backend);
 const a='a'.repeat(32),b='b'.repeat(32),operation=id=>({id,state:'completed',results:[]});
 controller.data.operation=operation(a);controller.save();
 let release,entered;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 f.manager.inOrder=async action=>{entered();await hold;return action();};
 const request=f.handler(new Request('https://owner.test/api/workbench/docker-cleanup?operationId='+a));
 await started;controller.data.operation=operation(b);controller.save();release();
 const response=await request;assert.equal(lastInput.operationId,a);
 assert.equal(response.status,404);assert.equal((await response.json()).code,'CLEANUP_OPERATION_NOT_FOUND');
 assert.equal(controller.data.operation.id,b);
});

test('GET plan lookup forwards selector and echoes binding; apply retry needs no current preview',async t=>{
 const planId='c'.repeat(32),operationId='d'.repeat(32),planHash='e'.repeat(64),selected=[{kind:'container',id:'f'.repeat(64)}],calls=[];
 const operation={id:operationId,planId,planHash,selection:selected,state:'completed',results:[],ownerSessionIds:['private-owner']};
 const f=await ownerFixture(t,async input=>{calls.push(input);return{version:1,operation};});
 await fs.writeFile(path.join(f.dir,'archived-docker-cleanup.json'),JSON.stringify({plans:{},receipts:{[planId]:operation},operation:{id:'0'.repeat(32)}}));
 const result=await f.handler(new Request('https://owner.test/api/workbench/docker-cleanup?planId='+planId+'&operationId='+operationId));
 assert.equal(result.status,200);const body=await result.json();
 assert.equal(calls[0].planId,planId);assert.equal(calls[0].operationId,operationId);
 assert.equal(body.operation.planId,planId);assert.equal(body.operation.planHash,planHash);
 assert.deepEqual(body.operation.selection,selected);assert.equal(body.operation.ownerSessionIds,undefined);
 const replay=await f.handler(new Request('https://owner.test/api/workbench/docker-cleanup',{method:'POST',headers:{host:'owner.test',origin:'https://owner.test'},body:JSON.stringify({op:'apply',planId,planHash,selections:selected})}));
 assert.equal(replay.status,200);assert.equal((await replay.json()).operation.id,operationId);assert.equal(calls[1].op,'apply');
});
