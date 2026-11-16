'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{once}=require('node:events'),{createHash}=require('node:crypto'),{fork,spawn}=require('node:child_process');
const {HOST,PORT,SOCKET,LIMITS,parseArguments,childEnvironment,startForwarder}=require('./egress-launch.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const closed=s=>s.destroyed?Promise.resolve():new Promise(r=>s.once('close',r));
async function until(check){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('bounded wait');}
async function fixture(t,{limits={},onUnix=s=>s.on('end',()=>s.end()),hang=false,absent=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-egress-test-')),socketPath=path.join(directory,'proxy.sock'),sockets=new Set(),clients=new Set();
 const observed={upstreams:0,backpressure:0,maxQueue:0};
 const unix=net.createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));observed.upstreams++;onUnix(socket);});
 await new Promise((resolve,reject)=>{unix.once('error',reject);unix.listen(socketPath,resolve);});
 function track(socket){const write=socket.write;socket.write=function(...args){const value=write.apply(this,args);if(!value)observed.backpressure++;observed.maxQueue=Math.max(observed.maxQueue,this.writableLength);return value;};return socket;}
 const network={createServer(options,accept){assert.equal(options.highWaterMark,65536);const server=net.createServer(options,socket=>accept(track(socket))),listen=server.listen;server.listen=function(options,callback){assert.equal(options.host,HOST);assert.equal(options.port,PORT);return listen.call(server,{...options,port:0},callback);};return server;},createConnection(options){assert.equal(options.path,SOCKET);return track(hang?new net.Socket({allowHalfOpen:true}):net.createConnection({...options,path:absent?socketPath+'.missing':socketPath}));}};
 const forwarder=await startForwarder({network,limits:{...LIMITS,...limits}});
 async function connect(){const client=net.createConnection({host:'127.0.0.1',port:forwarder.address().port});clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));await once(client,'connect');return client;}
 t.after(async()=>{for(const socket of clients)socket.destroy();for(const socket of sockets)socket.destroy();await forwarder.close();await new Promise(r=>unix.close(r));const canonical=await fs.realpath(directory);assert.equal(canonical,directory);assert(path.basename(directory).startsWith('homeai-egress-test-'));await fs.rm(directory,{recursive:true});});
 return{directory,socketPath,forwarder,connect,observed};
}
test('actual TCP to UNIX transport is opaque, preserves half-close and bounded backpressure',{skip:process.platform==='win32',timeout:5000},async t=>{
 const request=Buffer.alloc(2*1024*1024,0xa9),response=Buffer.alloc(4*1024*1024,0x53),hash=v=>createHash('sha256').update(v).digest('hex');let seen;
 const f=await fixture(t,{onUnix(socket){const digest=createHash('sha256');socket.pause();setTimeout(()=>socket.resume(),40);socket.on('data',chunk=>digest.update(chunk));socket.on('end',()=>{seen=digest.digest('hex');socket.end(response);});}});
 const client=await f.connect(),chunks=[];client.on('data',c=>chunks.push(c));client.pause();client.end(request);setTimeout(()=>client.resume(),80);await once(client,'end');await until(()=>f.forwarder.activeConnections()===0);
 assert.equal(seen,hash(request));assert.equal(hash(Buffer.concat(chunks)),hash(response));assert(f.observed.backpressure>0);assert(f.observed.maxQueue<=131072);assert.equal(f.forwarder.transferredBytes(),request.length+response.length);
});
test('connection cap and aggregate byte budget deny additional upstreams',{skip:process.platform==='win32',timeout:3000},async t=>{
 const f=await fixture(t,{limits:{connections:1,bytes:1024},onUnix(socket){socket.on('data',c=>socket.write(c));}}),first=await f.connect();first.resume();await until(()=>f.observed.upstreams===1);
 const extra=await f.connect();extra.resume();await closed(extra);assert.equal(f.observed.upstreams,1);
 first.write(Buffer.alloc(700));await closed(first);await until(()=>f.forwarder.activeConnections()===0);
 const exhausted=await f.connect();exhausted.resume();await closed(exhausted);assert.equal(f.observed.upstreams,1);
});
test('connect, idle, lifetime, missing target and explicit close bound endpoints',{skip:process.platform==='win32',timeout:4000},async t=>{
 for(const [name,options]of [['connect',{hang:true,limits:{connectMs:25}}],['idle',{limits:{idleMs:25}}],['lifetime',{limits:{lifetimeMs:25}}],['missing',{absent:true}],['close',{}]])await t.test(name,async t=>{
  const f=await fixture(t,options),client=await f.connect();client.resume();if(name==='close')await f.forwarder.close();await closed(client);await until(()=>f.forwarder.activeConnections()===0);
 });
});
test('CLI accepts only one bounded command and fixes proxy environment without changing server values',()=>{
 assert.equal(parseArguments(['echo ok']),'echo ok');for(const args of [[],['a','b'],[''],['x'.repeat(65537)],['x\0y']])assert.throws(()=>parseArguments(args));
 const env=childEnvironment({PATH:'/usr/bin',PORT:'21000',HOME:'/unsafe',HTTPS_PROXY:'http://foreign',ALL_PROXY:'bad',all_proxy:'bad',NO_PROXY:'*'});
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy'])assert.equal(env[key],'http://127.0.0.1:18199');assert.equal(env.NO_PROXY,'localhost,127.0.0.1,::1');assert.equal(env.no_proxy,env.NO_PROXY);assert.equal(env.NODE_USE_ENV_PROXY,'1');assert.equal(env.HOME,'/home/coder');assert.equal(env.PORT,'21000');assert.equal(env.ALL_PROXY,undefined);assert.equal(env.all_proxy,undefined);
});
async function cli(t,command){
 const f=await fixture(t),preload=path.join(f.directory,'network.cjs');
 await fs.writeFile(preload,`const net=require('node:net'),assert=require('node:assert/strict'),create=net.createServer,connect=net.createConnection;
net.createServer=function(options,accept){const s=create(options,accept),listen=s.listen;s.listen=function(options,cb){assert.equal(options.host,'127.0.0.1');assert.equal(options.port,18199);return listen.call(s,{...options,port:0},()=>{cb();setImmediate(()=>process.send({ready:true}));});};return s;};
net.createConnection=function(options){assert.equal(options.path,'/run/homeai-egress/proxy.sock');return connect({...options,path:${JSON.stringify(f.socketPath)}});};`);
 const child=fork(path.join(__dirname,'egress-launch.cjs'),[command],{execArgv:['--require',preload],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,HTTP_PROXY:'http://foreign',HOME:'/unsafe'}});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});await once(child,'message');
 return{child,exited,output:()=>({stdout,stderr})};
}
test('actual launcher preserves child exit, pipefail and fixed proxy env',{skip:process.platform==='win32',timeout:4000},async t=>{
 const f=await cli(t,'printf "%s" "$HTTP_PROXY|$HTTPS_PROXY|$NODE_USE_ENV_PROXY|$HOME"; exit 23'),[code,signal]=await f.exited;assert.equal(code,23);assert.equal(signal,null);assert.equal(f.output().stdout,'http://127.0.0.1:18199|http://127.0.0.1:18199|1|/home/coder');assert.equal(f.output().stderr,'');
 const failed=await cli(t,'false | true'),[pipeCode]=await failed.exited;assert.equal(pipeCode,1);
});
test('actual SIGTERM cancels only owned child and retains termination signal',{skip:process.platform==='win32',timeout:5000},async t=>{
 const canary=spawn('/bin/sleep',['10']);t.after(()=>canary.kill('SIGKILL'));
 const f=await cli(t,'exec /bin/sleep 30');f.child.kill('SIGTERM');const[code,signal]=await f.exited;assert.equal(code,null);assert.equal(signal,'SIGTERM');assert.equal(canary.exitCode,null);assert.equal(canary.signalCode,null);assert.equal(f.output().stderr,'');
});
