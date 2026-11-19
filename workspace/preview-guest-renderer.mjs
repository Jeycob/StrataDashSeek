import tls from 'node:tls';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile,lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {ownedPreviewAssets,pinnedPreviewBrowser,previewSnapshotPosition,renderPreviewSnapshot} from './preview-snapshot.mjs';

const failure = () => Object.assign(Error('PREVIEW_SNAPSHOT_GUEST_UNAVAILABLE'),{code:'PREVIEW_SNAPSHOT_GUEST_UNAVAILABLE',status:409});
const maxFrame = 3 * 1024 * 1024;
const maxWire = 13 * 1024 * 1024;
const bootId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const name = /^[a-z0-9-]{1,63}\.preview\.homeai\.invalid$/;
const id = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/;
const exact = (v,keys) => v && typeof v === 'object' && Object.keys(v).sort().join(',') === keys;
const identity = (v,key) => typeof v[key] === 'string' && id.test(v[key]);

function framing(socket) {
 socket.on('error',()=>{});
 async function* frames() {
  let pending = Buffer.alloc(0), received = 0;
  for await (const chunk of socket) {
   if ((received += chunk.length) > maxWire) throw failure();
   pending = Buffer.concat([pending,chunk]);
   let boundary;
   while ((boundary = pending.indexOf(10)) >= 0) {
    if (!boundary || boundary > maxFrame) throw failure();
    const line = pending.subarray(0,boundary);
    pending = pending.subarray(boundary+1);
    yield JSON.parse(line.toString('utf8'));
   }
   if (pending.length > maxFrame) throw failure();
  }
 }
 const reader=frames();
 let sent=0;
 return {
  async read(){const next=await reader.next();if(next.done)throw failure();return next.value;},
  async write(value){
   const data=Buffer.from(JSON.stringify(value)+'\n');
   if (data.length>maxFrame || (sent+=data.length)>maxWire) throw failure();
   await new Promise((resolve,reject)=>socket.write(data,error=>error?reject(error):resolve()));
  },
 };
}

function validateStart(value,instance) {
 if (!exact(value,'binding,instance,layout,nonce,route,scrollY,type,version') ||
     value.type!=='render' || value.version!==1 || value.instance!==instance || !bootId.test(value.nonce) ||
     !['mobile','desktop'].includes(value.layout) ||
     !exact(value.binding,'deadline,generation,previewId,projectId,sessionId') ||
     !['sessionId','generation','projectId','previewId'].every(key=>identity(value.binding,key)) ||
     !Number.isSafeInteger(value.binding.deadline) || value.binding.deadline<=Date.now() ||
     value.binding.deadline>Date.now()+10000) throw failure();
 previewSnapshotPosition(value.route,value.scrollY);
}

function checkImage(image,start) {
 const [width,height] = start.layout==='mobile' ? [390,720] : [960,620];
 if (!exact(image,'height,maxScrollY,png,regions,route,scrollStep,scrollY,width') ||
     image.route!==start.route || image.width!==width || image.height!==height ||
     typeof image.png!=='string' || image.png.length>1_398_104 ||
     !Array.isArray(image.regions) || image.regions.length>120 ||
     !Number.isSafeInteger(image.scrollY) || !Number.isSafeInteger(image.maxScrollY) ||
     image.scrollY<0 || image.scrollY>image.maxScrollY || image.maxScrollY>20000 ||
     !Number.isSafeInteger(image.scrollStep) || image.scrollStep<1 || image.scrollStep>1000) throw failure();
 const png=Buffer.from(image.png,'base64');
 if (png.length<24 || png.length>1024*1024 || png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' ||
     png.readUInt32BE(16)!==width || png.readUInt32BE(20)!==height ||
     image.regions.some(r=>!exact(r,'height,selector,width,x,y') ||
       typeof r.selector!=='string' || !/^[A-Za-z0-9_#> :()-]{1,256}$/.test(r.selector) ||
       ![r.x,r.y,r.width,r.height].every(Number.isSafeInteger) || r.x<0 || r.y<0 ||
       r.width<1 || r.height<1 || r.x+r.width>width || r.y+r.height>height)) throw failure();
 return image;
}

export function createGuestPreviewSnapshot({port,serverName,instance,credentials}) {
 return async options => {
  const signal=options.signal;
  let socket;
  const abort=()=>socket?.destroy();
  try {
   if (!Number.isInteger(port)||port<1024||port>65535||!name.test(serverName)||!bootId.test(instance)) throw failure();
   const position=previewSnapshotPosition(options.route,options.scrollY);
   const start={type:'render',version:1,instance,nonce:randomUUID(),binding:options.binding,layout:options.layout,...position};
   validateStart(start,instance);
   options.assertCurrent();
   const keys=await credentials();
   signal.throwIfAborted();
   socket=tls.connect({...keys,host:'127.0.0.1',port,servername:serverName,minVersion:'TLSv1.3',rejectUnauthorized:true});
   signal.addEventListener('abort',abort,{once:true});
   await once(socket,'secureConnect',{signal});
   const wire=framing(socket), readAsset=ownedPreviewAssets(options);
   await wire.write(start);
   let requests=0;
   for (;;) {
    const message=await wire.read();
    options.assertCurrent();
    signal.throwIfAborted();
    if (message?.nonce!==start.nonce) throw failure();
    if (exact(message,'image,nonce,type')&&message.type==='image') return checkImage(message.image,start);
    if (!exact(message,'nonce,path,type')||message.type!=='asset'||++requests>48) throw failure();
    const asset=await readAsset(message.path).catch(()=>null);
    options.assertCurrent();
    signal.throwIfAborted();
    await wire.write({type:'asset-result',nonce:start.nonce,asset:asset&&{...asset,body:asset.body.toString('base64')}});
   }
  } catch { throw failure(); }
  finally {signal.removeEventListener('abort',abort);socket?.destroy();}
 };
}

export function startPreviewGuestWorker({host,port,instance,credentials,browser}) {
 if (!bootId.test(instance)) throw failure();
 const server=tls.createServer({...credentials,minVersion:'TLSv1.3',requestCert:true,rejectUnauthorized:true,handshakeTimeout:2500},async socket=>{
  const cancel=new AbortController();
  socket.setTimeout(10000,()=>socket.destroy());
  socket.once('close',()=>cancel.abort());
  const wire=framing(socket);
  try {
   const start=await wire.read();
   validateStart(start,instance);
   const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(Math.max(1,start.binding.deadline-Date.now()))]);
   signal.addEventListener('abort',()=>socket.destroy(),{once:true});
   let assets=Promise.resolve();
   function readAsset(path) {
    const request=assets.then(async()=>{
     signal.throwIfAborted();
     await wire.write({type:'asset',path,nonce:start.nonce});
     const value=await wire.read();
     if (!exact(value,'asset,nonce,type')||value.type!=='asset-result'||value.nonce!==start.nonce||!value.asset) throw failure();
     const {body,status,headers}=value.asset;
     if (typeof body!=='string'||body.length>2_796_204||!Number.isInteger(status)||status<200||status>=300||
         !headers||Object.keys(headers).some(key=>!['content-type','content-security-policy'].includes(key)||
            typeof headers[key]!=='string'||headers[key].length>8192)) throw failure();
     return {status,headers,body:Buffer.from(body,'base64')};
    });
    assets=request.catch(()=>{});
    return request;
   }
   const image=await renderPreviewSnapshot({...start,readAsset,signal,assertCurrent:()=>signal.throwIfAborted()},browser);
   await wire.write({type:'image',nonce:start.nonce,image});
   socket.end();
  } catch {socket.destroy();}
 });
 server.maxConnections=4;
 return server.listen(port,host);
}

async function privateCredentials(directory,role) {
 const dir=await lstat(directory);
 if (!dir.isDirectory() || dir.mode&0o077 || dir.uid!==process.getuid() || await realpath(directory)!==directory) throw failure();
 const values=await Promise.all(['ca.crt',role+'.crt',role+'.key'].map(async file=>{
  const handle=await open(path.join(directory,file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
   const info=await handle.stat();
   if (!info.isFile() || info.nlink!==1 || info.size<1 || info.size>65536 || info.mode&0o077 || info.uid!==process.getuid()) throw failure();
   return await handle.readFile();
  } finally {await handle.close();}
 }));
 return {ca:values[0],cert:values[1],key:values[2]};
}

export function configuredGuestPreview(settings) {
 if (!exact(settings,'instance,port,serverName')) return async()=>{throw failure();};
 return createGuestPreviewSnapshot({...settings,credentials:()=>privateCredentials('/data/harness/secrets/preview-renderer','client')});
}

export async function runPreviewGuestWorker(port) {
 if (process.platform!=='linux'||!process.getuid()||!Number.isInteger(port)||port<1024||port>65535) throw failure();
 const instance=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 const credentials=await privateCredentials('/run/homeai-preview-renderer','server');
 return startPreviewGuestWorker({host:'10.0.2.15',port,instance,credentials,browser:{loadBrowser:()=>pinnedPreviewBrowser({guest:true})}});
}
