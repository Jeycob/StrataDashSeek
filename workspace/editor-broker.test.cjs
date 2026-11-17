'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const{createEditorBroker,safeRedirect}=require('./editor-broker.cjs');
const origin='https://owner.test:19443',ownerOrigin='https://owner.test';
test('editor relative redirects resolve within their exact origin and cannot enter broker or proxy routes',()=>{
 for(const value of ['?folder=%2Fworkspace','./?folder=%2Fworkspace',origin+'/?folder=%2Fworkspace'])assert.equal(safeRedirect(value,origin,'/'),'/?folder=%2Fworkspace');
 for(const value of ['https://evil.test/','//owner.test:19444/','javascript:alert(1)','/proxy/3090/','/__editor/claim','https://user@owner.test:19443/'])assert.equal(safeRedirect(value,origin,'/'),null,value);
});
async function fixture(t,options={}){
 const purpose=options.purpose??'editor',dir=await fs.mkdtemp(path.join(os.tmpdir(),'editor-broker-')),socketPath=process.platform==='win32'?'\\\\.\\pipe\\homeai-'+purpose+'-'+crypto.randomUUID():path.join(dir,'code.sock'),seen=[];let clock=1000;
 const upstream=http.createServer((req,res)=>{seen.push(req.headers);if(options.upstreamHandler)return options.upstreamHandler(req,res);if(req.url==='/redirect')res.writeHead(302,{'Location':'https://evil.test/','Set-Cookie':'dsh-auth-fixation=evil'});else res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'dsh-auth-fixation=evil','Access-Control-Allow-Origin':'*'});res.end('{"editor":true}');});
 const live=new Set();upstream.on('connection',s=>{live.add(s);s.on('close',()=>live.delete(s));});
 upstream.on('upgrade',(req,socket)=>{seen.push(req.headers);const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+accept+'\r\nSet-Cookie: dsh-auth-fixation=evil\r\n\r\n');});
 await new Promise((resolve,reject)=>{upstream.once('error',reject);upstream.listen(socketPath,resolve);});
 const broker=createEditorBroker({sessionId:'project-A',generation:'g1',origin,ownerOrigin,socketPath,now:()=>clock,...options});await new Promise(resolve=>broker.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{broker.close();for(const s of live)s.destroy();await new Promise(resolve=>upstream.close(resolve));assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'editor-broker-'));await fs.rm(dir,{recursive:true,force:true});});
 function request(url,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:broker.server.address().port,path:url,method,headers:{host:new URL(origin).host,'sec-fetch-site':'same-origin',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);});}
 async function claim(){const grant=broker.issue().url.split('#')[1],r=await request('/__'+purpose+'/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({grant})});assert.equal(r.status,200);return{grant,cookie:r.headers['set-cookie'][0].split(';')[0],response:r};}
 return{broker,seen,request,claim,advance:ms=>{clock+=ms;}};
}
test('one-use scoped claims, expiry and ownership are enforced before connecting to editor',async t=>{
 const f=await fixture(t),issued=f.broker.issue();assert.equal(issued.sessionId,'project-A');assert.equal(issued.generation,'g1');assert.ok(!issued.url.includes('?'));
 assert.equal(issued.grantExpiresAt,61000);assert.equal(issued.expiresAt,1801000);
 assert.equal((await f.request('/',{headers:{cookie:'dsh-auth-owner=SYNTHETIC_OWNER'}})).status,401);
 assert.equal(f.seen.length,0);const c=await f.claim();
 assert.equal((await f.request('/__editor/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({grant:c.grant})})).status,403);
 assert.equal((await f.request('/',{headers:{cookie:c.cookie,origin:'https://owner.test:19444'}})).status,403);
 f.advance(30*60000);assert.equal((await f.request('/',{headers:{cookie:c.cookie}})).status,401);assert.equal(f.seen.length,0);
});

test('preview purpose isolates its cookie/control namespace on a sibling HTTPS port without owner credentials',async t=>{
 const f=await fixture(t,{purpose:'preview'}),link=f.broker.issue();assert.match(link.url,/\/__preview\/bootstrap#/);assert.match(f.broker.cookieName,/^__Secure-homeai-preview-/);
 assert.equal((await f.request('/',{headers:{cookie:'dsh-auth-owner=SYNTHETIC_OWNER; __Secure-homeai-editor-x=SYNTHETIC_EDITOR'}})).status,401);
 assert.equal((await f.request('/__editor/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({grant:link.url.split('#')[1]})})).status,401);
 const claim=await f.claim();assert.match(claim.response.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Strict/);
 for(const headers of [{origin:'https://owner.test:19444'},{'sec-fetch-site':'same-site','sec-fetch-mode':'no-cors','sec-fetch-dest':'script'},{host:'owner.test:19444'}])assert.equal((await f.request('/',{headers:{cookie:claim.cookie,...headers}})).status,403);
 assert.equal(f.seen.length,0);
 const response=await f.request('/api/notes',{headers:{cookie:claim.cookie+'; dsh-auth-owner=SECRET',authorization:'Bearer SECRET','x-harness-owner':'SECRET','tailscale-user-login':'SECRET'}});assert.equal(response.status,200);assert.equal(f.seen.length,1);
 assert(!/SECRET|cookie|authorization|tailscale|x-harness/.test(JSON.stringify(f.seen[0])));assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.headers['access-control-allow-origin'],undefined);
 assert.equal(safeRedirect('/__preview/claim',origin,'/','/__preview'),null);
});

test('preview HTTP preserves B10-shaped relative API methods,409,204, Czech JSON and real attachment bytes',async t=>{
 const received=[];const f=await fixture(t,{purpose:'preview',upstreamHandler:async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;received.push({method:req.method,url:req.url,body});
  if(req.url==='/api/export'){res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="notes.json"'});res.write('{"items":');return res.end('["Žlutý kůň"]}');}
  if(req.method==='DELETE'){res.writeHead(204);return res.end();}
  res.writeHead(409,{'Content-Type':'application/json'});res.end('{"error":"Novější verze"}');
 }}),claim=await f.claim(),headers={cookie:claim.cookie,origin,'content-type':'application/json'},body='{"title":"Příliš","baseVersion":1}';
 const conflict=await f.request('/api/notes/n1',{method:'PATCH',headers,body});assert.equal(conflict.status,409);assert.equal(conflict.text,'{"error":"Novější verze"}');assert.deepEqual(received[0],{method:'PATCH',url:'/api/notes/n1',body});
 const download=await f.request('/api/export',{headers});assert.equal(download.status,200);assert.equal(download.headers['content-disposition'],'attachment; filename="notes.json"');assert.equal(download.text,'{"items":["Žlutý kůň"]}');
 assert.equal((await f.request('/api/notes/n1',{method:'DELETE',headers})).status,204);
 const before=f.seen.length;assert.equal((await f.request('/',{headers:{...headers,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'test','sec-websocket-version':'13'}})).status,403);assert.equal(f.seen.length,before);
});
test('HTTP removes owner credentials and upstream cookie/CORS while refusing redirects and port proxy escape',async t=>{
 const f=await fixture(t),c=await f.claim(),headers={cookie:c.cookie+'; dsh-auth-owner=SYNTHETIC_OWNER',authorization:'Bearer SYNTHETIC_OWNER','proxy-authorization':'SYNTHETIC_OWNER','tailscale-user-login':'SYNTHETIC_OWNER','x-forwarded-user':'SYNTHETIC_OWNER'};
 const r=await f.request('/?folder=%2Fworkspace',{headers});assert.equal(r.status,200);assert.equal(r.headers['set-cookie'],undefined);assert.equal(r.headers['access-control-allow-origin'],undefined);assert.ok(!JSON.stringify(f.seen).includes('SYNTHETIC_OWNER'));
 assert.match(r.headers['content-security-policy'],/frame-ancestors https:\/\/owner.test/);
 assert.equal((await f.request('/redirect',{headers})).status,502);
 for(const route of ['/proxy/3090/','/absproxy/3090/','//evil.test/','/%2fproxy/3090/'])assert.equal((await f.request(route,{headers})).status,404,route);
 assert.equal((await f.request('/write',{method:'POST',headers})).status,403);
});
test('WebSocket handshake strips owner request credentials and malicious Set-Cookie in 101 response',async t=>{
 const f=await fixture(t),c=await f.claim();
 const response=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.broker.server.address().port,path:'/',headers:{host:new URL(origin).host,origin,connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':crypto.randomBytes(16).toString('base64'),'sec-websocket-extensions':'permessage-deflate; client_max_window_bits',cookie:c.cookie+'; dsh-auth-owner=SYNTHETIC_OWNER',authorization:'Bearer SYNTHETIC_OWNER'}},res=>{res.resume();reject(Error('Expected upgrade '+res.statusCode));});req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res);});req.on('error',reject);req.end();});
 assert.equal(response.statusCode,101);assert.equal(response.headers['set-cookie'],undefined);assert.ok(!JSON.stringify(f.seen).includes('SYNTHETIC_OWNER'));assert.equal(f.seen.at(-1)['sec-websocket-extensions'],undefined);assert.equal(response.headers['sec-websocket-extensions'],undefined);
});

test('sibling editor no-cors subresources cannot use the victim cookie',async t=>{
 const f=await fixture(t),c=await f.claim();
 for(const dest of ['script','image','style','object','empty']){
  assert.equal((await f.request('/private-project.js',{headers:{cookie:c.cookie,'sec-fetch-site':'same-site','sec-fetch-mode':'no-cors','sec-fetch-dest':dest}})).status,403);
 }
 assert.equal((await f.request('/private-project.js',{headers:{cookie:c.cookie,'sec-fetch-site':''}})).status,403);
 assert.equal(f.seen.length,0);
 const nativeFrame=await f.request('/',{headers:{cookie:c.cookie,'sec-fetch-site':'same-site','sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'}});
 assert.equal(nativeFrame.status,200);assert.equal(nativeFrame.headers['cross-origin-resource-policy'],'same-origin');
 assert.match(nativeFrame.headers['content-security-policy'],/frame-ancestors https:\/\/owner.test/);
});

test('runtime renewal happens only after browser authorization and failure prevents upstream access',async t=>{
 let calls=0,allowed=false;const f=await fixture(t,{onActivity:async()=>{calls++;if(!allowed)throw Error('LEASE_EXPIRED');}});
 assert.equal((await f.request('/')).status,401);assert.equal(calls,0);
 const c=await f.claim();assert.equal(calls,0);
 assert.equal((await f.request('/',{headers:{cookie:c.cookie}})).status,503);assert.equal(calls,1);assert.equal(f.seen.length,0);
 allowed=true;assert.equal((await f.request('/',{headers:{cookie:c.cookie}})).status,200);assert.equal(calls,2);assert.equal(f.seen.length,1);
});

test('reopened grants and cookies never outlive the fixed runtime generation deadline',async t=>{
 const f=await fixture(t,{runtimeDeadline:10000});assert.equal(f.broker.issue().expiresAt,10000);assert.equal(f.broker.issue().grantExpiresAt,10000);
 f.advance(5000);const claim=await f.claim();assert.match(claim.response.headers['set-cookie'][0],/Max-Age=4(?:;|$)/);
 assert.equal(f.broker.issue().expiresAt,10000);f.advance(4000);
 assert.equal((await f.request('/',{headers:{cookie:claim.cookie}})).status,403);assert.throws(()=>f.broker.issue(),/EDITOR_CLOSED/);assert.equal(f.seen.length,0);
});
