import test from 'node:test';import assert from 'node:assert/strict';import worker from './worker.mjs';
import { Script } from 'node:vm';
test('wake portal serves English and Czech and executable client JavaScript',async()=>{const env={...baseEnv};
 const settings={HARNESS_URL:'https://harness.example.ts.net/phone/'};
 const en=await worker.fetch(new Request('https://wake.example.com/?lang=en'),settings);
 assert.match(await en.text(),/Your remote Harness/u);
 const cs=await worker.fetch(new Request('https://wake.example.com/?lang=cs'),settings);
 assert.match(await cs.text(),/Tvůj vzdálený Harness/u);
 const script=await worker.fetch(new Request('https://wake.example.com/app.js'),settings);
 assert.equal(script.status,200);const source=await script.text();assert.doesNotThrow(()=>new Script(source));
});
const origin='https://wake.example.com',baseEnv={WAKE_ACCESS_KEY:'a'.repeat(64),VAST_API_KEY:'test-only',INSTANCE_ID:'42',HARNESS_URL:'https://harness.example.ts.net/phone/'};
const req=(path,method='GET',body,cookie)=>new Request(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
test('HTTP 200 provider failure is never reported as a successful wake',async()=>{const env={...baseEnv};
 const saved=globalThis.fetch;let response={success:false,msg:'Required resources are currently unavailable, state change queued.'};
 globalThis.fetch=async(_url,options)=>Response.json(options.method==='GET'?{instances:{actual_status:'exited',intended_status:'stopped'}}:response);
 try{const login=await worker.fetch(req('/api/login','POST',{key:env.WAKE_ACCESS_KEY}),env),cookie=login.headers.get('set-cookie').split(';')[0];
  const queued=await worker.fetch(req('/api/wake','POST',{},cookie),env);assert.equal(queued.status,202);assert.deepEqual(await queued.json(),{ok:false,queued:true,code:'CAPACITY_UNAVAILABLE',retryAfterSeconds:15});
  response={success:false,msg:'Permission denied'};assert.equal((await worker.fetch(req('/api/wake','POST',{},cookie),{...env})).status,503);
 }finally{globalThis.fetch=saved;}
});
test('overlapping foreground wakes share one provider transition',async()=>{const env={...baseEnv};
 const saved=globalThis.fetch;let puts=0;globalThis.fetch=async(_url,options)=>{await new Promise(r=>setTimeout(r,10));if(options.method==='PUT'){puts++;return Response.json({success:true});}return Response.json({instances:{intended_status:'stopped'}});};
 try{const login=await worker.fetch(req('/api/login','POST',{key:env.WAKE_ACCESS_KEY}),env),cookie=login.headers.get('set-cookie').split(';')[0];const responses=await Promise.all([1,2,3].map(()=>worker.fetch(req('/api/wake','POST',{},cookie),env)));assert(responses.every(r=>r.status===200));assert.equal(puts,1);}finally{globalThis.fetch=saved;}
});
test('authentication, CSRF, signed cookies, fixed instance and idempotent wake',async()=>{const env={...baseEnv};
 let calls=[];const saved=globalThis.fetch;globalThis.fetch=async(url,options)=>{calls.push({url,method:options.method,body:options.body});return Response.json(options.method==='GET'?{instances:{actual_status:'running',intended_status:'running'}}:{success:true});};
 try{
  assert.equal((await worker.fetch(req('/api/status'),env)).status,401);assert.equal(calls.length,0);
  assert.equal((await worker.fetch(req('/api/login','POST',{key:'wrong'}),env)).status,401);
  let login=await worker.fetch(req('/api/login','POST',{key:env.WAKE_ACCESS_KEY}),env);assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
  let status=await worker.fetch(req('/api/status?instance=999','GET',undefined,cookie),env);assert.equal(status.status,200);assert.equal((await status.json()).harnessUrl,env.HARNESS_URL);assert.match(calls[0].url,/instances\/42\/$/);
  assert.equal((await worker.fetch(req('/api/status','GET',undefined,cookie+'x'),env)).status,401);
  const hostile=new Request(origin+'/api/wake',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'},body:'{}'});assert.equal((await worker.fetch(hostile,env)).status,403);
  assert.equal((await worker.fetch(req('/api/wake','POST',{},cookie),env)).status,200);assert.equal(calls.filter(c=>c.method==='PUT').length,0);
  globalThis.fetch=async(url,options)=>{calls.push({url,method:options.method,body:options.body});return Response.json(options.method==='GET'?{instances:{actual_status:'stopped',intended_status:'stopped'}}:{success:true});};
  assert.equal((await worker.fetch(req('/api/wake','POST',{},cookie),{...env})).status,200);assert.deepEqual(JSON.parse(calls.at(-1).body),{state:'running'});
 }finally{globalThis.fetch=saved;}
});
test('only the configured private Harness origin may use its provisioned wake key',async()=>{const env={...baseEnv};
 const originPrivate=new URL(env.HARNESS_URL).origin;const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({instances:{actual_status:'running',intended_status:'running',ssh_host:'ssh1.vast.ai',ssh_port:1234}});
 try{
  const preflight=await worker.fetch(new Request(origin+'/api/wake',{method:'OPTIONS',headers:{Origin:originPrivate}}),env);assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),originPrivate);
  const allowed=await worker.fetch(new Request(origin+'/api/wake',{method:'POST',headers:{Origin:originPrivate,Authorization:'Bearer '+env.WAKE_ACCESS_KEY},body:'{}'}),env);assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),originPrivate);assert.match(allowed.headers.get('access-control-expose-headers'),/Retry-After/);assert.match(preflight.headers.get('access-control-allow-headers'),/If-None-Match/);
  const bad=await worker.fetch(new Request(origin+'/api/wake',{method:'POST',headers:{Origin:'https://evil.example',Authorization:'Bearer '+env.WAKE_ACCESS_KEY},body:'{}'}),env);assert.equal(bad.status,403);
 }finally{globalThis.fetch=original;}
});

test('conditional status stays authenticated, shares cache and exposes only bounded diagnostic counts',async()=>{
 const env={...baseEnv};let calls=0;const saved=globalThis.fetch;globalThis.fetch=async()=>{calls++;return Response.json({instances:{actual_status:'running',intended_status:'running'}});};
 try{const login=await worker.fetch(req('/api/login','POST',{key:env.WAKE_ACCESS_KEY}),env),cookie=login.headers.get('set-cookie').split(';')[0];const first=await worker.fetch(req('/api/status','GET',undefined,cookie),env),tag=first.headers.get('etag');assert(tag);
  const headers={Cookie:cookie,'If-None-Match':tag};const second=await worker.fetch(new Request(origin+'/api/status',{headers}),env);assert.equal(second.status,304);assert.equal(await second.text(),'');assert.equal(calls,1);
  const weak=await worker.fetch(new Request(origin+'/api/status',{headers:{Cookie:cookie,'If-None-Match':'"other", W/'+tag}}),env);assert.equal(weak.status,304);
  assert.equal((await worker.fetch(new Request(origin+'/api/status',{headers:{'If-None-Match':tag}}),env)).status,401);
  const metrics=await worker.fetch(req('/api/request-metrics','GET',undefined,cookie),env),text=await metrics.text();assert.equal(JSON.parse(text).reads,1);assert.equal(JSON.parse(text).statusRequests,3);assert(!text.includes(env.VAST_API_KEY));assert.equal(calls,1);
 }finally{globalThis.fetch=saved;}
});

test('provider Retry-After is preserved and repeat requests do not hammer a limited provider',async()=>{
 const env={...baseEnv};let calls=0;const saved=globalThis.fetch;globalThis.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'75'}});};
 try{const login=await worker.fetch(req('/api/login','POST',{key:env.WAKE_ACCESS_KEY}),env),cookie=login.headers.get('set-cookie').split(';')[0];for(let i=0;i<3;i++){const response=await worker.fetch(req('/api/status','GET',undefined,cookie),env);assert.equal(response.status,503);assert(Number(response.headers.get('retry-after'))>=74);}assert.equal(calls,1);
 }finally{globalThis.fetch=saved;}
});
