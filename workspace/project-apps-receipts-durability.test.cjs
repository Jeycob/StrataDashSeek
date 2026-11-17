'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('actual receipt persist fsyncs temporary file before rename and parent directory after rename',{skip:process.platform!=='linux'},async t=>{
 const {createProjectAppsReceiptStore}=await import('./project-apps-receipts.mjs');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'homeai-receipt-fsync-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const events=[],sync=fs.fsyncSync,rename=fs.renameSync;fs.fsyncSync=function(fd){events.push(fs.fstatSync(fd).isDirectory()?'fsync-directory':'fsync-file');return sync.call(this,fd);};fs.renameSync=function(...args){events.push('rename');return rename.apply(this,args);};
 try{await createProjectAppsReceiptStore(root).save({requestId:'a'.repeat(32),ownerId:'synthetic',projectId:'b'.repeat(16),appsJobId:null,startedAt:1});}finally{fs.fsyncSync=sync;fs.renameSync=rename;}
 assert.deepEqual(events,['fsync-file','rename','fsync-directory']);
});
test('failed file fsync rejects receipt before rename; failed directory fsync also rejects acknowledgement',{skip:process.platform!=='linux'},async t=>{
 const {createProjectAppsReceiptStore}=await import('./project-apps-receipts.mjs');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'homeai-receipt-fault-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const store=createProjectAppsReceiptStore(root),row={requestId:'a'.repeat(32),ownerId:'synthetic',projectId:'b'.repeat(16),appsJobId:null,startedAt:1},sync=fs.fsyncSync;
 fs.fsyncSync=function(fd){if(fs.fstatSync(fd).isFile())throw Error('synthetic fsync failure');return sync.call(this,fd);};try{await assert.rejects(store.save(row));}finally{fs.fsyncSync=sync;}
 assert.deepEqual(await store.list(),[]);
 fs.fsyncSync=function(fd){if(fs.fstatSync(fd).isDirectory())throw Error('synthetic directory fsync failure');return sync.call(this,fd);};try{await assert.rejects(store.save(row));}finally{fs.fsyncSync=sync;}
 assert.deepEqual(await store.list(),[row]);
});
