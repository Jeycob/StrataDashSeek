import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {POLICY,rewriteRisk,summarizeLog,archiveLog,WorkCard,prefixFingerprint} from './context.mjs';
import {FairGate,normalizeCompaction} from './gate.mjs';
import {EventLedger,costReport,uniqueEngineRecord,intervalUnion} from './ledger.mjs';
import {focusContext} from './focus.mjs';
import {sampleBilling,billingWindows} from './billing-sample.mjs';
import {generateReport} from './report.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'efficiency-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}

test('focused changes pass while broad rewrites after a milestone are recognizable',()=>{
  const code=Array.from({length:100},(_,i)=>`const value${i}=${i};`).join('\n');
  assert.equal(rewriteRisk(code,code.replace('value50=50','value50=51')).large,false);
  assert.equal(rewriteRisk(code,Array.from({length:100},(_,i)=>`replacement ${i}`).join('\n')).large,true);
  assert.equal(rewriteRisk('x'.repeat(9000),'y'.repeat(9000)).large,true);
  assert.equal(rewriteRisk(code,code).large,false);
});
test('complete command logs are archived once and compact diagnostics retain failures',async t=>{
  const root=await temp(t),raw='build start\n'+'progress '.repeat(6000)+'\nError: missing lineTotal\n# pass 0\n# fail 1';
  const file=await archiveLog(root,raw),again=await archiveLog(root,raw);
  assert.equal(file,again);assert.equal(await fs.readFile(path.join(root,file),'utf8'),raw);
  const compact=summarizeLog(raw,file);assert.ok(compact.length<6001);assert.match(compact,/missing lineTotal/);assert.match(compact,/# fail 1/);
  assert.ok(summarizeLog(raw,file,{repeated:true}).length<2000);
  assert.equal(await archiveLog(root,'other',{maxFiles:1}),null);
});
test('work card changes only for semantic facts; complete verification clears old failures',()=>{
  const c=new WorkCard();c.setTask('Implement checkout and retain all original constraints');c.change('cart.ts');c.change('cart.ts');c.failure('test','invalid price','full.log');
  assert.equal(c.render(),c.render());assert.deepEqual(c.changes,['cart.ts']);
  c.verification({passed:true,complete:false},'one');assert.equal(c.verified,true);assert.equal(c.issues.size,1);
  c.verification({passed:true,complete:true},'two');assert.equal(c.issues.size,0);
});
test('prefix fingerprints ignore dynamic user context but detect system/schema changes',()=>{
  const a={messages:[{role:'system',content:[{type:'text',text:POLICY}]},{role:'user',content:[{type:'text',text:'taskA'}]}],tools:[{name:'read',parameters:{type:'object'}}]};
  const b=structuredClone(a);b.messages[1].content[0].text='taskB';assert.equal(prefixFingerprint(a).systemHash,prefixFingerprint(b).systemHash);
  b.tools[0].description='changed';assert.notEqual(prefixFingerprint(a).toolHash,prefixFingerprint(b).toolHash);
});
test('context excerpts are bounded and confined, with a current file hash',async t=>{
  const root=await temp(t);await fs.writeFile(path.join(root,'cart.mjs'),Array.from({length:200},(_,i)=>`line${i+1}`).join('\n'));
  const r=await focusContext(root,{files:[{path:'cart.mjs',start:100,lines:3}]});assert.match(r.excerpts[0].content,/100: line100/);assert.equal(r.excerpts[0].sha256.length,64);assert.equal(r.excerpts[0].totalLines,200);
  await assert.rejects(focusContext(root,{files:[{path:'../escape'}]}));
});
test('one inference stream at a time; waiting request runs while previous task does tools',async()=>{
  const q=new FairGate(),a=await q.acquire({rootId:'A'});let admitted=false;
  const b=q.acquire({rootId:'B'}).then(p=>{admitted=true;return p;});await tick();assert.equal(admitted,false);
  // A finishes inference, remains in a tool; B can now use the GPU.
  a.release();const pb=await b;assert.equal(admitted,true);assert.equal(q.active.size,1);pb.release();assert.equal(q.active.size,0);
});
test('FIFO cancellation never releases an active stream early and cleanup is idempotent',async()=>{
  const q=new FairGate(),c=new AbortController(),a=await q.acquire({rootId:'A',signal:c.signal});
  const waiting=new AbortController(),b=q.acquire({rootId:'B',signal:waiting.signal});waiting.abort(Error('waiting cancelled'));await assert.rejects(b,/cancelled/);
  c.abort();assert.equal(q.active.size,1);a.release();a.release();assert.equal(q.active.size,0);
  q.close();await assert.rejects(q.acquire({rootId:'C'}),/unloaded/);
});
test('heavy tool capacity bounds resource contention without serializing every read',async()=>{
  const q=new FairGate({capacity:2}),a=await q.acquire({rootId:'A'}),b=await q.acquire({rootId:'B'});assert.equal(q.active.size,2);
  let started=false;const c=q.acquire({rootId:'C'}).then(p=>(started=true,p));await tick();assert.equal(started,false);a.release();(await c).release();b.release();
});
test('compaction retains the existing bounded nonreasoning policy without recursion',()=>{
  const r=normalizeCompaction({purpose:'compaction',reasoningEffort:'medium',maxTokens:1000,messages:[]});assert.equal(r.reasoningEffort,'off');assert.equal(r.maxTokens,8192);assert.equal(normalizeCompaction(r),null);
  assert.equal(normalizeCompaction({reasoningEffort:'medium'}),null);
});
test('engine metrics require one unambiguous new record and preserve unknown values',()=>{
  const before={requests:[{id:'old'}]},r=uniqueEngineRecord(before,{requests:[{id:'old'},{id:'new',prompt_tokens:100,reused:80,prompt_ms:2,decode_ms:3,output_tokens:5}]});assert.equal(r.reusedTokens,80);
  assert.equal(uniqueEngineRecord(before,{requests:[{id:'a'},{id:'b'}]}),null);
  assert.equal(uniqueEngineRecord(before,{requests:[{id:'n'}]}).prefillMs,null);
});
const bill=[{from:0,to:3600000,computeUsdPerHour:1,storageUsdPerHour:.2,source:'synthetic fixture'}];
test('shared billing is allocated exactly once including failed attempts and idle time',()=>{
  const e=[{id:'1',at:0,type:'turn-start',taskId:'A',runId:'A1'},{id:'2',at:900000,type:'turn-start',taskId:'B',runId:'B1'},{id:'3',at:1800000,type:'turn-end',taskId:'A',runId:'A1'},{id:'4',at:2700000,type:'turn-end',taskId:'B',runId:'B1'},{id:'5',at:2700000,type:'accepted',taskId:'B',runId:'B1'}];
  const r=costReport(e,bill,{from:0,to:3600000});assert.ok(Math.abs(r.knownCostUsd-1.2)<1e-9);assert.ok(Math.abs(r.unattributedCostUsd-.3)<1e-9);
  assert.ok(Math.abs(r.tasks.reduce((n,t)=>n+t.costUsd,0)+r.unattributedCostUsd-r.knownCostUsd)<1e-9);assert.equal(r.costPerAcceptedTaskUsd,1.2);
});
test('retries count toward the same task; stale or new work invalidates acceptance',()=>{
  const e=[{id:'1',at:0,type:'turn-start',taskId:'A',runId:'1'},{id:'2',at:100,type:'turn-end',taskId:'A',runId:'1'},{id:'3',at:101,type:'turn-start',taskId:'A',runId:'2'},{id:'4',at:200,type:'turn-end',taskId:'A',runId:'2'},{id:'5',at:200,type:'accepted',taskId:'A',runId:'2'}];
  const r=costReport(e,bill,{from:0,to:300});assert.equal(r.tasks[0].attempts,2);assert.equal(r.acceptedTasks,1);
  assert.equal(costReport([...e,{id:'6',at:201,type:'source-changed',taskId:'A'}],bill,{from:0,to:300}).acceptedTasks,0);
  assert.equal(costReport([...e,{id:'7',at:301,type:'source-changed',taskId:'A'}],bill,{from:0,to:300}).acceptedTasks,1);
});
test('unknown price windows are explicit and never become zero-cost success',()=>{
  const r=costReport([{id:'1',at:0,type:'turn-start',taskId:'A',runId:'1'},{id:'2',at:100,type:'accepted',taskId:'A',runId:'1'}],[],{from:0,to:200});assert.equal(r.unknownCostMs,200);assert.equal(r.costPerAcceptedTaskUsd,null);
  assert.throws(()=>costReport([], [...bill,...bill],{from:0,to:10}),/nonoverlapping/);
});
test('phase overlap and duplicate journal records do not inflate elapsed time',()=>{
  assert.equal(intervalUnion([[0,10],[5,20],[30,40]]),30);
  const event={id:'1',type:'phase',taskId:'A',at:20,phase:'tools',start:0,end:20};const r=costReport([event,event],bill,{from:0,to:30});assert.equal(r.tasks[0].phases.toolsMs,20);
});
test('billing sampler never exposes credentials or double counts storage',async t=>{
  const dir=await temp(t),keyFile=path.join(dir,'key');await fs.writeFile(keyFile,'private-fixture-key');
  const r=await sampleBilling({instanceId:42,keyFile,now:()=>10,fetcher:async(_url,options)=>{assert.equal(options.headers.Authorization,'Bearer private-fixture-key');return{ok:true,json:async()=>({instances:{id:42,actual_status:'running',dph_total:.12,storage_total_cost:.02}})};}});
  assert.ok(Math.abs(r.computeUsdPerHour-.1)<1e-9);assert.doesNotMatch(JSON.stringify(r),/private-fixture/);
  assert.equal(billingWindows([r,{...r,at:20}]).length,1);assert.equal(billingWindows([r,{...r,at:20,status:'stopped'}]).length,0);
});
test('journal capacity and corrupt trailing lines make reports explicitly incomplete',async t=>{
  const dir=await temp(t),file=path.join(dir,'events.jsonl'),ledger=new EventLedger(file,{clock:()=>1,maxBytes:250});ledger.record('turn-start',{taskId:'A',runId:'A1'});assert.throws(()=>ledger.record('x',{data:'x'.repeat(500)}),/capacity/);
  const report=await generateReport({eventsFile:file,from:0,to:10});assert.equal(report.measurementComplete,false);assert.equal(report.costPerAcceptedTaskUsd,null);
});
