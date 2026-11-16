import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {registryBarrier} from './docker-cleanup.mjs';

// Qualification test: use the installed, pinned SDK rather than a fake queue.
test('pinned rc.2 SDK registry queue serializes cleanup and resumes after a rejected mutation',async()=>{
 const require=createRequire(path.join(process.env.HOMEAI_RUNTIME||'/data/harness/runtime','package.json'));
 assert.equal(require('@deepseek-ai/dsh-workspace/package.json').version,'0.2.2-rc.2');
 const {WorkspaceRegistry}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-workspace')).href);
 const registry=Object.create(WorkspaceRegistry.prototype);
 registry.state={workspaceIds:[]};registry.operationTail=Promise.resolve();
 let operation=null,release,entered;const started=new Promise(r=>entered=r),events=[];
 const barrier=registryBarrier(registry,async()=>operation);
 try{
  const cleanup=barrier.run(async()=>{events.push('cleanup');entered();await new Promise(r=>release=r);operation={state:'reconciliation_required'};});
  await started;const mutation=registry.enqueueOperation(async()=>events.push('mutation'));
  release();await cleanup;await assert.rejects(mutation,/CLEANUP_RECONCILIATION_REQUIRED/);
  assert.deepEqual(events,['cleanup']);operation={state:'completed'};
  await registry.enqueueOperation(async()=>events.push('mutation'));
  assert.deepEqual(events,['cleanup','mutation']);
 }finally{barrier.dispose();}
});
