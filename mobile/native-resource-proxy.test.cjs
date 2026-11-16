'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const{nativeResourceRoute,proxyNativeResource}=require('./native-resource-proxy.cjs');
async function fixture(t,handler,options={}){
 const upstream=http.createServer(handler);await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const proxy=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://fixture');let raw='';for await(const c of req)raw+=c;await proxyNativeResource({route:u.pathname,method:req.method,query:u.searchParams,cookie:'dsh-auth-fixture=synthetic',payload:raw?JSON.parse(raw):undefined,res,port:upstream.address().port,publicHost:'owner.test',...options});}catch{res.writeHead(400);res.end();}});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));t.after(async()=>{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);});
 return{request:(p,body)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:proxy.address().port,path:p,method:body?'POST':'GET'},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));res.on('error',reject);});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);})};
}
test('fixed Native route preserves explicit session/operation and action body without adding global authority',async t=>{
 let observed;const f=await fixture(t,async(req,res)=>{let raw='';for await(const c of req)raw+=c;observed={path:req.url,headers:req.headers,body:JSON.parse(raw)};res.writeHead(202,{'Content-Type':'application/json','Set-Cookie':'evil=1','Access-Control-Allow-Origin':'*'});res.end('{"queued":true}');});
 const body={sessionId:'A',phase:'apply',operationId:'op',planHash:'hash',action:'delete'},r=await f.request('/resource-action?sessionId=A&root=forbidden',body);
 assert.equal(r.status,202);assert.deepEqual(JSON.parse(r.text),{queued:true});assert.equal(observed.path,'/api/workbench/docker-resources?sessionId=A');assert.deepEqual(observed.body,body);assert.equal(observed.headers.origin,'https://owner.test');assert.equal(r.headers['set-cookie'],undefined);assert.equal(r.headers['access-control-allow-origin'],undefined);
 assert.equal(nativeResourceRoute('/resources','POST'),null);assert.equal(nativeResourceRoute('//evil.test','GET'),null);
});
test('authenticated export bytes stream intact and response limits and redirects fail closed',async t=>{
 const bytes='synthetic-file-content'.repeat(4000);const f=await fixture(t,(req,res)=>{if(req.url.includes('operationId=huge')){res.writeHead(200,{'Content-Length':999999});return res.end();}if(req.url.includes('operationId=redirect')){res.writeHead(302,{Location:'https://evil.test/'});return res.end();}res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="fixture.tar"'});for(let i=0;i<bytes.length;i+=1024)res.write(bytes.slice(i,i+1024));res.end();},{maxDownloadBytes:100000});
 const r=await f.request('/resource-export-download?sessionId=A&operationId=ok');assert.equal(r.status,200);assert.equal(r.text,bytes);assert.match(r.headers['content-disposition'],/fixture.tar/);
 assert.equal((await f.request('/resource-export-download?sessionId=A&operationId=huge')).status,502);assert.equal((await f.request('/resource-export-download?sessionId=A&operationId=redirect')).status,502);
});
