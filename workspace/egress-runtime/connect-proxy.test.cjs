'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createProxy,authority,publicIPv4,resolvePublic,limits}=require('./connect-proxy.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
const until=async check=>{for(let n=0;n<100&&!check();n++)await new Promise(r=>setTimeout(r,2));assert(check());};
async function scoped(t,options){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-connect-bounds-')),socket=path.join(directory,'socket'),proxy=createProxy(options),clients=new Set();await new Promise(r=>proxy.server.listen(socket,r));
 t.after(async()=>{for(const client of clients)client.destroy();await proxy.close();const real=fs.realpathSync(directory);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('homeai-connect-bounds-'));fs.rmSync(real,{recursive:true,force:true});});
 return{proxy,open(request='CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n'){const client=net.createConnection(socket,()=>client.write(request));clients.add(client);client.on('error',()=>{});client.on('data',()=>{});return client;}};
}
test('all reserved IPv4 classes and numeric/encoded/mapped authorities fail closed',async()=>{
 for(const ip of ['0.1.2.3','10.1.2.3','100.64.1.1','127.0.0.1','169.254.169.254','172.31.255.255','192.168.1.1','192.0.0.9','192.0.2.1','192.88.99.1','198.18.1.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::ffff:127.0.0.1','0177.0.0.1','0x7f000001'])assert.equal(publicIPv4(ip),false,ip);
 for(const target of ['127.0.0.1','2130706433','0x7f000001','0177.0.0.1','[::1]','[::ffff:127.0.0.1]','%31%32%37.0.0.1','user:password@example.com','example.com.','local.test'])assert.throws(()=>authority(Buffer.from('CONNECT '+target+':443 HTTP/1.1\r\nHost: fixture\r\n\r\n')),/REFUSED/);
 assert.equal(authority(Buffer.from('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n')),'registry.npmjs.org');
 assert.throws(()=>authority(Buffer.from('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nProxy-Authorization: private\r\n\r\n')),/REFUSED/);
 assert.throws(()=>authority(Buffer.from('CONNECT registry.npmjs.org:80 HTTP/1.1\r\n\r\n')),/REFUSED/);
 await assert.rejects(resolvePublic('registry.npmjs.org',async()=>[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}]),/REFUSED/);
 await assert.rejects(resolvePublic('registry.npmjs.org',async()=>[{address:'::ffff:10.0.0.1',family:6}]),/REFUSED/);
});
test('real UNIX transport connects only the exact validated public address and preserves binary tunnel bytes',{skip:process.platform==='win32'},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-connect-proxy-')),socket=path.join(directory,'socket');
 const echo=net.createServer({allowHalfOpen:true},client=>client.pipe(client));await new Promise(r=>echo.listen(0,'127.0.0.1',r));let selected,lookups=0;
 const proxy=createProxy({lookup:async(host,options)=>{lookups++;assert.equal(host,'registry.npmjs.org');assert.equal(options.family,4);return[{address:'1.1.1.1',family:4}];},connect:options=>{selected=options;return net.createConnection({host:'127.0.0.1',port:echo.address().port,allowHalfOpen:true});}});await new Promise(r=>proxy.server.listen(socket,r));
 t.after(async()=>{await proxy.close();await new Promise(r=>echo.close(r));const real=fs.realpathSync(directory);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('homeai-connect-proxy-'));fs.rmSync(real,{recursive:true,force:true});});
 const payload=Buffer.alloc(6*1024*1024,71),chunks=[];
 await new Promise((resolve,reject)=>{const client=net.createConnection(socket,()=>client.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n'));let response=Buffer.alloc(0),ready=false;client.on('data',chunk=>{if(ready){chunks.push(chunk);return;}response=Buffer.concat([response,chunk]);const end=response.indexOf('\r\n\r\n');if(end<0)return;assert.match(response.subarray(0,end).toString(),/200 Connection Established/);ready=true;chunks.push(response.subarray(end+4));client.end(payload);});client.on('error',reject);client.on('end',resolve);});
 assert.equal(lookups,1);assert.equal(selected.host,'1.1.1.1');assert.equal(selected.port,443);assert.equal(selected.family,4);assert.deepEqual(Buffer.concat(chunks),payload);
});
test('private DNS and malformed authority never create an upstream connection',{skip:process.platform==='win32'},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-connect-denial-')),socket=path.join(directory,'socket');let connected=0;
 const proxy=createProxy({lookup:async()=>[{address:'169.254.169.254',family:4}],connect:()=>{connected++;throw Error('SHOULD_NOT_CONNECT');},policy:{...limits,connectMs:50}});await new Promise(r=>proxy.server.listen(socket,r));
 t.after(async()=>{await proxy.close();const real=fs.realpathSync(directory);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('homeai-connect-denial-'));fs.rmSync(real,{recursive:true,force:true});});
 for(const request of ['CONNECT metadata.example.org:443 HTTP/1.1\r\n\r\n','CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n','GET http://metadata/ HTTP/1.1\r\n\r\n',''])await new Promise(resolve=>{const client=net.createConnection(socket,()=>{if(request)client.write(request);});client.on('error',()=>{});client.on('data',()=>{});client.on('close',resolve);});
 assert.equal(connected,0);assert.equal(proxy.activeConnections,0);
});
test('a late DNS reply after client disconnect cannot start a connection',{skip:process.platform==='win32'},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-connect-late-')),socket=path.join(directory,'socket');let resolveLookup,entered,connected=0;const started=new Promise(r=>entered=r);
 const proxy=createProxy({lookup:()=>{entered();return new Promise(r=>resolveLookup=r);},connect:()=>{connected++;throw Error('MUST_NOT_CONNECT');}});await new Promise(r=>proxy.server.listen(socket,r));
 t.after(async()=>{await proxy.close();const real=fs.realpathSync(directory);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('homeai-connect-late-'));fs.rmSync(real,{recursive:true,force:true});});
 const client=net.createConnection(socket,()=>client.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n'));client.on('error',()=>{});await started;client.destroy();await new Promise(r=>setTimeout(r,10));resolveLookup([{address:'1.1.1.1',family:4}]);await new Promise(r=>setTimeout(r,10));assert.equal(connected,0);
});

test('connection and in-flight DNS limits remain bounded after timed-out clients disconnect',{skip:process.platform==='win32'},async t=>{
 const replies=[];let connects=0;const f=await scoped(t,{lookup:()=>new Promise(r=>replies.push(r)),connect:()=>{connects++;throw Error('MUST_NOT_CONNECT');},policy:{...limits,connections:2,connectMs:100}});
 f.open();f.open();await until(()=>replies.length===2);const excess=f.open();await until(()=>excess.destroyed);assert.equal(replies.length,2);assert.equal(f.proxy.activeConnections,2);
 await until(()=>f.proxy.activeConnections===0);assert.equal(f.proxy.pendingResolutions,2);
 const fresh=f.open();await until(()=>fresh.destroyed);assert.equal(replies.length,2);assert.equal(connects,0);
 await f.proxy.close();for(const resolve of replies)resolve([{address:'1.1.1.1',family:4}]);await tick();assert.equal(connects,0);assert.equal(f.proxy.pendingResolutions,0);
});

test('oversized and non-ASCII headers fail before DNS and shutdown prevents late resolution',{skip:process.platform==='win32'},async t=>{
 let lookups=0,release;const f=await scoped(t,{lookup:()=>{lookups++;return new Promise(r=>release=r);},connect:()=>assert.fail('closed proxy connected')});
 for(const request of ['X'.repeat(9000),'CONNECT registry.npmjs.org:443 HTTP/1.1\r\nX: \u0001\r\n\r\n']){const client=f.open(request);await until(()=>client.destroyed);}assert.equal(lookups,0);
 f.open();await until(()=>lookups===1);await f.proxy.close();release([{address:'1.1.1.1',family:4}]);await tick();assert.equal(f.proxy.activeConnections,0);
});

test('aggregate byte allowance closes the whole generation and both ends of every tunnel',{skip:process.platform==='win32'},async t=>{
 const peers=new Set(),echo=net.createServer({allowHalfOpen:true},client=>{peers.add(client);client.on('error',()=>{});client.on('close',()=>peers.delete(client));client.pipe(client);});await new Promise(r=>echo.listen(0,'127.0.0.1',r));
 const f=await scoped(t,{lookup:async()=>[{address:'1.1.1.1',family:4}],connect:()=>net.createConnection({host:'127.0.0.1',port:echo.address().port,allowHalfOpen:true}),policy:{...limits,bytes:1024}});
 t.after(async()=>{for(const client of peers)client.destroy();await new Promise(r=>echo.close(r));});
 const a=f.open(),b=f.open();await until(()=>peers.size===2);await tick();a.write(Buffer.alloc(800));await until(()=>a.destroyed&&b.destroyed);await until(()=>peers.size===0);assert(f.proxy.transferredBytes>1024);assert.equal(f.proxy.activeConnections,0);assert.equal(f.proxy.server.listening,false);
});

test('actual TLS 1.3 stays end-to-end across CONNECT and verifies the target certificate',{skip:process.platform==='win32',timeout:5000},async t=>{
 const tls=require('node:tls'),cp=require('node:child_process'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-connect-tls-'));
 const generated=cp.spawnSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=registry.npmjs.org','-addext','subjectAltName=DNS:registry.npmjs.org','-keyout','server.key','-out','server.crt'],{cwd:directory,stdio:'ignore'});assert.equal(generated.status,0);
 const ca=fs.readFileSync(path.join(directory,'server.crt')),key=fs.readFileSync(path.join(directory,'server.key')),peers=new Set(),seen=[];
 const target=tls.createServer({key,cert:ca,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},socket=>{peers.add(socket);socket.on('error',()=>{});socket.on('data',chunk=>{seen.push(chunk);socket.end('verified TLS echo');});socket.on('close',()=>peers.delete(socket));});target.on('tlsClientError',()=>{});await new Promise(r=>target.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const socket of peers)socket.destroy();await new Promise(r=>target.close(r));const real=fs.realpathSync(directory);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('homeai-connect-tls-'));fs.rmSync(real,{recursive:true,force:true});});
 const f=await scoped(t,{lookup:async()=>[{address:'1.1.1.1',family:4}],connect:options=>{assert.equal(options.host,'1.1.1.1');assert.equal(options.port,443);return net.createConnection({host:'127.0.0.1',port:target.address().port,allowHalfOpen:true});}});
 async function tunnel(servername){
   const client=f.open();await new Promise((resolve,reject)=>{let header=Buffer.alloc(0);const receive=chunk=>{header=Buffer.concat([header,chunk]);if(!header.includes('\r\n\r\n'))return;assert.match(header.toString(),/^HTTP\/1.1 200/);client.removeListener('data',receive);resolve();};client.on('data',receive);client.once('error',reject);});
   return new Promise((resolve,reject)=>{const chunks=[],socket=tls.connect({socket:client,servername,ca,minVersion:'TLSv1.3',rejectUnauthorized:true},()=>{assert(socket.authorized);assert.equal(socket.getProtocol(),'TLSv1.3');socket.write('project TLS payload');});socket.on('data',chunk=>chunks.push(chunk));socket.on('end',()=>resolve(Buffer.concat(chunks).toString()));socket.on('error',reject);});
 }
 assert.equal(await tunnel('registry.npmjs.org'),'verified TLS echo');assert.equal(Buffer.concat(seen).toString(),'project TLS payload');await assert.rejects(tunnel('wrong.example.org'),error=>error.code==='ERR_TLS_CERT_ALTNAME_INVALID');
});
