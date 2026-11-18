'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {canonical,sha256}=require('./guest-disk-grow.cjs'),{superblock}=require('./guest-disk-grow-linux.cjs');
const {validateOwnedPlan,assessOwnedCapacity}=require('./guest-disk-owned-copyup.cjs'),fsck=require('./guest-disk-fsck.cjs');
const F=fs.constants,OVERLAY=0x794c7630,brands=new WeakMap(),fail=code=>Object.assign(Error(code),{code});
const stat=s=>Object.fromEntries(['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])])),same=(a,b)=>canonical(a)===canonical(b);
function hashRange(fd,bytes,check){
 const before=fs.fstatSync(fd,{bigint:true}),hash=require('node:crypto').createHash('sha256'),block=Buffer.alloc(4*1024**2);
 try{if(!before.isFile()||before.size!==BigInt(bytes))throw fail('COPYUP_DATA_CHANGED');let at=0;while(at<bytes){check();const n=fs.readSync(fd,block,0,Math.min(block.length,bytes-at),at);if(n<=0)throw fail('COPYUP_DATA_CHANGED');hash.update(block.subarray(0,n));at+=n;}
  check();if(fs.readSync(fd,block,0,1,bytes)!==0||!same(stat(before),stat(fs.fstatSync(fd,{bigint:true}))))throw fail('COPYUP_DATA_CHANGED');return hash.digest('hex');
 }finally{block.fill(0);}
}
function overlayMount(text,rawFile){
 const rows=text.trim().split('\n').map(line=>{const [a,b,...extra]=line.split(' - '),left=a?.split(' '),right=b?.split(' ');if(extra.length||left?.length<6||right?.length<3)throw fail('COPYUP_OVERLAY_UNKNOWN');return{line,mount:left[4].replace(/\\([0-7]{3})/g,(_,x)=>String.fromCharCode(parseInt(x,8))),type:right[0],options:[left[5],right[2]].join(',').split(',')};});
 const relevant=rows.filter(x=>rawFile===x.mount||rawFile.startsWith(x.mount==='/'?'/':x.mount+'/')).sort((a,b)=>b.mount.length-a.mount.length),r=relevant[0];
 if(!r||r.type!=='overlay'||r.options.includes('volatile')||r.options.includes('ro')||relevant.filter(x=>x.mount===r.mount).length!==1)throw fail('COPYUP_OVERLAY_UNKNOWN');return r.line;
}
async function createOwnedOperations(input,deadline){
 const owner=await require('./apps-vm-reconcile-linux.cjs').createColdWorkerFile({...input,deadline},'owned-copyup');
 try{
 const document=validateOwnedPlan(owner.document),g=document.growth,h=owner.helpers;
 let complete=false,closed=false,allocation=g.source.allocatedBytes,expectedManifest=g.source.manifestSha256;
 const rawFile=owner.rawFile,tools=new Map(),mount=overlayMount(fs.readFileSync('/proc/self/mountinfo','utf8'),rawFile),kernel=fs.readFileSync('/proc/sys/kernel/osrelease','utf8').trim();
 const check=()=>{owner.check();if(closed)throw fail('COPYUP_OWNER_CLOSED');};
 function tool(file,executable=true){const canonicalPath=fs.realpathSync(file);h.parents(canonicalPath);const r=h.boundedRead(canonicalPath,16*1024**2,check);if(executable&&!(BigInt(r.identity.mode)&0o111n))throw fail('COPYUP_TOOL_UNSAFE');return{path:canonicalPath,sha256:sha256(r.bytes),identity:r.identity,executable};}
 function assertTool(t){if(!same(t,tool(t.path,t.executable)))throw fail('COPYUP_TOOL_CHANGED');}
 function readManifest(){return h.boundedRead(g.workerRoot+'/manifest.json',16384,check,{owner:1001,gid:1001}).bytes;}
 function assertCold(){check();owner.assertCold();if(overlayMount(fs.readFileSync('/proc/self/mountinfo','utf8'),rawFile)!==mount||fs.readFileSync('/proc/sys/kernel/osrelease','utf8').trim()!==kernel)throw fail('COPYUP_OVERLAY_CHANGED');if(sha256(readManifest())!==expectedManifest)throw fail('GROW_MANIFEST_CHANGED');}
 function inspect(){check();const fd=owner.rawFd,s=fs.fstatSync(fd,{bigint:true}),st=fs.statfsSync('/proc/self/fd/'+fd,{bigint:true}),b=readManifest();return{raw:{dev:Number(s.dev),ino:Number(s.ino),uid:Number(s.uid),gid:Number(s.gid),bytes:Number(s.size),allocatedBytes:Number(s.blocks)*512,links:Number(s.nlink),mode:Number(s.mode&0o777n)},fs:superblock(fd),manifest:JSON.parse(b),manifestSha256:sha256(b),host:{availableBytes:Number(st.bavail*st.bsize),availableInodes:Number(st.ffree),backing:Number(st.type)===OVERLAY?'overlay':'unknown'}};}
 async function command(t,args,fd,timeoutMs,{unshare=false}={}){
  check();assertTool(t);const child=cp.spawn(t.path,args,{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe',fd,'ignore','ignore','ignore','ignore','ignore','ignore'],windowsHide:true});
  let error,expired=false,clipped=false,count=0;const out=[],err=[];for(const [stream,list]of [[child.stdout,out],[child.stderr,err]])stream.on('data',b=>{count+=b.length;if(count>4096){clipped=true;child.kill('SIGKILL');}else list.push(Buffer.from(b));});
  child.once('error',e=>error=e);const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},Math.max(1,Math.min(timeoutMs,owner.end-Date.now()))),result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
  try{check();assertTool(t);if(error||expired||clipped||result.signal)throw fail('COPYUP_TOOL_UNCONFIRMED');const stdout=Buffer.concat(out),stderr=Buffer.concat(err);if(unshare){let v;try{v=JSON.parse(stdout);}catch{throw fail('COPYUP_UNSHARE_UNCONFIRMED');}if(result.code!==0||v.ok!==true){if([22,38,95].includes(v.errno))throw fail('COPYUP_COW_UNSUPPORTED');throw fail('COPYUP_UNSHARE_UNCONFIRMED');}if(stderr.length||!same(v,{kind:'OWNED_UNSHARE_RANGE',flag:64,bytes:g.source.bytes,ok:true,errno:0}))throw fail('COPYUP_UNSHARE_UNCONFIRMED');return{toolSha256:t.sha256,helperSha256:sha256(h.boundedRead(path.join(__dirname,'guest-disk-unshare.py'),16384,check).bytes),flag:64,bytes:g.source.bytes,ownedClose:true};}
   if(result.code!==0)throw fail('GROW_TOOL_FAILED');return{ownedClose:true,toolSha256:t.sha256};
  }finally{for(const b of [...out,...err])b.fill(0);}
 }
 async function materialize(){
  assertCold();assessOwnedCapacity(g,inspect().host,false);const original=stat(fs.fstatSync(owner.rawFd,{bigint:true})),beforeHash=hashRange(owner.rawFd,g.source.bytes,check);assertCold();
  let rw;
  try{rw=fs.openSync(rawFile,F.O_RDWR|F.O_NOFOLLOW|F.O_NONBLOCK|0x40000);const afterOpen=stat(fs.fstatSync(rw,{bigint:true}));
   if(['dev','ino','uid','gid','mode','nlink','size','mtimeNs'].some(k=>afterOpen[k]!==original[k])||hashRange(rw,g.source.bytes,check)!==beforeHash)throw fail('COPYUP_DATA_CHANGED');
   fs.fsyncSync(rw);h.sync(g.workerRoot);owner.adoptRaw(rw,g.source.bytes);rw=undefined;assertCold();
   const fd=owner.rawFd,python=tools.get('python'),helper=path.join(__dirname,'guest-disk-unshare.py'),helperPin=tool(helper,false);
   const unshare=await command(python,['-I','-S','-B',helper,String(g.source.bytes)],fd,g.toolTimeoutMs,{unshare:true});assertTool(helperPin);
   if(hashRange(fd,g.source.bytes,check)!==beforeHash)throw fail('COPYUP_DATA_CHANGED');fs.fsyncSync(fd);h.sync(g.workerRoot);owner.adoptRaw(fd,g.source.bytes,{mtime:true});
   const named=fs.openSync(rawFile,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK|0x40000);try{if(!same(stat(fs.fstatSync(named,{bigint:true})),stat(fs.fstatSync(fd,{bigint:true})))||hashRange(named,g.source.bytes,check)!==beforeHash)throw fail('COPYUP_DATA_CHANGED');}finally{fs.closeSync(named);}
   assertCold();const after=inspect();allocation=after.raw.allocatedBytes;if(allocation<g.source.bytes)throw fail('GROW_PHYSICAL_ALLOCATION_UNPROVEN');complete=true;
   return{kind:'OWNED_COPYUP_UNSHARE_COMPLETED',beforeHash,afterHash:beforeHash,sourceBytes:g.source.bytes,before:original,after:stat(fs.fstatSync(fd,{bigint:true})),unshare,overlayMountSha256:sha256(mount),kernelRelease:kernel,hostAfter:after.host};
  }finally{if(rw!==undefined)fs.closeSync(rw);}
 }
 function requireCompleted(){assertCold();if(!complete)throw fail('COPYUP_LIVE_COMPLETION_REQUIRED');}
 async function mutate(t,args,size){requireCompleted();const fd=owner.rawFd;await command(t,args,fd,g.toolTimeoutMs);fs.fsyncSync(fd);owner.adoptRaw(fd,size,{mtime:true});assertCold();}
  for(const [name,file]of [['allocate','/usr/bin/fallocate'],['resize','/usr/sbin/resize2fs'],['setpriv','/usr/bin/setpriv'],['e2fsck','/usr/sbin/e2fsck'],['python','/usr/bin/python3']])tools.set(name,tool(file));
  // The signed helper itself is an executable Python source file only for its
  // hash/identity pin; no executable bit is required by the Python invocation.
  const helper=h.boundedRead(path.join(__dirname,'guest-disk-unshare.py'),16384,check);if(!helper.bytes.length)throw fail('COPYUP_TOOL_UNSAFE');
  const journal=g.installationRoot+'/root-secrets/runtime/state/guest-grow-'+g.migrationId+'.json',guard=g.installationRoot+'/runtime-status/worker-capacity.json';
  const readJson=file=>{const b=h.boundedRead(file,16384,check,{optional:true});return b?JSON.parse(b.bytes):undefined;};
  const write=(file,value,options={})=>{const b=Buffer.from(canonical(value));if(b.length>16384)throw fail('GROW_JOURNAL_LIMIT');h.atomic(file,b,check,{...options,beforeCommit:assertCold});};
  const ops={assertCold,assertConsumer(contract){assertCold();if(require('../vast/apps-worker-profile.cjs').CAPACITY_MIGRATION_CONTRACT!==contract)throw fail('GROW_RUNTIME_CONSUMER_REQUIRED');},inspect,readJournal:()=>readJson(journal),readGuard:()=>readJson(guard),writeJournal:v=>write(journal,v),writeGuard:v=>write(guard,v,{mode:0o644}),
   async fsck(timeoutMs){assertCold();const t=tools.get('e2fsck'),setpriv=tools.get('setpriv');assertTool(t);assertTool(setpriv);let fd=fs.openSync(rawFile,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK|0x40000);try{const before=stat(fs.fstatSync(fd,{bigint:true}));if(!same(before,stat(fs.fstatSync(owner.rawFd,{bigint:true}))))throw fail('GROW_IDENTITY_CHANGED');const v=await fsck.runFsck({setpriv:setpriv.path,e2fsck:t.path,uid:1001,gid:1001,fd,timeoutMs:Math.min(timeoutMs,owner.end-Date.now()),tool:{path:t.path,sha256:t.sha256,...Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>[k,t.identity[k]])),uid:0,gid:Number(t.identity.gid),mode:Number(t.identity.mode)}});try{assertTool(t);assertTool(setpriv);}catch{v.toolStable=false;}try{if(!same(before,stat(fs.fstatSync(fd,{bigint:true})))||!same(before,stat(fs.fstatSync(owner.rawFd,{bigint:true})))||!same(before,stat(fs.lstatSync(rawFile,{bigint:true}))))v.inputStable=false;fs.closeSync(fd);fd=undefined;assertCold();}catch{v.inputStable=false;}return fsck.retainWitness(v);}finally{if(fd!==undefined)fs.closeSync(fd);}},
   async allocate(delta){if(delta!==g.targetBytes-g.source.bytes)throw fail('GROW_LENGTH_UNCERTAIN');await mutate(tools.get('allocate'),['--keep-size','--offset',String(g.source.bytes),'--length',String(delta),'/proc/self/fd/3'],g.source.bytes);if(inspect().raw.allocatedBytes<g.targetBytes)throw fail('GROW_PHYSICAL_ALLOCATION_UNPROVEN');},
   extend(bytes){requireCompleted();if(bytes!==g.targetBytes)throw fail('GROW_LENGTH_UNCERTAIN');const fd=owner.rawFd;fs.ftruncateSync(fd,bytes);fs.fsyncSync(fd);owner.adoptRaw(fd,bytes,{mtime:true});assertCold();},
   async resize(blocks){if(blocks!==g.targetBytes/g.source.fs.blockSize)throw fail('GROW_LENGTH_UNCERTAIN');const t=tools.get('resize');assertTool(t);await mutate(tools.get('setpriv'),['--reuid','1001','--regid','1001','--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',t.path,'/proc/self/fd/3',String(blocks)],g.targetBytes);assertTool(t);},
   async sealAllocation(bytes){if(bytes!==g.targetBytes)throw fail('GROW_LENGTH_UNCERTAIN');await mutate(tools.get('allocate'),['--keep-size','--offset','0','--length',String(bytes),'/proc/self/fd/3'],bytes);if(inspect().raw.allocatedBytes<bytes)throw fail('GROW_PHYSICAL_ALLOCATION_UNPROVEN');},
   writeManifest(value){assertCold();const b=Buffer.from(canonical(value));h.atomic(g.workerRoot+'/manifest.json',b,check,{owner:1001,gid:1001,beforeCommit:assertCold});expectedManifest=sha256(b);assertCold();}};
  assertCold();brands.set(ops,{planSha256:sha256(g),materialize,allocatedBytes:()=>allocation,capacity:host=>{assertCold();return assessOwnedCapacity(g,host,complete);}});
  return{plan:g,ops,close(){if(closed)return;closed=true;brands.delete(ops);owner.close();}};
 }catch(error){owner.close();throw error;}
}
function ownedFor(ops,plan){const owned=brands.get(ops);if(!owned||owned.planSha256!==sha256(plan))throw fail('COPYUP_FACTORY_REQUIRED');return owned;}
module.exports={createOwnedOperations,ownedFor,hashRange,overlayMount};
