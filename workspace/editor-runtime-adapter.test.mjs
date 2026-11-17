import {executionBindingFixture} from './fixtures/execution-binding.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createProjectEditorAdapter,validateEditorProof} from './editor-runtime-adapter.mjs';
function memoryReceipts(){
 const rows=new Map(),live=new Map();
 return{async list(){return [...rows.values()].map(r=>({...r}));},async save(row){rows.set(row.generation,{...row});},async remove(generation){rows.delete(generation);},claim(generation,{reconciling=false}={}){if(live.has(generation))throw Object.assign(Error('ALREADY_LIVE'),{code:'PROJECT_RUNTIME_RECEIPT_ALREADY_OWNED'});live.set(generation,{reconciling});return()=>live.delete(generation);},isLive:generation=>live.has(generation)&&!live.get(generation).reconciling,simulateRestart(){live.clear();}};
}
function fixture({receiptStore=memoryReceipts()}={}){
 let clock=100000,failStop=false,failTouch=false,abortAfterEnsure,ensureFault,stopFault,identityHook;const source=executionBindingFixture('isolated-guest');
 const calls=[],bridges=[],proofs=new Map(),input={sessionId:'project-A',projectRoot:'/projects/A',readOnly:false},grants=[];
 const manager={execution:source.binding,async withProjectRuntimeAuthority(context,action){grants.push(context);return action('private-authority');}};
 const adapter=createProjectEditorAdapter(manager,{appsConfig:{enabled:true,vm:{enabled:true},projectRuntime:{enabled:true}},receiptStore,callApps:async(route,data)=>{
  assert.equal(route,'/project-runtime');calls.push(data);
  if(data.op==='stop'){if(failStop)throw Error('OFFLINE');return{version:1,state:'stopped',sessionId:data.sessionId,generation:data.generation,operationId:'c'.repeat(32),...stopFault};}
  if(data.op==='touch'){if(failTouch)throw Error('POLICY_DENIED');const proof=proofs.get(data.generation);assert.equal(data.stopToken,proof.stopToken);return{...proof,expiresAt:Math.min(clock+300000,proof.hardDeadline)};}
  const scopeId=crypto.createHash('sha256').update(input.sessionId+'\0'+input.projectRoot).digest('hex').slice(0,32);
  assert.match(data.stopToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await receiptStore.list()).find(r=>r.generation===data.generation)?.stopToken,data.stopToken,'durable receipt precedes admission');
  const proof={version:1,state:'ready',...input,generation:data.generation,scopeId,isolation:{enforced:true,...input},transport:{host:'127.0.0.1',guestAddress:'10.0.2.15',hostPort:19180,guestPort:19180,bootPid:42,mtls:true,serverName:scopeId+'.'+data.generation+'.editor.homeai.invalid'},containerIds:{editor:'a'.repeat(64),relay:'b'.repeat(64)},operationId:'c'.repeat(32),stopToken:data.stopToken,expiresAt:clock+300000,hardDeadline:clock+1800000};
  proofs.set(data.generation,proof);abortAfterEnsure?.abort(Error('CANCELLED'));if(ensureFault==='lost')throw Error('RESPONSE_LOST');return ensureFault==='swapped'?{...proof,stopToken:'x'.repeat(43)}:proof;
 },socketDirectory:'/private',transportIdentity:async({scopeId,generation})=>{await identityHook?.();return{serverName:scopeId+'.'+generation+'.editor.homeai.invalid'};},bridgeFactory:async()=>{const bridge={socketPath:'/private/fixture.sock',closed:false,async close(){this.closed=true;}};bridges.push(bridge);return bridge;},now:()=>clock});
 return{adapter,input,calls,bridges,proofs,grants,receiptStore,source,setIdentityHook:fn=>identityHook=fn,advance:ms=>clock+=ms,setFailStop:value=>failStop=value,setFailTouch:value=>failTouch=value,abortWith:controller=>abortAfterEnsure=controller,setEnsureFault:value=>ensureFault=value,setStopFault:value=>stopFault=value};
}
test('a binding change during awaited transport identity stops the exact admitted editor before any bridge is constructed',async()=>{
 const f=fixture();f.setIdentityHook(async()=>f.source.fail());await assert.rejects(f.adapter.ensureEditor(f.input),/BINDING_CHANGED/);assert.deepEqual(f.calls.map(call=>call.op),['ensure','stop']);assert.equal(f.bridges.length,0);assert.deepEqual(await f.receiptStore.list(),[]);await f.adapter.dispose();
});
test('reopening reuses the bridge with fresh touch authority and never repeats admission',async()=>{
 const f=fixture(),first=await f.adapter.ensureEditor(f.input),again=await f.adapter.ensureEditor(f.input);
 assert.deepEqual(again,first);assert.deepEqual(f.calls.map(c=>c.op),['ensure','touch']);assert.equal(f.bridges.length,1);assert.equal(f.grants.length,2);assert.equal(JSON.stringify(first).includes('private-authority'),false);assert.equal(JSON.stringify(first).includes('d'.repeat(43)),false);
 await f.adapter.dispose();assert.equal(f.bridges[0].closed,true);
});
test('only client activity renews after 30 seconds, with a hard non-extendable generation lifetime',async()=>{
 const f=fixture(),value=await f.adapter.ensureEditor(f.input),activity={...f.input,generation:value.generation};
 await f.adapter.touchEditor(activity);assert.equal(f.calls.length,1);
 f.advance(30001);await f.adapter.touchEditor(activity);assert.equal(f.calls.at(-1).op,'touch');
 f.advance(1800000);await assert.rejects(f.adapter.touchEditor(activity),{code:'EDITOR_RUNTIME_EXPIRED'});assert.equal(f.calls.at(-1).op,'stop');
 const next=await f.adapter.ensureEditor(f.input);assert.notEqual(next.generation,value.generation);await f.adapter.dispose();
});
test('failed stop retains its capability and blocks a new admission until known stopped',async()=>{
 const f=fixture(),value=await f.adapter.ensureEditor(f.input);f.setFailStop(true);
 await assert.rejects(f.adapter.stopEditor({...f.input,generation:value.generation}),/OFFLINE/);assert.equal(f.bridges[0].closed,true);
 await assert.rejects(f.adapter.ensureEditor(f.input),/OFFLINE/);assert.equal(f.calls.filter(c=>c.op==='ensure').length,1);
 f.setFailStop(false);const next=await f.adapter.ensureEditor(f.input);assert.notEqual(next.generation,value.generation);assert.equal(f.calls.filter(c=>c.op==='stop').length,3);await f.adapter.dispose();
});
test('late cancelled admissions are stopped and denied renewals close existing transport',async()=>{
 const f=fixture(),controller=new AbortController();f.abortWith(controller);
 await assert.rejects(f.adapter.ensureEditor({...f.input,signal:controller.signal}),/CANCELLED/);assert.deepEqual(f.calls.map(c=>c.op),['ensure','stop']);assert.equal(f.bridges.length,0);
 f.abortWith(null);const ready=await f.adapter.ensureEditor(f.input);f.setFailTouch(true);f.advance(30001);
 await assert.rejects(f.adapter.touchEditor({...f.input,generation:ready.generation}),/POLICY_DENIED/);assert.equal(f.bridges[0].closed,true);
});
test('proof rejects plaintext transport, swapped scope and unbounded lease',async()=>{
 const f=fixture(),value=await f.adapter.ensureEditor(f.input),proof=f.proofs.get(value.generation),context={...f.input,generation:value.generation};
 for(const patch of [{transport:{...proof.transport,mtls:false}},{scopeId:'f'.repeat(32)},{expiresAt:99999999},{hardDeadline:99999999},{transport:{...proof.transport,serverName:'foreign.invalid'}}]){
  assert.throws(()=>validateEditorProof({...proof,...patch},context,100000),{code:'EDITOR_ISOLATION_UNPROVEN'});
 }
 await f.adapter.dispose();
});
test('lost admission response uses the original pre-minted capability and forbids replacement until stop',async()=>{
 const f=fixture();f.setEnsureFault('lost');f.setFailStop(true);
 await assert.rejects(f.adapter.ensureEditor(f.input),/RESPONSE_LOST/);
 const admitted=f.calls.find(c=>c.op==='ensure');
 assert.equal(f.calls.at(-1).stopToken,admitted.stopToken);
 await assert.rejects(f.adapter.ensureEditor(f.input),/OFFLINE/);
 assert.equal(f.calls.filter(c=>c.op==='ensure').length,1);
 f.setFailStop(false);f.setEnsureFault(null);await f.adapter.ensureEditor(f.input);
 assert.equal(f.calls.filter(c=>c.op==='ensure').length,2);await f.adapter.dispose();
});
test('swapped echoed capability is refused and never used for cleanup',async()=>{
 const f=fixture();f.setEnsureFault('swapped');
 await assert.rejects(f.adapter.ensureEditor(f.input),{code:'EDITOR_ISOLATION_UNPROVEN'});
 assert.equal(f.bridges.length,0);assert.equal(f.calls.at(-1).stopToken,f.calls[0].stopToken);
 assert.notEqual(f.calls.at(-1).stopToken,'x'.repeat(43));
});
test('malformed or wrong-operation stop acknowledgement retains ownership',async()=>{
 const f=fixture(),ready=await f.adapter.ensureEditor(f.input);
 for(const patch of [{version:2},{operationId:'f'.repeat(32)},{generation:'0'.repeat(32)}]){
  f.setStopFault(patch);await assert.rejects(f.adapter.stopEditor({...f.input,generation:ready.generation}),{code:'EDITOR_STOP_UNCONFIRMED'});
 }
 assert.equal(f.calls.filter(c=>c.op==='ensure').length,1);
 f.setStopFault(null);await f.adapter.dispose();assert.equal(f.calls.at(-1).op,'stop');
});
test('restart reconciles the persisted generation before admitting a new editor',async()=>{
 const receipts=memoryReceipts(),old=fixture({receiptStore:receipts});old.setEnsureFault('lost');old.setFailStop(true);
 await assert.rejects(old.adapter.ensureEditor(old.input),/RESPONSE_LOST/);
 const abandoned=(await receipts.list())[0];assert.ok(receipts.isLive(abandoned.generation));
 receipts.simulateRestart();const next=fixture({receiptStore:receipts});
 const ready=await next.adapter.ensureEditor(next.input);
 assert.deepEqual(next.calls.map(c=>c.op),['stop','ensure']);
 assert.equal(next.calls[0].generation,abandoned.generation);assert.equal(next.calls[0].stopToken,abandoned.stopToken);
 assert.notEqual(ready.generation,abandoned.generation);assert.equal((await receipts.list()).length,1);
 await next.adapter.dispose();assert.deepEqual(await receipts.list(),[]);
});
test('unconfirmed restart cleanup blocks new admission and retains the private receipt',async()=>{
 const receipts=memoryReceipts();await receipts.save({kind:'editor',sessionId:'project-A',accessSessionId:'project-A',generation:'a'.repeat(32),stopToken:'z'.repeat(43),startedAt:1,operationId:null,jobId:null});
 const f=fixture({receiptStore:receipts});f.setFailStop(true);
 await assert.rejects(f.adapter.ensureEditor(f.input),{code:'EDITOR_RECONCILIATION_REQUIRED'});
 assert.equal(f.calls.some(c=>c.op==='ensure'),false);assert.equal((await receipts.list()).length,1);
 f.setFailStop(false);await f.adapter.ensureEditor(f.input);await f.adapter.dispose();
});
test('live editor claims survive unrelated heavy-admission reconciliation',async()=>{
 const f=fixture(),ready=await f.adapter.ensureEditor(f.input);
 await f.adapter.beforeHeavy();assert.deepEqual(f.calls.map(c=>c.op),['ensure']);
 assert.ok(f.receiptStore.isLive(ready.generation));await f.adapter.dispose();
});
