'use strict';
// Actual operator function bodies, controlled memory filesystem/processes only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'apps-vm-reconcile-linux.cjs'),'utf8'),core=require('../vast/apps-vm-reconciliation.cjs');
function load(io,child_process={}){const module={exports:{}};vm.runInNewContext(source+'\nmodule.exports.inert={atomic,boundedRead,procFile,scanCold,flock,actor,names};',{module,require:name=>({'node:fs':io,'node:path':path.posix,'node:child_process':child_process,'../vast/apps-vm-reconciliation.cjs':core}[name]??require(name)),process:{pid:555},Buffer,BigInt,Date,TextDecoder,setTimeout,clearTimeout},{filename:'ACTUAL_COLD_OPERATOR_INERT',timeout:1000});return module.exports;}
function memory(){
 const files=new Map(),handles=new Map(),events=[];let ino=100,fd=30;
 const make=(name,bytes,uid=0,gid=0,mode=0o100600)=>{const value={bytes:Buffer.from(bytes),dev:64n,ino:BigInt(ino++),uid:BigInt(uid),gid:BigInt(gid),mode:BigInt(mode),nlink:1n,mtimeNs:10n,ctimeNs:11n};files.set(name,value);return value;};
 const stat=x=>({dev:x.dev,ino:x.ino,uid:x.uid,gid:x.gid,mode:x.mode,nlink:x.nlink,size:BigInt(x.bytes.length),mtimeNs:x.mtimeNs,ctimeNs:x.ctimeNs,isFile:()=>true,isSymbolicLink:()=>false});
 const dir=name=>({dev:64n,ino:1n,uid:BigInt(['/data/harness/state','/data/harness/state/applications','/data/harness/docker-worker'].includes(name)?1001:0),gid:0n,mode:0o40700n,isDirectory:()=>true,isSymbolicLink:()=>false});
 const constants={...fs.constants,O_DIRECTORY:fs.constants.O_DIRECTORY||65536};
 const io={constants,realpathSync:x=>x,lstatSync(name){if(files.has(name))return stat(files.get(name));if(name.endsWith('.json')||name.includes('.vm-reconcile-'))throw Object.assign(Error('absent'),{code:'ENOENT'});return dir(name);},openSync(name,flags,mode){events.push(['open',name,flags]);const n=fd++;if(flags&constants.O_DIRECTORY){handles.set(n,{name,directory:true});return n;}if(flags&fs.constants.O_CREAT){if(files.has(name))throw Object.assign(Error('exists'),{code:'EEXIST'});make(name,Buffer.alloc(0),0,0,0o100000|(mode??0o600));}if(!files.has(name))throw Object.assign(Error('absent'),{code:'ENOENT'});handles.set(n,{name,offset:0,value:files.get(name)});return n;},fstatSync(n){const h=handles.get(n);return h.directory?dir(h.name):stat(h.value);},readSync(n,b,o,len,pos){const h=handles.get(n),at=pos??h.offset,k=Math.min(len,2,Math.max(0,h.value.bytes.length-at));h.value.bytes.copy(b,o,at,at+k);if(pos===null)h.offset+=k;return k;},writeFileSync(n,b){events.push(['write',handles.get(n).name]);handles.get(n).value.bytes=Buffer.from(b);},fchownSync(n,uid,gid){const s=handles.get(n).value;s.uid=BigInt(uid);s.gid=BigInt(gid);},fchmodSync(n,mode){const s=handles.get(n).value;s.mode=(s.mode&~0o7777n)|BigInt(mode);},fsyncSync(n){events.push(['fsync',handles.get(n).name]);},closeSync(n){events.push(['close',handles.get(n)?.name]);handles.delete(n);},renameSync(from,to){events.push(['rename',from,to]);files.set(to,files.get(from));files.delete(from);}};
 return{io,files,handles,events,make};
}
test('operator import has zero I/O and a non-Linux/nonroot call cannot touch installation paths',async()=>{let accesses=0;const io=new Proxy({constants:fs.constants},{get(t,k){if(k==='constants')return t[k];accesses++;throw Error('unintended I/O');}}),api=load(io);assert.equal(accesses,0);await assert.rejects(api.reconcileOffline({}),e=>e.code==='VM_RECONCILE_ROOT_REQUIRED');assert.equal(accesses,0);});
test('actual atomic writer fsyncs owned temp before rename and parent before readback',()=>{
 const f=memory(),file='/data/harness/state/applications/vm.json';f.make(file,'{"old":true}',1001,1001);const next=Buffer.from('{"new":true}');load(f.io).inert.atomic(file,next,()=>{},{owner:1001,gid:1001,expected:core.sha(Buffer.from('{"old":true}'))});
 assert(f.files.get(file).bytes.equals(next));assert.equal(f.files.get(file).uid,1001n);assert.equal(f.files.get(file).mode,0o100600n);const rename=f.events.findIndex(x=>x[0]==='rename');assert(f.events.slice(0,rename).some(x=>x[0]==='fsync'&&x[1].includes('.vm-reconcile-')));assert(f.events.slice(rename+1).some(x=>x[0]==='fsync'&&x[1]==='/data/harness/state/applications'));assert.equal(f.handles.size,0);
});
test('actual pre-rename fsync failure retains original and owned temp without cleanup',()=>{
 const f=memory(),file='/data/harness/state/applications/vm.json';f.make(file,'{"old":true}',1001,1001);f.io.fsyncSync=()=>{throw Error('inert fsync failure');};assert.throws(()=>load(f.io).inert.atomic(file,Buffer.from('{}'),()=>{},{owner:1001,gid:1001,expected:core.sha(Buffer.from('{"old":true}'))}));assert.equal(f.files.get(file).bytes.toString(),'{"old":true}');assert.equal([...f.files.keys()].filter(x=>x.includes('.vm-reconcile-')).length,1);assert(!f.events.some(x=>x[0]==='rename'));assert.equal(f.handles.size,0);
});
test('actual atomic writer refuses changed prior hash before creating a temp',()=>{
 const f=memory(),file='/data/harness/state/applications/vm.json';f.make(file,'{"foreign":true}',1001,1001);assert.throws(()=>load(f.io).inert.atomic(file,Buffer.from('{}'),()=>{},{owner:1001,gid:1001,expected:'0'.repeat(64)}),e=>e.code==='VM_RECONCILE_STATE_CHANGED');assert.equal(f.files.size,1);
});
test('cold/config drift injected at temp fsync is rejected immediately before actual rename',()=>{
 const f=memory(),file='/data/harness/state/applications/vm.json';f.make(file,'{"old":true}',1001,1001);let changed=false,guarded=false;const sync=f.io.fsyncSync;f.io.fsyncSync=n=>{sync(n);if(f.handles.get(n).name.includes('.vm-reconcile-'))changed=true;};
 assert.throws(()=>load(f.io).inert.atomic(file,Buffer.from('{}'),()=>{},{owner:1001,gid:1001,expected:core.sha(Buffer.from('{"old":true}')),beforeCommit:()=>{guarded=true;if(changed)throw Object.assign(Error('cold changed'),{code:'VM_RECONCILE_COLD_CHANGED'});}}),e=>e.code==='VM_RECONCILE_COLD_CHANGED');assert(guarded);assert.equal(f.files.get(file).bytes.toString(),'{"old":true}');assert(!f.events.some(x=>x[0]==='rename'));
});
test('actual bounded proc reader reads through short chunks to EOF, caps and always closes',()=>{
 const f=memory(),file='/proc/10/maps';f.make(file,'head\nold-raw-mapping-at-tail');const fn=load(f.io).inert.procFile;assert.equal(fn(file,64,()=>{}),'head\nold-raw-mapping-at-tail');assert.equal(f.handles.size,0);assert.throws(()=>fn(file,8,()=>{}),e=>e.code==='VM_RECONCILE_SCAN_LIMIT');let calls=0;assert.throws(()=>fn(file,64,()=>{if(++calls===3)throw Error('deadline');}));assert.equal(f.handles.size,0);
});
test('device/inode map matching does not depend on filename and rejects same inode on another device',()=>{
 const {rawMapping}=load({}),raw={dev:'64',ino:'123'};assert.equal(rawMapping('a-b r--p 0000 00:40 123 /alias/unexpected-name',raw),true);assert.equal(rawMapping('a-b r--p 0000 00:41 123 /data/harness/docker-worker/volume.raw',raw),false);assert.equal(rawMapping('a-b r--p 0000 00:40 124 /data/harness/docker-worker/volume.raw',raw),false);
});
test('fresh flock waits for owned close, not leader exit, and passes only the newly opened descriptor',async()=>{
 const child=new EventEmitter(),calls=[];child.kill=s=>calls.push(['kill',s]);const api=load({},{spawn(exe,args,opts){calls.push([exe,args,opts]);return child;}}),promise=api.inert.flock(77,()=>{});let settled=false;promise.then(()=>settled=true);child.emit('exit',0,null);await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(Array.from(calls[0][2].stdio),['ignore','ignore','ignore',77,'ignore','ignore','ignore','ignore','ignore','ignore']);child.emit('close',0,null);await promise;assert.equal(settled,true);
});
test('fresh flock failure cannot yield a cold capability',async()=>{
 const child=new EventEmitter();child.kill=()=>{};const api=load({},{spawn(){queueMicrotask(()=>child.emit('close',1,null));return child;}});await assert.rejects(api.inert.flock(77,()=>{}),e=>e.code==='VM_RECONCILE_LOCK_BUSY');
});
function scanFixture(){
 const f=memory(),lists=new Map([['/proc',['10']],['/proc/10/task',['10']],['/proc/10/task/10/fd',['3']],['/sys/class/block',['loop0']]]),stats=new Map(),links=new Map();
 const status='Name:\troot-worker\nUid:\t0\t0\t0\t0\n',fields=Array(22).fill('0');fields[0]='S';fields[19]='100';
 for(const prefix of ['/proc/10','/proc/10/task/10']){f.make(prefix+'/status',status);f.make(prefix+'/stat','10 (root worker) '+fields.join(' '));}
 for(const prefix of ['/proc/10','/proc/10/task/10']){f.make(prefix+'/cmdline','root-worker\0');f.make(prefix+'/comm','root-worker\n');f.make(prefix+'/maps','');f.make(prefix+'/mountinfo','');}
 stats.set('/proc/10/task/10/fd/3',{dev:64n,ino:222n,mode:0o100600n,isFile:()=>true});const loop='/sys/class/block/loop0';stats.set(loop,{dev:1n,ino:5n,isDirectory:()=>true});
 const real=f.io.realpathSync,ls=f.io.lstatSync;f.io.realpathSync=p=>p===loop?'/sys/devices/virtual/block/loop0':real(p);f.io.lstatSync=p=>{if(p===loop+'/loop')throw Object.assign(Error('not configured'),{code:'ENOENT'});return ls(p);};
 f.io.statSync=p=>{if(!stats.has(p))throw Object.assign(Error('unknown stat '+p),{code:'ENOENT'});return stats.get(p);};f.io.readlinkSync=p=>{if(!links.has(p))throw Object.assign(Error('unknown link'),{code:'ENOENT'});return links.get(p);};
 f.io.opendirSync=(p,opts)=>{assert.equal(opts.bufferSize,1);const list=lists.get(p);if(!list)throw Error('unexpected directory '+p);const values=typeof list==='function'?list():list;let i=0;return{readSync:()=>i<values.length?{name:values[i++]}:null,closeSync(){}};};
 return{...f,lists,stats,links,raw:{dev:'64',ino:'123',fd:77},run(loopRows=()=>[]){return load(f.io).inert.scanCold(this.raw,[],()=>{},loopRows);}};
}
test('actual scan accepts a stable unrelated process only with full task/fd census',()=>{const f=scanFixture();f.run();assert.equal(f.handles.size,0);});
test('effective/saved/fs service UID and thread-only service activity cannot pass cold census',()=>{
 for(const col of [1,2,3]){const f=scanFixture(),uids=[0,0,0,0];uids[col]=1001;f.make('/proc/10/status','Uid:\t'+uids.join('\t')+'\n');assert.throws(()=>f.run(),e=>e.code==='VM_RECONCILE_SERVICE_PROCESS_ACTIVE');}
 const f=scanFixture();f.make('/proc/10/task/10/status','Uid:\t0\t0\t1001\t0\n');assert.throws(()=>f.run(),e=>e.code==='VM_RECONCILE_SERVICE_PROCESS_ACTIVE');
});
test('unknown process, disappearing fd, and changed PID/task/fd sets cannot publish absence',()=>{
 const unknown=scanFixture();unknown.files.delete('/proc/10/status');assert.throws(()=>unknown.run());
 const fd=scanFixture();fd.stats.delete('/proc/10/task/10/fd/3');assert.throws(()=>fd.run());
 for(const key of ['/proc','/proc/10/task','/proc/10/task/10/fd']){const f=scanFixture(),first=f.lists.get(key);if(key.endsWith('/fd'))f.stats.set(key+'/99',{dev:64n,ino:999n,mode:0o100600n,isFile:()=>true});let count=0;f.lists.set(key,()=>++count===1?first:[...first,'99']);assert.throws(()=>f.run(),e=>e.code==='VM_RECONCILE_SCAN_CHANGED');}
});
test('thread fd or mapped device/inode aliases are detected without reading user contents',()=>{
 const fd=scanFixture();fd.stats.set('/proc/10/task/10/fd/3',{dev:64n,ino:123n,mode:0o100600n,isFile:()=>true});assert.throws(()=>fd.run(),e=>e.code==='VM_RECONCILE_RAW_IN_USE');
 const map=scanFixture();map.make('/proc/10/task/10/maps','1000-2000 r--s 0000 00:40 123 /unrelated-looking-alias\n');assert.throws(()=>map.run(),e=>e.code==='VM_RECONCILE_RAW_MAPPED');
});
test('an unshared task same-number raw FD is never mistaken for the leader enumerator',()=>{
 const file='/proc/555/task/556/fd',seen=[];let vanished=false,qualified=false;const io={opendirSync:()=>{let n=0;return{readSync:()=>n++===0?{name:'9'}:null,closeSync(){vanished=true;}};},readlinkSync:p=>{seen.push(p);return p.startsWith('/proc/self')?file:'/data/harness/docker-worker/volume.raw';},statSync:()=>({isDirectory:()=>false,dev:64n,ino:123n}),lstatSync:()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});}};
 const out=load(io).inert.names(file,64,()=>{},{ownFds:true,enumeratorSeen:()=>{qualified=true;}});assert.deepEqual(Array.from(out),['9']);assert.deepEqual(seen,[file+'/9']);assert(vanished);assert.equal(qualified,false);
});
test('shared-table enumerator requires positive appearance AND disappearance after own close',()=>{
 const file='/proc/555/task/556/fd';for(const retained of [false,true]){let open=true,qualified=false,n=0;const io={opendirSync:()=>({readSync:()=>n++===0?{name:'9'}:null,closeSync(){open=false;}}),readlinkSync:()=>file,statSync:()=>({isDirectory:()=>true,dev:1n,ino:2n}),lstatSync:()=>{if(open||retained)return{};throw Object.assign(Error('gone'),{code:'ENOENT'});}};const run=()=>load(io).inert.names(file,64,()=>{},{ownFds:true,enumeratorSeen:()=>{qualified=true;}});if(retained){assert.throws(run,e=>e.code==='VM_RECONCILE_ENUMERATOR_UNKNOWN');assert.equal(qualified,false);}else{assert.equal(run().length,0);assert.equal(qualified,true);}}
});
test('global final census catches same FD-number retarget, late closed-FD mmap and late exec',()=>{
 for(const change of [f=>f.stats.set('/proc/10/task/10/fd/3',{dev:64n,ino:333n,mode:0o100600n,isFile:()=>true}),f=>f.stats.set('/proc/10/task/10/fd/3',{dev:64n,ino:123n,mode:0o100600n,isFile:()=>true}),f=>f.make('/proc/10/task/10/maps','1000-2000 r--s 0000 00:40 123 /other-name\n'),f=>f.make('/proc/10/task/10/comm','qemu-system-x86\n'),f=>f.make('/proc/10/task/10/stat',f.files.get('/proc/10/task/10/stat').bytes.toString().replace(' 100 ',' 101 '))]){const f=scanFixture();let changed=false;assert.throws(()=>f.run(()=>{if(!changed){change(f);changed=true;}return[];}));}
});
test('a zombie thread-group leader does not hide a surviving task and raw mapping',()=>{
 const f=scanFixture();for(const name of ['status','stat','cmdline','comm','maps','mountinfo'])f.make('/proc/10/task/11/'+name,f.files.get('/proc/10/task/10/'+name).bytes.toString().replace(/^10 \(/,'11 ('));f.lists.set('/proc/10/task',['10','11']);f.lists.set('/proc/10/task/11/fd',['3']);f.stats.set('/proc/10/task/11/fd/3',{dev:64n,ino:222n,mode:0o100600n,isFile:()=>true});for(const p of ['/proc/10/stat','/proc/10/task/10/stat'])f.make(p,f.files.get(p).bytes.toString().replace(') S ',') Z '));f.make('/proc/10/task/11/maps','1000-2000 r--s 0000 00:40 123 /mapped-after-leader\n');assert.throws(()=>f.run(),e=>e.code==='VM_RECONCILE_RAW_MAPPED');
});
test('partial, hidden or overmounted proc views cannot certify a complete process census',()=>{
 const {qualifyProcVisibility}=load({}),base='20 10 0:1 / /proc rw,nosuid,nodev,noexec - proc proc rw\n';assert.doesNotThrow(()=>qualifyProcVisibility(base,0x9fa0));assert.doesNotThrow(()=>qualifyProcVisibility(base.replace('proc rw','proc rw,hidepid=0'),0x9fa0));for(const bad of [base.replace('proc rw','proc rw,hidepid=2'),base.replace('proc rw','proc rw,subset=pid'),base.replace('0:1 / /proc','0:1 /subset /proc'),base+'21 20 0:2 / /proc/123/fd rw - tmpfs tmpfs rw\n'])assert.throws(()=>qualifyProcVisibility(bad,0x9fa0),e=>e.code==='VM_RECONCILE_PROC_VISIBILITY_UNKNOWN');assert.throws(()=>qualifyProcVisibility(base,0x01021994));
});
test('loop qualification uses kernel backing device/inode, not an alias path stat',()=>{
 const {qualifyLoops}=load({}),raw={dev:'64',ino:'123'},row={name:'/dev/loop0','back-file':'/some/alias','back-ino':123,'back-maj:min':'0:64'};
 assert.throws(()=>qualifyLoops([row],['/dev/loop0'],raw),e=>e.code==='VM_RECONCILE_RAW_ATTACHED');assert.doesNotThrow(()=>qualifyLoops([{...row,'back-ino':124}],['/dev/loop0'],raw));assert.throws(()=>qualifyLoops([],['/dev/loop0'],raw),e=>e.code==='VM_RECONCILE_LOOP_UNKNOWN');assert.throws(()=>qualifyLoops([{...row,'back-ino':Number.MAX_SAFE_INTEGER+1}],['/dev/loop0'],raw),e=>e.code==='VM_RECONCILE_LOOP_UNKNOWN');
 const f=scanFixture(),ls=f.io.lstatSync;f.io.lstatSync=p=>p.endsWith('/loop')?{isDirectory:()=>true}:ls(p);assert.throws(()=>f.run(),'configured loop with missing backing evidence stays unknown');
});
