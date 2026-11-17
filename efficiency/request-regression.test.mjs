import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkCard} from './context.mjs';
import {apply} from './plugin.mjs';
import {createHash} from 'node:crypto';
import {createProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
function hostMode(){const policy={version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)},policySha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'),snapshot={...policy,policySha256,sourceCommit:'a'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'};return createProjectExecutionMode({snapshot,assertUnchanged:()=>snapshot}).service;}
const user=(id,text)=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text}]});
const original='Build the accessible inventory app.\n'+'Keep every requirement. '.repeat(300)+'\nFINAL REQUIREMENT: preserve CSV export.';
const correction='Keep the original goal.\n'+'Additional correction detail. '.repeat(100)+'\nFINAL CORRECTION: use decimal arithmetic.';

test('long objective and exact latest correction remain distinct, including repeated steps and an explicit return to the original request',()=>{
 const card=new WorkCard(),first=user('one',original),last=user('two',correction);
 card.observeMessages([first]);assert.equal(card.snapshot().task,original);assert.equal(card.snapshot().latestRequest,original);
 card.observeMessages([first,last]);card.observeMessages([first,last]);assert.equal(card.snapshot().task,original);assert.equal(card.snapshot().latestRequest,correction);assert.equal(card.snapshot().latestRequestId,'two');
 card.observeMessages([first]);assert.equal(card.snapshot().latestRequest,correction,'an older retained surface message must not replace the canonical latest request');
 card.observeMessages([{...user('internal','Wrong task'),source:{kind:'workspace-runtime'}},{...last,role:'assistant'}]);assert.equal(card.snapshot().latestRequest,correction);
 card.observeMessages([user('three',original)]);assert.equal(card.snapshot().latestRequest,original);assert.equal(card.snapshot().latestRequestId,'three');
});

test('resume recovers original and latest request from canonical history after compaction; child assignments cannot replace them',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'request-regression-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root={id:'root',session:{id:'root',header:{}}},child={id:'child',session:{id:'child',header:{origin:'subagent',parentSession:'root'}}},hooks=new Map(),contexts=[],effects=[];let reads=0;
 const ctx={agents:{get:id=>id==='root'?root:child},sessionQuery:{async readSession(id){reads++;assert.equal(id,'root');return{events:[{type:'user/message',data:user('one',original)},{type:'agent/inbox/spliced',data:{inserted:[user('two',correction)]}}]};}},systemPrompt:{section(){},context:v=>contexts.push(v)},on:(key,fn)=>hooks.set(key,fn),effect:fn=>effects.push(fn()),tools:{guard(){},register(){}},shell:{},shellEnv:{},waterfall:async()=>({root:directory})};
 ctx.projectExecutionMode=hostMode();
 await apply(ctx,{stateDirectory:directory,engineMetrics:false});t.after(()=>effects.forEach(fn=>fn?.()));
 const step=(agent,messages)=>hooks.get('agent/pre-step')({agent,messages,modelSelection:{provider:'strata-vast'}},async()=>({kind:'enter',messages}));
 await step(root,[{...user('summary','Short generated handoff'),source:{kind:'compaction'}}]);await step(child,[user('child-task','Investigate a small subtask')]);
 const snapshot=JSON.parse(contexts[0].text({agent:root}).split('\n').slice(1).join('\n'));
 assert.equal(snapshot.task,original);assert.equal(snapshot.latestRequest,correction);assert.equal(reads,1);
});
