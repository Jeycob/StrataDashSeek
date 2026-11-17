'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),tls=require('node:tls'),net=require('node:net');
const{EditorTransportStore}=require('./editor-transport.cjs'),{createEditorBridge}=require('./editor-bridge.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'editor-transport-'));await fs.chmod(root,0o700);t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert.match(path.basename(real),/^editor-transport-/);await fs.rm(real,{recursive:true,force:true});});return{root,store:new EditorTransportStore(path.join(root,'secrets'))};}
test('per-generation certificates bind the exact hostname, separate client keys and remove signing material',async t=>{
 const f=await fixture(t),scope='a'.repeat(32),generation='b'.repeat(32),ready=await f.store.prepare(scope,generation),identity=await f.store.clientIdentity(scope,generation);
 assert.equal(identity.serverName,scope+'.'+generation+'.editor.homeai.invalid');assert.equal(ready.serverDirectory,path.join(f.root,'secrets','guest-server',scope,generation));
 assert.deepEqual((await fs.readdir(ready.serverDirectory)).sort(),['ca.crt','server.crt','server.key']);assert.deepEqual((await fs.readdir(ready.clientDirectory)).sort(),['ca.crt','client.crt','client.key']);assert.equal((await fs.readdir(path.join(f.root,'secrets'))).some(n=>n.startsWith('.prepare-')),false);
 assert.deepEqual(await f.store.prepare(scope,generation),ready);
 const other=await f.store.prepare(scope,'c'.repeat(32));assert.notDeepEqual(await fs.readFile(path.join(other.serverDirectory,'ca.crt')),identity.ca);
 await fs.writeFile(path.join(ready.serverDirectory,'server.key'),await fs.readFile(path.join(other.serverDirectory,'server.key')));await assert.rejects(f.store.clientIdentity(scope,generation),/CERTIFICATE_INVALID/);
 await assert.rejects(f.store.prepare('../escape',generation),/SCOPE_INVALID/);
});
test('private host bridge forwards authenticated bytes only to its exact scoped TLS peer and closes active channels',{timeout:10000},async t=>{
 const f=await fixture(t),scope='d'.repeat(32),generation='e'.repeat(32),ready=await f.store.prepare(scope,generation),identity=await f.store.clientIdentity(scope,generation);let observed=0;const sockets=new Set();
 const server=tls.createServer({key:await fs.readFile(path.join(ready.serverDirectory,'server.key')),cert:await fs.readFile(path.join(ready.serverDirectory,'server.crt')),ca:identity.ca,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.3',allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('data',data=>{observed+=data.length;socket.write(data);});socket.on('end',()=>socket.end());socket.on('close',()=>sockets.delete(socket));});server.on('tlsClientError',(_error,socket)=>socket.destroy());server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 let port;for(let candidate=19180;candidate<=19243;candidate++){try{await new Promise((resolve,reject)=>{const failed=e=>{server.removeListener('listening',ready);reject(e);},ready=()=>{server.removeListener('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen(candidate,'127.0.0.1');});port=candidate;break;}catch(error){if(error.code!=='EADDRINUSE')throw error;}}assert.ok(port);
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 const bridge=await createEditorBridge({directory:path.join(f.root,'sockets'),sessionId:'A',generation,hostPort:port,transportIdentity:identity});t.after(()=>bridge.close());
 const payload=Buffer.alloc(512*1024,37),received=[];
 await new Promise((resolve,reject)=>{const client=net.createConnection(bridge.socketPath,()=>client.end(payload));client.on('data',b=>received.push(b));client.on('error',reject);client.on('end',resolve);});assert.deepEqual(Buffer.concat(received),payload);assert.equal(observed,payload.length);
 await bridge.close();const wrong=await createEditorBridge({directory:path.join(f.root,'sockets'),sessionId:'B',generation,hostPort:port,transportIdentity:{...identity,serverName:'f'.repeat(32)+'.'+generation+'.editor.homeai.invalid'}});t.after(()=>wrong.close());
 await new Promise(resolve=>{const client=net.createConnection(wrong.socketPath,()=>client.end('MUST_NOT_FORWARD'));client.on('error',()=>{});client.on('close',resolve);});assert.equal(observed,payload.length);
 await assert.rejects(createEditorBridge({directory:path.join(f.root,'sockets'),sessionId:'C',generation,hostPort:port}),/IDENTITY_REQUIRED/);
});
