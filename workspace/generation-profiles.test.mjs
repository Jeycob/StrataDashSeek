import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {WorkspaceManager} from './manager.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import {createGenerationProfiles,installGenerationProfiles,generationControls,freezeGenerationSettings} from './generation-profiles.mjs';
import {profileComparisons} from './profile-comparisons.mjs';
const {normalizePayload,requestControls}=createRequire(import.meta.url)('../vast/model-proxy.cjs');
const sampling={maxTokens:2048,thinkingBudget:512,temperature:.4,topP:.8};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-profiles-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sessions=new Map(['one','two'].map(id=>[id,{id,header:{cwd:root}}])),workspace={id:'w1',sessionIds:['one','two']};let provider='strata-vast';
 const ctx={workspaceRegistry:{list:()=>[workspace]},agents:{get:()=>({model:{current:()=>({provider,model:'strata'})}})}};
 const manager=new WorkspaceManager(ctx,{stateRoot:root},hostExecutionBinding());manager.data={workspaces:{},sessions:{}};manager.projectFor=async id=>{const live=sessions.get(id);if(!live)throw Error('SESSION_NOT_FOUND');return{header:live.header,live};};
 const api=createGenerationProfiles(ctx,manager,{readHistory:()=>({version:1,runs:[]})});return{manager,api,sessions,root,provider:value=>provider=value};
}
test('saved profile applies through real settings and proxy controls, persists, and keeps other sessions and in-flight snapshots unchanged',async t=>{
 const f=await fixture(t),before=f.manager.settings(f.sessions.get('one'));f.manager.frozenSettings.set('one',{...before});
 const saved=await f.api.mutate('one',{op:'save',name:'Small context output',sampling,expectedQuantization:'requested-IQ3'}),id=saved.profiles[0].id;
 assert.deepEqual(saved.effectiveSampling,{maxTokens:32768,thinkingBudget:4096,temperature:1,topP:.95});
 await f.api.mutate('one',{op:'select',id});const next=f.manager.settings(f.sessions.get('one'));
 assert.equal(next.temperature,.4);assert.equal(f.manager.settings(f.sessions.get('two')).temperature,1);assert.deepEqual(f.manager.frozenSettings.get('one'),before);
 const payload=normalizePayload({max_tokens:32000,reasoning_effort:'medium'},requestControls(Buffer.from(JSON.stringify(generationControls(next))).toString('base64url')));
 assert.equal(payload.max_tokens,2048);assert.equal(payload.temperature,.4);assert.equal(payload.top_p,.8);assert.equal(payload.thinking_budget_tokens,512);
 const actual=f.manager.ownerAgent;f.manager.ownerAgent=agent=>agent;const frozen=freezeGenerationSettings(f.manager,{session:f.sessions.get('one')});f.manager.ownerAgent=actual;
 const high=normalizePayload({reasoning_effort:'high'},generationControls(frozen));assert.equal(high.thinking_budget_tokens,512,'a saved sampling budget follows the current model effort, even when workspace effort differs');
 const off=normalizePayload({reasoning_effort:'off'},generationControls(frozen));assert.equal(off.thinking_budget_tokens,undefined,'a profile never enables thinking against the selected off mode');
 f.manager.data=JSON.parse(await fs.readFile(f.manager.file,'utf8'));assert.deepEqual((await f.api.inspect('one')).effectiveSampling,sampling);
 await f.api.mutate('one',{op:'save',id,name:'Edited profile',sampling:{...sampling,temperature:.7}});assert.equal(f.manager.settings(f.sessions.get('one')).temperature,.4,'editing a saved profile does not retroactively reconfigure selected snapshots');
 await f.api.mutate('one',{op:'select',id});assert.equal(f.manager.settings(f.sessions.get('one')).temperature,.7);
 await f.api.mutate('one',{op:'select',id:null});assert.equal(f.manager.settings(f.sessions.get('one')).temperature,1);
});
test('invalid controls, cross-workspace selection, non-Strata routes and failed persistence do not change effective controls',async t=>{
 const f=await fixture(t);await assert.rejects(f.api.mutate('one',{op:'save',name:'Bad',sampling:{...sampling,topP:2}}),{code:'INVALID_SETTINGS'});
 const saved=await f.api.mutate('one',{op:'save',name:'Saved',sampling}),id=saved.profiles[0].id;
 f.provider('cloud');await assert.rejects(f.api.mutate('one',{op:'select',id}),{code:'STRATA_SELECTION_REQUIRED'});f.provider('strata-vast');
 f.manager.data.generationProfiles.profiles[id].workspaceId='other';await assert.rejects(f.api.mutate('one',{op:'select',id}),{code:'PROFILE_NOT_FOUND'});f.manager.data.generationProfiles.profiles[id].workspaceId='w1';
 f.manager.save=async()=>{throw Error('disk full');};await assert.rejects(f.api.mutate('one',{op:'select',id}),/disk full/);assert.equal(f.manager.settings(f.sessions.get('one')).temperature,1);
});
test('profile endpoint refuses foreign-origin writes and oversized payloads before persistence',async t=>{
 const f=await fixture(t);let route;const ctx={...f.manager.ctx,effect:action=>action(),connection:{fetch:{register:value=>{route=value;}}}};
 installGenerationProfiles(ctx,f.manager);
 const request=(body,origin='https://owner.example')=>new Request('http://dsh.internal/api/workbench/model-profiles',{method:'POST',headers:{host:'owner.example',origin,'content-type':'application/json'},body});
 assert.equal((await route.fetch(request(JSON.stringify({sessionId:'one',op:'save',name:'Valid',sampling}),'https://foreign.example'))).status,403);
 assert.equal((await route.fetch(request(' '.repeat(8193)))).status,413);assert.equal(f.manager.data.generationProfiles,undefined);
 const result=await route.fetch(request(JSON.stringify({sessionId:'one',op:'save',name:'Valid',sampling})));assert.equal(result.status,200);assert.equal((await result.json()).profiles.length,1);
});
const digest='a'.repeat(64),comparison={definition:'benchmarks/roadmap-16-smoke/README.md',promptSha256:digest,inputSha256:digest,acceptanceSha256:digest,runtimeCommit:'b'.repeat(40),budgetSha256:digest,cacheCondition:'cold',contextTokens:131072};
function run(arm){return{id:'run-'+arm,pairId:'pair',arm,workspaceId:'w1',profileName:arm,epoch:'same-runtime',comparison:{...comparison},submittedAt:1000,finishedAt:4000,requestedQuantization:'requested-only',acceptance:{passed:true,at:arm==='A'?3000:3500,evidenceId:'qa-'+arm},serving:{epoch:'same-runtime',observedAt:2000,evidenceId:'model-'+arm,provider:'strata-vast',model:'observed-model',quantization:'IQ3',configurationSha256:digest},memory:{epoch:'same-runtime',observedAt:2500,evidenceId:'memory-'+arm,kind:'sample',rssBytes:1024,vramBytes:0}};}
test('historical comparison needs the same frozen input and measured provenance; zero, unknown, failed and mismatched runs remain distinct',()=>{
 const a=run('A'),b=run('B'),project=()=>profileComparisons({version:1,runs:[a,b]},'w1').pairs[0];
 assert.equal(project().acceptedDeltaMs,500);assert.equal(project().quantizationComparable,true);assert.equal(project().rows[1].memory.vramBytes,0);assert.equal(profileComparisons({version:1,runs:[a,b]},'other').pairs.length,0);
 delete b.serving.configurationSha256;b.memory.epoch='different-runtime';b.acceptance={passed:false,evidenceId:'failed-check'};const partial=project();assert.equal(partial.quantizationComparable,false);assert.equal(partial.rows[1].serving.quantization,null);assert.equal(partial.rows[1].memory,null);assert.equal(partial.rows[1].accepted,false);assert.equal(partial.acceptedDeltaMs,null);
 b.comparison.promptSha256='c'.repeat(64);assert.equal(project().sameInput,false);
 b.comparison={...comparison};b.comparison.cacheCondition='warm';assert.equal(project().sameInput,false);
 b.comparison={...comparison};b.serving.observedAt=5000;assert.equal(project().rows[1].serving,null);
 delete b.acceptance;assert.equal(project().rows[1].accepted,null);
});
