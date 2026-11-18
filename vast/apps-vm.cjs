'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), net = require('node:net'), crypto = require('node:crypto');
const {LABEL} = require('./apps-engine.cjs');
const {atomicJson}=require('../mobile/private-json.cjs');
const {PILOT_WORKER_PROFILE,validatePilot,validateWorkerShape,workerProfile}=require('./apps-worker-profile.cjs');
const {inspectWorkerCapacity}=require('./apps-worker-growth-policy.cjs');
const {fixedguestOverlayProbe,parseOverlayProbe}=require('./apps-overlay-probe.cjs');
const projectVM=require('./apps-project-vm.cjs');
const {bindAppsExecution,assertAppsExecution}=require('./apps-execution-mode.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Only a ChildProcess returned by THIS controller's spawn is ownership. A PID
// file, matching argv or an old saved state cannot manufacture that handle.
const ownedProcesses=new WeakMap();
const ownershipError=()=>Object.assign(Error('Worker process identity or completion is unconfirmed; explicit read-only reconciliation is required'),{code:'APPS_VM_RECONCILIATION_REQUIRED',status:409});
const settlementError=()=>Object.assign(Error('Owned worker has not closed; completion remains unconfirmed'),{code:'APPS_VM_SETTLEMENT_UNCONFIRMED',status:409});
function pidRecord(vm){
 const file=path.join(vm.root,'qemu.pid');let fd,inspected=false;
 try{
  const before=fs.lstatSync(file);
  inspected=true;
  if(!before.isFile()||before.isSymbolicLink()||before.uid!==process.getuid()||before.nlink!==1||before.mode&0o022||before.size<1||before.size>32)return{kind:'UNKNOWN'};
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const same=s=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>before[k]===s[k]);
  if(!same(fs.fstatSync(fd)))return{kind:'UNKNOWN'};
  const bytes=Buffer.alloc(before.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0);
  if(count!==before.size||!same(fs.fstatSync(fd))||!same(fs.lstatSync(file)))return{kind:'UNKNOWN'};
  const text=bytes.subarray(0,count).toString('utf8');if(!/^[1-9][0-9]{0,9}\n?$/.test(text))return{kind:'UNKNOWN'};
  const pid=Number(text.trim());return Number.isSafeInteger(pid)&&pid>1?{kind:'RECORD',pid}:{kind:'UNKNOWN'};
 }catch(error){return{kind:error.code==='ENOENT'&&!inspected?'ABSENT':'UNKNOWN'};}
 finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{return{kind:'UNKNOWN'};}}
}
function processObservation(vm){
 if(!ownedProcesses.has(vm))return{kind:'UNKNOWN'};
 const record=pidRecord(vm),own=ownedProcesses.get(vm);
 if(record.kind==='UNKNOWN')return record;
 if(own?.child&&!own.closed){
  if(own.exited||!Number.isSafeInteger(own.child.pid)||own.child.pid<2||own.child.exitCode!==null||own.child.signalCode!==null)return{kind:'UNKNOWN'};
  if(record.kind==='RECORD'&&record.pid!==own.child.pid)return{kind:'UNKNOWN'};
  return{kind:'OWNED',pid:own.child.pid};
 }
 const receipt=vm.saved.workerProcess,absentReceipt=receipt?.version===1&&receipt.state==='absent'&&Object.keys(receipt).length===2;
 if(own?.child&&own.closed&&!own.absenceConfirmed)return{kind:'UNKNOWN'};
 return record.kind==='ABSENT'&&(absentReceipt||own?.admitting||own?.fresh&&receipt===undefined)?record:{kind:'UNKNOWN'};
}
function requireProcess(vm,{absent=false}={}){
 const value=processObservation(vm);if(value.kind==='OWNED'||absent&&value.kind==='ABSENT')return value;throw ownershipError();
}
function publishAbsence(vm,own){
 if(!own.closed||pidRecord(vm).kind!=='ABSENT')throw ownershipError();
 vm.saved.workerProcess={version:1,state:'absent'};
 try{vm.save();own.absenceConfirmed=true;}
 catch{vm.saved.workerProcess={version:1,state:'unknown'};throw ownershipError();}
}
function retainChild(vm,child){
 let finish;const own={child,exited:false,closed:false,absenceConfirmed:false,done:new Promise(resolve=>{finish=resolve;})};ownedProcesses.set(vm,own);
 child.on('error',error=>{vm.error=error.message;});
 child.once('exit',()=>{own.exited=true;if(!vm.stopping){vm.phase='settling';vm.error='Worker exited; waiting for its owned process to close';}});
 child.once('close',()=>{
  own.closed=true;vm.serial?.destroy();vm.serial=null;
  if(!vm.stopping){try{publishAbsence(vm,own);vm.phase='asleep';vm.error='Worker exited; next operation may start a new owned worker';}catch{vm.phase='quarantined';vm.error=ownershipError().message;}}
  finish();
 });
 return own;
}
async function waitOwnedClose(own){
 let timer;try{
  // The timeout rejects and retains the private claim. It never creates a
  // completion event or permits a replacement while the old child is unknown.
  await Promise.race([own.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(settlementError()),60000);})]);
 }finally{clearTimeout(timer);}
}
function requireControl(vm,{settling=false,isolated=false,owned=false}={}){
 if(vm.cfg?.enabled===false||vm.cfg?.vm?.enabled===false)throw Object.assign(Error('Docker worker is not enabled; an existing guest remains quarantined for explicit reconciliation'),{code:'APPS_WORKER_DISABLED',status:409});
 if(vm.quarantined)throw ownershipError();
 if(!settling&&ownedProcesses.get(vm)?.stopRequested&&!ownedProcesses.get(vm).closed)throw settlementError();
 if(!settling)assertAppsExecution(vm,{isolated});
 if(owned)requireProcess(vm);
}
function projectsEnabled(vm){return vm.execution.snapshot.mode==='isolated-guest'&&vm.cfg?.projectRuntime?.enabled===true;}
function controlFirewall(){return `
iptables -w -N HARNESS_CONTROL_V1 2>/dev/null || iptables -w -S HARNESS_CONTROL_V1 >/dev/null
firewall_rule() { iptables -w -C "$@" 2>/dev/null || iptables -w -A "$@"; }
firewall_rule HARNESS_CONTROL_V1 -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN
firewall_rule HARNESS_CONTROL_V1 -d 10.0.2.3/32 -p udp --dport 53 -j RETURN
firewall_rule HARNESS_CONTROL_V1 -d 10.0.2.3/32 -p tcp --dport 53 -j RETURN
firewall_rule HARNESS_CONTROL_V1 -d 10.0.2.2/32 -p udp --dport 67 -j RETURN
firewall_rule HARNESS_CONTROL_V1 -d 10.0.2.0/24 -j REJECT
iptables -w -C OUTPUT -j HARNESS_CONTROL_V1 2>/dev/null || iptables -w -I OUTPUT 1 -j HARNESS_CONTROL_V1
iptables -w -C DOCKER-USER -j HARNESS_CONTROL_V1 2>/dev/null || iptables -w -I DOCKER-USER 1 -j HARNESS_CONTROL_V1
iptables -w -C INPUT ! -i eth0 -p tcp --dport 2375 -j REJECT 2>/dev/null || iptables -w -I INPUT 1 ! -i eth0 -p tcp --dport 2375 -j REJECT
for scope in all default; do
 if test -e /proc/sys/net/ipv6/conf/$scope/disable_ipv6; then echo 1 > /proc/sys/net/ipv6/conf/$scope/disable_ipv6; fi
done
`;}

function bootstrap(manifest, initialize, nonce, repairCache=false) {
 if (!/^[a-f0-9]{32}$/.test(manifest.volumeId) || !/^[a-f0-9]{16}$/.test(nonce)) throw Error('Invalid bootstrap identity');
 return `#!/bin/sh
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
isolate_control_plane() { ${controlFirewall()} }
require_unified_cgroups() {
 test "$(stat -f -c %T /sys/fs/cgroup)" = cgroup2fs || { echo REFUSE_NON_UNIFIED_CGROUPS; exit 1; }
 for controller in memory cpu pids; do grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || { echo REQUIRED_CGROUP_CONTROLLER_MISSING; exit 1; }; done
}
require_daemon_cgroup() {
 daemon_pid=$(pidof dockerd)
 case "$daemon_pid" in ''|*[!0-9]*) echo REFUSE_AMBIGUOUS_DAEMON_PID; exit 1;; esac
 test "$(cat /proc/$daemon_pid/cgroup)" = '0::/homeai-daemons/docker' || { echo REFUSE_DAEMON_LEAF_COLD_BOOT_REQUIRED; exit 1; }
 test -f /sys/fs/cgroup/homeai-daemons/docker/memory.swap.max
 test -z "$(cat /sys/fs/cgroup/homeai-containers/cgroup.procs)"
 for controller in cpu memory pids; do grep -qw "$controller" /sys/fs/cgroup/homeai-containers/cgroup.subtree_control; done
}
# Existing v1/hybrid guests require a deliberate cold boot. Never remount a
# running workload's hierarchy or relax the managed resource admission gate.
grep -qw 'cgroup_no_v1=all' /proc/cmdline || { echo REFUSE_UNIFIED_COLD_BOOT_REQUIRED; exit 1; }
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then require_unified_cgroups; require_daemon_cgroup; isolate_control_plane; echo HARNESS_READY_${nonce}; exit 0; fi
ip link set eth0 up
udhcpc -i eth0 -q -n
printf '%s\\n' 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main' 'https://dl-cdn.alpinelinux.org/alpine/v3.24/community' > /etc/apk/repositories
modprobe ext4
mkdir -p /var/lib/harness
if ! mountpoint -q /var/lib/harness; then
 if ! mount -t ext4 /dev/vda /var/lib/harness; then
  ${initialize ? `test "$(blockdev --getsize64 /dev/vda)" = ${PILOT_WORKER_PROFILE.diskBytes}
  if test -n "$(blkid /dev/vda)"; then echo REFUSE_EXISTING_FILESYSTEM; exit 1; fi
  apk add --no-cache e2fsprogs
  mkfs.ext4 -F -m 0 -L sdsh-docker /dev/vda
  mount -t ext4 /dev/vda /var/lib/harness` : 'echo REFUSE_REFORMAT_PERSISTENT_VOLUME; exit 1'}
 fi
fi
if test -f /var/lib/harness/.stratadashseek-volume; then
 test "$(cat /var/lib/harness/.stratadashseek-volume)" = '${manifest.volumeId}'
else
 ${initialize ? `test -z "$(ls -A /var/lib/harness | grep -v '^lost+found$')"
 printf '%s' '${manifest.volumeId}' > /var/lib/harness/.stratadashseek-volume` : 'echo VOLUME_ID_MISSING; exit 1'}
fi
mkdir -p /var/lib/harness/apk-cache
if ! apk --cache-dir /var/lib/harness/apk-cache --no-network add docker acpid; then
 ${initialize||repairCache ? 'apk --cache-dir /var/lib/harness/apk-cache update\n apk --cache-dir /var/lib/harness/apk-cache add docker acpid' : 'echo OFFLINE_PACKAGE_CACHE_UNAVAILABLE; exit 1'}
fi
${initialize||repairCache ? 'apk --cache-dir /var/lib/harness/apk-cache cache sync' : ''}
printf '\\nrc_cgroup_mode="unified"\\n' >> /etc/rc.conf
rc-service cgroups start
require_unified_cgroups
printf '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control
mkdir -p /sys/fs/cgroup/homeai-daemons /sys/fs/cgroup/homeai-containers
test -z "$(cat /sys/fs/cgroup/homeai-daemons/cgroup.procs)"
test -z "$(cat /sys/fs/cgroup/homeai-containers/cgroup.procs)"
printf '+cpu +memory +pids' > /sys/fs/cgroup/homeai-daemons/cgroup.subtree_control
printf '+cpu +memory +pids' > /sys/fs/cgroup/homeai-containers/cgroup.subtree_control
mkdir -p /sys/fs/cgroup/homeai-daemons/docker
test -f /sys/fs/cgroup/homeai-daemons/docker/memory.swap.max
rc-service acpid start
if ! pidof dockerd >/dev/null; then
 sh -c 'printf "%s\\n" "$$" > /sys/fs/cgroup/homeai-daemons/docker/cgroup.procs; exec "$@"' homeai-daemon dockerd --storage-driver=${PILOT_WORKER_PROFILE.storageDriver} --data-root=/var/lib/harness/docker --cgroup-parent=/homeai-containers --host=unix:///var/run/docker.sock --host=tcp://0.0.0.0:2375 --tls=false --label=io.stratadashseek.worker=${manifest.volumeId} > /tmp/docker.log 2>&1 &
fi
for n in $(seq 1 90); do
 if docker info >/dev/null 2>&1; then require_daemon_cgroup; isolate_control_plane; sync; echo HARNESS_READY_${nonce}; exit 0; fi
 sleep 1
done
tail -n 30 /tmp/docker.log
exit 1
`;
}

class DockerVM {
 constructor(cfg, engine, executionBinding) {
  this.execution=bindAppsExecution(executionBinding);
  if(process.getuid?.()===0)throw Error('Docker VM must run as the unprivileged harness user');
  if(cfg.vm.root!=='/data/harness/docker-worker')throw Error('Unexpected pilot worker directory');
  this.cfg=cfg; this.engine=engine; this.root=cfg.vm.root; this.stateFile=path.join(cfg.stateDir,'vm.json');
  const manifestBytes=fs.readFileSync(path.join(this.root,'manifest.json'));this.manifestSha256=crypto.createHash('sha256').update(manifestBytes).digest('hex');
  this.manifest=JSON.parse(manifestBytes);validateWorkerShape(this.manifest);
  const hasSavedState=fs.existsSync(this.stateFile);
  this.saved=hasSavedState?JSON.parse(fs.readFileSync(this.stateFile)):{initialized:false,resumeIds:[],containers:[]};
  this.phase='asleep'; this.error=null; this.serial=null; this.pending=null; this.lastUsed=Date.now(); this.stopping=false; this.buffer='';
  ownedProcesses.set(this,{fresh:!hasSavedState,child:null,closed:true});
  const observed=processObservation(this),unknown=observed.kind==='UNKNOWN',disabled=cfg.enabled!==true||cfg.vm.enabled!==true;
  // Detecting a PID is observation only. Disabled startup never turns it into
  // an automatic ensure()/resume operation, even if configuration later changes.
  this.quarantined=unknown;
  this.phase=unknown?'quarantined':disabled?'disabled':'asleep';
  if(unknown)this.error=ownershipError().message;
 }
 save(){atomicJson(this.stateFile,this.saved);}
 pid(){const value=processObservation(this);return value.kind==='OWNED'?value.pid:null;}
 capacityStatus(){const capacity=inspectWorkerCapacity({workerRoot:this.root,guardFile:'/data/harness/runtime-status/worker-capacity.json'});return capacity.allowed&&capacity.manifestSha256!==this.manifestSha256?{...capacity,allowed:false,phase:'unknown',reasonCode:'WORKER_CAPACITY_MANIFEST_CHANGED'}:capacity;}
 requireCapacity(){const capacity=this.capacityStatus();if(!capacity.allowed||capacity.manifestSha256!==this.manifestSha256)throw Object.assign(Error(capacity.reasonCode||'WORKER_CAPACITY_MANIFEST_CHANGED'),{code:capacity.reasonCode||'WORKER_CAPACITY_MANIFEST_CHANGED'});validatePilot(this.manifest,{capacity});return capacity;}
 status(){
  let executionError=null;try{assertAppsExecution(this);}catch(error){executionError=error.code||'PROJECT_EXECUTION_BINDING_UNAVAILABLE';}
  const observation=processObservation(this);if(observation.kind==='UNKNOWN')executionError=executionError??'APPS_VM_RECONCILIATION_REQUIRED';
  const capacity=this.capacityStatus(),ready=this.phase==='ready'&&observation.kind==='OWNED'&&capacity.allowed&&!executionError;
  return{managed:true,phase:capacity.allowed&&!executionError?this.phase:'blocked',pid:this.pid(),error:this.error??executionError??capacity.reasonCode??null,capacity,idleSeconds:this.cfg.vm.idleSeconds||120,freeBytes:this.freeBytes??null,freeInodes:this.freeInodes??null,totalBytes:this.totalBytes??null,usedBytes:this.usedBytes??null,totalInodes:this.totalInodes??null,storageCategories:this.storageCategories??null,storageCheckedAt:this.storageCheckedAt??null,diskCheckedAt:this.diskCheckedAt??null,profile:workerProfile(this.manifest,{capacity,driver:this.observedStorageDriver,at:this.storageObservedAt,ready}),initialized:!!this.saved.initialized,controlIsolation:{version:this.saved.controlIsolationVersion||0,verified:ready&&this.saved.controlIsolationVersion===1},projectRuntimeIsolation:ready&&projectsEnabled(this)&&this.projectRuntimeIsolation?.bootPid===this.pid()?structuredClone(this.projectRuntimeIsolation):null};
 }
 touch(){this.lastUsed=Date.now();}
 async ensure(){
  requireControl(this);requireProcess(this,{absent:true});this.requireCapacity();
  this.touch();const waitUntil=Date.now()+90000;while(this.stopping&&Date.now()<waitUntil){await pause(250);requireControl(this);}if(this.stopping)throw Error('Docker is still saving its state; retry shortly');
  if(this.pending){await this.pending;requireControl(this);return;}
  this.pending=this.start().finally(()=>{this.pending=null;});await this.pending;requireControl(this);
 }
 async connectSerial({settling=false}={}){
  requireControl(this,{settling,owned:true});
  if(this.serial&&!this.serial.destroyed)return;
  const socket=net.createConnection(path.join(this.root,'serial.sock'));socket.setEncoding('utf8');
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  try{requireControl(this,{settling});}catch(error){socket.destroy();throw error;}
  this.serial=socket;socket.on('error',e=>{this.error=e.message;});
  socket.on('data',text=>{
   if(this.phase==='starting')try{requireControl(this);}catch(error){this.phase='error';this.error=error.message;socket.destroy();return;}
   if(text.includes('\x1b[6n'))socket.write('\x1b[1;1R');
   this.buffer=(this.buffer+text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-16384);const log=path.join(this.root,'console.log');
   try{const old=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';fs.writeFileSync(log,(old+text).slice(-256*1024),{mode:0o600});}catch{}
   const free=this.buffer.match(/HARNESS_FREE_([a-f0-9]{16})=(\d+)/g)?.at(-1);if(free)this.freeBytes=Number(free.split('=')[1])*1024;
   if(this.phase==='starting' && /login:\s*$/.test(this.buffer)){socket.write('root\n');this.buffer='';}
   else if(this.phase==='starting' && /(?:localhost:~|\/\s*)#\s*$/.test(this.buffer) && !this.scriptSent){
    this.scriptSent=true;const script=Buffer.from(bootstrap(this.manifest,!this.saved.initialized,this.nonce,!!this.repairCache)).toString('base64');
    socket.write("base64 -d > /tmp/harness-boot.sh <<'HARNESS_SCRIPT'\n"+script.match(/.{1,512}/g).join('\n')+"\nHARNESS_SCRIPT\nsh /tmp/harness-boot.sh; printf 'HARNESS_BOOT_EXIT_"+this.nonce+"=%s\\n' \"$?\"\n");
   }
  });
  socket.write('\n');
 }
 async start(){
  requireControl(this);requireProcess(this,{absent:true});this.requireCapacity();
  const projects=projectsEnabled(this);
  if(this.phase==='ready' && this.pid() && this.saved.controlIsolationVersion===1 && this.saved.resourceBootstrapVersion===2 && (!projects||this.projectRuntimeIsolation?.bootPid===this.pid())){await this.engine.available();requireControl(this);return;}
  this.phase='starting';this.error=null;this.scriptSent=false;this.nonce=crypto.randomBytes(8).toString('hex');
  if(this.serial&&!this.serial.destroyed)this.serial.write('\n');
  if(requireProcess(this,{absent:true}).kind==='ABSENT'){
   for(const name of ['serial.sock','qmp.sock','qemu.pid'])try{fs.unlinkSync(path.join(this.root,name));}catch(e){if(e.code!=='ENOENT')throw e;}
   const stat=fs.statfsSync(this.root);if(stat.bavail*stat.bsize<2*1024**3)throw Error('Less than 2 GiB host reserve; worker not started');
   const forwards=['hostfwd=tcp:127.0.0.1:19075-:2375'];
   for(let n=0;n<this.cfg.portCount;n++)forwards.push('hostfwd=tcp:127.0.0.1:'+(this.cfg.firstPort+n)+'-:'+(this.cfg.firstPort+n));
   if(projects)forwards.push(...projectVM.forwards());
   const args=['-name','stratadashseek-docker','-accel',PILOT_WORKER_PROFILE.acceleration+',thread=single','-smp',String(PILOT_WORKER_PROFILE.vcpus),'-m',String(PILOT_WORKER_PROFILE.memoryMiB),'-cpu','max','-display','none','-monitor','none','-no-reboot',
    '-chardev','socket,id=console,path='+this.root+'/serial.sock,server=on,wait=off','-serial','chardev:console','-qmp','unix:'+this.root+'/qmp.sock,server=on,wait=off','-pidfile',this.root+'/qemu.pid',
    '-kernel',this.root+'/vmlinuz-virt','-initrd',this.root+'/initramfs-virt','-cdrom',this.root+'/alpine.iso','-drive','file='+this.root+'/volume.raw,format=raw,if=virtio,cache=writeback',
    '-append','console=ttyS0 alpine_dev=cdrom:iso9660 modules=loop,squashfs,sd-mod,usb-storage,virtio_blk quiet cgroup_no_v1=all swapaccount=1','-netdev','user,id=net0,'+forwards.join(','),'-device','virtio-net-pci,netdev=net0'];
   requireControl(this);this.projectRuntimeIsolation=null;this.projectBootKernelSha256=projects?projectVM.kernelFingerprint(this):null;this.projectExports=projects?projectVM.openExports(this.cfg):null;
   if(this.projectExports)args.push(...projectVM.qemuArguments(Boolean(this.projectExports.toolchain)));
   let log;
   try{
    requireControl(this);this.requireCapacity();log=fs.openSync(path.join(this.root,'qemu.log'),'a',0o600);requireControl(this);
    const admission=ownedProcesses.get(this);admission.admitting=true;
    try{
     // This existing private state file fences controller restart even if the
     // QEMU pidfile disappears before the new process can be reconciled.
     this.saved.workerProcess={version:1,state:'starting'};this.save();requireControl(this);
     this.child=cp.spawn('nice',['-n','19','qemu-system-x86_64',...args],{cwd:this.root,stdio:['ignore',log,log,...(this.projectExports?[this.projectExports.projects.fd,this.projectExports.transport.fd,...(this.projectExports.toolchain?[this.projectExports.toolchain.fd]:[])]:[])]});retainChild(this,this.child);
    }finally{admission.admitting=false;}
   }
   finally{if(log!==undefined)fs.closeSync(log);projectVM.closeExports(this.projectExports);}
  }
  const deadline=Date.now()+(this.saved.initialized?300000:900000);
  try{
   while(Date.now()<deadline){
    requireControl(this,{owned:true});
    const bootExit=this.buffer.match(new RegExp('HARNESS_BOOT_EXIT_'+this.nonce+'=(\\d+)'));if(bootExit&&Number(bootExit[1])!==0)throw Error('Guest setup failed with exit '+bootExit[1]+'; inspect the worker console');
    if(!this.serial||this.serial.destroyed)try{await this.connectSerial();requireControl(this);}catch(error){requireControl(this);}
    if(!this.scriptSent||!this.buffer.includes('HARNESS_READY_'+this.nonce)||!bootExit){await pause(250);requireControl(this);continue;}
    try{
     const info=await this.engine.json('GET','/info',{timeout:2000});
     requireControl(this);
     if(!info.Labels?.includes('io.stratadashseek.worker='+this.manifest.volumeId))throw Error('Unexpected Docker worker identity');
     if(info.CgroupVersion!=='2')throw Object.assign(Error('Unified cgroup v2 was not reported by the managed Docker worker; cold reconciliation is required'),{code:'APPS_CGROUP_V2_REQUIRED'});
     this.observedStorageDriver=info.Driver;this.storageObservedAt=Date.now();
     this.phase='restoring';this.saved.initialized=true;this.saved.controlIsolationVersion=1;this.saved.resourceBootstrapVersion=2;this.save();
     if(projects){requireControl(this,{isolated:true});await projectVM.proveExports(this);requireControl(this,{isolated:true});}
     const resumeIds=this.saved.resumeIds||[];
     if(resumeIds.length){if(typeof this.validateResume!=='function')throw Error('Published application resume identities require the application controller');await this.validateResume(resumeIds);requireControl(this);}
     for(const id of resumeIds){requireControl(this);if(typeof this.startManagedContainer!=='function')throw Error('Managed container resource admission requires the application controller');await this.startManagedContainer(id);requireControl(this);}
     this.phase='ready';this.touch();await this.diskFree();requireControl(this);this.save();return;
    }catch(e){requireControl(this);if(this.phase!=='starting'||e.code==='APPS_CGROUP_V2_REQUIRED')throw e;}
    await pause(1000);requireControl(this);
   }
   throw Error('Docker worker startup exceeded five minutes; inspect its console');
  }catch(e){this.phase='error';this.error=e.message;throw e;}
 }
 async diskFree(){
  requireControl(this,{owned:true});
  if(!this.serial||this.serial.destroyed){await this.connectSerial();requireControl(this);}const nonce=crypto.randomBytes(8).toString('hex');
  this.serial.write("df -Pk /var/lib/harness | tail -n 1 | awk '{printf \"HARNESS_TOTAL_"+nonce+"=%s\\nHARNESS_USED_"+nonce+"=%s\\nHARNESS_FREE_"+nonce+"=%s\\n\", $2, $3, $4}'; df -Pi /var/lib/harness | tail -n 1 | awk '{printf \"HARNESS_ITOTAL_"+nonce+"=%s\\nHARNESS_INODES_"+nonce+"=%s\\n\", $2, $4}'\n");
  const deadline=Date.now()+5000;while(Date.now()<deadline){requireControl(this);const read=label=>{const found=this.buffer.match(new RegExp('HARNESS_'+label+'_'+nonce+'=(\\d+)'));return found?Number(found[1]):null;},available=read('FREE'),inodes=read('INODES');if(available!==null&&inodes!==null){this.freeBytes=available*1024;this.freeInodes=inodes;this.totalBytes=read('TOTAL')===null?null:read('TOTAL')*1024;this.usedBytes=read('USED')===null?null:read('USED')*1024;this.totalInodes=read('ITOTAL');this.diskCheckedAt=Date.now();return this.freeBytes;}await pause(100);requireControl(this);}throw Error('Worker disk space and inodes could not be verified');
 }
 async probeOverlay(){
  requireControl(this);
  if(this.phase!=='ready'||this.saved.controlIsolationVersion!==1||!this.pid()||!this.serial||this.serial.destroyed)throw Error('Overlay probe requires an already ready verified managed worker');
  if(this.overlayProbePending)throw Error('An overlay probe is already running');
  const nonce=crypto.randomBytes(8).toString('hex'),dir='/tmp/harness-overlay-'+nonce,script=Buffer.from(fixedguestOverlayProbe({volumeId32hex:this.manifest.volumeId,nonce16hex:nonce})).toString('base64');
  this.overlayProbePending=nonce;
  try{
   // The fixed script is the only serial payload. A private, nonexisting guest
   // directory and the outer hard timeout bound even interrupted diagnostics.
   this.serial.write("( umask 077; if mkdir '"+dir+"'; then\nbase64 -d > '"+dir+"/probe.sh' <<'OVERLAY_SCRIPT_"+nonce+"'\n"+script.match(/.{1,512}/g).join('\n')+"\nOVERLAY_SCRIPT_"+nonce+"\ntimeout -s TERM -k 20 45 sh '"+dir+"/probe.sh'; probe_rc=$?\nif test ! -L '"+dir+"' && test \"$(readlink -f '"+dir+"')\" = '"+dir+"' && test \"$(stat -c %u '"+dir+"')\" = 0; then rm -f -- '"+dir+"/probe.sh' && rmdir -- '"+dir+"' || probe_rc=124; else probe_rc=124; fi\nprintf 'HARNESS_OVERLAY_DONE_"+nonce+"=%s\\n' \"$probe_rc\"; else printf 'HARNESS_OVERLAY_DONE_"+nonce+"=125\\n'; fi )\n");
   const deadline=Date.now()+70000;while(Date.now()<deadline){requireControl(this);const done=this.buffer.match(new RegExp('(?:^|\\n)HARNESS_OVERLAY_DONE_'+nonce+'=(\\d+)(?:\\r?\\n|$)'));if(done){const result=parseOverlayProbe(this.buffer,nonce),rc=Number(done[1]);if(rc===124||rc===125)throw Error('Overlay probe wrapper cleanup or preparation failed');if(result.supported&&rc!==0)throw Error('Overlay probe success conflicts with its exit status');const report={...result,checkedAt:Date.now()};this.saved.overlayProbe={...report,volumeId:this.manifest.volumeId,alpineSHA256:this.manifest.alpineSHA256};this.save();return report;}await pause(100);requireControl(this);}throw Error('Bounded overlay probe did not return a complete result');
  }finally{this.overlayProbePending=null;}
 }
 async remember({settling=false}={}){requireControl(this,{settling,owned:true});if(this.phase!=='ready')return;const listed=await this.engine.list();requireControl(this,{settling,owned:true});const rows=listed.filter(c=>c.Labels?.[LABEL+'.role']!=='test');this.saved.containers=rows;this.saved.resumeIds=rows.filter(c=>c.State==='running'&&!/^project-(?:editor|relay|executor|egress)$/.test(c.Labels?.[LABEL+'.role']||'')).map(c=>c.Id);this.save();}
 async prepareProjectRuntime(input){requireControl(this,{isolated:true});const value=await projectVM.prepare(this,input);requireControl(this,{isolated:true});return value;}
 async projectRuntimeHealth(input){requireControl(this,{isolated:true});const value=await projectVM.health(this,input);requireControl(this,{isolated:true});return value;}
 async prepareProjectEgress(input){requireControl(this,{isolated:true});const value=await projectVM.prepareEgress(this,input);requireControl(this,{isolated:true});return value;}
 async projectEgressHealth(input){requireControl(this,{isolated:true});const value=await projectVM.egressHealth(this,input);requireControl(this,{isolated:true});return value;}
 async stop(){
  requireControl(this,{settling:true});
  if(this.pending)throw Error('Docker worker is starting');if(this.stopping)throw Error('Docker worker is already stopping');
  const observed=requireProcess(this,{absent:true});if(observed.kind==='ABSENT'){this.phase='asleep';return;}
  const own=ownedProcesses.get(this);
  this.stopping=true;
  try{
   if(this.phase!=='ready')throw Error('Worker is not in a verified state; refusing automatic poweroff');
   own.stopRequested=true;
   await this.remember({settling:true});this.phase='saving';
   // Inspect before stopping: a stop can hold daemon locks for its full grace period.
   const stopIds=this.saved.containers?this.saved.containers.filter(c=>c.State==='running').map(c=>c.Id):this.saved.resumeIds;
   await Promise.all(stopIds.map(id=>this.engine.owned(id)));
   requireProcess(this);
   const stops=await Promise.allSettled(stopIds.map(id=>this.engine.request('POST','/containers/'+id+'/stop?t=15',{timeout:45000})));
   const failed=stops.find(r=>r.status==='rejected');if(failed)throw failed.reason;
   requireProcess(this);
   if(!this.serial||this.serial.destroyed)await this.connectSerial({settling:true});this.serial.write('\nkill -TERM $(pidof dockerd) 2>/dev/null || true; for n in $(seq 1 30); do pidof dockerd >/dev/null || break; sleep 1; done; if pidof dockerd >/dev/null; then echo HARNESS_DOCKER_SHUTDOWN_FAILED; else sync; poweroff; fi\n');
   await waitOwnedClose(own);
   publishAbsence(this,own);
   if(processObservation(this).kind!=='ABSENT')throw ownershipError();
   this.phase='asleep';this.serial?.destroy();this.serial=null;this.error=null;
  }catch(e){this.phase='error';this.error=e.message;throw e;}finally{this.stopping=false;}
 }
}
module.exports={DockerVM,bootstrap,controlFirewall};
