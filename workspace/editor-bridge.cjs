'use strict';
// Native-owned private UNIX listener -> one validated QEMU loopback forward.
// Protocol bytes cannot select another destination. HTTP auth stays in broker.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),tls=require('node:tls'),crypto=require('node:crypto');
async function createEditorBridge({directory,sessionId,generation,hostPort,transportIdentity}){
 if(!path.isAbsolute(directory||'')||!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId||'')||!/^[a-f0-9]{32}$/.test(generation||'')||!Number.isInteger(hostPort)||hostPort<19180||hostPort>19243)throw Error('EDITOR_BRIDGE_CONFIGURATION_INVALID');
 if(!transportIdentity||!Buffer.isBuffer(transportIdentity.ca)||!Buffer.isBuffer(transportIdentity.cert)||!Buffer.isBuffer(transportIdentity.key)||!/^[a-f0-9]{32}\.[a-f0-9]{32}\.editor\.homeai\.invalid$/.test(transportIdentity.serverName||''))throw Error('EDITOR_TRANSPORT_IDENTITY_REQUIRED');
 await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==path.resolve(directory)||process.platform!=='win32'&&(stat.uid!==process.getuid()||stat.mode&0o077))throw Error('EDITOR_BRIDGE_DIRECTORY_UNSAFE');
 const id=crypto.createHash('sha256').update(sessionId+'\0'+generation).digest('hex').slice(0,32),socketPath=process.platform==='win32'?'\\\\.\\pipe\\homeai-editor-'+id:path.join(directory,id+'.sock');
 const peers=new Set();let closed=false;
 const server=net.createServer({allowHalfOpen:true,highWaterMark:65536},client=>{
  if(closed||peers.size>=32){client.destroy();return;}client.pause();
  const upstream=tls.connect({host:'127.0.0.1',port:hostPort,servername:transportIdentity.serverName,ca:transportIdentity.ca,cert:transportIdentity.cert,key:transportIdentity.key,rejectUnauthorized:true,minVersion:'TLSv1.3',allowHalfOpen:true,highWaterMark:65536});const pair={client,upstream};peers.add(pair);let bytes=0,ends=0;
  const stop=()=>{clearTimeout(connect);clearTimeout(lifetime);client.destroy();upstream.destroy();};
  const connect=setTimeout(stop,5000),lifetime=setTimeout(stop,3600000);connect.unref();lifetime.unref();
  for(const socket of [client,upstream]){socket.on('error',stop);socket.on('close',()=>{if(!socket.readableEnded||!socket.writableFinished)stop();if(++ends===2){peers.delete(pair);clearTimeout(connect);clearTimeout(lifetime);}});socket.setTimeout(120000,stop);socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>256*1024**2)stop();});}
  upstream.once('secureConnect',()=>{clearTimeout(connect);if(closed||!upstream.authorized)return stop();client.pipe(upstream);upstream.pipe(client);client.resume();});
 });
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});if(process.platform!=='win32')await fs.chmod(socketPath,0o600);}catch(error){server.close();throw error;}
 return{socketPath,async close(){if(closed)return;closed=true;for(const p of peers){p.client.destroy();p.upstream.destroy();}await new Promise(resolve=>server.close(resolve));}};
}
module.exports={createEditorBridge};
