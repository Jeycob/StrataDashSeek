import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createProjectEditorAdapter,validateEditorProof} from './editor-runtime-adapter.mjs';
function fixture(){
 let clock=100000,failStop=false,failTouch=false,abortAfterEnsure;
 const calls=[],bridges=[],proofs=new Map(),input={sessionId:'project-A',projectRoot:'/projects/A',readOnly:false},grants=[];
 const manager={async withProjectRuntimeAuthority(context,action){grants.push(context);return action('private-authority');}};
 const adapter=createProjectEditorAdapter(manager,{appsConfig:{projectRuntime:{enabled:true}},callApps:async(route,data)=>{
  assert.equal(route,'/project-runtime');calls.push(data);
  if(data.op==='stop'){if(failStop)throw Error('OFFLINE');return{state:'stopped',sessionId:data.sessionId,generation:data.generation};}
  if(data.op==='touch'){if(failTouch)throw Error('POLICY_DENIED');const proof=proofs.get(data.generation);assert.equal(data.stopToken,proof.stopToken);return{...proof,expiresAt:Math.min(clock+300000,proof.hardDeadline)};}
  const scopeId=crypto.createHash('sha256').update(input.sessionId+'\0'+input.projectRoot).digest('hex').slice(0,32);
  const proof={version:1,state:'ready',...input,generation:data.generation,scopeId,isolation:{enforced:true,...input},transport:{host:'127.0.0.1',guestAddress:'10.0.2.15',hostPort:19180,guestPort:19180,bootPid:42,mtls:true,serverName:scopeId+'.'+data.generation+'.editor.homeai.invalid'},containerIds:{editor:'a'.repeat(64),relay:'b'.repeat(64)},operationId:'c'.repeat(32),stopToken:'d'.repeat(43),expiresAt:clock+300000,hardDeadline:clock+1800000};
  proofs.set(data.generation,proof);abortAfterEnsure?.abort(Error('CANCELLED'));return proof;
 },socketDirectory:'/private',transportIdentity:async({scopeId,generation})=>({serverName:scopeId+'.'+generation+'.editor.homeai.invalid'}),bridgeFactory:async()=>{const bridge={socketPath:'/private/fixture.sock',closed:false,async close(){this.closed=true;}};bridges.push(bridge);return bridge;},now:()=>clock});
 return{adapter,input,calls,bridges,proofs,grants,advance:ms=>clock+=ms,setFailStop:value=>failStop=value,setFailTouch:value=>failTouch=value,abortWith:controller=>abortAfterEnsure=controller};
}
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
