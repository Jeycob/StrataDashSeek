// Inert Native-shaped event tests only. No actual session or filesystem tool execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRootLifecycle} from './lifecycle.mjs';
const target={owned:true,sessionId:'own-session',workspaceId:'own-workspace',projectId:'own-project'};
const sourceCommit='a'.repeat(40),requestId='11111111-1111-4111-8111-111111111111';
const call=(name='working_directory')=>({seq:1,type:'tool/call',data:{callId:'own-call',name,arguments:JSON.stringify({cd:'/synthetic/own-project'})}});
const result=()=>({seq:2,type:'tool/result',data:{message:{role:'tool',toolCallId:'own-call',source:{kind:'tool',callId:'own-call'},isError:false,content:[{type:'text',text:'/synthetic/own-project'}]}}});
function fixture({rows=[],children=[],terminals=[],assertTarget=async()=>{}}={}){
 const native={target,jobsSnapshot:async()=>rows,followJob:async row=>row,killJob:async()=>{throw Error('Unexpected kill');},projections:async()=>({kind:'sequenced',asOfSeq:100,values:{subagentCatalog:children}}),terminals:async()=>terminals};
 const life=createRootLifecycle({target,sourceCommit},{native,assertTarget});
 life.bindIntent({identity:{...target,sourceCommit},operator:{requestId,baselineSeq:0}});
 return(events,extra={})=>life.observeWork({sessionId:target.sessionId,requestId,events,deadline:Date.now()+1000,...extra});
}
test('r4 exact working_directory call/result is an awaited effect, without QA or process-range claim',async()=>{
 const out=await fixture()([call(),result()]);assert.equal(out.settled,true);
 assert.deepEqual(out.evidence.toolProofs,[{callId:'own-call',name:'working_directory',resultSeq:2,kind:'reviewed-awaited-effect'}]);assert.equal(out.accepted,undefined);
});
test('missing working_directory result stays pending',async()=>{
 const out=await fixture()([call()]);assert.equal(out.settled,false);assert(out.evidence.unknown.includes('TOOL_RESULT_PENDING'));
});
test('foreign/mismatched tool-result source cannot complete the own working_directory call',async()=>{
 for(const mutate of [m=>m.source.callId='foreign',m=>m.toolCallId='foreign',m=>m.source.kind='message',m=>m.role='assistant']){
  const row=result();mutate(row.data.message);const out=await fixture()([call(),row]);assert.equal(out.settled,false);assert(out.evidence.unknown.includes('LIFECYCLE_RESULT_UNPAIRED'));
 }
});
test('foreign session or failed actual target attestation cannot reuse a matching working_directory pair',async()=>{
 assert.equal((await fixture()([call(),result()],{sessionId:'foreign'})).settled,false);
 const out=await fixture({assertTarget:async()=>{throw Object.assign(Error('changed'),{code:'SOURCE_CHANGED'});}})([call(),result()]);assert.equal(out.settled,false);assert(out.evidence.unknown.includes('SOURCE_CHANGED'));
});
test('working_directory completion cannot settle live jobs, child agents, PTYs, or unreviewed process tools',async()=>{
 for(const state of [{rows:[{id:'own-bash',owner:target.sessionId,kind:'bash',startedAt:1,status:'running'}]},{children:[{id:'child'}]},{terminals:[{id:'pty'}]}])assert.equal((await fixture(state)([call(),result()])).settled,false);
 for(const name of ['working_directory_extra','bash','project_exec','verify_project'])assert.equal((await fixture()([call(name),result()])).settled,false,name);
});
