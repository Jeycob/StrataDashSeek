import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGuestProjectCommandRunner } from './project-guest-runner.mjs';
import { bindHeavyToolLease } from '../efficiency/heavy-tool-lease.mjs';
function fixture() {
  const owner={id:'owner',session:{mode:'workspace-write'}},child={id:'child',owner,session:{mode:'read-only'}},root=path.resolve('/synthetic-project');
  const hooks=new Map(),calls=[],authorities=[],ctx={on(name,fn){const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);return()=>{const at=list.indexOf(fn);if(at>=0)list.splice(at,1);};},workspaceRegistry:{archivedSessionIds:[]},sandboxPolicy:{resolve:({session})=>({mode:session.mode})},shell:{execute(){assert.fail('Host shell must never execute');}}};
  let runtime,jobStatus='running',code=0,holdStop=false,releaseStop,holdAdmission=false,releaseAdmission,failStops=0,loseAdmission=false;
  const manager={ownerAgent:a=>a.owner||a,data:{sessions:{owner:{root,independentRepository:true}}},async withProjectRuntimeAuthority(input,action){authorities.push(input);return action('a'.repeat(32));}};
  const callApps=async(route,data,cfg)=>{
    calls.push({route,data,cfg});
    if(data?.op==='execute'){assert.equal(rows.get(data.generation)?.stopToken,data.stopToken,'receipt must precede RPC');runtime={version:1,state:'running',sessionId:data.sessionId,generation:data.generation,jobId:'b'.repeat(16),operationId:'c'.repeat(32),stopToken:data.stopToken};if(holdAdmission)await new Promise(r=>releaseAdmission=r);if(loseAdmission)throw Error('SYNTHETIC_LOST_ADMISSION_REPLY');return runtime;}
    if(data?.op==='stop'){if(failStops-->0)throw Error('Synthetic lost stop response');if(holdStop)await new Promise(r=>releaseStop=r);jobStatus='interrupted';return{version:1,state:'stopped',sessionId:data.sessionId,generation:data.generation,operationId:runtime.operationId};}
    if(route.startsWith('/job-status'))return{version:1,job:{id:runtime.jobId,action:'project-executor',status:jobStatus,terminal:jobStatus!=='running',...(['passed','failed'].includes(jobStatus)?{exitCode:code}:{})}};
    if(route.startsWith('/job-log'))return{text:'actual synthetic output\n'};
    assert.fail('Unexpected RPC');
  };
  const rows=new Map(),live=new Set(),receiptStore={async list(){return[...rows.values()].map(row=>({...row}));},async save(row){rows.set(row.generation,{...row});},async remove(generation){rows.delete(generation);},claim(generation){assert(!live.has(generation));live.add(generation);return()=>live.delete(generation);},isLive:generation=>live.has(generation)};
  const run=createGuestProjectCommandRunner(ctx,manager,{appsConfig:{projectRuntime:{enabled:true}},callApps,pollMs:1,wait:()=>new Promise(r=>setTimeout(r,1)),receiptStore});
  const controller=new AbortController(),execution={agent:child,signal:controller.signal,callId:'tool1'};
  return{run,ctx,manager,owner,child,calls,authorities,controller,execution,receiptStore,emit(name,...args){for(const fn of hooks.get(name)??[])fn(...args);},finish(value=0){code=value;jobStatus=value===0?'passed':'failed';},holdStop(){holdStop=true;},releaseStop(){holdStop=false;releaseStop?.();},holdAdmission(){holdAdmission=true;},releaseAdmission(){holdAdmission=false;releaseAdmission?.();},failStops(count){failStops=count;},loseAdmission(){loseAdmission=true;}};
}
const args={command:'node check.mjs',description:'Check project',timeoutMs:1000};
const eventually=async check=>{for(let n=0;n<100&&!check();n++)await new Promise(r=>setTimeout(r,2));assert(check());};
test('guest foreground command passes real child authority and retains actual exit code without host fallback',async()=>{
  const f=fixture(),pending=f.run(args,f.execution);await eventually(()=>f.authorities.length>0);f.finish(19);const result=await pending;
  assert.equal(result.result.exitCode,19);assert.equal(result.result.stdout.text,'actual synthetic output\n');assert.equal(result.result.sandbox.mode,'read-only');
  assert.equal(f.authorities[0].accessSessionId,'child');assert.equal(f.authorities[0].sessionId,'owner');
  const create=f.calls.find(c=>c.data?.op==='execute');assert.match(create.data.command,/^cd -- '\/workspace' && node check.mjs$/);assert(!create.data.command.includes(f.manager.data.sessions.owner.root));await f.run.dispose();
});
test('cancellation does not release heavy lease until exact generation stop is confirmed',async()=>{
  const f=fixture();f.holdStop();let released=0;const releaseTool=bindHeavyToolLease(f.execution,{release(){released++;}});
  const pending=f.run(args,f.execution);pending.catch(()=>{});await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));f.controller.abort();releaseTool();await eventually(()=>f.calls.some(c=>c.data?.op==='stop'));assert.equal(released,0);
  f.releaseStop();await assert.rejects(pending);await eventually(()=>released===1);await f.run.dispose();
});
test('outside target, legacy project and unavailable executor refuse without an RPC',async()=>{
  const f=fixture();await assert.rejects(f.run({...args,workdir:'../foreign'},f.execution),{code:'PROJECT_RUNTIME_OUTSIDE_PROJECT'});
  f.manager.data.sessions.owner.independentRepository=false;await assert.rejects(f.run(args,f.execution),{code:'PROJECT_RUNTIME_NOT_ISOLATED'});assert.equal(f.calls.length,0);
  const unavailable=createGuestProjectCommandRunner(f.ctx,f.manager);await assert.rejects(unavailable(args,f.execution),{code:'PROJECT_RUNTIME_ISOLATION_UNAVAILABLE'});await f.run.dispose();await unavailable.dispose();
});

for(const id of ['owner','child'])test('policy changes revoke the exact '+id+' command and retain the lease through stop confirmation',async()=>{
  const f=fixture();f.holdStop();let released=0;const releaseTool=bindHeavyToolLease(f.execution,{release(){released++;}});
  const pending=f.run({...args,timeoutMs:10000},f.execution);pending.catch(()=>{});await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));
  f.emit('session/event',{id:'foreign'},{type:'sandbox/mode'});assert.equal(f.calls.some(c=>c.data?.op==='stop'),false);
  f.emit('session/event',f[id].session.id?f[id].session:{id},{type:'sandbox/mode'});releaseTool();await assert.rejects(pending,{code:'PROJECT_RUNTIME_ACCESS_REVOKED'});await eventually(()=>f.calls.some(c=>c.data?.op==='stop'));
  assert.equal(released,0);assert.throws(()=>f.emit('workspace/session-unarchiving',{sessionId:id}),{code:'PROJECT_RUNTIME_RECONCILIATION_REQUIRED'});
  const command=f.calls.find(c=>c.data?.op==='execute').data,stop=f.calls.find(c=>c.data?.op==='stop').data;assert.equal(stop.sessionId,'owner');assert.equal(stop.generation,command.generation);assert.equal(stop.stopToken,command.stopToken);
  f.releaseStop();await eventually(()=>released===1);f.emit('workspace/session-unarchiving',{sessionId:id});await f.run.dispose();
});

test('archive revocation during admission aborts transport and drains a late running receipt before disposal',async()=>{
  const f=fixture();f.holdAdmission();f.holdStop();const pending=f.run({...args,timeoutMs:10000},f.execution);pending.catch(()=>{});await eventually(()=>f.calls.some(c=>c.data?.op==='execute'));
  f.ctx.workspaceRegistry.archivedSessionIds.push('child');f.emit('workspace/session-archived',{sessionId:'child'});
  assert.equal(f.calls.find(c=>c.data?.op==='execute').cfg.signal.aborted,true);
  let disposed=false;const drain=f.run.dispose().then(()=>{disposed=true;});f.releaseAdmission();await eventually(()=>f.calls.some(c=>c.data?.op==='stop'));assert.equal(disposed,false);
  f.releaseStop();await assert.rejects(pending,{code:'PROJECT_RUNTIME_ACCESS_REVOKED'});await drain;assert.equal(disposed,true);
});

test('revoked command retries a lost stop response until owned stop is confirmed',async()=>{
  const f=fixture();f.failStops(2);const pending=f.run({...args,timeoutMs:10000},f.execution);pending.catch(()=>{});await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));
  f.emit('workspace/session-stop',{sessionId:'owner'});await assert.rejects(pending,{code:'PROJECT_RUNTIME_ACCESS_REVOKED'});await f.run.dispose();assert(f.calls.filter(c=>c.data?.op==='stop').length>=3);
});

test('lost admission reply retains its pre-minted stop capability and heavy lease until cancellation is durable',async()=>{
  const f=fixture();f.loseAdmission();f.holdStop();let released=0;const releaseTool=bindHeavyToolLease(f.execution,{release(){released++;}});
  await assert.rejects(f.run({...args,timeoutMs:10000},f.execution),{code:'PROJECT_RUNTIME_ADMISSION_UNVERIFIED'});releaseTool();await eventually(()=>f.calls.some(c=>c.data?.op==='stop'));assert.equal(released,0);
  const create=f.calls.find(c=>c.data?.op==='execute').data,stop=f.calls.find(c=>c.data?.op==='stop').data;assert.match(create.stopToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(stop.generation,create.generation);assert.equal(stop.stopToken,create.stopToken);
  assert(!f.calls.some(c=>c.route.startsWith('/job-status')));f.releaseStop();await eventually(()=>released===1);await f.run.dispose();
});

test('orphan receipt blocks a new command before any fresh authority or execute RPC',async()=>{
 const f=fixture();await f.receiptStore.save({kind:'executor',sessionId:'previous',accessSessionId:'previous-child',generation:'a'.repeat(32),stopToken:'s'.repeat(43),startedAt:1,operationId:null,jobId:null});
 await assert.rejects(f.run(args,f.execution),{code:'PROJECT_RUNTIME_RECONCILIATION_REQUIRED'});assert.equal(f.authorities.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].data.op,'stop');assert.equal((await f.receiptStore.list()).length,1);
 await f.run.dispose();
});

test('receipt persistence failure prevents execution and Native authority issuance',async()=>{
 const f=fixture();f.receiptStore.save=async()=>{throw Error('SYNTHETIC_FSYNC_FAILED');};await assert.rejects(f.run(args,f.execution),/FSYNC_FAILED/);assert.equal(f.calls.length,0);assert.equal(f.authorities.length,0);await f.run.dispose();
});
