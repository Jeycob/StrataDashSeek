'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createPushServer}=require('./webpush-server.cjs');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
async function until(fn){const end=Date.now()+3000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Local outbox condition timed out');}
async function fixture(t,send){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notification-http-')),installation='fixture_installation_001',origin='https://fixture.example.ts.net';
 const subscription={endpoint:'https://web.push.apple.com/fixture',keys:{auth:'a'.repeat(16),p256dh:'b'.repeat(40)}};
 fs.writeFileSync(path.join(root,'webpush-subscriptions.json'),JSON.stringify({version:1,installations:{[installation]:{subscription,createdAt:1}}}));
 const native=http.createServer((req,res)=>{res.writeHead(req.headers.cookie==='owner=fixture'?200:401);res.end();});await listen(native);
 let now=1700000000000,service,base;const cfg={publicHost:'fixture.example.ts.net',secretDir:root,harnessPort:native.address().port};
 async function start(auto=true){service=createPushServer(cfg,{generateVAPIDKeys:()=>({publicKey:'fixture-public',privateKey:'fixture-private'}),setVapidDetails(){},sendNotification:send},{outboxAutoStart:auto,outboxPolicy:{now:()=>now,random:()=>0.5,minFreeBytes:0,retryBaseMs:100,retryMaxMs:1000,sendTimeoutMs:500,leaseMs:1000}});await listen(service.server);base='http://127.0.0.1:'+service.server.address().port;return service;}
 async function stop(){if(service){await close(service.server);await service.outbox.stop();service=null;}}
 t.after(async()=>{await stop();await close(native);const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert(path.basename(resolved).startsWith('notification-http-'));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(resolved,{recursive:true,force:true});});
 async function request(route,body,{internal=false}={}){const result=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:internal?{'X-Harness-Notify-Key':fs.readFileSync(service.files.internal,'utf8').trim()}:{Origin:origin,Cookie:'owner=fixture'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:result.status,body:await result.json()};}
 await start();return{get service(){return service;},installation,start,stop,request,advance:ms=>{now+=ms;}};
}
test('HTTP202 acknowledges durable enqueue; two503 failures and full service restarts recover one event without duplicate fanout',async t=>{
 let calls=0;const payloads=[];
 const f=await fixture(t,async(_subscription,payload)=>{payloads.push(payload);calls++;if(calls<=2)throw{statusCode:503};return{statusCode:201};});
 const enqueue=()=>f.request('/internal/event',{id:'session-fixture:1',category:'done',message:'PRIVATE_CHAT_CANARY'},{internal:true});
 const first=await enqueue();assert.equal(first.status,202);assert.equal(first.body.persisted,true);
 await until(()=>f.service.outbox.delivery('session-fixture:1',f.installation)?.attempts===1&&!f.service.outbox.active);
 await f.stop();f.advance(101);await f.start();
 await until(()=>f.service.outbox.delivery('session-fixture:1',f.installation)?.attempts===2&&!f.service.outbox.active);
 await f.stop();f.advance(201);await f.start();
 await until(()=>f.service.outbox.delivery('session-fixture:1',f.installation)?.phase==='provider-accepted');
 const duplicate=await enqueue();assert.equal(duplicate.status,202);assert.equal(duplicate.body.duplicate,true);await f.service.outbox.tick();assert.equal(calls,3);
 assert(payloads.every(payload=>!payload.includes('PRIVATE_CHAT_CANARY')));
 const state=await f.request('/internal/state',{}, {internal:true});assert.equal(state.body.outbox.providerAcceptedTargets,1);assert.equal(state.body.deliveryConfirmed,false);
 f.service.outbox.minFreeBytes=Number.MAX_SAFE_INTEGER;
 assert.equal((await enqueue()).status,202);
 const full=await f.request('/internal/event',{id:'session-fixture:capacity',category:'done'},{internal:true});assert.equal(full.status,507);assert.notEqual(full.body.persisted,true);
});
test('a blocked provider does not hold202, and a failed SQLite write cannot claim durable acceptance',async t=>{
 let release;const f=await fixture(t,()=>new Promise(resolve=>{release=resolve;}));
 const accepted=await f.request('/internal/event',{id:'session-fixture:2',category:'done'},{internal:true});assert.equal(accepted.status,202);assert.equal(accepted.body.persisted,true);
 await until(()=>typeof release==='function');release({statusCode:201});await f.service.outbox.tick();
 f.service.outbox.db.exec('PRAGMA query_only=ON');
 const failed=await f.request('/internal/event',{id:'session-fixture:3',category:'error'},{internal:true});assert.equal(failed.status,503);assert.notEqual(failed.body.persisted,true);
 f.service.outbox.db.exec('PRAGMA query_only=OFF');assert.equal(f.service.outbox.metrics().persistedEvents,1);
});
test('test notifications persist their delay and rate limit through service restart',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return{statusCode:201};});
 const queued=await f.request('/phone/api/test',{installationId:f.installation});assert.equal(queued.status,202);assert.equal(queued.body.persisted,true);assert.equal(calls,0);
 await f.stop();f.advance(5001);await f.start();await until(()=>calls===1);
 const limited=await f.request('/phone/api/test',{installationId:f.installation});assert.equal(limited.status,429);
 const state=await f.request('/phone/api/state?installationId='+f.installation);assert.equal(state.body.outbox.providerAcceptedTargets,1);assert.equal(state.body.deliveryConfirmed,false);
});
test('provider410 retires registration across restart until an explicit valid subscription is saved',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;if(calls===1)throw{statusCode:410};return{statusCode:201};});
 await f.request('/internal/event',{id:'session-fixture:4',category:'done'},{internal:true});await until(()=>f.service.outbox.isRetired(f.installation));
 await f.stop();await f.start();
 const state=await f.request('/phone/api/state?installationId='+f.installation);assert.equal(state.body.registered,false);
 const subscription={endpoint:'https://web.push.apple.com/replacement',keys:{auth:'a'.repeat(16),p256dh:'b'.repeat(40)}};
 assert.equal((await f.request('/phone/api/subscribe',{installationId:f.installation,subscription})).status,200);
 await f.request('/internal/event',{id:'session-fixture:5',category:'done'},{internal:true});await until(()=>f.service.outbox.delivery('session-fixture:5',f.installation)?.phase==='provider-accepted');assert.equal(calls,2);
});

for(const stage of ['before-rename','after-rename'])test('subscription persistence failure '+stage+' invalidates old sends and holds registration until an explicit durable retry',async t=>{
 let rejectOld,calls=0;const f=await fixture(t,async()=>{calls++;if(calls===1)return new Promise((_,reject)=>{rejectOld=reject;});return{statusCode:201};});
 await f.request('/internal/event',{id:'session-fixture:old',category:'done'},{internal:true});await until(()=>typeof rejectOld==='function');
 const subscription={endpoint:'https://web.push.apple.com/replacement',keys:{auth:'c'.repeat(16),p256dh:'d'.repeat(40)}},rename=fs.renameSync;
 const mocked=t.mock.method(fs,'renameSync',(from,to)=>{if(to===f.service.files.subs){if(stage==='after-rename')rename(from,to);throw Object.assign(Error('fixture persistence failure'),{code:'EIO'});}return rename(from,to);});
 let failed;try{failed=await f.request('/phone/api/subscribe',{installationId:f.installation,subscription});}finally{mocked.mock.restore();}
 assert.equal(failed.status,503);assert.notEqual(failed.body.ok,true);
 assert.equal((await f.request('/phone/api/state?installationId='+f.installation)).body.registered,false);
 rejectOld({statusCode:410});await f.service.outbox.tick();
 assert.equal(f.service.outbox.delivery('session-fixture:old',f.installation).code,'SUBSCRIPTION_UPDATE_PENDING');
 await f.stop();await f.start();
 assert.equal((await f.request('/phone/api/state?installationId='+f.installation)).body.registered,false);
 assert.equal((await f.request('/phone/api/subscribe',{installationId:f.installation,subscription})).status,200);
 await f.request('/internal/event',{id:'session-fixture:replacement',category:'done'},{internal:true});
 await until(()=>f.service.outbox.delivery('session-fixture:replacement',f.installation)?.phase==='provider-accepted');assert.equal(calls,2);
});
