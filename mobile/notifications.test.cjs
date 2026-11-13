const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPushServer}=require('./webpush-server.cjs');
const http=require('node:http');
test('retired migration registration receives no duplicate push',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-push-retired-'));const sent=[];
 fs.writeFileSync(path.join(dir,'webpush-subscriptions.json'),JSON.stringify({version:1,installations:{old:{retiredAt:1,subscription:{endpoint:'https://web.push.apple.com/mock-retired'}},current:{subscription:{endpoint:'https://web.push.apple.com/mock-active'}}}}));
 const adapter={generateVAPIDKeys:()=>({publicKey:'test-public',privateKey:'test-private'}),setVapidDetails(){},async sendNotification(subscription){sent.push(subscription.endpoint);return {statusCode:201};}};
 const service=createPushServer({publicHost:'fixture.example.ts.net',secretDir:dir},adapter);await service.publish('done','fixture-completed');await service.publish('done','fixture-completed');assert.deepEqual(sent,['https://web.push.apple.com/mock-active']);assert.equal(service.stats.accepted,1);
});
test('automatic owner entry and wake provisioning preserve authentication boundaries',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-owner-entry-')),keyFile=path.join(dir,'wake.key');fs.writeFileSync(keyFile,'fixture-wake-key');
 const host=http.createServer((req,res)=>{if(req.url==='/?token=fixture-launch'){res.writeHead(303,{'Set-Cookie':'owner=fixture; HttpOnly; SameSite=Strict',Location:'/'});return res.end();}res.writeHead(req.headers.cookie==='owner=fixture'?200:401);res.end();});await new Promise(r=>host.listen(0,'127.0.0.1',r));
 const adapter={generateVAPIDKeys:()=>({publicKey:'fixture-public',privateKey:'fixture-private'}),setVapidDetails(){}};
 const service=createPushServer({publicHost:'fixture.example.ts.net',secretDir:dir,harnessPort:host.address().port,wakeUrl:'https://wake.example.com/',wakeKeyFile:keyFile},adapter);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 try{
  const publicConfig=await fetch(base+'/phone/config.json');assert.equal((await publicConfig.json()).key,undefined);
  assert.equal((await fetch(base+'/phone/api/wake-config')).status,401);
  const privateConfig=await fetch(base+'/phone/api/wake-config',{headers:{Cookie:'owner=fixture'}});assert.equal(privateConfig.status,200);assert.equal((await privateConfig.json()).key,'fixture-wake-key');assert.equal(privateConfig.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/phone/entry?token=wrong',{redirect:'manual'})).status,401);
  const entry=await fetch(base+'/phone/entry?token=fixture-launch',{redirect:'manual'});assert.equal(entry.status,303);assert.equal(entry.headers.get('location'),'/phone/');assert.match(entry.headers.get('set-cookie'),/Secure/);
 }finally{await new Promise(r=>service.server.close(r));await new Promise(r=>host.close(r));}
});
