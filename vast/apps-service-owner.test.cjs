'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {ownAppsService}=require('./apps-service-owner.cjs');
test('a second service cannot construct a writer; active work retains the lease until an idle close',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sdsh-app-owner-'));let writes=0,first,second;
 t.after(async()=>{for(const app of [first,second])if(app){app.manager.busy=null;await app.close();}const real=await fs.realpath(dir);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('sdsh-app-owner-'));await fs.rm(real,{recursive:true,force:true});});
 const cfg={stateDir:dir},create=()=>{writes++;return{server:http.createServer(),manager:{busy:null}};};
 first=await ownAppsService(cfg,create);assert.equal(writes,1);
 await assert.rejects(ownAppsService(cfg,create,{timeoutMs:30}),{code:'LOCK_BUSY'});assert.equal(writes,1);
 first.manager.busy='deployment';await assert.rejects(first.close(),{code:'APPS_SERVICE_BUSY'});await assert.rejects(ownAppsService(cfg,create,{timeoutMs:30}),{code:'LOCK_BUSY'});assert.equal(writes,1);
 first.manager.busy=null;await first.close();second=await ownAppsService(cfg,create);assert.equal(writes,2);await second.close();
});

test('an accepted HTTP request that starts late cannot release the controller lease to a second writer',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sdsh-app-owner-'));let app,next,continueHandler,started;const entered=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>continueHandler=resolve);let writes=0;
 t.after(async()=>{continueHandler?.();for(const value of[app,next])if(value){value.manager.busy=null;await value.close();}const real=await fs.realpath(dir);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('sdsh-app-owner-'));await fs.rm(real,{recursive:true,force:true});});
 const manager={busy:null},create=()=>{writes++;return{manager,server:http.createServer(async(req,res)=>{started();await hold;manager.busy='late-deployment';res.writeHead(202);res.end('queued');})};};
 app=await ownAppsService({stateDir:dir},create);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const response=fetch('http://127.0.0.1:'+app.server.address().port);await entered;
 const closing=app.close();assert.equal(manager.serviceClosing,true);continueHandler();assert.equal((await response).status,202);await assert.rejects(closing,{code:'APPS_SERVICE_BUSY'});
 await assert.rejects(ownAppsService({stateDir:dir},create,{timeoutMs:30}),{code:'LOCK_BUSY'});assert.equal(writes,1);manager.busy=null;await app.close();next=await ownAppsService({stateDir:dir},create);assert.equal(writes,2);await next.close();
});
