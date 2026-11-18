'use strict';
// Explicit Root cold API, no CLI/default/startup hook. Never kills, mounts,
// repairs, resizes, deletes a PID/socket/raw file or adopts a process.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {CONTRACT,MAX,sha,validatePlan,runReconciliation}=require('../vast/apps-vm-reconciliation.cjs');
const F=fs.constants,ROOT='/data/harness',WORKER=ROOT+'/docker-worker',APPS=ROOT+'/state/applications',PRIVATE=ROOT+'/root-secrets/runtime/state',PUBLIC=ROOT+'/runtime-status';
const fail=code=>Object.assign(Error(code),{code});
const fields=['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'];
const meta=s=>Object.fromEntries(fields.map(k=>[k,String(s[k])])),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function rawMapping(line,raw){const m=line.match(/^\S+\s+\S+\s+\S+\s+([a-f0-9]+):([a-f0-9]+)\s+(\d+)(?:\s|$)/);if(!m||m[3]!==raw.ino)return false;const d=BigInt(raw.dev),major=((d>>8n)&0xfffn)|((d>>32n)&0xfffff000n),minor=(d&0xffn)|((d>>12n)&0xffffff00n);return BigInt('0x'+m[1])===major&&BigInt('0x'+m[2])===minor;}
function qualifyProcVisibility(text,type){
 if(BigInt(type)!==0x9fa0n)throw fail('VM_RECONCILE_PROC_VISIBILITY_UNKNOWN');const rows=text.split('\n').filter(Boolean).map(line=>{const halves=line.split(' - ');if(halves.length!==2)throw fail('VM_RECONCILE_PROC_VISIBILITY_UNKNOWN');const left=halves[0].split(' '),right=halves[1].split(' ');if(left.length<6||right.length<3)throw fail('VM_RECONCILE_PROC_VISIBILITY_UNKNOWN');return{left,right};}),proc=rows.filter(x=>x.left[4]==='/proc');
 if(proc.length!==1||proc[0].left[3]!=='/'||proc[0].right[0]!=='proc')throw fail('VM_RECONCILE_PROC_VISIBILITY_UNKNOWN');
 const options=[proc[0].left[5],proc[0].right[2]].join(',').split(',');if(options.some(x=>x.startsWith('hidepid=')&&x!=='hidepid=0'||x==='subset=pid')||rows.some(x=>/^\/proc\/(?:[1-9]\d*|self|thread-self)(?:\/|$)/.test(x.left[4]||'')))throw fail('VM_RECONCILE_PROC_VISIBILITY_UNKNOWN');
}
function boundedRead(file,cap,check,{owner=0,gid,optional=false}={}){
 let fd;try{check();fd=fs.openSync(file,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);const s=fs.fstatSync(fd,{bigint:true});
  if(!s.isFile()||s.uid!==BigInt(owner)||gid!==undefined&&s.gid!==BigInt(gid)||s.nlink!==1n||s.mode&0o022n||s.size<1n||s.size>BigInt(cap))throw fail('VM_RECONCILE_INPUT_UNSAFE');
  const b=Buffer.alloc(Number(s.size)+1);let n=0;while(n<b.length){check();const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}
  if(n!==Number(s.size)||!equal(meta(s),meta(fs.fstatSync(fd,{bigint:true})))||!equal(meta(s),meta(fs.lstatSync(file,{bigint:true}))))throw fail('VM_RECONCILE_INPUT_CHANGED');return{bytes:b.subarray(0,n),identity:meta(s)};
 }catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function directory(file,owner=0){const s=fs.lstatSync(file,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(owner)||s.mode&0o022n||fs.realpathSync(file)!==file)throw fail('VM_RECONCILE_PARENT_UNSAFE');return{dev:String(s.dev),ino:String(s.ino),uid:String(s.uid),gid:String(s.gid),mode:String(s.mode)};}
function parents(file){let at='/';const out=[];for(const part of path.posix.dirname(file).slice(1).split('/')){at=path.posix.join(at,part);out.push([at,directory(at,[ROOT+'/state',APPS,WORKER].includes(at)?1001:0)]);}return out;}
function sync(file){const fd=fs.openSync(file,F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeExclusive(file,bytes,check){check();const before=parents(file),fd=fs.openSync(file,F.O_WRONLY|F.O_CREAT|F.O_EXCL|F.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}check();if(!equal(before,parents(file)))throw fail('VM_RECONCILE_PARENT_CHANGED');sync(path.dirname(file));if(!boundedRead(file,MAX,check).bytes.equals(bytes))throw fail('VM_RECONCILE_WRITE_UNCONFIRMED');}
function atomic(file,bytes,check,{owner=0,gid=0,mode=0o600,expected,beforeCommit}={}){
 check();const before=parents(file),prior=boundedRead(file,MAX,check,{owner,gid,optional:true});if(expected!==undefined&&(!prior||sha(prior.bytes)!==expected))throw fail('VM_RECONCILE_STATE_CHANGED');
 const temp=path.join(path.dirname(file),'.vm-reconcile-'+require('node:crypto').randomBytes(16).toString('hex')),fd=fs.openSync(temp,F.O_WRONLY|F.O_CREAT|F.O_EXCL|F.O_NOFOLLOW,0o600);
 try{fs.fchownSync(fd,owner,gid);fs.fchmodSync(fd,mode);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 check();if(!equal(before,parents(file)))throw fail('VM_RECONCILE_PARENT_CHANGED');const again=boundedRead(file,MAX,check,{owner,gid,optional:true});if(!equal(prior?.identity,again?.identity)||prior&&!prior.bytes.equals(again.bytes))throw fail('VM_RECONCILE_STATE_CHANGED');
 beforeCommit?.();check();fs.renameSync(temp,file);sync(path.dirname(file));if(!boundedRead(file,MAX,check,{owner,gid}).bytes.equals(bytes))throw fail('VM_RECONCILE_WRITE_UNCONFIRMED');
 // An uncertain temporary is deliberately retained, never recursively cleaned.
}
function procFile(file,cap,check){check();const fd=fs.openSync(file,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);try{const b=Buffer.alloc(cap+1);let n=0;while(n<b.length){check();const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}if(n>cap)throw fail('VM_RECONCILE_SCAN_LIMIT');return b.subarray(0,n).toString();}finally{fs.closeSync(fd);}}
function actor(pid,check,prefix='/proc/'+pid){const status=procFile(prefix+'/status',16384,check),stat=procFile(prefix+'/stat',4096,check),split=stat.lastIndexOf(') '),f=stat.slice(split+2).split(' '),ids=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m)?.slice(1).map(Number);if(split<0||!ids||!ids.every(Number.isSafeInteger)||!/^\d+$/.test(f[19]||''))throw fail('VM_RECONCILE_SCAN_UNKNOWN');return{pid:Number(pid),uid:ids[0],uids:ids,state:f[0],startTicks:f[19]};}
const actorIdentity=a=>({pid:a.pid,uid:a.uid,uids:a.uids,startTicks:a.startTicks,inactive:['Z','X'].includes(a.state)});
function names(file,max,check,{ownFds=false,enumeratorSeen}={}){
 check();const dir=fs.opendirSync(file,{bufferSize:1}),out=[];let bytes=0,enumerators=0,enumeratorFile;
 try{for(let ent;(ent=dir.readSync())!==null;){check();bytes+=Buffer.byteLength(ent.name);if(out.length>=max||bytes>256*1024)throw fail('VM_RECONCILE_SCAN_LIMIT');
  if(ownFds){const actual=file+'/'+ent.name,link=fs.readlinkSync(actual);if(link===file){const a=fs.statSync(actual,{bigint:true}),b=fs.statSync(file,{bigint:true});if(!a.isDirectory()||a.dev!==b.dev||a.ino!==b.ino||++enumerators>1)throw fail('VM_RECONCILE_SCAN_UNKNOWN');enumeratorFile=actual;continue;}}
  out.push(ent.name);
 }}finally{dir.closeSync();}
 if(enumeratorFile){try{fs.lstatSync(enumeratorFile);throw fail('VM_RECONCILE_ENUMERATOR_UNKNOWN');}catch(e){if(e.code!=='ENOENT')throw e;}enumeratorSeen?.();}
 return out.sort();
}
function scanCold(raw,oldActors,check,loopRows){
 const pids=names('/proc',8192,check).filter(x=>/^[1-9]\d*$/.test(x));if(pids.length>4096)throw fail('VM_RECONCILE_SCAN_LIMIT');let fds=0,tasks=0,mapsBytes=0,mountBytes=0;const witnesses=[];
 function fdSnapshot(listing,pid){let sharedOwnerTable=false;const found=names(listing,65536,check,{ownFds:Number(pid)===process.pid,enumeratorSeen:()=>{sharedOwnerTable=true;}}),rows=[];
  for(const name of found){check();if(!/^\d+$/.test(name)||++fds>65536)throw fail('VM_RECONCILE_SCAN_LIMIT');const s=fs.statSync(listing+'/'+name,{bigint:true});if(s.isFile()&&String(s.dev)===raw.dev&&String(s.ino)===raw.ino&&!(sharedOwnerTable&&Number(pid)===process.pid&&Number(name)===raw.fd))throw fail('VM_RECONCILE_RAW_IN_USE');rows.push([name,String(s.dev),String(s.ino),String(s.mode&0o170000n)]);}
  return{rows,sharedOwnerTable};
 }
 function resources(prefix){
  const cmd=procFile(prefix+'/cmdline',1024*1024,check),comm=procFile(prefix+'/comm',256,check);if(/^qemu(?:-|\b)/.test(comm)||cmd.split('\0').some(x=>/^qemu(?:-|$)/.test(path.basename(x))))throw fail('VM_RECONCILE_QEMU_ACTIVE');
  const maps=procFile(prefix+'/maps',4*1024**2,check);mapsBytes+=Buffer.byteLength(maps);if(mapsBytes>32*1024**2)throw fail('VM_RECONCILE_SCAN_LIMIT');for(const line of maps.split('\n'))if(rawMapping(line,raw))throw fail('VM_RECONCILE_RAW_MAPPED');
  const mounts=procFile(prefix+'/mountinfo',4*1024**2,check);mountBytes+=Buffer.byteLength(mounts);if(mountBytes>32*1024**2)throw fail('VM_RECONCILE_SCAN_LIMIT');if(mounts.includes(WORKER+'/volume.raw'))throw fail('VM_RECONCILE_RAW_MOUNTED');
  // Relevant projections are stable; unrelated JIT/heap mappings and process
  // scheduling states need not be byte-identical to prove zero raw/QEMU use.
  return{qemu:false,rawMapped:false,rawMounted:false};
 }
 for(const pid of pids){const a=actor(pid,check);
  if(a.uids.includes(1001))throw fail('VM_RECONCILE_SERVICE_PROCESS_ACTIVE');
  const tids=names('/proc/'+pid+'/task',8192,check);if(tids.some(t=>!/^\d+$/.test(t))||(tasks+=tids.length)>8192)throw fail('VM_RECONCILE_SCAN_LIMIT');
  const taskWitnesses=[];
  for(const tid of tids){const prefix='/proc/'+pid+'/task/'+tid,t=actor(tid,check,prefix);if(t.uids.includes(1001))throw fail('VM_RECONCILE_SERVICE_PROCESS_ACTIVE');if(['Z','X'].includes(t.state)){taskWitnesses.push({tid,prefix,actor:actorIdentity(t),inactive:true});continue;}
   if(oldActors.some(x=>x.pid===a.pid&&x.startTicks===a.startTicks))throw fail('VM_RECONCILE_OLD_ACTOR_ACTIVE');const listing=prefix+'/fd',before=fdSnapshot(listing,pid),projection=resources(prefix);
   if(!equal(before,fdSnapshot(listing,pid))||!equal(actorIdentity(t),actorIdentity(actor(tid,check,prefix))))throw fail('VM_RECONCILE_SCAN_CHANGED');taskWitnesses.push({tid,prefix,listing,before,projection,actor:actorIdentity(t)});
  }
  if(!equal(tids,names('/proc/'+pid+'/task',8192,check)))throw fail('VM_RECONCILE_SCAN_CHANGED');
  if(!equal(actorIdentity(a),actorIdentity(actor(pid,check))))throw fail('VM_RECONCILE_SCAN_CHANGED');witnesses.push({pid,actor:actorIdentity(a),tids,tasks:taskWitnesses});
 }
 if(!equal(pids,names('/proc',8192,check).filter(x=>/^[1-9]\d*$/.test(x))))throw fail('VM_RECONCILE_SCAN_CHANGED');
 const loops=names('/sys/class/block',4096,check).filter(x=>/^loop\d+$/.test(x)),configuredLoops=[];
 for(const name of loops){const root='/sys/class/block/'+name,canonical=fs.realpathSync(root),before=fs.statSync(root,{bigint:true});if(canonical!=='/sys/devices/virtual/block/'+name||!before.isDirectory())throw fail('VM_RECONCILE_LOOP_UNKNOWN');let configured=true;
  try{fs.lstatSync(root+'/loop');}catch(e){if(e.code==='ENOENT')configured=false;else throw e;}
  if(configured){configuredLoops.push('/dev/'+name);const backing=procFile(root+'/loop/backing_file',4096,check).trim();if(!backing.startsWith('/')||backing.endsWith(' (deleted)'))throw fail('VM_RECONCILE_LOOP_UNKNOWN');if(backing===WORKER+'/volume.raw')throw fail('VM_RECONCILE_RAW_ATTACHED');}
  const after=fs.statSync(root,{bigint:true});if(before.dev!==after.dev||before.ino!==after.ino||fs.realpathSync(root)!==canonical)throw fail('VM_RECONCILE_LOOP_CHANGED');
 }
 if(!equal(loops,names('/sys/class/block',4096,check).filter(x=>/^loop\d+$/.test(x))))throw fail('VM_RECONCILE_LOOP_CHANGED');
 const firstLoopRows=loopRows();qualifyLoops(firstLoopRows,configuredLoops,raw);
 // Recheck the WHOLE retained census after later PIDs and loop observations,
 // not just each PID locally. FD-number reuse is not stable FD identity.
 for(const w of witnesses){if(!equal(w.actor,actorIdentity(actor(w.pid,check))))throw fail('VM_RECONCILE_SCAN_CHANGED');if(!equal(w.tids,names('/proc/'+w.pid+'/task',8192,check)))throw fail('VM_RECONCILE_SCAN_CHANGED');for(const t of w.tasks){if(!equal(t.actor,actorIdentity(actor(t.tid,check,t.prefix))))throw fail('VM_RECONCILE_SCAN_CHANGED');if(t.inactive)continue;if(!equal(t.before,fdSnapshot(t.listing,w.pid))||!equal(t.projection,resources(t.prefix)))throw fail('VM_RECONCILE_SCAN_CHANGED');}}
 const finalLoopRows=loopRows();qualifyLoops(finalLoopRows,configuredLoops,raw);if(!equal(firstLoopRows,finalLoopRows)||!equal(loops,names('/sys/class/block',4096,check).filter(x=>/^loop\d+$/.test(x))))throw fail('VM_RECONCILE_LOOP_CHANGED');
 if(!equal(pids,names('/proc',8192,check).filter(x=>/^[1-9]\d*$/.test(x))))throw fail('VM_RECONCILE_SCAN_CHANGED');
}
function qualifyLoops(rows,configured,raw){
 if(!Array.isArray(rows)||rows.length>4096||new Set(rows.map(x=>x?.name)).size!==rows.length||!equal(rows.map(x=>x.name).sort(),configured.slice().sort()))throw fail('VM_RECONCILE_LOOP_UNKNOWN');
 const dev=BigInt(raw.dev),major=((dev>>8n)&0xfffn)|((dev>>32n)&0xfffff000n),minor=(dev&0xffn)|((dev>>12n)&0xffffff00n);
 for(const row of rows){const ino=typeof row['back-ino']==='string'?row['back-ino']:Number.isSafeInteger(row['back-ino'])?String(row['back-ino']):'',device=row['back-maj:min'];if(!/^\/dev\/loop\d+$/.test(row.name)||!/^\d+$/.test(ino)||typeof device!=='string'||!/^\d+:\d+$/.test(device)||typeof row['back-file']!=='string'||!row['back-file'].startsWith('/')||row['back-file'].includes('\0'))throw fail('VM_RECONCILE_LOOP_UNKNOWN');const[ma,mi]=device.split(':').map(BigInt);if(BigInt(ino)===BigInt(raw.ino)&&ma===major&&mi===minor)throw fail('VM_RECONCILE_RAW_ATTACHED');}
}
async function flock(fd,check){check();const child=cp.spawn('/usr/bin/flock',['-n','3'],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['ignore','ignore','ignore',fd,'ignore','ignore','ignore','ignore','ignore','ignore']});let error;child.once('error',e=>error=e);const timer=setTimeout(()=>child.kill('SIGKILL'),1000);const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);check();if(error||result.code!==0||result.signal)throw fail('VM_RECONCILE_LOCK_BUSY');}
// Internal shared factory. A completed journal is never a cold capability:
// each caller independently opens and holds these actual locks and raw FD.
async function createColdWorkerFile({planFile,expectedPlanSha256,deadline},purpose='reconcile'){
 if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.env.NODE_OPTIONS||process.env.NODE_PATH)throw fail('VM_RECONCILE_ROOT_REQUIRED');
  if(!['reconcile','owned-copyup'].includes(purpose))throw fail('VM_RECONCILE_PLAN_INVALID');
  const end=purpose==='reconcile'?Date.now()+120000:deadline??Date.now()+120000;if(!Number.isSafeInteger(end)||end<=Date.now()||end>Date.now()+600000)throw fail('VM_RECONCILE_DEADLINE');const check=()=>{if(Date.now()>=end)throw fail('VM_RECONCILE_DEADLINE');};
 if(typeof planFile!=='string'||!planFile.startsWith(PRIVATE+'/')||path.dirname(planFile)!==PRIVATE||!planFile.endsWith('.json')||!/^[a-f0-9]{64}$/.test(expectedPlanSha256||''))throw fail('VM_RECONCILE_PLAN_INVALID');
  parents(planFile);const planBytes=boundedRead(planFile,16384,check).bytes;if(sha(planBytes)!==expectedPlanSha256)throw fail('VM_RECONCILE_PLAN_CHANGED');const document=purpose==='reconcile'?validatePlan(JSON.parse(planBytes)):require('./guest-disk-owned-copyup.cjs').validateOwnedPlan(JSON.parse(planBytes)),plan=purpose==='reconcile'?document:document.cold;
 const release=ROOT+'/releases/'+plan.sourceCommit;if(fs.realpathSync(__dirname)!==release+'/development')throw fail('VM_RECONCILE_SIGNED_SOURCE_REQUIRED');
 const source=require('../vast/runtime-release.cjs');if(source.currentCommit(ROOT)!==plan.sourceCommit)throw fail('VM_RECONCILE_SOURCE_CHANGED');source.verifySync(ROOT,plan.sourceCommit);check();
 const consumerFile=release+'/vast/apps-vm.cjs',qualifierFile=release+'/development/guest-disk-fsck.cjs',consumer=boundedRead(consumerFile,128*1024,check),qualifierBytes=boundedRead(qualifierFile,64*1024,check);
 if(sha(qualifierBytes.bytes)!==plan.fsckQualifierSha256||require(consumerFile).RECONCILIATION_CONTRACT!==CONTRACT)throw fail('VM_RECONCILE_CONSUMER_REQUIRED');
 const rawFile=WORKER+'/volume.raw';
  const locks=[];let rawfd=fs.openSync(rawFile,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK|0x40000),initialDirs,expectedRaw=purpose==='reconcile'?plan.raw:Object.fromEntries(fields.map(k=>[k,plan.raw[k]])),closed=false;
  const currentRaw=()=>{check();if(closed)throw fail('VM_RECONCILE_RAW_CLOSED');const s=fs.fstatSync(rawfd,{bigint:true}),named=fs.lstatSync(rawFile,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||!equal(meta(s),meta(named))||!equal(meta(s),expectedRaw))throw fail('VM_RECONCILE_RAW_CHANGED');return{...meta(s),fd:rawfd};};
  const close=()=>{if(closed)return;closed=true;fs.closeSync(rawfd);for(const fd of locks.reverse())fs.closeSync(fd);};
 const assertSource=()=>{check();if(source.currentCommit(ROOT)!==plan.sourceCommit||!equal(consumer.identity,boundedRead(consumerFile,128*1024,check).identity)||!equal(qualifierBytes.identity,boundedRead(qualifierFile,64*1024,check).identity))throw fail('VM_RECONCILE_SOURCE_CHANGED');};
 try{
  const loopTool=fs.realpathSync('/usr/sbin/losetup');if(!/^\/(?:usr\/)?sbin\/losetup$/.test(loopTool))throw fail('VM_RECONCILE_TOOL_UNSAFE');
  const controlTools=['/usr/bin/flock','/usr/bin/setpriv',loopTool].map(file=>{parents(file);const r=boundedRead(file,8*1024**2,check);if(!(BigInt(r.identity.mode)&0o111n))throw fail('VM_RECONCILE_TOOL_UNSAFE');return{file,...r};});
  function loopRows(){check();const r=cp.spawnSync(loopTool,['--json','--list','--output','NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN'],{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore','ignore'],timeout:Math.min(2000,end-Date.now()),maxBuffer:65536});check();if(r.error||r.signal||r.status!==0||r.stderr.length||r.stdout.length>65536)throw fail('VM_RECONCILE_LOOP_UNKNOWN');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.stdout));if(!value||Object.keys(value).length!==1||!Array.isArray(value.loopdevices))throw fail('VM_RECONCILE_LOOP_UNKNOWN');return value.loopdevices;}
  // Each fs.open below creates an independent open-file-description. A still
  // inherited old FD9 lock therefore makes this acquisition FAIL, never qualify.
  for(const[file,owner]of [[ROOT+'/supervisor.lock',0],[APPS+'/apps-service.lock.oslock',1001]]){parents(file);const fd=fs.openSync(file,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);locks.push(fd);const s=fs.fstatSync(fd,{bigint:true}),n=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.uid!==BigInt(owner)||s.nlink!==1n||s.mode&0o022n||!equal(meta(s),meta(n)))throw fail('VM_RECONCILE_LOCK_UNSAFE');await flock(fd,check);}
  initialDirs=[directory(WORKER,1001),directory(APPS,1001),directory(PRIVATE),directory(PUBLIC)];
  parents(plan.coldJournalFile);const stop=boundedRead(plan.coldJournalFile,256*1024,check);if(sha(stop.bytes)!==plan.coldJournalSha256)throw fail('VM_RECONCILE_COLD_JOURNAL_CHANGED');const cold=JSON.parse(stop.bytes);
  if(cold.version!==1||cold.source!==plan.sourceCommit||cold.epoch!==plan.epoch||cold.phase!=='whole-tree-offline'||cold.realIssuerClosedAdmission!==true||!cold.root||!cold.ui||cold.root.uid!==0||cold.ui.uid!==0||!/^pid:\[\d+\]$/.test(cold.pidNamespace||''))throw fail('VM_RECONCILE_REAL_ISSUER_REQUIRED');
  const lease=fs.fstatSync(locks[0],{bigint:true});if(String(cold.leaseFileIdentity?.dev)!==String(lease.dev)||String(cold.leaseFileIdentity?.ino)!==String(lease.ino))throw fail('VM_RECONCILE_LOCK_CHANGED');
  const oldActors=[cold.root,cold.ui,...Object.values(cold.actors||{}),...(cold.modelChildren||[])];if(oldActors.length<3||oldActors.length>64||oldActors.some(x=>!Number.isSafeInteger(x.pid)||x.pid<2||!/^\d+$/.test(x.startTicks||'')))throw fail('VM_RECONCILE_COLD_JOURNAL_CHANGED');
  const admissionFile=PRIVATE+'/runtime-admission-controller.json',cfgFile=ROOT+'/apps-config.json',policyFile=PRIVATE+'/project-execution-policy.json',admission=boundedRead(admissionFile,16384,check),config=boundedRead(cfgFile,16384,check),policy=boundedRead(policyFile,4096,check);
  function assertCold(){
   check();assertSource();if(!equal(initialDirs,[directory(WORKER,1001),directory(APPS,1001),directory(PRIVATE),directory(PUBLIC)]))throw fail('VM_RECONCILE_PARENT_CHANGED');
   if(fs.readlinkSync('/proc/self/ns/pid')!==cold.pidNamespace||fs.readlinkSync('/proc/1/ns/pid')!==cold.pidNamespace||['mnt','user'].some(name=>fs.readlinkSync('/proc/self/ns/'+name)!==fs.readlinkSync('/proc/1/ns/'+name)))throw fail('VM_RECONCILE_NAMESPACE_CHANGED');
   qualifyProcVisibility(procFile('/proc/self/mountinfo',4*1024**2,check),fs.statfsSync('/proc',{bigint:true}).type);
   for(const t of controlTools){const current=boundedRead(t.file,8*1024**2,check);if(!equal(t.identity,current.identity)||!t.bytes.equals(current.bytes))throw fail('VM_RECONCILE_TOOL_CHANGED');}
   if(!planBytes.equals(boundedRead(planFile,16384,check).bytes)||!stop.bytes.equals(boundedRead(plan.coldJournalFile,256*1024,check).bytes))throw fail('VM_RECONCILE_PLAN_CHANGED');
   const a=boundedRead(admissionFile,16384,check).bytes,c=boundedRead(cfgFile,16384,check).bytes;if(!admission.bytes.equals(a)||!config.bytes.equals(c)||!policy.bytes.equals(boundedRead(policyFile,4096,check).bytes))throw fail('VM_RECONCILE_COLD_CHANGED');const av=JSON.parse(a),cv=JSON.parse(c);
   if(av.version!==1||av.open!==false||av.epoch!==plan.epoch||av.sourceCommit!==plan.sourceCommit||cv.enabled!==false||cv.vm?.enabled!==false||cv.vm.root!==WORKER||(cv.stateDir??APPS)!==APPS)throw fail('VM_RECONCILE_ADMISSION_OR_APPS_OPEN');
   for(let i=0;i<locks.length;i++){const file=i===0?ROOT+'/supervisor.lock':APPS+'/apps-service.lock.oslock';if(!equal(meta(fs.fstatSync(locks[i],{bigint:true})),meta(fs.lstatSync(file,{bigint:true}))))throw fail('VM_RECONCILE_LOCK_CHANGED');}
   try{fs.lstatSync(WORKER+'/qemu.pid');throw fail('VM_RECONCILE_PIDFILE_REQUIRES_SEPARATE_REVIEW');}catch(e){if(e.code!=='ENOENT')throw e;}
   currentRaw();scanCold(currentRaw(),oldActors,check,loopRows);
  }
   assertCold();
   // No generic caller receipt changes an identity. Only the separately
   // validated, owned materialization workflow can adopt its own held FD after
   // its full content checks. Reconciliation never calls this surface.
   function adoptRaw(fd,size,{mtime=false}={}){
    check();if(purpose!=='owned-copyup'||closed||!Number.isSafeInteger(fd)||fd<0||![Number(plan.raw.size),document.growth.targetBytes].includes(size))throw fail('VM_RECONCILE_RAW_CHANGED');
    const s=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(rawFile,{bigint:true}),m=meta(s);
    if(!s.isFile()||!equal(m,meta(named))||['dev','ino','uid','gid','mode','nlink'].some(k=>m[k]!==plan.raw[k])||s.size!==BigInt(size)||!mtime&&m.mtimeNs!==expectedRaw.mtimeNs)throw fail('VM_RECONCILE_RAW_CHANGED');
    const old=rawfd;rawfd=fd;expectedRaw=m;if(old!==fd)fs.closeSync(old);return{...m,fd:rawfd};
   }
   return{document,plan,rawFile,get rawFd(){currentRaw();return rawfd;},currentRaw,adoptRaw,check,assertCold,assertSource,close,end,helpers:{boundedRead,atomic,meta,sync,parents,directory}};
  }catch(error){close();throw error;}
}
async function reconcileOffline({planFile,expectedPlanSha256}){
  const owner=await createColdWorkerFile({planFile,expectedPlanSha256}),{plan,assertCold,assertSource,currentRaw,check}=owner;
  const release=ROOT+'/releases/'+plan.sourceCommit,qualifierFile=release+'/development/guest-disk-fsck.cjs',fsck=require(qualifierFile),journalFile=PRIVATE+'/apps-vm-reconcile-'+plan.reconciliationId+'.json',originalFile=PRIVATE+'/apps-vm-legacy-'+plan.reconciliationId+'.json',gateFile=PUBLIC+'/apps-vm-reconciliation.json',stateFile=APPS+'/vm.json';
  try{
   const jsonRead=(file,optional=false)=>{const r=boundedRead(file,MAX,check,{optional});return r?JSON.parse(r.bytes):null;};
  const ops={assertCold,assertSource,readJournal:()=>jsonRead(journalFile,true),readGate:()=>jsonRead(gateFile,true),readState:()=>boundedRead(stateFile,MAX,check,{owner:1001,gid:1001}).bytes,stateIdentity:()=>boundedRead(stateFile,MAX,check,{owner:1001,gid:1001}).identity,
   assertRaw:()=>{check();currentRaw();if(sha(boundedRead(WORKER+'/manifest.json',16384,check,{owner:1001,gid:1001}).bytes)!==plan.manifestSha256)throw fail('VM_RECONCILE_MANIFEST_CHANGED');},
   async fsck(timeoutMs){assertCold();const e2fsck=fs.realpathSync('/usr/sbin/e2fsck'),t=boundedRead(e2fsck,8*1024**2,check),s=t.identity;if(!/^\/(?:usr\/)?sbin\/e2fsck$/.test(e2fsck)||!(BigInt(s.mode)&0o111n))throw fail('VM_RECONCILE_TOOL_UNSAFE');const tool={path:e2fsck,sha256:sha(t.bytes),...Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>[k,s[k]])),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode)};
    const result=await fsck.runFsck({setpriv:'/usr/bin/setpriv',e2fsck,uid:1001,gid:1001,fd:owner.rawFd,timeoutMs:Math.min(timeoutMs,owner.end-Date.now()),tool});
    const after=boundedRead(e2fsck,8*1024**2,check);if(!equal(t.identity,after.identity)||!t.bytes.equals(after.bytes))result.toolStable=false;try{currentRaw();}catch{result.inputStable=false;}
    assertCold();const witness=fsck.assertWitness(result,require('./guest-disk-grow-linux.cjs').superblock(owner.rawFd));return{code:0,warningFree:true,outputSha256:sha(Buffer.from(JSON.stringify([witness.stdout,witness.stderr]))),witness};},
   writeOriginal:b=>writeExclusive(originalFile,b,check),writeJournal:v=>atomic(journalFile,Buffer.from(JSON.stringify(v)),check),writeGate:v=>atomic(gateFile,Buffer.from(JSON.stringify(v)),check,{mode:0o644,...(v.phase==='complete'?{beforeCommit:assertCold}:{})}),publishState:(b,expected)=>atomic(stateFile,b,check,{owner:1001,gid:1001,expected,beforeCommit:()=>{assertCold();currentRaw();if(sha(boundedRead(WORKER+'/manifest.json',16384,check,{owner:1001,gid:1001}).bytes)!==plan.manifestSha256||sha(boundedRead(stateFile,MAX,check,{owner:1001,gid:1001}).bytes)!==expected)throw fail('VM_RECONCILE_STATE_CHANGED');}})};
  assertCold();return await runReconciliation(plan,ops);
  }finally{owner.close();}
}
module.exports={reconcileOffline,CONTRACT,rawMapping,qualifyLoops,qualifyProcVisibility,createColdWorkerFile};
