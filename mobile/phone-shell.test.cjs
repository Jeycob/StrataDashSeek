'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function worker(fetchImpl){const events={},writes=[];const self={location:{origin:'https://fixture.ts.net'},addEventListener:(n,f)=>events[n]=f};const cache={match:async()=>new Response('old-shell'),put:async(k,r)=>writes.push([k,await r.text()])};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'phone-sw.js'),'utf8'),{self,URL,caches:{open:async()=>cache},fetch:fetchImpl,AbortController,setTimeout,clearTimeout});return{events,writes};}
test('installed phone loads fresh controls while server is online',async()=>{const w=worker(async()=>new Response('new-app-controls'));let result;w.events.fetch({request:new Request('https://fixture.ts.net/phone/app.js'),respondWith:p=>result=p,waitUntil(){}});assert.equal(await(await result).text(),'new-app-controls');assert.deepEqual(w.writes,[['/phone/app.js','new-app-controls']]);});
test('phone shell falls back offline and never caches application APIs',async()=>{const w=worker(async()=>{throw Error('offline')});let result;w.events.fetch({request:new Request('https://fixture.ts.net/phone/'),respondWith:p=>result=p,waitUntil(){}});assert.equal(await(await result).text(),'old-shell');let intercepted=false;w.events.fetch({request:new Request('https://fixture.ts.net/phone/api/apps/state'),respondWith(){intercepted=true;},waitUntil(){}});assert.equal(intercepted,false);assert.equal(w.writes.length,0);});
test('an installed phone replaces the v11 cache and retains fresh boot controls offline',async()=>{
 const previous='harness-static-shell-v12-model-cold-start',next='harness-static-shell-v13-pairing-wake';
 const boot='/phone/boot.js',origin='https://fixture.ts.net',events={};
 const buckets=new Map([[previous,new Map([[boot,'old-boot']])],['unrelated-cache',new Map()]]);
 let skipped=false,claimed=false,online=true;
 const fetch=async request=>{
  if(!online)throw Error('offline');
  const pathname=new URL(typeof request==='string'?request:request.url,origin).pathname;
  return new Response(pathname===boot?'new-boot':'shell asset');
 };
 const caches={keys:async()=>[...buckets.keys()],delete:async key=>buckets.delete(key),async open(key){
  if(!buckets.has(key))buckets.set(key,new Map());
  const values=buckets.get(key);
  return{
   async addAll(urls){for(const url of urls)values.set(url,await(await fetch(url)).text());},
   async match(url){if(values.has(url))return new Response(values.get(url));},
  };
 }};
 const self={location:{origin},addEventListener:(name,handler)=>events[name]=handler,
  skipWaiting:async()=>{skipped=true;},clients:{claim:async()=>{claimed=true;}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'phone-sw.js'),'utf8'),{self,URL,caches,fetch,AbortController,setTimeout,clearTimeout});
 const lifecycle=name=>{let pending;events[name]({waitUntil:value=>{pending=value;}});return pending;};
 await lifecycle('install');
 assert.equal(skipped,true);assert.equal(buckets.get(previous).get(boot),'old-boot');
 assert.equal(buckets.get(next)?.get(boot),'new-boot');
 await lifecycle('activate');
 assert.equal(claimed,true);assert.deepEqual([...buckets.keys()].sort(),[next,'unrelated-cache']);
 online=false;
 let response;const updates=[];
 events.fetch({request:new Request(origin+boot),respondWith:value=>{response=value;},waitUntil:value=>updates.push(value)});
 assert.equal(await(await response).text(),'new-boot');await Promise.all(updates);
 assert.equal(buckets.get(next).get(boot),'new-boot');
});
