'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createAppsService } = require('./apps-service.cjs');
test('disconnect of real authenticated HTTP request aborts admission; runtime reconciliation IDs survive error response', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'homeai-runtime-http-')), keyFile = path.join(directory,'key'); await fs.writeFile(keyFile,'synthetic-key');
  let entered, aborted; const ready = new Promise(r=>entered=r), cancelled = new Promise(r=>aborted=r);
  const manager = { heartbeat(){}, async tick(){}, async projectRuntime(data,{signal}) {
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
