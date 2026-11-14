import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {apply} from './plugin.mjs';
import {digest} from '../quality/core.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'eff-plugin-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const hooks=new Map(),tools=new Map(),effects=[],guards=[],sections=[],contexts=[],agent={id:'A',session:{id:'A',header:{}}};let reviewCalls=0;
  const ctx={agents:{get:id=>id==='A'?agent:undefined},systemPrompt:{section:x=>sections.push(x),context:x=>contexts.push(x)},on:(name,fn)=>{if(!hooks.has(name))hooks.set(name,[]);hooks.get(name).push(fn);},effect:fn=>effects.push(fn()),tools:{guard:fn=>guards.push(fn),register:x=>tools.set(x.name,x)},llm:{},shell:{sandboxMode:'workspace-write'},shellEnv:{collect:()=>({})},waterfall:async()=>{reviewCalls++;return{root:directory,sourceHash:'source',checkpoints:{test:{}},legacy:false};}};
  await apply(ctx,{stateDirectory:path.join(directory,'.state'),engineMetrics:false});t.after(()=>effects.forEach(fn=>fn?.()));
  const call=(name,...args)=>hooks.get(name)[0](...args);
  const exec=(name,args)=>({name,arguments:args,agent,token:Symbol(),signal:new AbortController().signal});
  return{directory,ctx,call,hooks,tools,guards,agent,exec,sections,contexts,reviewCalls:()=>reviewCalls};
}
test('large overwrite denial is synchronous at the final guard; explanation is one-use and hash-bound',async t=>{
  const f=await fixture(t),name=path.join(f.directory,'cart.js'),before=Array.from({length:100},(_,i)=>`old${i}`).join('\n');await fs.writeFile(name,before);
  const e=f.exec('write',{file_path:name,content:Array.from({length:100},(_,i)=>`new${i}`).join('\n')});
  assert.equal((await f.call('tools/pre-execute',e,async()=>({kind:'allow'}))).kind,'deny');assert.equal(f.guards[0](e).info.code,'REWRITE_EXPLANATION_REQUIRED');assert.equal(f.guards[0](e) instanceof Promise,false);
  const explain=f.tools.get('explain_rewrite');
  await assert.rejects(explain.execute({path:'cart.js',sha256:'0'.repeat(64),reason:'The existing layout cannot represent the required checkout state.',validationPlan:'Run the full checkout and pricing regression suite after the rewrite.'},f.exec('explain_rewrite',{})),/changed/);
  await explain.execute({path:'cart.js',sha256:digest(before),reason:'The existing layout cannot represent the required checkout state.',validationPlan:'Run the full checkout and pricing regression suite after the rewrite.'},f.exec('explain_rewrite',{}));
  const allowed=f.exec('write',e.arguments);assert.equal((await f.call('tools/pre-execute',allowed,async()=>({kind:'allow'}))).kind,'allow');
  const denied=f.exec('write',e.arguments);assert.equal((await f.call('tools/pre-execute',denied,async()=>({kind:'allow'}))).kind,'deny');
});
test('small edits remain allowed and existing denial is never overridden',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.directory,'small.js'),'const total=1;');
  assert.equal((await f.call('tools/pre-execute',f.exec('write',{file_path:'small.js',content:'const total=2;'}),async()=>({kind:'allow'}))).kind,'allow');
  const denied={kind:'deny',reason:'original policy'};assert.equal(await f.call('tools/pre-execute',f.exec('write',{}),async()=>denied),denied);
});
test('log compaction preserves failure exit status, images and the immutable canonical result',async t=>{
  const f=await fixture(t),result=Object.freeze({isError:false,value:Object.freeze({exitCode:7,timedOut:false}),content:Object.freeze([{type:'text',text:'noise '.repeat(3000)},{type:'image',attachment:{id:'fixture'}}])});
  const e=f.exec('project_exec',{command:'npm test'}),r=await f.call('tools/post-execute',e,result,async()=>({kind:'accept'}));
  assert.match(r.content[0].text,/exitCode=7/);assert.equal(r.content[1],result.content[1]);assert.equal(result.value.exitCode,7);assert.equal(result.content[0].text.length,18000);
  const repeat=await f.call('tools/post-execute',e,result,async()=>({kind:'accept'}));assert.match(repeat.content[0].text,/Repeated identical/);assert.match(repeat.content[0].text,/exitCode=7/);
});
test('working summary is appended context; system policy and original messages are unchanged',async t=>{
  const f=await fixture(t),message={role:'user',source:{kind:'user'},content:[{type:'text',text:'Implement cart; preserve keyboard navigation.'}]},payload={agent:f.agent,messages:[message],modelSelection:{provider:'strata-vast'}};
  const decision={kind:'enter',messages:[message]};assert.equal(await f.call('agent/pre-step',payload,async()=>decision),decision);assert.equal(message.content[0].text,'Implement cart; preserve keyboard navigation.');
  const a=f.contexts[0].text({agent:f.agent});assert.match(a,/keyboard navigation/);assert.equal(f.contexts[0].text({agent:f.agent}),a);
  await f.call('agent/pre-step',payload,async()=>decision);assert.equal(f.reviewCalls(),1);assert.equal(typeof f.sections[0].text,'string');
});
test('actual streamed iterator completion owns release, including thrown provider and cancelled queue',async t=>{
  const f=await fixture(t),stream=f.hooks.get('llm/stream')[0];let finish;const hold=new Promise(r=>finish=r),options={provider:'strata-vast',sessionId:'A',messages:[],signal:new AbortController().signal};
  const a=stream.call({},options,async function*(){yield{type:'text-delta',text:'a'};await hold;yield{type:'finish',reason:{kind:'stop'}};});
  const ai=a[Symbol.asyncIterator]();await ai.next();let bStarted=false;
  const b=stream.call({},options,async function*(){bStarted=true;throw Error('provider failed');});
  const runB=(async()=>{for await(const _ of b){}})();await new Promise(r=>setImmediate(r));assert.equal(bStarted,false);
  finish();await ai.next();await ai.next();await assert.rejects(runB,/provider failed/);
  const c=stream.call({},options,async function*(){yield{type:'finish',reason:{kind:'stop'}};});for await(const _ of c){}
});
