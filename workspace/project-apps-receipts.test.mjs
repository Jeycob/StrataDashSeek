import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createProjectAppsReceiptStore} from './project-apps-receipts.mjs';
import {createAppsLifetime} from './project-apps-lifetime.mjs';
test('private receipts survive reload, bind exact identities, and retain unknown admission',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-apps-receipt-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=createProjectAppsReceiptStore(root),row={requestId:'a'.repeat(32),projectId:'b'.repeat(16),ownerId:'synthetic-owner',appsJobId:null,startedAt:1};
 await store.save(row);assert.deepEqual(await createProjectAppsReceiptStore(root).list(),[row]);
 await assert.rejects(store.save({...row,projectId:'c'.repeat(16)}));
 await store.save({...row,appsJobId:'d'.repeat(16)});assert.equal((await store.list())[0].appsJobId,'d'.repeat(16));
 await assert.rejects(store.save({...row,appsJobId:'e'.repeat(16)}));await store.remove(row.requestId);assert.deepEqual(await store.list(),[]);
 await fs.writeFile(path.join(root,'project-apps-admissions.json'),'malformed');await assert.rejects(store.list());
});
test('lifetime releases only before enqueue or on matching terminal job, never unknown/stale evidence',()=>{
 let releases=0;const lease=createAppsLifetime(()=>releases++);lease.attempted();lease.failed();assert.equal(releases,0);assert.equal(lease.snapshot().reconciliationRequired,true);
 lease.accepted('a'.repeat(16));assert.throws(()=>lease.terminal({id:'b'.repeat(16),terminal:true,status:'passed'}));assert.equal(releases,0);
 assert.throws(()=>lease.terminal({id:'a'.repeat(16),terminal:false,status:'running'}));
 for(const status of ['interrupted','recovery_required'])assert.throws(()=>lease.terminal({id:'a'.repeat(16),terminal:true,status,workSettled:true}));
 assert.throws(()=>lease.terminal({id:'a'.repeat(16),terminal:true,status:'passed',workSettled:false}));
 lease.terminal({id:'a'.repeat(16),terminal:true,status:'passed',workSettled:true});lease.terminal({id:'a'.repeat(16),terminal:true,status:'passed',workSettled:true});assert.equal(releases,1);
 const pre=createAppsLifetime(()=>releases++);pre.failed();pre.failed();assert.equal(releases,2);
});
