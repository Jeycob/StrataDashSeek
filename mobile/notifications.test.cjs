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
 const service=createPushServer({publicHost:'fixture.example.ts.net',secretDir:dir,harnessPort:host.address().port,wakeUrl:'https://wake.example.com/',wakeKeyFile:keyFile,desktopLog:path.join(dir,'host.log'),tailscaleAutoLoginUsers:['owner@example.com']},adapter);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.server.address().port;
 const logFile=path.join(dir,'host.log');fs.writeFileSync(logFile,'https://fixture.example.ts.net/?token=fixture-launch');
 // The configuration object is retained by the server; production values are private.
 try{
  const origin='https://fixture.example.ts.net';
  for(const login of [null,'other@example.com']){const headers={Origin:origin};if(login)headers['Tailscale-User-Login']=login;assert.equal((await fetch(base+'/phone/api/tailscale-login',{method:'POST',headers})).status,403);}
  assert.equal((await fetch(base+'/phone/api/tailscale-login',{method:'POST',headers:{Origin:'https://evil.example','Tailscale-User-Login':'owner@example.com'}})).status,403);
  const automatic=await fetch(base+'/phone/api/tailscale-login',{method:'POST',headers:{Origin:origin,'Tailscale-User-Login':'owner@example.com'}});assert.equal(automatic.status,200);assert.match(automatic.headers.get('set-cookie'),/HttpOnly/);assert.match(automatic.headers.get('set-cookie'),/Secure/);
  const publicConfig=await fetch(base+'/phone/config.json');assert.equal((await publicConfig.json()).key,undefined);
  assert.equal((await fetch(base+'/phone/api/wake-config')).status,401);
  const privateConfig=await fetch(base+'/phone/api/wake-config',{headers:{Cookie:'owner=fixture'}});assert.equal(privateConfig.status,200);assert.equal((await privateConfig.json()).key,'fixture-wake-key');assert.equal(privateConfig.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/phone/entry?token=wrong',{redirect:'manual'})).status,401);
  const entry=await fetch(base+'/phone/entry?token=fixture-launch',{redirect:'manual'});assert.equal(entry.status,303);assert.equal(entry.headers.get('location'),'/phone/');assert.match(entry.headers.get('set-cookie'),/Secure/);
 }finally{await new Promise(r=>service.server.close(r));await new Promise(r=>host.close(r));}
});

