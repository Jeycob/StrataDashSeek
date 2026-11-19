'use strict';
// Controlled measurements and real job/persistence code; no Docker, guest or network.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {admit,verifyCapacity,capacityDiagnosticFor}=require('./apps-deployment-capacity.cjs');
const {AppsManager}=require('./apps-manager.cjs'),{hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const fields=['hostBytes','guestBytes','hostInodes','guestInodes','memoryBytes'];
function failure(){const required=Object.fromEntries(fields.map(key=>[key,100])),sample={...required,hostBytes:50,guestBytes:25};try{admit(required,sample);}catch(error){error.capacityObservedAt={host:1000,guest:2000};error.details.privatePath='/private/DO_NOT_COPY';return error;}throw Error('Expected controlled deficit');}
test('capacity projection preserves exact side deficits and original times, without copying arbitrary error fields',()=>{
 const error=failure(),d=capacityDiagnosticFor(error);assert.deepEqual(d,{version:1,code:'DEPLOYMENT_CAPACITY_INSUFFICIENT',reason:'insufficient',items:[{resource:'hostBytes',required:100,available:50,missing:50,observedAt:1000},{resource:'guestBytes',required:100,available:25,missing:75,observedAt:2000}]});
 assert(!JSON.stringify(d).includes('private'));assert(!JSON.stringify(d).includes('DO_NOT_COPY'));
 error.capacityObservedAt.host=Number.MAX_SAFE_INTEGER;
 assert.equal(capacityDiagnosticFor(error).items[0].observedAt,null);
 delete error.capacityObservedAt;assert(capacityDiagnosticFor(error).items.every(row=>row.observedAt===null));
});
test('unknown samples and budgets remain explicit unknowns; unrelated or malformed diagnostics do not invent values',()=>{
 for(const [field,reason]of [['hostBytes','measurement_unknown'],['guestInodes','measurement_unknown'],['image.Size','budget_unknown'],['isolated-worker','worker_unverified'],['/private/DO_NOT_COPY','budget_unknown']]){
  const d=capacityDiagnosticFor({code:'DEPLOYMENT_CAPACITY_UNKNOWN',details:{field}});assert.equal(d.reason,reason);assert(d.items.every(row=>row.available===null&&row.required===null&&row.missing===null&&row.observedAt===null));assert(!JSON.stringify(d).includes('DO_NOT_COPY'));
 }
 assert.equal(capacityDiagnosticFor(Error('Other error')),undefined);
 assert.deepEqual(capacityDiagnosticFor({code:'DEPLOYMENT_CAPACITY_UNKNOWN'}).items,[]);
 for(const patch of [{available:-1},{missing:1},{required:Number.MAX_SAFE_INTEGER+1}]){const e=failure();Object.assign(e.details.hostBytes,patch);assert.deepEqual(capacityDiagnosticFor(e).items,[]);}
 const e=failure();e.details.memoryBytes={required:100,available:1,missing:99};e.capacityObservedAt.memory=9999;assert.equal(capacityDiagnosticFor(e).items.at(-1).observedAt,null);
});
test('existing capacity sampling stamps host statfs and retains the guest sampler time without changing admission',async t=>{
 t.mock.method(Date,'now',()=>20000);t.mock.method(fs,'statfsSync',()=>({bavail:1,bsize:1,ffree:1}));let reads=0;
 const worker={diskCheckedAt:1000,status:()=>({phase:'ready',controlIsolation:{verified:true},profile:{memoryMiB:1}}),diskFree:async()=>{reads++;return 1;},freeInodes:1};
 const manager={busy:'own-job',cfg:{stateDir:'/synthetic/no-files-read'},worker,log:()=>assert.fail('Rejected capacity must not log admitted')};
 await assert.rejects(verifyCapacity(manager,{id:'own-job'},{images:[{Id:'sha256:'+'a'.repeat(64),Size:1024,InodeCount:1}],candidateMemoryMiB:1,existingMemoryMiB:0,sourceBytes:1}),error=>{
  assert.equal(error.code,'DEPLOYMENT_CAPACITY_INSUFFICIENT');const d=capacityDiagnosticFor(error);assert(d.items.some(row=>row.resource==='hostBytes'&&row.observedAt===20000));assert(d.items.some(row=>row.resource==='guestBytes'&&row.observedAt===1000));assert(d.items.every(row=>row.resource!=='memoryBytes'||row.observedAt===null));return true;
 });assert.equal(reads,1);
});
test('real job catches persist and expose the bounded diagnostic for refused and unknown capacity',async t=>{
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'capacity-job-'));t.after(async()=>{const real=await fsp.realpath(directory);assert.equal(path.dirname(real),await fsp.realpath(os.tmpdir()));assert(path.basename(real).startsWith('capacity-job-'));await fsp.rm(real,{recursive:true,force:true});});
 await fsp.mkdir(path.join(directory,'project'));await fsp.writeFile(path.join(directory,'project/Dockerfile'),'FROM scratch\n');await fsp.writeFile(path.join(directory,'project/.harness-app.json'),JSON.stringify({version:1,name:'Synthetic',port:3000}));
 const manager=new AppsManager({enabled:true,workspaceRoot:directory,stateDir:path.join(directory,'state'),minFreeBytes:0},{available:async()=>true,list:async()=>[]},undefined,hostExecutionBinding()),project=await manager.register('project');
 manager.ready=async()=>{};
 for(const [action,error] of [['build',failure()],['verify',failure()],['verify',Object.assign(Error('DEPLOYMENT_CAPACITY_UNKNOWN'),{code:'DEPLOYMENT_CAPACITY_UNKNOWN',details:{field:'guestInodes'}})]]){
  manager.build=manager.verifyRelease=async()=>{throw error;};
  const job=manager.enqueue(project.id,action),until=Date.now()+5000;
  while(['queued','running'].includes(job.status)){assert(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(job.status,'failed');assert.equal(job.error,error.code);
  assert.deepEqual(job.capacityDiagnostic,capacityDiagnosticFor(error));
  const saved=JSON.parse(await fsp.readFile(manager.storeFile,'utf8')).jobs.find(row=>row.id===job.id);assert.deepEqual(saved.capacityDiagnostic,job.capacityDiagnostic);assert(!JSON.stringify(saved).includes('DO_NOT_COPY'));
  const view=await manager.state();assert.deepEqual(view.jobs.find(row=>row.id===job.id).capacityDiagnostic,job.capacityDiagnostic);
 }
});
