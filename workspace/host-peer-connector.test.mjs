import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createOwnPeerConnector,parsePeerStat,parsePeerTcp,peerLimits} from './host-peer-connector.mjs';
const header=' sl local_address rem_address st tx tr retr uid timeout inode\n';
const tcp=(inode='900',mapped=false)=>header+' 0: '+(mapped?'0000000000000000FFFF00000100007F':'0100007F')+':5208 '+(mapped?'0000000000000000FFFF00000100007F':'0100007F')+':9C40 01 0:0 00:0 0 1001 0 '+inode+' 1\n';
const stat=(pid,ppid,pgrp,start)=>pid+' (a ) tricky) S '+ppid+' '+pgrp+' '+Array(16).fill('0').join(' ')+' '+start+' 0\n';
class MemoryProc{
 constructor(){this.events=[];this.files=new Map([['/proc/100/stat',stat(100,50,100,'1000')],['/proc/200/stat',stat(200,100,777,'2000')],['/proc/100/task/100/children','200 '],['/proc/200/task/200/children',''],['/proc/self/net/tcp',tcp()],['/proc/self/net/tcp6',header]]);this.dirs=new Map([['/proc/100/task',['100']],['/proc/200/task',['200']],['/proc/100/fd',['0']],['/proc/200/fd',['0','3']]]);this.links=new Map([['/proc/self/ns/pid','pid:[1]'],['/proc/self/ns/net','net:[2]'],['/proc/100/ns/pid','pid:[1]'],['/proc/100/ns/net','net:[2]'],['/proc/200/ns/pid','pid:[1]'],['/proc/200/ns/net','net:[2]'],['/proc/100/fd/0','/dev/null'],['/proc/200/fd/0','/dev/null'],['/proc/200/fd/3','socket:[900]']]);this.uid=1001;this.hook=null;}
 async step(kind,file){this.events.push(kind+':'+file);await this.hook?.(kind,file);}
 missing(){return Object.assign(Error('synthetic missing'),{code:'ENOENT'});}
 async open(file){await this.step('open',file);if(!this.files.has(file))throw this.missing();const buffer=Buffer.from(this.files.get(file));let offset=0;const self=this;return{async read(out,at,size){await self.step('read',file);const count=Math.min(size,buffer.length-offset);buffer.copy(out,at,offset,offset+count);offset+=count;return{bytesRead:count};},async close(){self.events.push('close:'+file);}};}
 async opendir(file){await this.step('opendir',file);if(!this.dirs.has(file))throw this.missing();const entries=[...this.dirs.get(file)],self=this;let offset=0;return{async read(){return offset<entries.length?{name:entries[offset++]}:null;},async close(){self.events.push('closedir:'+file);}};}
 async readlink(file){await this.step('readlink',file);if(!this.links.has(file))throw this.missing();return this.links.get(file);}
 async stat(file){await this.step('stat',file);return{uid:this.uid,dev:1,ino:file==='/owned/project'?1:Number(file.split('/').at(-1)),isDirectory:()=>true};}
 async realpath(file){await this.step('realpath',file);return file;}
}
class Socket extends EventEmitter{
 constructor(){super();this.destroyed=false;this.readyState='closed';this.bytesWritten=0;this.connects=[];this.paused=false;}
 pause(){this.paused=true;}
 connect(options){this.connects.push(options);this.localAddress='127.0.0.1';this.localPort=40000;this.remoteAddress=options.host;this.remotePort=options.port;this.readyState='open';queueMicrotask(()=>{if(!this.destroyed)this.emit('connect');});}
 destroy(){if(this.destroyed)return;this.destroyed=true;this.readyState='closed';queueMicrotask(()=>this.emit('close'));}
 write(){throw Error('NO APPLICATION WRITES PERMITTED IN CONNECTOR');}
}
function fixture(){
 const proc=new MemoryProc(),socket=new Socket(),revoke=new AbortController();let settled,live=true,bindingLive=true,time=1000,bindingCalls=0,custodyCalls=0;
 const leaseDone=new Promise(resolve=>{settled=resolve;}),target=Object.freeze({jobId:'own-job',owner:'own-agent',generation:'a'.repeat(32),projectSessionId:'project-session',workspaceId:'workspace',projectId:'project',projectRoot:'/owned/project',uid:1001,port:21000,signal:revoke.signal,assertCurrent(){assert(bindingLive,'binding invalid');}});
 const lease={jobId:target.jobId,owner:target.owner,identity:{stage:'wrapper-frame',generation:target.generation,pid:100,ppid:50,pgrp:100,startTicks:'1000',pidNamespace:'pid:[1]'},context:{projectSessionId:target.projectSessionId,workspaceId:target.workspaceId,projectRoot:target.projectRoot},done:leaseDone,assertCurrent(){assert(live,'lease invalid');}};
 const trusted={fs:proc,socket:()=>socket,platform:'linux',endianness:'LE',now:()=>time,sleep:async ms=>{time+=ms;}};
 const callbacks={binding:async()=>{bindingCalls++;return target;},custodyFor:async(id,owner)=>{custodyCalls++;assert.equal(id,target.jobId);assert.equal(owner,target.owner);return lease;}};
 const create=(changes={},testChanges={})=>createOwnPeerConnector({...callbacks,...changes},{...trusted,...testChanges});
 return{proc,socket,target,lease,revoke,create,get calls(){return{bindingCalls,custodyCalls};},connect:options=>create().connect({deadline:3000,...options}),settle(){live=false;settled();},expireBinding(){bindingLive=false;}};
}
const rejectCode=expected=>error=>error.code===expected;
async function flushed(){for(let n=0;n<16;n++)await Promise.resolve();}
test('pure TCP decoders include mapped IPv6 and strict complete/valid tables',()=>{
 for(const mapped of[false,true]){const rows=parsePeerTcp(tcp('900',mapped));assert.equal(rows[0].local.address,'127.0.0.1');assert.equal(rows[0].remote.address,'127.0.0.1');assert.equal(rows[0].inode,'900');}
 assert.equal(parsePeerStat(stat(100,50,100,'1000'),100).startTicks,'1000');for(const value of['',header.trimEnd(),header+'bad\n'])assert.throws(()=>parsePeerTcp(value));assert.throws(()=>parsePeerStat(stat(100,50,100,'1000').replace(' S ',' Z '),100));
});
test('requires trusted callbacks and permits only deadline/signal connect inputs',async()=>{
 assert.throws(()=>createOwnPeerConnector(),rejectCode('PEER_TRUSTED_CALLBACKS_REQUIRED'));const f=fixture();for(const extra of[{port:3090},{host:'foreign'},{pid:200},{url:'http://x'}])await assert.rejects(()=>f.connect(extra),rejectCode('PEER_CONNECT_OPTIONS_INVALID'));assert.equal(f.socket.connects.length,0);
 await assert.rejects(()=>f.create({}, {platform:'win32'}).connect({deadline:3000}),rejectCode('PEER_PLATFORM_UNSUPPORTED'));
});
test('retains same paused zero-write socket attributed to own setsid descendant',async()=>{
 const f=fixture(),result=await f.connect();assert.equal(result.socket,f.socket);assert(f.socket.paused);assert.equal(f.socket.bytesWritten,0);assert.deepEqual(f.socket.connects,[{host:'127.0.0.1',port:21000,family:4,localAddress:'127.0.0.1'}]);assert.equal(result.evidence.holder.pid,200);assert.equal(result.evidence.ancestry[1].pgrp,777);assert.equal(result.evidence.exclusiveOwnershipProven,false);assert.equal(result.evidence.atomicOwnershipLease,false);assert.deepEqual(f.calls,{bindingCalls:1,custodyCalls:1});result.close();await result.done;assert(f.socket.destroyed);
});
test('accepts exact dual-stack IPv4-mapped reverse tuple',async()=>{const f=fixture();f.proc.files.set('/proc/self/net/tcp',header);f.proc.files.set('/proc/self/net/tcp6',tcp('900',true));const result=await f.connect();assert.equal(result.evidence.inode,'900');result.close();await result.done;});
test('waits boundedly for accepted nonzero inode and never reconnects',async()=>{
 const f=fixture();f.proc.files.set('/proc/self/net/tcp',tcp('0'));let reads=0;f.proc.hook=(kind,file)=>{if(kind==='open'&&file==='/proc/self/net/tcp'&&++reads===2)f.proc.files.set(file,tcp());};const result=await f.connect();assert(reads>=3);assert.equal(f.socket.connects.length,1);result.close();await result.done;
});
test('same-port listener/foreign process or same-pgrp never substitutes for exact accepted inode ancestry',async()=>{
 const f=fixture();f.proc.links.set('/proc/200/fd/3','socket:[899]');await assert.rejects(()=>f.connect(),rejectCode('PEER_UNATTRIBUTED'));assert(f.socket.destroyed);assert.equal(f.socket.connects.length,1);assert(!f.proc.events.some(event=>event.includes('/proc/300/')));
});
test('rejects reverse-tuple or own-range-holder ambiguity',async()=>{
 const a=fixture();a.proc.files.set('/proc/self/net/tcp6',tcp('901',true));await assert.rejects(()=>a.connect(),rejectCode('PEER_REVERSE_TUPLE_AMBIGUOUS'));assert(a.socket.destroyed);
 const b=fixture();b.proc.links.set('/proc/100/fd/0','socket:[900]');await assert.rejects(()=>b.connect(),rejectCode('PEER_OWNER_AMBIGUOUS'));assert(b.socket.destroyed);
});
test('anchor reuse, broken ancestry, UID and namespace mismatches fail closed',async()=>{
 for(const change of[f=>f.proc.files.set('/proc/100/stat',stat(100,50,100,'1001')),f=>f.proc.files.set('/proc/200/stat',stat(200,99,777,'2000')),f=>f.proc.uid=1002,f=>f.proc.links.set('/proc/200/ns/pid','pid:[3]'),f=>f.proc.links.set('/proc/100/ns/net','net:[3]')]){const f=fixture();change(f);await assert.rejects(()=>f.connect());assert(f.socket.destroyed||f.socket.connects.length===0);}
});
test('fd replacement and process generation change between snapshots never release socket',async()=>{
 for(const change of[f=>f.proc.links.set('/proc/200/fd/3','socket:[901]'),f=>f.proc.files.set('/proc/200/stat',stat(200,100,777,'2001'))]){const f=fixture();let reads=0;f.proc.hook=(kind,file)=>{if(kind==='readlink'&&file==='/proc/200/fd/3'&&++reads===2)change(f);};await assert.rejects(()=>f.connect());assert(f.socket.destroyed);assert.equal(f.socket.connects.length,1);}
});
test('denied, missing, malformed, truncated and overbudget proc observations cannot pass',async()=>{
 const denied=fixture();denied.proc.hook=(kind,file)=>{if(file==='/proc/200/fd')throw Object.assign(Error('denied'),{code:'EACCES'});};await assert.rejects(()=>denied.connect(),rejectCode('EACCES'));assert(denied.socket.destroyed);
 for(const change of[f=>f.proc.files.delete('/proc/200/stat'),f=>f.proc.files.set('/proc/self/net/tcp',tcp().trimEnd()),f=>f.proc.files.set('/proc/100/task/100/children','invalid'),f=>f.proc.dirs.set('/proc/100/task',Array.from({length:peerLimits.tasks+1},(_,n)=>String(n+100)))]){const f=fixture();change(f);await assert.rejects(()=>f.connect());assert(f.socket.destroyed);}
});
test('trusted target context/generation and canonical project root are required before connect',async()=>{
 for(const key of['generation','projectSessionId','workspaceId','projectRoot']){const f=fixture();if(key==='generation')f.lease.identity[key]='b'.repeat(32);else f.lease.context[key]='foreign';await assert.rejects(()=>f.connect(),rejectCode('PEER_CUSTODY_MISMATCH'));assert.equal(f.socket.connects.length,0);}
 const f=fixture();f.proc.realpath=async()=>'/foreign';await assert.rejects(()=>f.connect(),rejectCode('PEER_PROJECT_ROOT_CHANGED'));assert.equal(f.socket.connects.length,0);
});
test('lease and target validity are rechecked after awaited proc reads',async()=>{
 for(const expire of[f=>f.settle(),f=>f.expireBinding()]){const f=fixture();f.proc.hook=(kind,file)=>{if(kind==='readlink'&&file==='/proc/200/fd/3')expire(f);};await assert.rejects(()=>f.connect());assert(f.socket.destroyed);}
});
test('settlement, binding revocation and caller abort close only retained own socket',async()=>{
 for(const action of[(f,c)=>f.settle(),(f,c)=>f.revoke.abort(),(f,c)=>c.abort()]){const f=fixture(),controller=new AbortController(),result=await f.connect({signal:controller.signal});action(f,controller);await result.done;assert(f.socket.destroyed);assert.equal(f.socket.connects.length,1);}
});
test('absolute deadline and abort fence a late binding before any TCP effect',async()=>{
 let release;const f=fixture(),controller=new AbortController(),pending=f.create({binding:()=>new Promise(resolve=>{release=resolve;})}).connect({deadline:3000,signal:controller.signal});await flushed();controller.abort();await assert.rejects(pending,rejectCode('PEER_ABORTED'));release(f.target);await flushed();assert.equal(f.socket.connects.length,0);
 const g=fixture();let timeout;const p=g.create({binding:()=>new Promise(()=>{})},{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{}}).connect({deadline:3000});timeout();await assert.rejects(p,rejectCode('PEER_DEADLINE'));assert.equal(g.socket.connects.length,0);
});

test('late open and opendir acquisition always close handles when the post-await fence rejects',async()=>{
 for(const method of['open','opendir']){const f=fixture(),base=f.proc[method].bind(f.proc);let acquired;f.proc[method]=async file=>{const handle=await base(file);if(!acquired){acquired=file;f.revoke.abort();}return handle;};await assert.rejects(()=>f.connect());await flushed();assert(acquired);assert(f.proc.events.includes((method==='open'?'close:':'closedir:')+acquired));assert(f.socket.destroyed||f.socket.connects.length===0);}
});

test('peer close rejects pending proof without cancelling its only hard deadline',async()=>{
 const f=fixture();let release,entered=false;f.proc.hook=async(kind,file)=>{if(kind==='open'&&file==='/proc/self/net/tcp'){entered=true;await new Promise(resolve=>{release=resolve;});}};const pending=f.connect();for(let n=0;n<256&&!entered;n++)await Promise.resolve();assert(entered);f.socket.destroy();await assert.rejects(pending,rejectCode('PEER_SOCKET_CLOSED'));release();await flushed();assert.equal(f.socket.connects.length,1);
});

test('all tasks are inspected so a nonleader-thread child remains in anchor ancestry',async()=>{
 const f=fixture();f.proc.dirs.set('/proc/100/task',['100','101']);f.proc.files.set('/proc/100/task/100/children','');f.proc.files.set('/proc/100/task/101/children','200 ');const result=await f.connect();assert.equal(result.evidence.holder.pid,200);result.close();await result.done;
});
test('no written byte or oversized proc file can be accepted',async()=>{
 const f=fixture(),original=f.socket.connect.bind(f.socket);f.socket.connect=options=>{f.socket.bytesWritten=1;original(options);};await assert.rejects(()=>f.connect(),rejectCode('PEER_SOCKET_TUPLE_INVALID'));assert(f.socket.destroyed);
 const g=fixture();g.proc.files.set('/proc/self/net/tcp','x'.repeat(peerLimits.fileBytes+1));await assert.rejects(()=>g.connect(),rejectCode('PEER_PROC_FILE_LIMIT'));assert(g.socket.destroyed);
});
test('hard deadline during pending proc proof closes own connection and fences late continuation',async()=>{
 const f=fixture();let release,entered=false,timeout;f.proc.hook=async(kind,file)=>{if(kind==='open'&&file==='/proc/self/net/tcp'){entered=true;await new Promise(resolve=>{release=resolve;});}};const pending=f.create({}, {setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{}}).connect({deadline:3000});for(let n=0;n<256&&!entered;n++)await Promise.resolve();assert(entered);timeout();await assert.rejects(pending,rejectCode('PEER_DEADLINE'));assert(f.socket.destroyed);const count=f.proc.events.length;release();await flushed();assert(f.proc.events.slice(count).every(event=>event.startsWith('close:')));assert.equal(f.socket.connects.length,1);
});
