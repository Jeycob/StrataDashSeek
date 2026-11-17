'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {bindAppsExecution,bindAppsProcess,assertAppsExecution}=require('./apps-execution-mode.cjs');
const {hostExecutionBinding,executionBindingFixture}=require('./fixtures/execution-binding.cjs');
const {AppsManager}=require('./apps-manager.cjs'),{createAppsService}=require('./apps-service.cjs');
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-apps-mode-'));t.after(async()=>{const actual=await fs.realpath(dir);assert.equal(path.dirname(actual),await fs.realpath(os.tmpdir()));assert(path.basename(actual).startsWith('homeai-apps-mode-'));await fs.rm(actual,{recursive:true,force:true});});return dir;}
test('Apps bindings require a trusted projection object and refuse changed identity without adopting it',()=>{
 assert.throws(()=>bindAppsExecution('host-compat'),{code:'PROJECT_EXECUTION_BINDING_REQUIRED'});const f=executionBindingFixture('host-compat'),bound=bindAppsExecution(Object.freeze({...f.binding,registerWorkspace(){}}));assert.equal(bound.snapshot.mode,'host-compat');f.fail();assert.throws(()=>bound.assertUnchanged(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
 assert.throws(()=>assertAppsExecution({execution:hostExecutionBinding()},{isolated:true}),{code:'PROJECT_RUNTIME_MODE_UNAVAILABLE'});
});
test('Apps process derives exact own immutable source and inherited launch, without reading user config',()=>{
 const f=executionBindingFixture('host-compat'),directory='/data/harness/releases/'+f.binding.snapshot.sourceCommit+'/vast',calls=[];
 const bound=bindAppsProcess({directory,launchId:f.binding.snapshot.launchId,filesystem:{realpathSync:p=>p},trustedDirectory:p=>calls.push(p),modeContract:{bindForService(input){calls.push(input);return f.binding;}}});assert.equal(bound.snapshot.sourceCommit,'b'.repeat(40));assert.deepEqual(calls,[directory,{sourceCommit:'b'.repeat(40),launchId:f.binding.snapshot.launchId}]);
 for(const invalid of ['/data/harness/app/vast','/tmp/releases/'+ 'b'.repeat(40)+'/vast',directory+'/nested'])assert.throws(()=>bindAppsProcess({directory:invalid,filesystem:{realpathSync:p=>p}}),{code:'PROJECT_EXECUTION_SOURCE_INVALID'});
 assert.throws(()=>bindAppsProcess({directory,launchId:'mismatched',filesystem:{realpathSync:p=>p},trustedDirectory(){},modeContract:{bindForService:()=>f.binding}}),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
});
test('Apps DEFAULT process validator reads every protected ancestor without privileged runtime helpers',()=>{
 const f=executionBindingFixture('host-compat'),directory='/data/harness/releases/'+f.binding.snapshot.sourceCommit+'/vast',seen=[],unsafe=new Map();
 const filesystem={realpathSync:p=>unsafe.get(p)?.realpath??p,lstatSync(p){seen.push(p);return{uid:0,mode:0o755,isDirectory:()=>true,isSymbolicLink:()=>false,...unsafe.get(p)};}};
 let binds=0;const options={directory,launchId:f.binding.snapshot.launchId,filesystem,modeContract:{bindForService(input){binds++;assert.deepEqual(input,{sourceCommit:f.binding.snapshot.sourceCommit,launchId:f.binding.snapshot.launchId});return f.binding;}}};
 assert.equal(bindAppsProcess(options).snapshot.mode,'host-compat');assert.deepEqual(seen,['/','/data','/data/harness','/data/harness/releases','/data/harness/releases/'+f.binding.snapshot.sourceCommit,directory]);assert.equal(binds,1);
 for(const [target,change]of [['/data',{uid:1001}],['/data/harness/releases',{mode:0o775}],[directory,{mode:0o757}],[directory,{isDirectory:()=>false}],['/data/harness',{isSymbolicLink:()=>true}],['/data/harness/releases',{realpath:'/different'}]]){unsafe.set(target,change);assert.throws(()=>bindAppsProcess(options),{code:'PROJECT_EXECUTION_SOURCE_UNSAFE'});unsafe.clear();assert.equal(binds,1);}
 assert.throws(()=>bindAppsProcess({...options,filesystem:{...filesystem,lstatSync(){throw Object.assign(Error('denied'),{code:'EACCES'});}}}),{code:'PROJECT_EXECUTION_SOURCE_UNSAFE'});assert.equal(binds,1);
 f.fail();assert.throws(()=>bindAppsProcess(options),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
});
test('missing Apps production binding fails before creating state or controller key',async t=>{
 const dir=await temporary(t),stateDir=path.join(dir,'not-created'),keyFile=path.join(dir,'not-created-key');assert.throws(()=>new AppsManager({stateDir,executionMode:'host-compat'}),{code:'PROJECT_EXECUTION_BINDING_REQUIRED'});await assert.rejects(fs.stat(stateDir),{code:'ENOENT'});
 assert.throws(()=>createAppsService({keyFile,executionMode:'host-compat'}),{code:'PROJECT_EXECUTION_SOURCE_INVALID'});await assert.rejects(fs.stat(keyFile),{code:'ENOENT'});
});
test('host generic Apps composition never enables project runtime from availability or config strings',async t=>{
 for(const enabled of [false,true]){const dir=await temporary(t);let calls=0;const engine={available:async()=>{calls++;},list:async()=>{calls++;return[];}},m=new AppsManager({stateDir:dir,enabled,executionMode:'isolated-guest',projectRuntime:{enabled:true}},engine,undefined,hostExecutionBinding());
  await assert.rejects(m.projectRuntime({op:'execute',kind:'executor'}),{code:'PROJECT_RUNTIME_MODE_UNAVAILABLE'});assert.equal(calls,0);assert.equal(m.execution.snapshot.mode,'host-compat');assert.equal(JSON.parse(await fs.readFile(path.join(dir,'activity.json'),'utf8')).enabled,enabled);
 }
});
test('stale Apps binding cannot dispatch after an awaited engine readiness boundary',async t=>{
 const dir=await temporary(t),f=executionBindingFixture('host-compat');let calls=0;const m=new AppsManager({stateDir:dir,enabled:true},{available:async()=>{calls++;f.fail();}},undefined,f.binding);await assert.rejects(m.ready(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(calls,1);
});
test('authenticated exact-cap runtime stop survives stale binding and closed service; new work and wrong cap refuse',async t=>{
 const dir=await temporary(t),f=executionBindingFixture('isolated-guest'),keyFile=path.join(dir,'key');let calls=0;const engine={available:async()=>{calls++;assert.fail('No Docker access');}},m=new AppsManager({stateDir:dir,enabled:false},engine,undefined,f.binding),stop={op:'stop',sessionId:'owner',generation:'a'.repeat(32),stopToken:'s'.repeat(43)};
 m.store.jobs.push({id:'b'.repeat(16),status:'running',projectRuntime:{state:'stopped',operationId:'c'.repeat(32),sessionId:stop.sessionId,generation:stop.generation,stopTokenHash:crypto.createHash('sha256').update(stop.stopToken).digest('hex')}});m.save();
 let admissions=0;const service=createAppsService({keyFile},m,{admission:{async admit(){admissions++;throw Error('CLOSED');}}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(async()=>{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));});
 const headers={'x-harness-apps-key':(await fs.readFile(keyFile,'utf8')).trim(),'content-type':'application/json'},url='http://127.0.0.1:'+service.server.address().port+'/project-runtime',post=data=>fetch(url,{method:'POST',headers,body:JSON.stringify(data)});f.fail();m.serviceClosing=true;
 const response=await post(stop);assert.equal(response.status,200);assert.equal((await response.json()).state,'stopped');assert.equal(admissions,0);assert.equal(calls,0);
 assert.equal((await post({...stop,stopToken:'t'.repeat(43)})).status,409);assert.equal((await post({...stop,op:'execute'})).status,409);assert.equal((await post({...stop,extra:true})).status,409);assert.equal(calls,0);
});
