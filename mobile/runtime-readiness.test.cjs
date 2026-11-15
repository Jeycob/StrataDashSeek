'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRuntimeReadiness,protectedJSON,probe}=require('./runtime-readiness.cjs');
const commit='a'.repeat(40);
function fixture(extra={}){let time=100000,update={version:1,enabled:true,phase:'ready',signatureVerified:true,appliedCommit:commit},services={at:time,sourceCommit:commit,phase:'ready'},admission={version:1,enabled:true,sourceCommit:commit,epoch:'11111111-2222-4333-8444-555555555555',observedAt:time};const sampler=createRuntimeReadiness({}, {now:()=>time,read:name=>name==='startup-update.json'?update:name==='service-health.json'?services:admission,native:async()=>({status:200,workspaceReady:true,sourceCommit:commit}),model:async()=>({loaded:true}),...extra});return{sampler,update,services,admission,advance:()=>{time+=1001;}};}
test('readiness requires independent signed source, fresh matching services and model proof',async()=>{
 const f=fixture();assert.equal((await f.sampler.sample()).ready,true);
 for(const mutation of [()=>{f.update.signatureVerified=false;},()=>{f.update.signatureVerified=true;f.services.sourceCommit='b'.repeat(40);},()=>{f.services.sourceCommit=commit;f.services.at=0;}]){mutation();f.advance();const result=await f.sampler.sample();assert.equal(result.ready,false);assert.equal(result.runtimeReady,false);}
 const model=fixture({model:async()=>({loaded:false})});const result=await model.sampler.sample();assert.equal(result.phase,'model_loading');assert.equal(result.sourceReady,true);assert.equal(result.runtimeReady,true);assert.equal(result.modelReady,false);assert.equal(result.ready,false);
});
test('failed runtime or signature gate stays failed despite retained positive booleans',async()=>{
 const f=fixture();f.services.phase='failed';const a=await f.sampler.sample();assert.equal(a.phase,'failed');assert.equal(a.ready,false);assert.equal(a.modelReady,true);
 f.update.phase='blocked';f.advance();const b=await f.sampler.sample();assert.equal(b.reasonCode,'SIGNED_UPDATE_BLOCKED');assert.equal(b.sourceReady,false);
 const offline=fixture({native:async()=>null});const c=await offline.sampler.sample();assert.equal(c.phase,'starting_services');assert.equal(c.sourceReady,true);assert.equal(c.runtimeReady,false);
 for(const native of [async()=>({status:401}),async()=>({status:200,workspaceReady:true,sourceCommit:'b'.repeat(40)})])assert.equal((await fixture({native}).sampler.sample()).runtimeReady,false);
});
test('concurrent reads share one bounded observation and never send a model generation request',async t=>{
 const requests=[];const native=http.createServer((req,res)=>{requests.push(req.method+' '+(req.url.startsWith('/?token=')?'[local-login]':req.url));if(req.url.startsWith('/?token=')){res.writeHead(303,{'Set-Cookie':'local=fixture; HttpOnly'});return res.end();}assert.equal(req.headers.cookie,'local=fixture');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,workspaceReady:true,sourceCommit:commit}));});const model=http.createServer((req,res)=>{requests.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({loaded:false}));});
 await Promise.all([new Promise(r=>native.listen(0,'127.0.0.1',r)),new Promise(r=>model.listen(0,'127.0.0.1',r))]);t.after(()=>Promise.all([new Promise(r=>native.close(r)),new Promise(r=>model.close(r))]));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-health-')),desktopLog=path.join(dir,'harness.log');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(desktopLog,'https://fixture.example.ts.net/?token=FIXTURE_PRIVATE_TOKEN',{mode:0o640});
 const sampler=createRuntimeReadiness({publicHost:'fixture.example.ts.net',desktopLog,harnessPort:native.address().port,modelPort:model.address().port},{read:name=>name==='startup-update.json'?{version:1,enabled:true,phase:'ready',signatureVerified:true,appliedCommit:commit}:name==='service-health.json'?{at:Date.now(),sourceCommit:commit,phase:'ready'}:{version:1,enabled:true,sourceCommit:commit,epoch:'11111111-2222-4333-8444-555555555555',observedAt:Date.now()}});
 const values=await Promise.all(Array.from({length:12},()=>sampler.sample()));assert(values.every(v=>v.phase==='model_loading'));assert.deepEqual(requests.sort(),['GET /api/workbench/health','GET /health','GET [local-login]']);await sampler.sample();assert.equal(requests.length,3);assert.doesNotMatch(JSON.stringify(values),/PRIVATE_TOKEN|local=fixture/);
});
test('healthy infrastructure remains unavailable to users until fresh root admission opens for this exact source',async()=>{
 for(const patch of [{enabled:false},{sourceCommit:'b'.repeat(40)},{observedAt:1},{epoch:null}]){const f=fixture();Object.assign(f.admission,patch);const state=await f.sampler.sample();assert.equal(state.runtimeReady,false);assert.equal(state.reasonCode,'RUNTIME_ADMISSION_CLOSED');}
 const root=fixture({infrastructureOnly:true});root.admission.enabled=false;assert.equal((await root.sampler.sample()).runtimeReady,true);
});
test('a server that sends headers without completing JSON cannot hold health forever',async t=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.flushHeaders();res.write('{');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const start=Date.now();assert.equal(await probe(server.address().port,'/health',{json:true,timeoutMs:40}),null);assert(Date.now()-start<1500);
});
test('protected status reader rejects hardlinks and writable parents without exposing other data',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-health-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const dir=path.join(root,'status');fs.mkdirSync(dir,{mode:0o755});const file=path.join(dir,'startup-update.json');fs.writeFileSync(file,JSON.stringify({version:1}),{mode:0o644});assert.equal(protectedJSON(dir,'startup-update.json').version,1);
 fs.linkSync(file,path.join(root,'retained'));assert.throws(()=>protectedJSON(dir,'startup-update.json'),/Untrusted/);fs.unlinkSync(path.join(root,'retained'));
 if(process.platform==='linux'){fs.chmodSync(dir,0o777);assert.throws(()=>protectedJSON(dir,'startup-update.json'),/Untrusted/);}
});
