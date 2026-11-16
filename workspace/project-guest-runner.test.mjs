import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createGuestProjectCommandRunner } from './project-guest-runner.mjs';
import { bindHeavyToolLease } from '../efficiency/heavy-tool-lease.mjs';
function fixture() {
  const owner={id:'owner',session:{mode:'workspace-write'}},child={id:'child',owner,session:{mode:'read-only'}},root=path.resolve('/synthetic-project');
  const calls=[],authorities=[],ctx={sandboxPolicy:{resolve:({session})=>({mode:session.mode})},shell:{execute(){assert.fail('Host shell must never execute');}}};
  let runtime,jobStatus='running',code=0,holdStop=false,releaseStop;
  const manager={ownerAgent:a=>a.owner||a,data:{sessions:{owner:{root,independentRepository:true}}},async withProjectRuntimeAuthority(input,action){authorities.push(input);return action('a'.repeat(32));}};
  const callApps=async(route,data,cfg)=>{
    calls.push({route,data,cfg});
    if(data?.op==='execute'){runtime={version:1,state:'running',sessionId:data.sessionId,generation:data.generation,jobId:'b'.repeat(16),operationId:'c'.repeat(32),stopToken:'d'.repeat(43)};return runtime;}
    if(data?.op==='stop'){if(holdStop)await new Promise(r=>releaseStop=r);jobStatus='interrupted';return{version:1,state:'stopped',sessionId:data.sessionId,generation:data.generation,operationId:runtime.operationId};}
    if(route.startsWith('/job-status'))return{version:1,job:{id:runtime.jobId,action:'project-executor',status:jobStatus,terminal:jobStatus!=='running',...(['passed','failed'].includes(jobStatus)?{exitCode:code}:{})}};
    if(route.startsWith('/job-log'))return{text:'actual synthetic output\n'};
    assert.fail('Unexpected RPC');
  };
  const run=createGuestProjectCommandRunner(ctx,manager,{appsConfig:{projectRuntime:{enabled:true}},callApps,pollMs:1,wait:()=>new Promise(r=>setTimeout(r,1))});
  const controller=new AbortController(),execution={agent:child,signal:controller.signal,callId:'tool1'};
  return{run,ctx,manager,owner,child,calls,authorities,controller,execution,finish(value=0){code=value;jobStatus=value===0?'passed':'failed';},holdStop(){holdStop=true;},releaseStop(){holdStop=false;releaseStop?.();}};
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
