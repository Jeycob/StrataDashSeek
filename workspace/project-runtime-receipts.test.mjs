import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createProjectRuntimeReceiptStore, reconcileProjectRuntimeReceipts } from './project-runtime-receipts.mjs';
const sample=(generation='a'.repeat(32),kind='executor')=>({kind,sessionId:'owner',accessSessionId:'child',generation,stopToken:'s'.repeat(43),startedAt:1,operationId:null,jobId:null});
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-runtime-receipts-')),store=createProjectRuntimeReceiptStore(root),directory=path.join(root,'project-runtime-private'),file=path.join(directory,'pending.json');
 t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('homeai-runtime-receipts-'));await fs.rm(real,{recursive:true,force:true});});
 return{root,store,directory,file};
}
const stopped=data=>({version:1,state:'stopped',sessionId:data.sessionId,generation:data.generation,operationId:'c'.repeat(32)});

test('editor and executor share one private durable store with immutable capability bindings',async t=>{
 const f=await fixture(t),row=sample();assert.equal(createProjectRuntimeReceiptStore(f.root),f.store);
 const release=f.store.claim(row.generation);assert(f.store.isLive(row.generation));assert.throws(()=>f.store.claim(row.generation),{code:'PROJECT_RUNTIME_RECEIPT_ALREADY_OWNED'});
 await f.store.save(row);assert.deepEqual(await f.store.list(),[row]);
 if(process.platform!=='win32'){assert.equal((await fs.stat(f.directory)).mode&0o777,0o700);assert.equal((await fs.stat(f.file)).mode&0o777,0o600);}
 for(const changed of [{stopToken:'x'.repeat(43)},{accessSessionId:'other'},{kind:'editor'},{startedAt:2}])await assert.rejects(f.store.save({...row,...changed}),{code:'PROJECT_RUNTIME_RECEIPT_MISMATCH'});
 const known={...row,operationId:'b'.repeat(32),jobId:'c'.repeat(16)};await f.store.save(known);await assert.rejects(f.store.save(row),{code:'PROJECT_RUNTIME_RECEIPT_MISMATCH'});
 release();assert(!f.store.isLive(row.generation));await f.store.remove(row.generation);assert.deepEqual(await f.store.list(),[]);
});

test('a real producer exit leaves a durable orphan with no restored live claim',async t=>{
 const f=await fixture(t),row=sample(),source=`import {createProjectRuntimeReceiptStore} from ${JSON.stringify(new URL('./project-runtime-receipts.mjs',import.meta.url).href)};const store=createProjectRuntimeReceiptStore(process.argv[1]);const row=JSON.parse(process.argv[2]);store.claim(row.generation);await store.save(row);process.exit(0);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,f.root,JSON.stringify(row)],{stdio:['ignore','ignore','pipe'],windowsHide:true});let stderr='';child.stderr.on('data',b=>stderr+=b);await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr)));});
 assert.deepEqual(await f.store.list(),[row]);assert.equal(f.store.isLive(row.generation),false);
 let calls=0;const result=await reconcileProjectRuntimeReceipts(f.store,{callApps:async(route,data)=>{calls++;assert.equal(route,'/project-runtime');assert.equal(data.op,'stop');assert.equal(data.stopToken,row.stopToken);return stopped(data);}});
 assert.equal(calls,1);assert.equal(result.reconciliationRequired,false);assert.deepEqual(await f.store.list(),[]);
});

test('unknown or mismatched stop remains durable while a live editor is skipped',async t=>{
 const f=await fixture(t),executor={...sample(),operationId:'c'.repeat(32)},editor=sample('b'.repeat(32),'editor');await f.store.save(executor);await f.store.save(editor);const release=f.store.claim(editor.generation);let calls=0;
 const bad=await reconcileProjectRuntimeReceipts(f.store,{callApps:async(_route,data)=>{calls++;return{...stopped(data),operationId:'d'.repeat(32)};}});assert.equal(calls,1);assert.equal(bad.reconciliationRequired,true);assert(!JSON.stringify(bad).includes(executor.stopToken));assert.equal((await f.store.list()).length,2);
 const good=await reconcileProjectRuntimeReceipts(f.store,{callApps:async(_route,data)=>stopped(data)});assert.equal(good.reconciliationRequired,false);assert.equal(good.pending.length,1);assert.equal(good.pending[0].liveOwned,true);
 release();const final=await reconcileProjectRuntimeReceipts(f.store,{callApps:async(_route,data)=>stopped(data)});assert.equal(final.pending.length,0);
});

test('bounded reconciliation never retries execution or drops unknown records',async t=>{
 const f=await fixture(t);for(let n=0;n<34;n++)await f.store.save(sample(n.toString(16).padStart(32,'0')));let calls=0;
 const result=await reconcileProjectRuntimeReceipts(f.store,{callApps:async(_route,data)=>{calls++;assert.equal(data.op,'stop');throw Error('SYNTHETIC_UNAVAILABLE');}});assert.equal(result.checked,32);assert.equal(calls,32);assert.equal(result.pending.length,34);assert.equal(result.reconciliationRequired,true);
 const abort=new AbortController();abort.abort();await assert.rejects(reconcileProjectRuntimeReceipts(f.store,{signal:abort.signal,callApps:()=>assert.fail('aborted reconcile dispatched')}));
});

test('a second admission check cannot mistake in-flight orphan reconciliation for a live owned process',async t=>{
 const f=await fixture(t),row=sample();await f.store.save(row);let releaseStop,entered;const started=new Promise(r=>entered=r);let calls=0;
 const callApps=async()=>{calls++;entered();return new Promise(r=>releaseStop=r);};const first=reconcileProjectRuntimeReceipts(f.store,{callApps});await started;
 assert.equal(f.store.isLive(row.generation),false);
 const second=await reconcileProjectRuntimeReceipts(f.store,{callApps});assert.equal(second.reconciliationRequired,true);assert.equal(second.pending[0].liveOwned,false);assert.equal(calls,1);
 releaseStop({version:1,state:'unknown'});assert.equal((await first).reconciliationRequired,true);assert.equal((await f.store.list()).length,1);
 const confirmed=await reconcileProjectRuntimeReceipts(f.store,{callApps:async(_route,data)=>stopped(data)});assert.equal(confirmed.reconciliationRequired,false);
});

test('private receipt aliases and writable permissions are refused',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);await f.store.save(sample());const alias=path.join(f.root,'alias');await fs.link(f.file,alias);await assert.rejects(f.store.list(),{code:'PROJECT_RUNTIME_RECEIPT_INVALID'});await fs.unlink(alias);
 await fs.chmod(f.file,0o644);await assert.rejects(f.store.list(),{code:'PROJECT_RUNTIME_RECEIPT_INVALID'});await fs.chmod(f.file,0o600);
 await fs.rename(f.file,alias);await fs.symlink(alias,f.file);await assert.rejects(f.store.list(),{code:'PROJECT_RUNTIME_RECEIPT_UNAVAILABLE'});await fs.unlink(f.file);await fs.rename(alias,f.file);
 await fs.chmod(f.directory,0o755);await assert.rejects(f.store.list(),{code:'PROJECT_RUNTIME_RECEIPT_ROOT_INVALID'});await fs.chmod(f.directory,0o700);
});
