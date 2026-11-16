'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const{createEditorBroker}=require('./editor-broker.cjs');
const origin='https://owner.test:19443',ownerOrigin='https://owner.test';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'editor-broker-')),socketPath=process.platform==='win32'?'\\\\.\\pipe\\homeai-editor-'+crypto.randomUUID():path.join(dir,'code.sock'),seen=[];let clock=1000;
 const upstream=http.createServer((req,res)=>{seen.push(req.headers);if(req.url==='/redirect')res.writeHead(302,{'Location':'https://evil.test/','Set-Cookie':'dsh-auth-fixation=evil'});else res.writeHead(200,{'Content-Type':'application/json','Set-Cookie':'dsh-auth-fixation=evil','Access-Control-Allow-Origin':'*'});res.end('{"editor":true}');});
 const live=new Set();upstream.on('connection',s=>{live.add(s);s.on('close',()=>live.delete(s));});
 upstream.on('upgrade',(req,socket)=>{seen.push(req.headers);const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+accept+'\r\nSet-Cookie: dsh-auth-fixation=evil\r\n\r\n');});
 await new Promise((resolve,reject)=>{upstream.once('error',reject);upstream.listen(socketPath,resolve);});
 const broker=createEditorBroker({sessionId:'project-A',generation:'g1',origin,ownerOrigin,socketPath,now:()=>clock});await new Promise(resolve=>broker.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{broker.close();for(const s of live)s.destroy();await new Promise(resolve=>upstream.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 function request(url,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:broker.server.address().port,path:url,method,headers:{host:new URL(origin).host,'sec-fetch-site':'same-origin',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);});}
 async function claim(){const grant=broker.issue().url.split('#')[1],r=await request('/__editor/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({grant})});assert.equal(r.status,200);return{grant,cookie:r.headers['set-cookie'][0].split(';')[0],response:r};}
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
