'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {validatePlan,canonical,sha256,CONTRACT}=require('./guest-disk-grow.cjs');
const fail=code=>Object.assign(Error(code),{code});
const F=fs.constants,MAX=16384,OVERLAY=0x794c7630;
function boundedFile(file,{owner=0,optional=false}={}){
 let fd;try{fd=fs.openSync(file,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==owner||s.nlink!==1||s.mode&0o022||s.size<1||s.size>MAX)throw fail('GROW_INPUT_UNSAFE');const b=Buffer.alloc(s.size+1),n=fs.readSync(fd,b,0,b.length,0),a=fs.lstatSync(file);if(n!==s.size||a.isSymbolicLink()||a.ino!==s.ino||a.dev!==s.dev)throw fail('GROW_INPUT_CHANGED');return b.subarray(0,n);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function directory(file,owner=0){const s=fs.lstatSync(file);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==owner||s.mode&0o022||fs.realpathSync(file)!==file)throw fail('GROW_PARENT_UNSAFE');return s;}
function rootParents(file){let at=path.parse(file).root;for(const part of path.dirname(file).slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,part);const s=fs.lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)&&!(s.mode&0o1000))throw fail('GROW_PARENT_UNSAFE');}}
function atomic(file,value,{owner=0,gid=0,mode=0o600}={}){
 const parent=directory(path.dirname(file),owner),temp=file+'.grow-'+require('node:crypto').randomBytes(8).toString('hex');let fd;
 try{fd=fs.openSync(temp,F.O_WRONLY|F.O_CREAT|F.O_EXCL|F.O_NOFOLLOW,mode);fs.writeFileSync(fd,canonical(value));fs.fchownSync(fd,owner,gid);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;const again=directory(path.dirname(file),owner);if(again.ino!==parent.ino||again.dev!==parent.dev)throw fail('GROW_PARENT_CHANGED');try{const old=fs.lstatSync(file);if(!old.isFile()||old.isSymbolicLink()||old.nlink!==1||old.uid!==owner)throw fail('GROW_OUTPUT_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}fs.renameSync(temp,file);const d=fs.openSync(path.dirname(file),F.O_RDONLY|F.O_DIRECTORY|F.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
 finally{if(fd!==undefined)fs.closeSync(fd);/* Preserve any unpublished temporary for operator inspection. */}
}
function superblock(fd){
 const b=Buffer.alloc(1024);if(fs.readSync(fd,b,0,b.length,1024)!==1024||b.readUInt16LE(56)!==0xef53||b.readUInt32LE(24)!==2)throw fail('GROW_EXT4_UNSUPPORTED');
 const wide=Boolean(b.readUInt32LE(96)&0x80),count=(lo,hi)=>Number(BigInt(b.readUInt32LE(lo))+(wide?BigInt(b.readUInt32LE(hi))<<32n:0n));
 const value={uuid:b.subarray(104,120).toString('hex'),blockSize:4096,blockCount:count(4,336),freeBlocks:count(12,344),inodeCount:b.readUInt32LE(0),freeInodes:b.readUInt32LE(16),clean:Boolean(b.readUInt16LE(58)&1)};
 if(!Object.values(value).every(x=>typeof x!=='number'||Number.isSafeInteger(x))||value.freeBlocks>value.blockCount||value.freeInodes>value.inodeCount)throw fail('GROW_EXT4_UNSUPPORTED');return value;
}
async function command(exe,args,{fds=[],uid,gid,timeoutMs=1000,stdoutLimit=1024*1024}={}){
 // Never inherit model/account environment or the root FD9 supervisor lease.
 const child=cp.spawn(exe,args,{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'},...(uid===undefined?{}:{uid,gid}),stdio:['ignore','pipe','pipe',...fds,'ignore','ignore','ignore','ignore','ignore','ignore'],windowsHide:true});
 let bytes=0,expired=false,clipped=false,spawnError;const chunks=[];
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes>stdoutLimit){clipped=true;child.kill('SIGKILL');}else chunks.push(b);});
 const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},timeoutMs);child.once('error',error=>spawnError=error);
 const code=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);
 // Return only after the owned child actually closes; a kill request is not settlement.
 if(spawnError||expired||clipped||code!==0)throw fail(expired?'GROW_TOOL_TIMEOUT':clipped?'GROW_TOOL_OUTPUT_LIMIT':'GROW_TOOL_FAILED');return{code,outputSha256:sha256(Buffer.concat(chunks))};
}
function trustedTool(file){rootParents(file);const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.mode&0o022||!(s.mode&0o111))throw fail('GROW_TOOL_UNSAFE');return file;}
function scanCold(plan,raw,ownPid=process.pid){
 const pids=fs.readdirSync('/proc').filter(name=>/^[1-9][0-9]*$/.test(name));if(pids.length>4096)throw fail('GROW_PROCESS_SCAN_UNKNOWN');let fds=0;
 for(const pid of pids){if(Number(pid)===ownPid)continue;try{
  const status=fs.readFileSync('/proc/'+pid+'/status','utf8'),state=status.match(/^State:\s+(\S)/m)?.[1];if(state==='Z'||state==='X')continue;
  const uid=Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);if(!Number.isSafeInteger(uid))throw fail('GROW_PROCESS_SCAN_UNKNOWN');if(uid===plan.serviceUid)throw fail('GROW_WRITER_ACTIVE');
  const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');if(args.length>1024*1024)throw fail('GROW_PROCESS_SCAN_UNKNOWN');if(args.includes('qemu')&&(args.includes(plan.workerRoot)||args.includes('stratadashseek-docker')))throw fail('GROW_QEMU_ACTIVE');
  for(const name of fs.readdirSync('/proc/'+pid+'/fd')){if(++fds>65536)throw fail('GROW_PROCESS_SCAN_UNKNOWN');try{const s=fs.statSync('/proc/'+pid+'/fd/'+name);if(s.isFile()&&s.dev===raw.dev&&s.ino===raw.ino)throw fail('GROW_RAW_IN_USE');}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}}
 }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw fail(/^GROW_/.test(error.code||'')?error.code:'GROW_PROCESS_SCAN_UNKNOWN');}}
 // A regular image cannot be an ext4 block mount without a loop association.
 // Refuse associations even if currently unmounted, and inspect all namespaces.
 const devices=fs.readdirSync('/sys/class/block');
 for(const name of devices.filter(name=>/^loop\d+$/.test(name))){let backing;try{backing=fs.readFileSync('/sys/class/block/'+name+'/loop/backing_file','utf8').trim();}catch(error){if(error.code==='ENOENT')continue;throw fail('GROW_MOUNT_SCAN_UNKNOWN');}if(backing===plan.workerRoot+'/volume.raw'||backing.replace(/ \(deleted\)$/,'')===plan.workerRoot+'/volume.raw')throw fail('GROW_RAW_ATTACHED');}
 for(const pid of pids)try{const text=fs.readFileSync('/proc/'+pid+'/mountinfo','utf8');if(text.length>4*1024*1024)throw fail('GROW_MOUNT_SCAN_UNKNOWN');if(text.includes(plan.workerRoot+'/volume.raw'))throw fail('GROW_RAW_MOUNTED');}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw fail(/^GROW_/.test(error.code||'')?error.code:'GROW_MOUNT_SCAN_UNKNOWN');}
}
async function makeOperations(planFile,{expectedPlanSha256,fixture=false}={}){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw fail('GROW_LINUX_ROOT_REQUIRED');rootParents(planFile);
 const plan=validatePlan(JSON.parse(boundedFile(planFile).toString('utf8')),{fixture});if(expectedPlanSha256!==sha256(plan))throw fail('GROW_PLAN_HASH_MISMATCH');
 const root=plan.installationRoot,worker=plan.workerRoot,rawFile=worker+'/volume.raw',state=root+'/root-secrets/runtime/state',guardFile=root+'/runtime-status/worker-capacity.json',journalFile=state+'/guest-grow-'+plan.migrationId+'.json';
 rootParents(root+'/entry');directory(root);directory(state);directory(root+'/runtime-status');rootParents(state+'/entry');directory(worker,plan.serviceUid);directory(plan.appsStateDir,plan.serviceUid);
 const tools=Object.fromEntries(['e2fsck','resize2fs','fallocate','flock','setpriv'].map(name=>[name,trustedTool(fs.realpathSync((['e2fsck','resize2fs'].includes(name)?'/usr/sbin/':'/usr/bin/')+name))]));
 const locks=[],raw=fs.openSync(rawFile,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);let writeFd,closed=false;
 const current=()=>writeFd??raw;
 const rawInfo=()=>{const s=fs.fstatSync(current()),p=fs.lstatSync(rawFile);if(!s.isFile()||p.isSymbolicLink()||s.nlink!==1||p.nlink!==1||s.mode&0o022||s.dev!==p.dev||s.ino!==p.ino||s.uid!==plan.serviceUid||s.gid!==plan.serviceGid)throw fail('GROW_IDENTITY_CHANGED');return{dev:s.dev,ino:s.ino,uid:s.uid,gid:s.gid,bytes:s.size,allocatedBytes:s.blocks*512,links:s.nlink,mode:s.mode&0o777};};
 async function close(){if(closed)return;closed=true;if(writeFd!==undefined)fs.closeSync(writeFd);fs.closeSync(raw);for(const fd of locks.reverse())fs.closeSync(fd);}
 try{
  for(const [file,owner]of [[root+'/supervisor.lock',0],[plan.appsStateDir+'/apps-service.lock.oslock',plan.serviceUid]]){const fd=fs.openSync(file,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);locks.push(fd);const s=fs.fstatSync(fd),p=fs.lstatSync(file);if(!s.isFile()||s.nlink!==1||s.uid!==owner||s.mode&0o022||s.ino!==p.ino||s.dev!==p.dev)throw fail('GROW_LOCK_UNSAFE');await command(tools.flock,['-n','3'],{fds:[fd]});}
  const cfgHash=sha256(boundedFile(root+'/apps-config.json')),admissionFile=state+'/runtime-admission-controller.json',admissionHash=sha256(boundedFile(admissionFile));
  function assertCold(){
   if(sha256(validatePlan(JSON.parse(boundedFile(planFile).toString('utf8')),{fixture}))!==expectedPlanSha256)throw fail('GROW_PLAN_CHANGED');
   if(sha256(boundedFile(root+'/apps-config.json'))!==cfgHash)throw fail('GROW_CONFIG_CHANGED');const cfg=JSON.parse(boundedFile(root+'/apps-config.json').toString('utf8'));if(cfg.enabled!==false||cfg.vm?.enabled!==false||cfg.vm.root!==worker||(cfg.stateDir??root+'/state/applications')!==plan.appsStateDir)throw fail('GROW_APPS_NOT_DISABLED');
   const admissionBytes=boundedFile(admissionFile),admission=JSON.parse(admissionBytes.toString('utf8'));if(sha256(admissionBytes)!==admissionHash||admission.version!==1||admission.open!==false||admission.epoch!==plan.coldFence.epoch||admission.sourceCommit!==plan.coldFence.sourceCommit)throw fail('GROW_ADMISSION_NOT_CLOSED');
   directory(worker,plan.serviceUid);rawInfo();scanCold(plan,rawInfo());
  }
  function inspect(){const manifestBytes=boundedFile(worker+'/manifest.json',{owner:plan.serviceUid}),s=fs.statfsSync(worker),p=fs.statSync(worker),j=fs.statSync(state);if(p.dev!==j.dev)throw fail('GROW_CAPACITY_FILESYSTEM_MISMATCH');return{raw:rawInfo(),fs:superblock(current()),manifest:JSON.parse(manifestBytes.toString('utf8')),manifestSha256:sha256(manifestBytes),host:{availableBytes:s.bavail*s.bsize,availableInodes:s.ffree,backing:Number(s.type)===OVERLAY?'overlay':Number(s.type)===0xef53||fixture&&Number(s.type)===0x01021994?'direct':'unknown'}};}
  function assertConsumer(contract){
   if(fixture)return;
   // This handshake must come from the actual protected signed serving release,
   // never an operator boolean, plan field or agent-writable capabilities file.
   const release=require('../vast/runtime-release.cjs'),commit=release.currentCommit(root);release.verifySync(root,commit);
   const profile=path.join(root,'releases',commit,'vast/apps-worker-profile.cjs');rootParents(profile);boundedFile(profile);
   const installed=require(profile);if(installed.CAPACITY_MIGRATION_CONTRACT!==contract)throw fail('GROW_RUNTIME_CONSUMER_REQUIRED');
  }
  const ops={fixture,assertCold,assertConsumer,inspect,readJournal:()=>{const b=boundedFile(journalFile,{optional:true});return b?JSON.parse(b.toString('utf8')):null;},readGuard:()=>{const b=boundedFile(guardFile,{optional:true});return b?JSON.parse(b.toString('utf8')):undefined;},writeJournal:value=>atomic(journalFile,value),writeGuard:value=>atomic(guardFile,value,{mode:0o644}),
   fsck:timeoutMs=>command(tools.setpriv,['--reuid',String(plan.serviceUid),'--regid',String(plan.serviceGid),'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',tools.e2fsck,'-f','-n','/proc/self/fd/3'],{fds:[current()],timeoutMs}),
   async allocate(delta,timeoutMs){writeFd=fs.openSync(rawFile,F.O_RDWR|F.O_NOFOLLOW|F.O_NONBLOCK);const s=rawInfo();if(s.dev!==plan.source.dev||s.ino!==plan.source.ino||s.bytes!==plan.source.bytes)throw fail('GROW_IDENTITY_CHANGED');await command(tools.fallocate,['--keep-size','--offset',String(plan.source.bytes),'--length',String(delta),'/proc/self/fd/3'],{fds:[writeFd],timeoutMs});fs.fsyncSync(writeFd);if(rawInfo().allocatedBytes<plan.targetBytes)throw fail('GROW_PHYSICAL_ALLOCATION_UNPROVEN');},
   extend:bytes=>{if(writeFd===undefined||bytes!==plan.targetBytes||rawInfo().bytes!==plan.source.bytes)throw fail('GROW_LENGTH_UNCERTAIN');fs.ftruncateSync(writeFd,bytes);fs.fsyncSync(writeFd);},
   resize:(blocks,timeoutMs)=>command(tools.setpriv,['--reuid',String(plan.serviceUid),'--regid',String(plan.serviceGid),'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',tools.resize2fs,'/proc/self/fd/3',String(blocks)],{fds:[current()],timeoutMs}),
   async sealAllocation(bytes,timeoutMs){if(writeFd===undefined||bytes!==plan.targetBytes||rawInfo().bytes!==bytes)throw fail('GROW_LENGTH_UNCERTAIN');await command(tools.fallocate,['--keep-size','--offset','0','--length',String(bytes),'/proc/self/fd/3'],{fds:[writeFd],timeoutMs});fs.fsyncSync(writeFd);if(rawInfo().allocatedBytes<bytes)throw fail('GROW_PHYSICAL_ALLOCATION_UNPROVEN');},
   writeManifest:value=>atomic(worker+'/manifest.json',value,{owner:plan.serviceUid,gid:plan.serviceGid})};
  assertCold();return{plan,ops,close};
 }catch(error){await close();throw error;}
}
const createLinuxOperations=(file,options)=>makeOperations(file,{...options,fixture:false});
// Explicitly separate fixture seam: hard-limited unique /tmp image, at most
// 128MiB source+target, never available through growOffline or a runtime flag.
const createFixtureOperations=(file,options)=>makeOperations(file,{...options,fixture:true});
module.exports={createLinuxOperations,createFixtureOperations,superblock};
