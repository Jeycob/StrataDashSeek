'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const token={version:2,wakeUrl:'https://wake.example.com',credential:'device-only-fixture-token',deviceId:'fixture-device-123',expiresAt:9999999999999,scope:['status','wake']};
async function fixture(t,{width=390,paired=true,initialHealth,manualPairing=false}={}){
 let health=initialHealth||{phase:'model_loading',reasonCode:'MODEL_LOADING',sourceReady:true,runtimeReady:true,modelReady:false,observedAt:new Date().toISOString()},offline=false,revoked=false,wakes=0,reads=0,provisions=0,ownerEntries=0;const errors=[];
 const json=(res,value,status=200,headers={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(value));};
 const server=http.createServer((req,res)=>{
  const nativePaired=!manualPairing||req.headers.cookie?.split('; ').includes('fixture_native=paired');
  if(req.url==='/phone/'||req.url==='/phone'){
   res.setHeader('Content-Type','text/html');return res.end(fs.readFileSync(path.join(__dirname,'phone.html'),'utf8').replace('<script src="/phone/monitor.js"></script>','').replace('<script src="/phone/localize.js"></script>',''));
  }
  const assets={'/phone/boot.js':'mobile/phone-boot.js','/phone/app.js':'mobile/phone.js','/phone/i18n.js':'shared/i18n.cjs','/phone/ui-copy.js':'shared/ui-copy.cjs'};
  if(assets[req.url]){res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(root,assets[req.url])));}
  if(req.url==='/phone/health'){reads++;return json(res,offline?{code:'UNREACHABLE'}:health,offline?503:200);}
  if(req.url==='/phone/api/wake-credential'){provisions++;return paired&&nativePaired?json(res,token):json(res,{code:'PAIRING_REQUIRED'},401);}
  if(manualPairing&&req.url==='/phone/api/tailscale-login'){ownerEntries++;return json(res,{error:'Tailscale identity not allowed'},403);}
  if(manualPairing&&req.url==='/phone/api/pair')return json(res,{ok:true},200,{'Set-Cookie':'fixture_native=paired; Path=/; HttpOnly; SameSite=Strict'});
  if(req.url.startsWith('/phone/api/state'))return nativePaired?json(res,{registered:true,watcherOnline:true,vapidPublicKey:'fixture'}):json(res,{error:'Not paired'},401);
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<main>Native Harness fixture</main>');}
  res.writeHead(404);res.end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width,height:844},isMobile:manualPairing,hasTouch:manualPairing});page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
 await page.addInitScript(({token,manualPairing})=>{
  localStorage.setItem('harness.language','en');if(!manualPairing)localStorage.setItem('harness.wake.device.v2',JSON.stringify(token));
  window.testHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.testHidden});
  window.testOnline=true;Object.defineProperty(navigator,'onLine',{get:()=>window.testOnline});
 },{token,manualPairing});
 await page.route('https://wake.example.com/**',async route=>{const url=route.request().url();assert.equal(route.request().headers().authorization,'Bearer '+token.credential);if(revoked)return route.fulfill({status:401,json:{code:'DEVICE_REVOKED'}});if(url.endsWith('/api/wake')){wakes++;return route.fulfill({status:202,json:{queued:true,retryAfterSeconds:15}});}return route.fulfill({json:{status:'stopped',intended:'stopped',observedAt:new Date().toISOString()}});});
 const settle=()=>new Promise(r=>setTimeout(r,80));await page.goto('http://127.0.0.1:'+server.address().port+'/phone/');await settle();
 return{page,errors,get wakes(){return wakes;},get reads(){return reads;},get provisions(){return provisions;},get ownerEntries(){return ownerEntries;},setHealth:value=>{health=value;offline=false;},offline:()=>offline=true,revoke:()=>{revoked=true;},advance:async ms=>{await page.clock.runFor(ms);await settle();},hidden:async value=>{await page.evaluate(value=>{window.testHidden=value;document.dispatchEvent(new Event('visibilitychange'));},value);await settle();},online:async value=>{await page.evaluate(value=>{window.testOnline=value;window.dispatchEvent(new Event(value?'online':'offline'));},value);await settle();}};
}
for(const width of [320,390,768])test('actual phone source opens Native frame during model load and retains availability at '+width,async t=>{
 const f=await fixture(t,{width});await f.page.locator('#harness:not([hidden])').waitFor();assert.equal(await f.page.evaluate(()=>harnessBackendReady),true);assert.equal(await f.page.evaluate(()=>harnessModelReady),false);assert.equal(await f.page.locator('#setup-header').isVisible(),true);assert.match(await f.page.locator('#status').innerText(),/model is still loading/);
 assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await f.page.getByText('Connection details',{exact:true}).click();assert.match(await f.page.locator('#availability-details').innerText(),/MODEL_LOADING/);
 await f.page.locator('#availability-cancel').click();assert.equal(await f.page.evaluate(()=>harnessAvailabilityState.reasonCode),'WAIT_CANCELLED');const count=f.reads;await f.hidden(true);await f.hidden(false);await f.advance(30000);assert.equal(f.reads,count);
 f.setHealth({phase:'ready',reasonCode:'READY',sourceReady:true,runtimeReady:true,modelReady:true,observedAt:new Date().toISOString()});await f.page.locator('#availability-retry').click();await f.page.waitForFunction(()=>harnessModelReady);assert.equal(await f.page.locator('#setup-header').isHidden(),true);assert.equal(f.wakes,0);assert.deepEqual(f.errors,[]);
});
test('actual phone capacity wait stops while hidden; revoked device never silently reprovisions',async t=>{
 const f=await fixture(t);f.offline();await f.page.locator('#availability-cancel').click();await f.page.locator('#availability-retry').click();await f.page.waitForFunction(()=>harnessAvailabilityState.phase==='capacity_wait');assert.equal(f.wakes,1);await f.hidden(true);await f.advance(60000);assert.equal(f.wakes,1);
 f.revoke();await f.hidden(false);await f.page.waitForFunction(()=>harnessAvailabilityState.phase==='authentication_required');assert.equal(await f.page.evaluate(()=>HarnessWakeCredentials.get()),null);assert.equal(f.provisions,0);await f.page.locator('#availability-retry').click();await f.advance(1000);assert.equal(f.provisions,0);assert.deepEqual(f.errors,[]);
});
test('verified source does not open the Native iframe before runtime readiness',async t=>{
 const f=await fixture(t,{initialHealth:{phase:'starting_services',sourceReady:true,runtimeReady:false,modelReady:false,reasonCode:'RUNTIME_STARTING'}});assert.equal(await f.page.evaluate(()=>harnessBackendReady),false);assert.equal(await f.page.locator('#harness').getAttribute('src'),null);assert.equal(await f.page.locator('#harness').isHidden(),true);
 f.setHealth({phase:'model_loading',sourceReady:true,runtimeReady:true,modelReady:false,reasonCode:'MODEL_LOADING'});await f.advance(2500);await f.page.locator('#harness:not([hidden])').waitFor();assert.equal(await f.page.locator('#harness').getAttribute('src'),'/');assert.equal(await f.page.evaluate(()=>harnessModelReady),false);assert.equal(f.wakes,0);assert.deepEqual(f.errors,[]);
});
test('a fresh manual pairing provisions wake permission and resumes from one wake after reconnecting',async t=>{
 const ready=()=>({phase:'ready',reasonCode:'READY',sourceReady:true,runtimeReady:true,modelReady:true,observedAt:new Date().toISOString()});
 const f=await fixture(t,{manualPairing:true,initialHealth:ready()});
 await f.page.locator('#pair').waitFor();
 assert.equal(await f.page.evaluate(()=>HarnessWakeCredentials.get()),null);
 await f.page.locator('#pair-code').fill('12345678');await f.page.locator('#pair-form button').click();
 await f.page.frameLocator('#harness').getByText('Native Harness fixture').waitFor();
 await f.page.waitForFunction(()=>HarnessWakeCredentials.get()?.scope.join(',')==='status,wake');
 assert.equal(f.ownerEntries,1);assert.equal(f.wakes,0);
 f.offline();await f.online(false);await f.hidden(true);
 await f.page.clock.fastForward(60000);assert.equal(f.wakes,0);
 await f.online(true);assert.equal(f.wakes,0);
 await f.hidden(false);await f.page.waitForFunction(()=>harnessAvailabilityState.phase==='capacity_wait');assert.equal(f.wakes,1);
 await f.hidden(true);await f.page.clock.fastForward(60000);assert.equal(f.wakes,1);
 f.setHealth(ready());await f.hidden(false);await f.page.waitForFunction(()=>harnessModelReady);
 assert.equal(f.wakes,1);assert.equal(f.ownerEntries,1);assert.deepEqual(f.errors,[]);
});
