'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
const {qualifyReadOnlyFsck,assertWitness,OUTPUT_LIMIT,TEXT_LIMIT,PROOF_LIMIT}=require('./guest-disk-fsck.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),copy=v=>JSON.parse(JSON.stringify(v));
const tool={path:'/usr/sbin/e2fsck',sha256:'a'.repeat(64),dev:'64',ino:'100',size:'128',uid:0,gid:0,mode:0o100755,mtimeNs:'100',ctimeNs:'100'};
const geometry={blockCount:786432,freeBlocks:4104,inodeCount:196608,freeInodes:128809,clean:true};
const stdout=Buffer.from('Pass 1: Checking inodes, blocks, and sizes\nPass 2: Checking directory structure\nPass 3: Checking directory connectivity\nPass 4: Checking reference counts\nPass 5: Checking group summary information\nprivate-label: 67799/196608 files (0.0% non-contiguous), 782328/786432 blocks\n'),stderr=Buffer.from('e2fsck 1.47.2 (1-Jan-2025)\n');
const proof=extra=>qualifyReadOnlyFsck({stdout,stderr,code:0,closed:true,tool,...extra});
test('complete forced fsck is a journal-safe sanitized witness with exact separate raw hashes',()=>{
 const p=proof();assertWitness(p,geometry);assert.equal(p.stdout.sha256,sha(stdout));assert.equal(p.stderr.sha256,sha(stderr));assert(!JSON.stringify(p).includes('private-label'));assert(Buffer.byteLength(JSON.stringify(p))<=PROOF_LIMIT);
 // The production journal sorts keys; a replay must not depend on insertion order.
 const sorted=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(sorted):Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
 assertWitness(sorted(p),geometry);
});
test('exit0 warnings and unknown stdout/stderr, missing passes, wrong tool banner and malformed UTF8 hold',()=>{
 for(const extra of [
  {stdout:Buffer.from(stdout.toString().replace('private-label:','Free blocks count wrong (620672, counted=453338).\nFix? no\n\nprivate-label:'))},
  {stdout:Buffer.from(stdout.toString().replace('Pass 4: Checking reference counts\n',''))},
  {stdout:Buffer.concat([stdout,Buffer.from('\n')])},
  {stdout:Buffer.concat([stdout,Buffer.from('/private/user/path\n')])},
  {stderr:Buffer.concat([stderr,Buffer.from('WARNING: /private/user/path\n')])},
  {stderr:Buffer.from('resize2fs 1.47.2 (1-Jan-2025)\n')},
  {stdout:Buffer.concat([stdout,Buffer.from([255])])}
 ]){const p=proof(extra);assert.throws(()=>assertWitness(p,geometry),{code:'GROW_FSCK_PROOF_REQUIRED'});assert(!JSON.stringify(p).includes('/private/user/path'));}
});
test('missing close, timeout, stream errors, nonzero/signal and late identity flags cannot qualify',()=>{
 for(const extra of [{closed:false},{expired:true},{clipped:true},{spawnError:true,code:-2},{streamError:true},{code:1},{signal:'SIGKILL'}])assert.throws(()=>assertWitness(proof(extra),geometry),{code:'GROW_FSCK_PROOF_REQUIRED'});
 for(const key of ['toolStable','inputStable']){const p=proof();p[key]=false;assert.throws(()=>assertWitness(p,geometry),{code:'GROW_FSCK_PROOF_REQUIRED'});}
 const p=qualifyReadOnlyFsck({stdout,stderr,code:0,tool});assert.equal(p.closed,false);assert.throws(()=>assertWitness(p,geometry));
});
test('wrong or unsafe tool identity and tampered summary/hash/completeness do not pass',()=>{
 for(const change of [t=>t.path='/usr/sbin/resize2fs',t=>t.uid=1001,t=>t.mode=0o100777,t=>t.mode=0o755,t=>t.sha256='missing',t=>t.size='0']){const t=copy(tool);change(t);assert.throws(()=>proof({tool:t}),{code:'GROW_FSCK_PROOF_REQUIRED'});}
 for(const change of [p=>p.summary.usedBlocks++,p=>p.stdout.sha256='b'.repeat(64),p=>p.stdout.contentComplete=false,p=>p.warningFree=false,p=>p.stdout.text='Pass 1: /private/user/path']){const p=proof();change(p);assert.throws(()=>assertWitness(p,geometry),{code:'GROW_FSCK_PROOF_REQUIRED'});}
 assert.throws(()=>assertWitness(proof(),{...geometry,freeBlocks:4105}),{code:'GROW_FSCK_PROOF_REQUIRED'});
 assert.throws(()=>assertWitness(proof(),{...geometry,clean:null}),{code:'GROW_FSCK_PROOF_REQUIRED'});
});
test('sanitization expansion remains bounded, private content never enters the journal, and incomplete text holds',()=>{
 const p=proof({stdout:Buffer.from('/secret/path\n'.repeat(200))});assert.equal(p.sanitizedComplete,false);assert(Buffer.byteLength(p.stdout.text)+Buffer.byteLength(p.stderr.text)<=TEXT_LIMIT);assert(Buffer.byteLength(JSON.stringify(p))<=PROOF_LIMIT);assert(!JSON.stringify(p).includes('/secret/path'));assert.throws(()=>assertWitness(p));
});
function runner(){
 const calls=[],kills=[];let timer,child;
 const module={exports:{}},source=fs.readFileSync(path.join(__dirname,'guest-disk-fsck.cjs'),'utf8');
 vm.runInNewContext(source,{module,exports:module.exports,Buffer,TextDecoder,require:n=>n==='node:child_process'?{spawn(exe,args,options){calls.push({exe,args,options});child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=s=>{kills.push(s);return true;};return child;}}:require(n),setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){}},{filename:'actual-fsck-runner-under-inert-child.cjs'});
 return{api:module.exports,calls,kills,get child(){return child;},expire:()=>timer()};
}
const options={setpriv:'/usr/bin/setpriv',e2fsck:tool.path,uid:1001,gid:1001,fd:27,timeoutMs:1000,tool};
test('actual runner passes only held FD3, drops inherited environment/lease, and waits for exact owned close',async()=>{
 const f=runner();let settled=false;const done=f.api.runFsck(options).then(p=>{settled=true;return p;});
 f.child.stdout.emit('data',stdout);f.child.stderr.emit('data',stderr);f.child.emit('exit',0,null);await Promise.resolve();assert.equal(settled,false);
 const call=f.calls[0];assert.equal(call.exe,'/usr/bin/setpriv');assert.deepEqual(Array.from(call.options.stdio),['ignore','pipe','pipe',27,'ignore','ignore','ignore','ignore','ignore','ignore']);assert(call.args.includes('--no-new-privs'));assert.deepEqual(Array.from(call.args.slice(-3)),['-f','-n','/proc/self/fd/3']);assert.equal(call.options.env.HOME,'/nonexistent');
 f.child.emit('close',0,null);assertWitness(await done,geometry);
});
test('actual runner overflow keeps complete per-stream hashes/counts after kill and separate capped prefixes',async()=>{
 const f=runner(),done=f.api.runFsck(options),chunks=[['stdout',stdout],['stderr',stderr],['stdout',Buffer.alloc(OUTPUT_LIMIT,65)],['stderr',Buffer.alloc(OUTPUT_LIMIT+7,66)],['stdout',Buffer.from('after-kill')]];
 const kept={stdout:[],stderr:[]};let left=OUTPUT_LIMIT;
 for(const [name,b]of chunks){const n=Math.min(left,b.length);kept[name].push(b.subarray(0,n));left-=n;f.child[name].emit('data',b);}
 assert.equal(f.kills.length,1);f.child.emit('close',0,null);const p=await done;assert.equal(p.clipped,true);assert.equal(p.warningFree,false);
 for(const name of ['stdout','stderr']){const full=Buffer.concat(chunks.filter(([s])=>s===name).map(([,b])=>b)),prefix=Buffer.concat(kept[name]);assert.equal(p[name].bytes,full.length);assert.equal(p[name].sha256,sha(full));assert.equal(p[name].retainedBytes,prefix.length);assert.equal(p[name].retainedSha256,sha(prefix));}
 assert.equal(p.fullStreamsHashed,true);assert.throws(()=>assertWitness(p));assert(Buffer.byteLength(JSON.stringify(p))<=PROOF_LIMIT);
});
test('actual runner timeout and stream/spawn errors stay unqualified and await owned close',async()=>{
 for(const kind of ['timeout','stream','spawn']){
  const f=runner();let settled=false;const done=f.api.runFsck(options).then(p=>{settled=true;return p;});
  if(kind==='timeout')f.expire();else if(kind==='stream')f.child.stdout.emit('error',Error('inert'));else f.child.emit('error',Error('inert'));
  await Promise.resolve();assert.equal(settled,false);f.child.emit('close',kind==='spawn'?-2:0,null);const p=await done;assert.throws(()=>assertWitness(p));if(kind==='timeout')assert.equal(p.expired,true);if(kind==='stream')assert.equal(p.fullStreamsHashed,false);if(kind==='spawn')assert.equal(p.spawnError,true);
 }
 const f=runner();await assert.rejects(f.api.runFsck({...options,e2fsck:'/usr/sbin/resize2fs'}),{code:'GROW_FSCK_PROOF_REQUIRED'});assert.equal(f.calls.length,0);
});
