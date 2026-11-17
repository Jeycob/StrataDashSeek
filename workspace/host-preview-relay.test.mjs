// Ephemeral local sockets and synthetic proof callback, never a real proc scan
// or product/Native endpoint. The kernel connector's own tests remain separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPreviewRelay} from './host-preview-relay.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let n=0;n<100;n++){if(check())return;await tick();}assert.fail('relay fixture timed out');}
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'preview-relay-')),socketPath=process.platform==='win32'?'\\\\.\\pipe\\homeai-preview-'+randomUUID():path.join(directory,'relay.sock');
 const received=[],accepted=new Set(),created=new Set();let decide,proofRequested=false,assertions=0;
 const proof=new Promise((resolve,reject)=>{decide={resolve,reject};});void proof.catch(()=>{});
 const target=net.createServer(socket=>{accepted.add(socket);socket.on('data',bytes=>{received.push(Buffer.from(bytes));socket.write(bytes);});socket.on('error',()=>{});socket.on('close',()=>accepted.delete(socket));});
 await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
 const relay=await createPreviewRelay({socketPath,assertCurrent(){assertions++;},async connect(options){
  assert.deepEqual(Object.keys(options).sort(),['deadline','signal']);const socket=new net.Socket();created.add(socket);socket.pause();socket.on('error',()=>{});let finish;
  const done=new Promise(resolve=>{finish=resolve;});socket.once('close',()=>{created.delete(socket);finish();});
  options.signal.addEventListener('abort',()=>socket.destroy(),{once:true});
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.connect(target.address().port,'127.0.0.1',resolve);});proofRequested=true;
  try{await proof;options.signal.throwIfAborted();return{socket,done,close:()=>socket.destroy()};}catch(error){socket.destroy();throw error;}
 }});
 const client=net.createConnection(socketPath);client.on('error',()=>{});const reply=[];client.on('data',bytes=>reply.push(Buffer.from(bytes)));
 await new Promise(resolve=>client.once('connect',resolve));
 t.after(async()=>{decide.reject(Error('fixture cleanup'));client.destroy();await relay.close();for(const socket of created)socket.destroy();for(const socket of accepted)socket.destroy();await new Promise(resolve=>target.close(resolve));assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'preview-relay-'));await fs.rm(directory,{recursive:true,force:true});});
 return{relay,client,received,reply,target,decide,created,get proofRequested(){return proofRequested;},get assertions(){return assertions;}};
}
test('private relay sends zero HTTP bytes until own-peer proof and then preserves exact bidirectional bytes',async t=>{
 const f=await fixture(t),payload=Buffer.from('PATCH /api/notes/n1 HTTP/1.1\r\nContent-Length: 2\r\n\r\nč');f.client.write(payload);
 await until(()=>f.proofRequested);await tick();assert.equal(f.received.length,0);assert.equal([...f.created][0].bytesWritten,0);
 f.decide.resolve();await until(()=>Buffer.concat(f.reply).length===payload.length);assert.deepEqual(Buffer.concat(f.received),payload);assert.deepEqual(Buffer.concat(f.reply),payload);assert.equal(f.assertions,2);
 f.relay.destroyConnections();await until(()=>f.created.size===0);assert.equal(f.target.listening,true);
});
test('refused foreign peer receives zero buffered request bytes and its listener is never killed',async t=>{
 const f=await fixture(t);f.client.write('GET /native-secret HTTP/1.1\r\n\r\n');await until(()=>f.proofRequested);f.decide.reject(Object.assign(Error('foreign'),{code:'PEER_UNATTRIBUTED'}));
 await until(()=>f.created.size===0&&f.client.destroyed);assert.equal(f.received.length,0);assert.equal(f.target.listening,true);
});
test('revocation while proof is pending fences a late verified callback without forwarding buffered bytes',async t=>{
 const f=await fixture(t);f.client.write('DELETE /api/notes/n1 HTTP/1.1\r\n\r\n');await until(()=>f.proofRequested);f.relay.destroyConnections();f.decide.resolve();await until(()=>f.created.size===0);await tick();assert.equal(f.received.length,0);assert.equal(f.target.listening,true);
});
