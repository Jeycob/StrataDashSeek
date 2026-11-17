import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { acquireProcessLock } from './process-lock.mjs';
import {bindProjectExecution} from './execution-mode.mjs';
const { atomicJson } = createRequire(import.meta.url)('../mobile/private-json.cjs');
const stores = new Map(), id = /^[A-Za-z0-9_-]{1,128}$/, hex32 = /^[a-f0-9]{32}$/;
const keys = ['kind','sessionId','accessSessionId','generation','stopToken','startedAt','operationId','jobId'];
const fail = code => Object.assign(Error(code), { code });
function valid(row) {
  return row && typeof row === 'object' && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row,key)) && ['executor','editor'].includes(row.kind) && id.test(row.sessionId ?? '') && id.test(row.accessSessionId ?? '') && hex32.test(row.generation ?? '') && /^[A-Za-z0-9_-]{43}$/.test(row.stopToken ?? '') && Number.isSafeInteger(row.startedAt) && row.startedAt >= 0 && (row.operationId === null || hex32.test(row.operationId ?? '')) && (row.jobId === null || /^[a-f0-9]{16}$/.test(row.jobId ?? ''));
}
// Private cancellation capabilities, never a model/UI DTO or a second job
// registry. Atomic fsync precedes RPC; one shared queue and OS lock protect
// editor/executor writers. Live claims are deliberately NOT restored on boot.
export function createProjectRuntimeReceiptStore(privateRoot,{assertActive=()=>{},executionBinding}={}) {
  if (typeof privateRoot !== 'string' || !path.isAbsolute(privateRoot)) throw fail('PROJECT_RUNTIME_RECEIPT_ROOT_INVALID');
  const root = path.resolve(privateRoot), directory = path.join(root,'project-runtime-private'), file = path.join(directory,'pending.json');
  const bound=executionBinding?bindProjectExecution(executionBinding):null,identity=bound?JSON.stringify(bound.snapshot):null;
  if(bound)assertActive=()=>bound.assertUnchanged();
  if (stores.has(file)) {
    const entry=stores.get(file);
    if(identity!==entry.identity)throw fail('PROJECT_RUNTIME_RECEIPT_BINDING_CHANGED');
    // Same immutable root launch may reload its service/provider. Keep the
    // queue/live claims, but replace the closed old provider's guard.
    if(bound)entry.assertActive=assertActive;
    return entry.store;
  }
  const entry={identity,assertActive,store:null};
  let queue = Promise.resolve(); const live = new Map();
  async function safeDirectory() {
    const parent = await fs.lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink() || await fs.realpath(root) !== root || process.platform !== 'win32' && (parent.uid !== process.getuid() || parent.mode & 0o022)) throw fail('PROJECT_RUNTIME_RECEIPT_ROOT_INVALID');
    await fs.mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory || process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)) throw fail('PROJECT_RUNTIME_RECEIPT_ROOT_INVALID');
  }
  async function read() {
    await safeDirectory(); let handle;
    try {
      try { handle = await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw fail('PROJECT_RUNTIME_RECEIPT_UNAVAILABLE'); }
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024*1024 || process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)) throw fail('PROJECT_RUNTIME_RECEIPT_INVALID');
      const bytes = Buffer.alloc(info.size+1), { bytesRead } = await handle.read(bytes,0,bytes.length,0);
      const current = await fs.lstat(file);
      if (bytesRead !== info.size || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw fail('PROJECT_RUNTIME_RECEIPT_CHANGED');
      let value; try { value = JSON.parse(bytes.subarray(0,bytesRead).toString()); } catch { throw fail('PROJECT_RUNTIME_RECEIPT_INVALID'); }
      if (value?.version !== 1 || !Array.isArray(value.pending) || value.pending.length > 1024 || !value.pending.every(valid) || new Set(value.pending.map(row=>row.generation)).size !== value.pending.length) throw fail('PROJECT_RUNTIME_RECEIPT_INVALID');
      return value.pending;
    } finally { await handle?.close(); }
  }
  function mutate(action,guard=false) {
    const result = queue.then(async()=>{
      await safeDirectory(); const lock = await acquireProcessLock(path.join(directory,'writer.lock'));
      try { const rows = action(await read()); if (rows.length > 1024) throw fail('PROJECT_RUNTIME_RECEIPT_LIMIT');if(guard)entry.assertActive();atomicJson(file,{version:1,pending:rows}); }
      finally { await lock.release(); }
    }); queue = result.catch(()=>{}); return result;
  }
  const store = {
    list:()=>queue.then(read),
    save(row) {
      if (!valid(row)) return Promise.reject(fail('PROJECT_RUNTIME_RECEIPT_INVALID')); const copy = {...row};
      return mutate(rows=>{const prior=rows.find(item=>item.generation===copy.generation);if(prior && keys.some(key=>['operationId','jobId'].includes(key) ? prior[key]!==null && prior[key]!==copy[key] : prior[key]!==copy[key]))throw fail('PROJECT_RUNTIME_RECEIPT_MISMATCH');return[...rows.filter(item=>item.generation!==copy.generation),copy];},true);
    },
    remove(generation) { if(!hex32.test(generation ?? ''))return Promise.reject(fail('PROJECT_RUNTIME_RECEIPT_INVALID'));return mutate(rows=>rows.filter(row=>row.generation!==generation)); },
    claim(generation,{reconciling=false}={}) { if(!hex32.test(generation ?? '') || live.has(generation))throw fail('PROJECT_RUNTIME_RECEIPT_ALREADY_OWNED');const identity={reconciling};live.set(generation,identity);return()=>{if(live.get(generation)===identity)live.delete(generation);}; },
    isLive:generation=>live.has(generation)&&live.get(generation).reconciling!==true,
  };
  entry.store=store;stores.set(file,entry);return store;
}

export async function reconcileProjectRuntimeReceipts(store, { callApps, appsConfig, signal } = {}) {
  if (!store || typeof callApps !== 'function') throw fail('PROJECT_RUNTIME_RECEIPT_UNAVAILABLE');
  signal?.throwIfAborted(); const deadline = Date.now()+8000; let checked = 0;
  for (const row of await store.list()) {
    if (store.isLive(row.generation)) continue;
    if (checked >= 32 || Date.now() >= deadline || signal?.aborted) break;
    // Claim synchronously before any await so reopen/launch cannot take this
    // generation while reconciliation is stopping its historical capability.
    let release;
    try { release = store.claim(row.generation,{reconciling:true}); }
    catch (error) { if(error.code==='PROJECT_RUNTIME_RECEIPT_ALREADY_OWNED')continue;throw error; }
    checked++;
    try {
      const bounded = AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())));
      const value = await callApps('/project-runtime',{op:'stop',sessionId:row.sessionId,generation:row.generation,stopToken:row.stopToken},{...appsConfig,timeoutMs:5000,signal:signal?AbortSignal.any([signal,bounded]):bounded});
      if (value?.version !== 1 || value.state !== 'stopped' || value.sessionId !== row.sessionId || value.generation !== row.generation || !hex32.test(value.operationId ?? '') || row.operationId !== null && value.operationId !== row.operationId) throw fail('PROJECT_RUNTIME_STOP_UNVERIFIED');
      await store.remove(row.generation);
    } catch { /* Unknown outcomes remain durable and block new heavy work. */ }
    finally { release(); }
  }
  signal?.throwIfAborted();
  const pending = (await store.list()).map(row=>({kind:row.kind,sessionId:row.sessionId,accessSessionId:row.accessSessionId,generation:row.generation,startedAt:row.startedAt,liveOwned:store.isLive(row.generation)}));
  return {version:1,checked,pending,reconciliationRequired:pending.some(row=>!row.liveOwned)};
}
