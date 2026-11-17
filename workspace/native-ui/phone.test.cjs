'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
for(const legacyAbort of [false,true])test((legacyAbort?'Missing abort helpers: ':'')+'Native notification mount preserves the phone registration and click handlers',async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),root=path.resolve(__dirname,'../..'),requests=[];
 const bootstrap=`window.harnessBackendReady=true;window.harnessPrepare=()=>Promise.resolve();window.permissionCalls=0;window.subscribeCalls=0;const fixtureRegistration={pushManager:{getSubscription:async()=>({toJSON:()=>({endpoint:'https://push.fixture/existing',keys:{}})}),subscribe:async()=>{window.subscribeCalls++;throw Error('Duplicate subscription');}}};Notification.requestPermission=()=>{window.permissionCalls++;return Promise.resolve('granted')};navigator.serviceWorker.register=async()=>fixtureRegistration;Object.defineProperty(navigator.serviceWorker,'ready',{value:Promise.resolve(fixtureRegistration)});`;
 const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;if(req.method==='POST')requests.push({url:req.url,body:JSON.parse(body)});
  if(req.url==='/phone/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(fs.readFileSync(path.join(root,'mobile/phone.html'),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/i18n.js"></script><script src="/ui-copy.js"></script><script>HarnessI18n.setLanguage("cs")</script><script src="/bootstrap.js"></script><script src="/phone-app.js"></script></body>'));}
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><div id="notification-slot"></div><script>window.dispose=parent.HarnessPhoneSettings.mount(document.querySelector("#notification-slot"));</script>');}
  if(req.url==='/bootstrap.js'){res.setHeader('Content-Type','text/javascript');return res.end(bootstrap);}
  if(req.url==='/phone-app.js'||req.url==='/i18n.js'||req.url==='/ui-copy.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,req.url==='/i18n.js'?'shared/i18n.cjs':req.url==='/ui-copy.js'?'shared/ui-copy.cjs':'mobile/phone.js')));}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/phone/api/state')?{registered:true,watcherOnline:true,vapidPublicKey:'fixture'}:{message:'fixture acknowledged'}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  if(legacyAbort)await page.addInitScript(()=>{delete AbortSignal.any;delete AbortSignal.timeout;});
  await page.goto('http://127.0.0.1:'+server.address().port+'/phone/');const frame=page.frameLocator('#harness');
  await frame.getByRole('button',{name:'Povolit oznámení',exact:true}).waitFor();await page.evaluate(()=>HarnessI18n.setLanguage('en'));await frame.getByRole('button',{name:'Enable notifications',exact:true}).waitFor();await page.evaluate(()=>HarnessI18n.setLanguage('cs'));
  await frame.getByRole('button',{name:'Povolit oznámení',exact:true}).click();await page.waitForFunction(()=>window.permissionCalls===1);
  await frame.getByRole('button',{name:'Test za 5 sekund',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#harness').contentDocument.getElementById('message')?.textContent==='fixture acknowledged');
  const installation=await page.evaluate(()=>localStorage.getItem('harness.push.installation'));
  assert.ok(installation);assert.equal(requests.filter(r=>r.url==='/phone/api/subscribe').length,1);assert.equal(requests.find(r=>r.url==='/phone/api/subscribe').body.installationId,installation);
  await page.locator('#harness').evaluate(e=>{const w=e.contentWindow;w.dispose();w.dispose=window.HarnessPhoneSettings.mount(w.document.querySelector('#notification-slot'));});
  assert.equal(await frame.locator('#enable').count(),1);assert.equal(await page.evaluate(()=>window.subscribeCalls),0);
  assert.equal(requests.filter(r=>r.url==='/phone/api/subscribe').length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
