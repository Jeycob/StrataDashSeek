'use strict';
const {isolatedExecutionBinding}=require('./fixtures/execution-binding.cjs');
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createAppsService } = require('./apps-service.cjs');
test('disconnect of real authenticated HTTP request aborts admission; runtime reconciliation IDs survive error response', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'homeai-runtime-http-')), keyFile = path.join(directory,'key'); await fs.writeFile(keyFile,'synthetic-key');
  let entered, aborted; const ready = new Promise(r=>entered=r), cancelled = new Promise(r=>aborted=r);
  const manager = { execution:isolatedExecutionBinding(), heartbeat(){}, async tick(){}, async projectRuntime(data,{signal}) {
    if(data.op==='fail')throw Object.assign(Error('PROJECT_RUNTIME_RECONCILIATION_REQUIRED'),{code:'PROJECT_RUNTIME_RECONCILIATION_REQUIRED',status:409,operationId:'a'.repeat(32),jobId:'b'.repeat(16)});
    entered(); await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted();resolve();},{once:true})); throw Object.assign(Error('cancelled'),{status:409});
  } };
  const service = createAppsService({keyFile},manager); await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),await fs.realpath(os.tmpdir()));assert(path.basename(resolved).startsWith('homeai-runtime-http-'));await fs.rm(resolved,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+service.server.address().port, headers={'X-Harness-Apps-Key':'synthetic-key','Content-Type':'application/json'};
  const refused=await fetch(base+'/project-runtime',{method:'POST',headers,body:JSON.stringify({op:'fail'})});assert.equal(refused.status,409);const body=await refused.json();assert.equal(body.code,'PROJECT_RUNTIME_RECONCILIATION_REQUIRED');assert.equal(body.operationId,'a'.repeat(32));assert.equal(body.jobId,'b'.repeat(16));
  const req=http.request(base+'/project-runtime',{method:'POST',headers});req.on('error',()=>{});req.end(JSON.stringify({op:'ensure'}));await ready;req.destroy();
  await Promise.race([cancelled,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('ABORT_NOT_DELIVERED')),2000);timer.unref();})]);
});

test('closed new-work admission permits only authenticated exact-cap stop and durable cancellation tombstones',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-runtime-cold-')),keyFile=path.join(directory,'key');await fs.writeFile(keyFile,'synthetic-key');
  const {ProjectRuntime}=require('./apps-project-runtime.cjs'),{atomicJson}=require('../mobile/private-json.cjs'),calls=[];let admissions=0;
  const manager={execution:isolatedExecutionBinding(),store:{jobs:[]},heartbeat(){},async tick(){},save(){atomicJson(path.join(directory,'state.json'),this.store);},worker:{pid(){assert.fail('cleanup must not touch VM launch');}}};
  const runtime=new ProjectRuntime(manager);manager.projectRuntime=(data,options)=>{calls.push(data.op);return runtime.handle(data,options);};
  const service=createAppsService({keyFile},manager,{admission:{async admit(){admissions++;throw Error('SYNTHETIC_FENCE_CLOSED');}}});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),await fs.realpath(os.tmpdir()));assert(path.basename(resolved).startsWith('homeai-runtime-cold-'));await fs.rm(resolved,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+service.server.address().port,headers={'X-Harness-Apps-Key':'synthetic-key','Content-Type':'application/json'},stop={op:'stop',sessionId:'owner',generation:'a'.repeat(32),stopToken:'s'.repeat(43)};
  const post=(route,data,auth=headers)=>fetch(base+route,{method:'POST',headers:auth,body:JSON.stringify(data)});
  assert.equal((await post('/project-runtime',stop,{'Content-Type':'application/json'})).status,401);
  for(const data of [{...stop,op:'ensure',kind:'editor'},{...stop,op:'execute',kind:'executor',command:'must not run'},{...stop,op:'touch'},{...stop,command:'extra field'},{...stop,stopToken:'invalid'}])assert.equal((await post('/project-runtime',data)).status,503);
  assert.equal((await post('/project-action',{id:'a'.repeat(16),action:'verify'})).status,503);assert.equal(admissions,6);assert.deepEqual(calls,[]);
  manager.serviceClosing=true;const response=await post('/project-runtime',stop);assert.equal(response.status,200);const value=await response.json();assert.equal(value.state,'stopped');assert.match(value.operationId,/^[a-f0-9]{32}$/);assert.equal(admissions,6);assert.deepEqual(calls,['stop']);
  const saved=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));assert.equal(Object.keys(saved.projectRuntimeIntents).length,1);assert(!JSON.stringify(saved).includes(stop.stopToken));assert.equal(saved.jobs.length,0);
  assert.equal((await post('/project-runtime',{...stop,stopToken:'x'.repeat(43)})).status,409);assert.equal((await post('/project-runtime',{...stop,op:'execute',kind:'executor',command:'must not run'})).status,503);
});
