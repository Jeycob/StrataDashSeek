import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import http from 'node:http';import path from 'node:path';import {createRequire} from 'node:module';
import {client} from '../cloudflare/client.mjs';
import {devicePanel} from '../cloudflare/device-page.mjs';
const load=createRequire(import.meta.url),playwright=load(process.env.HARNESS_PLAYWRIGHT_MODULE??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/playwright'));
async function fixture(t,{monitor=false}={}){
 const calls=[];let busy=false;const script=monitor?await fs.readFile(new URL('./monitor.js',import.meta.url),'utf8'):client;
 const server=http.createServer((req,res)=>{if(req.url.startsWith('/api/')||req.url==='/phone/api/monitor'){calls.push({url:req.url,headers:req.headers});res.setHeader('content-type','application/json');
  if(req.url==='/phone/api/monitor')return res.end(JSON.stringify({at:Date.now(),model:{loaded:true,busy}}));
  if(req.url==='/api/wake')return res.end('{"ok":true,"queued":false}');
  res.setHeader('etag','"state1"');if(req.headers['if-none-match']==='"state1"'){res.writeHead(304);return res.end();}return res.end('{"status":"exited","harnessUrl":"https://example.ts.net/phone/"}');}
  res.setHeader('content-type','text/html');res.end('<html lang="cs"><body><select id="language"></select><form id="login"></form><section id="control"><button id="wake"></button><a id="open"></a></section><input id="key"><p id="status"></p><p id="message"></p>'+devicePanel+'<script>'+script+'</script>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await playwright.chromium.launch({headless:true,...(process.env.HARNESS_BROWSER_CHANNEL?{channel:process.env.HARNESS_BROWSER_CHANNEL}:{})});t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));});const page=await browser.newPage(),clockTime=Date.now();await page.clock.install({time:clockTime});
 await page.addInitScript(()=>{
  window.testHidden=true;Object.defineProperty(document,'hidden',{get:()=>window.testHidden});
  const fetch=window.fetch.bind(window);window.testPendingResponses=0;
  window.fetch=async(...args)=>{
   window.testPendingResponses++;
   // A task after body consumption lets application continuations render and
   // schedule their next poll. MessageChannel also runs while fake time is paused.
   const complete=()=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{window.testPendingResponses--;channel.port1.close();channel.port2.close();};channel.port2.postMessage(null);};
   try{
    const response=await fetch(...args);
    if(response.status===304||!response.ok)complete();
    else{const json=response.json.bind(response);response.json=async()=>{try{return await json();}finally{complete();}};}
    return response;
   }catch(error){complete();throw error;}
  };
 });await page.goto('http://127.0.0.1:'+server.address().port);await page.clock.pauseAt(clockTime+60000);
 async function settle(){
  const deadline=Date.now()+10000;
  while(await page.evaluate(()=>window.testPendingResponses!==0)){
   assert(Date.now()<deadline,'Browser response processing did not settle');
   await new Promise(r=>setTimeout(r,10));
  }
 }
 async function visible(value){await page.evaluate(value=>{window.testHidden=!value;document.dispatchEvent(new Event('visibilitychange'));},value);await settle();}
 return{page,calls,visible,settle,busy:value=>{busy=value;},advance:async ms=>{
  // Do not let virtual request timeouts overtake real localhost responses.
  for(let remaining=ms;remaining>0;remaining-=1000){await page.clock.runFor(Math.min(1000,remaining));await settle();}
 }};
}
test('wake portal makes no hidden requests, resumes once and uses conditional status',async t=>{
 const f=await fixture(t);assert.equal(f.calls.length,0);await f.visible(true);await f.advance(5000);assert.equal(f.calls.filter(x=>x.url==='/api/wake').length,1);assert(f.calls.some(x=>x.headers['if-none-match']==='"state1"'));
 await f.visible(false);const count=f.calls.length;await f.advance(60000);assert.equal(f.calls.length,count);await f.visible(true);await f.advance(16000);assert.equal(f.calls.filter(x=>x.url==='/api/wake').length,1);
});
test('monitor waits longer while idle and stops completely when closed or hidden',async t=>{
 const f=await fixture(t,{monitor:true});await f.visible(true);await f.page.evaluate(()=>window.openHarnessMonitor());await f.settle();assert.equal(f.calls.length,1);
 await f.advance(4000);assert.equal(f.calls.length,1);await f.advance(12000);assert.equal(f.calls.length,2);
 f.busy(true);await f.advance(16000);const busyCount=f.calls.length;await f.advance(4000);assert(f.calls.length>busyCount);
 await f.visible(false);const hiddenCount=f.calls.length;await f.advance(60000);assert.equal(f.calls.length,hiddenCount);
 await f.visible(true);await f.page.click('#monitor-close');const closedCount=f.calls.length;await f.advance(60000);assert.equal(f.calls.length,closedCount);
});
