'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const{createOwnerAPI}=require('./owner-api.cjs');
test('packaged maintenance helper authenticates locally without mutating sessions',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'harness-owner-fixture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/logs');await fs.writeFile(root+'/config.json',JSON.stringify({publicHost:'fixture.ts.net'}));await fs.writeFile(root+'/logs/harness.log','https://fixture.ts.net/?token=fixture-only\n');let methods=[];
 const server=http.createServer(async(req,res)=>{assert.equal(req.headers.host,'fixture.ts.net');if(req.method==='GET'){assert.equal(req.url,'/?token=fixture-only');res.writeHead(303,{'Set-Cookie':'owner=fixture; HttpOnly; Path=/'});res.end();return;}assert.equal(req.headers.cookie,'owner=fixture');assert.equal(req.headers.origin,'https://fixture.ts.net');let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);methods.push(body.method);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result:{ok:true,value:{items:[]}}}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const api=createOwnerAPI({root,port:server.address().port}),cookie=await api.login();assert.deepEqual(await api.call('session/list',{},cookie),{items:[]});assert.deepEqual(methods,['session/list']);
 await fs.writeFile(root+'/logs/harness.log','https://foreign.invalid/?token=fixture-only\n');await assert.rejects(api.login(),/authority mismatch/u);
});
