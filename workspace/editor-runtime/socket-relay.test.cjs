'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const net=require('node:net'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {once}=require('node:events'), {createHash}=require('node:crypto'), {spawnSync,fork}=require('node:child_process');
const {startRelay,parseArguments,HOST,SOCKET,LIMITS}=require('./socket-relay.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const closed=socket=>socket.destroyed ? Promise.resolve() : new Promise(resolve=>socket.once('close',resolve));
const hash=value=>createHash('sha256').update(value).digest('hex');
async function until(predicate) { for(let n=0;n<200;n++){if(predicate())return;await delay(5);}throw Error('test condition timed out'); }

async function fixture(t,{limits={},onUnix=socket=>socket.on('end',()=>socket.end()),hangConnect=false,missingTarget=false}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-relay-test-'));
  const socketPath=path.join(directory,'synthetic.sock'), peers=new Set(), clients=new Set();
  const observed={connects:0,backpressure:0,maxQueued:0};
  const unix=net.createServer({allowHalfOpen:true},socket=>{
    peers.add(socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket));
    observed.connects++;onUnix(socket);
  });
  await new Promise((resolve,reject)=>{unix.once('error',reject);unix.listen(socketPath,resolve);});
  function track(socket) {
    const write=socket.write;
    socket.write=function(...args){const result=write.apply(this,args);observed.maxQueued=Math.max(observed.maxQueued,this.writableLength);if(!result)observed.backpressure++;return result;};
    return socket;
  }
  const network={
    createServer(options,accept) {
      assert.equal(options.pauseOnConnect,true);assert.equal(options.highWaterMark,64*1024);
      const server=net.createServer(options,socket=>accept(track(socket))),listen=server.listen;
      server.listen=function(options,callback){
        assert.equal(options.host,HOST);assert.equal(options.port,29000);assert.equal(options.exclusive,true);
        return listen.call(this,{...options,host:'127.0.0.1',port:0},callback);
      };
      return server;
    },
    createConnection(options) {
      assert.equal(options.path,SOCKET);assert.equal(options.highWaterMark,64*1024);
      return track(hangConnect ? new net.Socket({allowHalfOpen:true}) : net.createConnection({...options,path:missingTarget ? socketPath+'.absent' : socketPath}));
    }
  };
  const relay=await startRelay(29000,{network,limits:{...LIMITS,shutdownMs:50,...limits}});
  async function connect() {
    const client=net.createConnection({host:'127.0.0.1',port:relay.address().port});
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    await once(client,'connect');return client;
  }
  t.after(async()=>{
    for(const socket of clients)socket.destroy();
    for(const socket of peers)socket.destroy();
    await relay.close();
    await new Promise(resolve=>unix.close(resolve));
    // Only the exclusively created synthetic fixture directory is removed.
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {relay,connect,observed,directory,socketPath};
}

test('opaque binary stream preserves half-close response with actual backpressure',{timeout:5000,skip:process.platform==='win32'},async t=>{
  const request=Buffer.alloc(2*1024*1024,0xa7),response=Buffer.alloc(4*1024*1024,0x53);
  let requestDigest;
  const f=await fixture(t,{onUnix(socket){
    const digest=createHash('sha256');socket.pause();setTimeout(()=>socket.resume(),40);
    socket.on('data',chunk=>digest.update(chunk));
    socket.on('end',()=>{requestDigest=digest.digest('hex');socket.end(response);});
  }});
  const client=await f.connect(),chunks=[];
  client.on('data',chunk=>chunks.push(chunk));client.pause();
  client.end(request);setTimeout(()=>client.resume(),80);
  await once(client,'end');await until(()=>f.relay.activeConnections()===0);
  assert.equal(requestDigest,hash(request));assert.equal(hash(Buffer.concat(chunks)),hash(response));
  assert(f.observed.backpressure>0,'must actually exercise backpressure');
  assert(f.observed.maxQueued<=2*LIMITS.highWaterMark,'bounded writable queue plus one input chunk');
});

test('connection cap rejects overflow before opening another UNIX stream',{timeout:3000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,{limits:{connections:2}});
  const first=await f.connect(),second=await f.connect();
  await until(()=>f.observed.connects===2);
  const extra=await f.connect();extra.resume();await closed(extra);
  assert.equal(f.observed.connects,2);assert.equal(f.relay.activeConnections(),2);
  first.destroy();second.destroy();await until(()=>f.relay.activeConnections()===0);
});

test('byte budget counts both directions and drops the overflowing chunk',{timeout:3000,skip:process.platform==='win32'},async t=>{
  let received=0;
  const f=await fixture(t,{limits:{bytes:1024},onUnix(socket){socket.on('data',chunk=>{received+=chunk.length;socket.write(chunk);});}});
  const client=await f.connect(),chunks=[];client.on('data',chunk=>chunks.push(chunk));
  client.write(Buffer.alloc(700));await closed(client);
  assert.equal(received,700);assert.equal(Buffer.concat(chunks).length,0);
  await until(()=>f.relay.activeConnections()===0);
});

test('connect timeout and idle timeout release both endpoints',{timeout:3000,skip:process.platform==='win32'},async t=>{
  await t.test('connect deadline',async t=>{
    const f=await fixture(t,{hangConnect:true,limits:{connectMs:30}}),client=await f.connect();
    client.resume();await closed(client);await until(()=>f.relay.activeConnections()===0);assert.equal(f.observed.connects,0);
  });
  await t.test('idle deadline',async t=>{
    const f=await fixture(t,{limits:{idleMs:30}}),client=await f.connect();
    client.resume();await closed(client);await until(()=>f.relay.activeConnections()===0);assert.equal(f.observed.connects,1);
  });
});

test('activity cannot extend lifetime; graceful stop bounds outstanding streams',{timeout:3000,skip:process.platform==='win32'},async t=>{
  await t.test('absolute lifetime',async t=>{
    const f=await fixture(t,{limits:{idleMs:100,lifetimeMs:120},onUnix(socket){socket.on('data',chunk=>socket.write(chunk));}});
    const client=await f.connect();client.resume();const interval=setInterval(()=>client.write('x'),10);
    try {await closed(client);} finally {clearInterval(interval);}
    await until(()=>f.relay.activeConnections()===0);
  });
  await t.test('grace shutdown',async t=>{
    const f=await fixture(t,{limits:{shutdownMs:40}}),client=await f.connect();client.resume();
    await until(()=>f.relay.activeConnections()===1);
    const began=Date.now(),result=await f.relay.close();
    assert.equal(result.reason,'closed');assert.equal(f.relay.activeConnections(),0);
    assert(Date.now()-began<1000);assert.equal(f.relay.address(),null);await closed(client);
  });
});

test('CLI permits only a validated assigned port and never echoes private arguments',()=>{
  assert.equal(parseArguments(['--port','29000']),29000);
  for(const args of [[],['--port','80'],['--port','65536'],['--port','1e4'],['--host','127.0.0.1'],['--port','29000','--socket','PRIVATE_TARGET']])assert.throws(()=>parseArguments(args),/RELAY_ARGUMENT_INVALID/);
  const result=spawnSync(process.execPath,[path.join(__dirname,'socket-relay.cjs'),'--port','29000','--socket','PRIVATE_TARGET'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'RELAY_START_FAILED\n');
  assert.equal(LIMITS.connections,32);assert.equal(LIMITS.bytes,256*1024*1024);assert(Object.isFrozen(LIMITS));
});

test('missing UNIX endpoint closes cleanly without a fallback target',{timeout:3000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,{missingTarget:true}),client=await f.connect();client.resume();
  await closed(client);await until(()=>f.relay.activeConnections()===0);
  assert.equal(f.observed.connects,0);
});

test('actual CLI SIGTERM stops accepting and closes an active stream after five seconds',{timeout:8000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),preload=path.join(f.directory,'synthetic-network-preload.cjs');
  // Test-process preload only. The actual CLI remains fixed-target and receives
  // no path/host/limit options. Remap Node transport to our private local fixture.
  await fs.writeFile(preload,`'use strict';
const net=require('node:net'),assert=require('node:assert/strict');
const createServer=net.createServer,createConnection=net.createConnection;
net.createServer=function(options,accept){const server=createServer(options,accept),listen=server.listen;
server.listen=function(options,callback){assert.equal(options.host,'10.0.2.15');assert.equal(options.port,29000);
return listen.call(server,{...options,host:'127.0.0.1',port:0},()=>{callback();setImmediate(()=>process.send({port:server.address().port}));});};return server;};
net.createConnection=function(options){assert.equal(options.path,'/run/homeai-editor/code.sock');return createConnection({...options,path:${JSON.stringify(f.socketPath)}});};
`);
  const child=fork(path.join(__dirname,'socket-relay.cjs'),['--port','29000'],{execArgv:['--require',preload],stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const completion=once(child,'exit'),[message]=await once(child,'message');
  const client=net.createConnection({host:'127.0.0.1',port:message.port});client.on('error',()=>{});client.resume();
  t.after(()=>client.destroy());await once(client,'connect');await until(()=>f.observed.connects===1);
  const began=Date.now();child.kill('SIGTERM');
  const [code,signal]=await completion;await closed(client);
  assert.equal(code,0);assert.equal(signal,null);assert(Date.now()-began>=4500);assert(Date.now()-began<7000);
  assert.equal(stdout,'');assert.equal(stderr,'');
});
