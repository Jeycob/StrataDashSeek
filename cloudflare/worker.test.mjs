import test from 'node:test';import assert from 'node:assert/strict';import worker from './worker.mjs';
const origin='https://wake.example.com',env={WAKE_ACCESS_KEY:'a'.repeat(64),VAST_API_KEY:'test-only',INSTANCE_ID:'42',HARNESS_URL:'https://harness.example.ts.net/phone/'};
const req=(path,method='GET',body,cookie)=>new Request(origin+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
test('authentication, CSRF, signed cookies, fixed instance and idempotent wake',async()=>{
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
  assert.equal((await worker.fetch(req('/api/wake','POST',{},cookie),env)).status,200);assert.deepEqual(JSON.parse(calls.at(-1).body),{state:'running'});
 }finally{globalThis.fetch=saved;}
});
