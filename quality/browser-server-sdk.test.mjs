// Real pinned Cordis + OwnedRangeSubprocess; only the kernel process/range is
// inert. No real subprocess, browser, Linux peer proof, server or model runs;
// the verify callback returns an opaque phase result, never quality PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeRequire} from '../runtime/require.cjs';
import OwnedRangeSubprocess from '../workspace/owned-range-subprocess.mjs';
import {withBrowserServer} from './browser-server-contract.mjs';
const {Context}=runtimeRequire('@deepseek-ai/cordis');
const {LocalSubprocessRuntime}=runtimeRequire('@deepseek-ai/dsh-subprocess-local');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,5));
async function until(check){for(let n=0;n<200;n++){if(check())return;await tick();}assert.fail('bounded SDK fixture wait');}
function fixture(t,{rangeUnknown=false}={}){
  const ctx=new Context(),direct=deferred(),range=deferred();let kills=0,waits=0,settled=false;
  t.mock.method(LocalSubprocessRuntime.prototype,'spawn',()=>({done:direct.promise,terminate(){kills++;},waitForExit(){waits++;return rangeUnknown?Promise.resolve(false):range.promise;}}));
  const provider=new OwnedRangeSubprocess(ctx);
  t.after(async()=>{direct.resolve({exitCode:0,signal:null});range.resolve(true);await ctx.fiber.dispose();});
  return{direct,range,get kills(){return kills;},get waits(){return waits;},start(){const owned=provider.spawn({argv:['node','server.mjs'],cwd:process.cwd(),stdio:{stdin:'ignore',stdout:{maxBytes:65536},stderr:{maxBytes:65536}},graceMs:100});void owned.done.then(()=>{settled=true;});return{...owned,assertCurrent(){assert.equal(settled,false);}};}};
}
const options=()=>({server:{command:['node','server.mjs']},deadline:Date.now()+5000,readinessDeadline:Date.now()+2000});

test('one server/browser operation waits actual SDK child range after direct leader exits',async t=>{
  const f=fixture(t);let verified=0,finished=false;
  const pending=withBrowserServer({...options(),start:()=>f.start(),ready:async()=>{},verify:async({assertCurrent})=>{assertCurrent();verified++;return 'phase-result';}}).then(value=>{finished=true;return value;});
  await until(()=>verified===1&&f.kills===1);f.direct.resolve({exitCode:0,signal:null});await until(()=>f.waits===1);
  assert.equal(finished,false);f.range.resolve(true);assert.equal(await pending,'phase-result');assert.equal(finished,true);
});

test('Stop during readiness terminates the exact SDK range and cannot enter browser or acknowledge child exit early',async t=>{
  const f=fixture(t),controller=new AbortController(),entered=deferred();let verified=0,finished=false;
  const pending=withBrowserServer({...options(),signal:controller.signal,start:()=>f.start(),ready:({signal})=>{entered.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},verify:async()=>{verified++;}}).then(()=>{finished=true;},error=>{finished=true;throw error;});
  await entered.promise;controller.abort(Error('owner Stop'));await until(()=>f.kills===1);f.direct.resolve({exitCode:null,signal:'SIGTERM'});await until(()=>f.waits===1);
  assert.equal(verified,0);assert.equal(finished,false);f.range.resolve(true);await assert.rejects(pending,/owner Stop/);assert.equal(finished,true);
});

test('failed owned readiness preserves its concrete failure and drains before returning failure',async t=>{
  const f=fixture(t);let verified=0,finished=false;
  const pending=withBrowserServer({...options(),start:()=>f.start(),ready:async()=>{throw Object.assign(Error('owned connection refused'),{code:'ECONNREFUSED'});},verify:async()=>{verified++;}}).catch(error=>{finished=true;throw error;});
  await until(()=>f.kills===1);f.direct.resolve({exitCode:1,signal:null});await until(()=>f.waits===1);assert.equal(finished,false);assert.equal(verified,0);
  f.range.resolve(true);await assert.rejects(pending,{code:'ECONNREFUSED'});
});

test('owned range exit aborts and observes active browser cleanup instead of leaving it detached',async t=>{
  const f=fixture(t),entered=deferred();let browserClosed=false;
  const pending=withBrowserServer({...options(),start:()=>f.start(),ready:async()=>{},verify:({signal})=>{entered.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{browserClosed=true;reject(signal.reason);},{once:true}));}});
  await entered.promise;f.direct.resolve({exitCode:1,signal:null});f.range.resolve(true);
  await assert.rejects(pending,{code:'BROWSER_SERVER_EXITED'});assert.equal(browserClosed,true);
});

test('Stop during browser waits browser cancellation and the same SDK range, with no second start',async t=>{
  const f=fixture(t),controller=new AbortController(),entered=deferred();let browserClosed=false,finished=false,starts=0;
  const pending=withBrowserServer({...options(),signal:controller.signal,start:()=>{starts++;return f.start();},ready:async()=>{},verify:({signal})=>{entered.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{browserClosed=true;reject(signal.reason);},{once:true}));}}).catch(error=>{finished=true;throw error;});
  await entered.promise;controller.abort(Error('browser Stop'));await until(()=>f.kills===1);assert.equal(browserClosed,true);
  f.direct.resolve({exitCode:null,signal:'SIGTERM'});await until(()=>f.waits===1);assert.equal(finished,false);assert.equal(starts,1);
  f.range.resolve(true);await assert.rejects(pending,/browser Stop/);
});

test('unknown actual SDK range exit cannot become completed verification after Stop',async t=>{
  const f=fixture(t,{rangeUnknown:true}),controller=new AbortController(),entered=deferred();let finished=false;
  const pending=withBrowserServer({...options(),signal:controller.signal,start:()=>f.start(),ready:({signal})=>{entered.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},verify:async()=>assert.fail('browser must not start')});
  void pending.then(()=>{finished=true;},()=>{finished=true;});
  await entered.promise;controller.abort(Error('unknown-range Stop'));f.direct.resolve({exitCode:0,signal:null});await until(()=>f.waits===1);await tick();
  assert.equal(finished,false);assert(f.kills>=1);
  // Deliberately unresolved: SDK cannot prove quiescence. A pending promise
  // holds no timers; disposal only releases the inert original fake handle.
});
