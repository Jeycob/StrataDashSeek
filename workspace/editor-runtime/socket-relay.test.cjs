'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const net=require('node:net'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const tls=require('node:tls');
const {once}=require('node:events'), {createHash}=require('node:crypto'), {spawnSync,fork}=require('node:child_process');
const {startRelay,parseArguments,HOST,SOCKET,TRANSPORT,LIMITS}=require('./socket-relay.cjs');
const SERVER_NAME='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.editor.homeai.invalid';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const closed=socket=>socket.destroyed ? Promise.resolve() : new Promise(resolve=>socket.once('close',resolve));
const hash=value=>createHash('sha256').update(value).digest('hex');
async function until(predicate) { for(let n=0;n<200;n++){if(predicate())return;await delay(5);}throw Error('test condition timed out'); }

async function certificates(directory) {
  function openssl(...args) {const r=spawnSync('openssl',args,{cwd:directory,stdio:'ignore'});assert.equal(r.status,0,'synthetic cert generation');}
  openssl('req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=Synthetic CA','-keyout','ca.key','-out','ca.crt');
  for(const role of ['server','client']) {
    openssl('req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=Synthetic '+role,'-keyout',role+'.key','-out',role+'.csr');
    await fs.writeFile(path.join(directory,role+'.ext'),role==='server' ? 'subjectAltName=DNS:'+SERVER_NAME+'\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
    openssl('x509','-req','-in',role+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days','1','-extfile',role+'.ext','-out',role+'.crt');
  }
  const values={};for(const name of ['server.key','server.crt','ca.crt','client.key','client.crt'])values[name]=await fs.readFile(path.join(directory,name));
  return values;
}

async function fixture(t,{limits={},onUnix=socket=>socket.on('end',()=>socket.end()),hangConnect=false,missingTarget=false}={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-relay-test-'));
  const credentials=await certificates(directory);
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
      assert.equal(options.requestCert,true);assert.equal(options.rejectUnauthorized,true);assert.equal(options.highWaterMark,64*1024);
      const server=tls.createServer(options,socket=>accept(track(socket))),listen=server.listen;
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
  const relay=await startRelay(29000,{network,readFile:name=>{assert(name.startsWith(TRANSPORT));return credentials[name.slice(TRANSPORT.length)];},limits:{...LIMITS,shutdownMs:50,...limits}});
  const clientOptions={ca:credentials['ca.crt'],key:credentials['client.key'],cert:credentials['client.crt'],servername:SERVER_NAME};
  async function connect() {
    const client=tls.connect({host:'127.0.0.1',port:relay.address().port,...clientOptions});
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    await once(client,'secureConnect');return client;
  }
  t.after(async()=>{
    for(const socket of clients)socket.destroy();
    for(const socket of peers)socket.destroy();
    await relay.close();
    await new Promise(resolve=>unix.close(resolve));
    // Only the exclusively created synthetic fixture directory is removed.
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {relay,connect,observed,directory,socketPath,credentials,clientOptions};
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
  const extra=net.createConnection({host:'127.0.0.1',port:f.relay.address().port});extra.on('error',()=>{});extra.resume();await closed(extra);
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

test('sibling connections require mTLS and exact generation hostname before any UNIX access',{timeout:5000,skip:process.platform==='win32'},async t=>{
  let bytes=0;
  const f=await fixture(t,{limits:{connectMs:100},onUnix(socket){socket.on('data',chunk=>{bytes+=chunk.length;socket.end('authenticated');});}});
  const foreignDirectory=path.join(f.directory,'foreign');await fs.mkdir(foreignDirectory);
  const foreign=await certificates(foreignDirectory);
  async function rejected(label,options,raw=false,expectedError) {
    await t.test(label,async()=>{
      const before=f.observed.connects;
      const client=raw ? net.createConnection({host:'127.0.0.1',port:f.relay.address().port}) : tls.connect({host:'127.0.0.1',port:f.relay.address().port,...options});
      let error;client.on('error',value=>{error=value.code;});client.resume();
      let forced=false;
      const safety=setTimeout(()=>{forced=true;client.destroy();},1500);
      try {
        if(raw)client.write('GET / HTTP/1.1\r\nHost: sibling\r\n\r\n');
        await closed(client);await delay(20);
        assert.equal(forced,false,'relay must reject without the test safety timer');
        if(expectedError)assert.equal(error,expectedError);
        assert.equal(f.observed.connects,before,'rejected peer never opens UNIX upstream');
        assert.equal(bytes,0,'rejected peer never forwards application bytes');
      } finally {clearTimeout(safety);client.destroy();}
    });
  }
  await rejected('raw TCP',null,true);
  await t.test('silent handshake is bounded',async()=>{
    const client=net.createConnection({host:'127.0.0.1',port:f.relay.address().port});client.on('error',()=>{});client.resume();
    const began=Date.now();await closed(client);assert(Date.now()-began<1000);assert.equal(f.observed.connects,0);
  });
  await rejected('no client certificate',{ca:f.credentials['ca.crt'],servername:SERVER_NAME});
  await rejected('foreign CA client',{...f.clientOptions,key:foreign['client.key'],cert:foreign['client.crt']});
  await rejected('wrong server hostname',{...f.clientOptions,servername:'cccccccccccccccccccccccccccccccc.dddddddddddddddddddddddddddddddd.editor.homeai.invalid'},false,'ERR_TLS_CERT_ALTNAME_INVALID');
  await rejected('TLS 1.2 is refused',{...f.clientOptions,maxVersion:'TLSv1.2'});
  const client=await f.connect(),chunks=[];assert.equal(client.authorized,true);assert.equal(client.getProtocol(),'TLSv1.3');
  client.on('data',chunk=>chunks.push(chunk));client.write('allowed');await once(client,'end');
  assert.equal(Buffer.concat(chunks).toString(),'authenticated');assert.equal(bytes,7);assert.equal(f.observed.connects,1);
});

test('missing credentials fail closed before listener construction',async()=>{
  let called=false;
  await assert.rejects(startRelay(29000,{readFile(){throw Error('synthetic missing key');},network:{createServer(){called=true;}}}));
  assert.equal(called,false);
});

test('actual CLI SIGTERM stops accepting and closes an active stream after five seconds',{timeout:8000,skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),preload=path.join(f.directory,'synthetic-network-preload.cjs');
  // Test-process preload only. The actual CLI remains fixed-target and receives
  // no path/host/limit options. Remap Node transport to our private local fixture.
  await fs.writeFile(preload,`'use strict';
const net=require('node:net'),tls=require('node:tls'),fs=require('node:fs'),assert=require('node:assert/strict');
const createServer=tls.createServer,createConnection=net.createConnection,readFile=fs.readFileSync;
fs.readFileSync=function(name,...args){if(typeof name==='string'&&name.startsWith('/run/homeai-transport/'))return readFile(${JSON.stringify(f.directory)}+'/'+name.split('/').pop(),...args);return readFile(name,...args);};
tls.createServer=function(options,accept){const server=createServer(options,accept),listen=server.listen;
server.listen=function(options,callback){assert.equal(options.host,'10.0.2.15');assert.equal(options.port,29000);
return listen.call(server,{...options,host:'127.0.0.1',port:0},()=>{callback();setImmediate(()=>process.send({port:server.address().port}));});};return server;};
net.createConnection=function(options){assert.equal(options.path,'/run/homeai-editor/code.sock');return createConnection({...options,path:${JSON.stringify(f.socketPath)}});};
`);
  const child=fork(path.join(__dirname,'socket-relay.cjs'),['--port','29000'],{execArgv:['--require',preload],stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const completion=once(child,'exit'),[message]=await once(child,'message');
  const client=tls.connect({host:'127.0.0.1',port:message.port,...f.clientOptions});client.on('error',()=>{});client.resume();
  t.after(()=>client.destroy());await once(client,'secureConnect');await until(()=>f.observed.connects===1);
  const began=Date.now();child.kill('SIGTERM');
  const [code,signal]=await completion;await closed(client);
  assert.equal(code,0);assert.equal(signal,null);assert(Date.now()-began>=4500);assert(Date.now()-began<7000);
  assert.equal(stdout,'');assert.equal(stderr,'');
});
