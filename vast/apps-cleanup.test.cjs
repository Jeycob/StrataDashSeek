'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const{cleanupTemporary,ensureCapacity,capacityStatus}=require('./apps-cleanup.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'apps-cleanup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return{cfg:{stateDir:root,minFreeBytes:0},store:{projects:{},jobs:[]},log(){}};}
async function put(m,rel,text='keep'){await fs.mkdir(path.dirname(path.join(m.cfg.stateDir,rel)),{recursive:true});await fs.writeFile(path.join(m.cfg.stateDir,rel),text);}
async function exists(m,rel){return fs.stat(path.join(m.cfg.stateDir,rel)).then(()=>true,()=>false);}
test('cleanup removes terminal staging and failed source copies, retains evidence, successful releases and live work',async t=>{
 const m=await fixture(t),failed='a'.repeat(16),passed='b'.repeat(16),running='c'.repeat(16),project='d'.repeat(16);
 m.store.jobs=[{id:failed,status:'failed'},{id:passed,status:'passed'},{id:running,status:'running'}];m.busy=running;
 for(const id of [failed,passed,running]){await put(m,'build-'+id+'/source.js');await put(m,'exports/'+id+'-metadata/README');await put(m,'exports/'+id+'.tar.gz');await put(m,`releases/${project}/${id}/source/app.js`);await put(m,`releases/${project}/${id}/source/.harness/deployment/browser.json`);await put(m,`releases/${project}/${id}/release.json`,JSON.stringify({id,projectId:project,status:id===failed?'failed':id===passed?'passed':'checking',completedAt:1}));}
 await put(m,'projects/source.js');await put(m,'models/model.gguf');await put(m,'credentials/token');
 const result=await cleanupTemporary(m);assert.ok(result.removed>0);
 for(const rel of ['build-'+failed,'build-'+passed,'exports/'+failed+'.tar.gz',`releases/${project}/${failed}/source/app.js`])assert.equal(await exists(m,rel),false,rel);
 for(const rel of ['build-'+running,'exports/'+passed+'.tar.gz','exports/'+running+'.tar.gz',`releases/${project}/${failed}/release.json`,`releases/${project}/${failed}/source/.harness/deployment/browser.json`,`releases/${project}/${passed}/source/app.js`,`releases/${project}/${running}/source/app.js`,'projects/source.js','models/model.gguf','credentials/token'])assert.equal(await exists(m,rel),true,rel);
});
test('active transfer, current release, unowned names and malformed reports are protected',async t=>{
 const m=await fixture(t),id='a'.repeat(16),p='b'.repeat(16);m.store.jobs=[{id,status:'failed'}];await put(m,'build-'+id+'/a');m.previewRequests=1;assert.equal((await cleanupTemporary(m)).skipped,'active-transfer');assert.equal(await exists(m,'build-'+id),true);m.previewRequests=0;m.store.projects[p]={releaseId:id};await put(m,`releases/${p}/${id}/source/a`);await put(m,`releases/${p}/${id}/release.json`,JSON.stringify({id,projectId:p,status:'failed',completedAt:1}));await put(m,'build-unrecognized/a');await cleanupTemporary(m);assert.equal(await exists(m,`releases/${p}/${id}/source/a`),true);assert.equal(await exists(m,'build-unrecognized/a'),true);
});
test('cleanup rejects links without touching their targets',async t=>{
 const m=await fixture(t),outside=await fs.mkdtemp(path.join(os.tmpdir(),'apps-cleanup-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.writeFile(path.join(outside,'precious'),'keep');const id='a'.repeat(16);m.store.jobs=[{id,status:'failed'}];await fs.symlink(outside,path.join(m.cfg.stateDir,'build-'+id),process.platform==='win32'?'junction':'dir');await cleanupTemporary(m);assert.equal(await fs.readFile(path.join(outside,'precious'),'utf8'),'keep');assert.ok((await fs.lstat(path.join(m.cfg.stateDir,'build-'+id))).isSymbolicLink());
});
test('capacity reports precise deficit and retains the configured safety reserve',async t=>{const m=await fixture(t);m.cfg.minFreeBytes=Number.MAX_SAFE_INTEGER;await assert.rejects(ensureCapacity(m),/bytes missing after safe temporary cleanup/);assert.ok(m.lastCleanup);assert.deepEqual(capacityStatus({minFreeBytes:200},{bavail:10,bsize:20}),{freeBytes:200,minFreeBytes:200,requiredVerifyBytes:536871112,deficitBytes:536870912});});
