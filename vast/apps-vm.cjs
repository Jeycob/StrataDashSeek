'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), net = require('node:net'), crypto = require('node:crypto');
const {LABEL} = require('./apps-engine.cjs');
const {atomicJson}=require('../mobile/private-json.cjs');
const {PILOT_WORKER_PROFILE,validatePilot,workerProfile}=require('./apps-worker-profile.cjs');
const {fixedguestOverlayProbe,parseOverlayProbe}=require('./apps-overlay-probe.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function requireControl(vm){
 if(vm.cfg?.enabled===false||vm.cfg?.vm?.enabled===false||vm.quarantined)throw Object.assign(Error('Docker worker is not enabled; an existing guest remains quarantined for explicit reconciliation'),{code:'APPS_WORKER_DISABLED',status:409});
}
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
 constructor(cfg, engine) {
  if(process.getuid?.()===0)throw Error('Docker VM must run as the unprivileged harness user');
  if(cfg.vm.root!=='/data/harness/docker-worker')throw Error('Unexpected pilot worker directory');
  this.cfg=cfg; this.engine=engine; this.root=cfg.vm.root; this.stateFile=path.join(cfg.stateDir,'vm.json');
  this.manifest=JSON.parse(fs.readFileSync(path.join(this.root,'manifest.json')));
  validatePilot(this.manifest);
  this.saved=fs.existsSync(this.stateFile)?JSON.parse(fs.readFileSync(this.stateFile)):{initialized:false,resumeIds:[],containers:[]};
  this.phase='asleep'; this.error=null; this.serial=null; this.pending=null; this.lastUsed=Date.now(); this.stopping=false; this.buffer='';
  const live=this.pid(),disabled=cfg.enabled!==true||cfg.vm.enabled!==true;
  // Detecting a PID is observation only. Disabled startup never turns it into
  // an automatic ensure()/resume operation, even if configuration later changes.
  this.quarantined=!!live&&disabled;
  this.phase=disabled?(live?'quarantined':'disabled'):(live?'recovering':'asleep');
 }
 save(){atomicJson(this.stateFile,this.saved);}
 pid(){try{const pid=Number(fs.readFileSync(path.join(this.root,'qemu.pid'),'utf8')); const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');return args.includes('stratadashseek-docker') && args.includes('file='+this.root+'/volume.raw,format=raw,if=virtio,cache=writeback')?pid:null;}catch{return null;}}
 status(){return{managed:true,phase:this.phase,pid:this.pid(),error:this.error,idleSeconds:this.cfg.vm.idleSeconds||120,freeBytes:this.freeBytes??null,freeInodes:this.freeInodes??null,totalBytes:this.totalBytes??null,usedBytes:this.usedBytes??null,totalInodes:this.totalInodes??null,storageCategories:this.storageCategories??null,storageCheckedAt:this.storageCheckedAt??null,diskCheckedAt:this.diskCheckedAt??null,profile:workerProfile(this.manifest,{driver:this.observedStorageDriver,at:this.storageObservedAt,ready:this.phase==='ready'}),initialized:!!this.saved.initialized,controlIsolation:{version:this.saved.controlIsolationVersion||0,verified:this.phase==='ready'&&this.saved.controlIsolationVersion===1}};}
 touch(){this.lastUsed=Date.now();}
 async ensure(){
  requireControl(this);
  this.touch();const waitUntil=Date.now()+90000;while(this.stopping&&Date.now()<waitUntil)await pause(250);if(this.stopping)throw Error('Docker is still saving its state; retry shortly');
  if(this.pending)return this.pending;
  this.pending=this.start().finally(()=>{this.pending=null;});return this.pending;
 }
 async connectSerial(){
  requireControl(this);
  if(this.serial&&!this.serial.destroyed)return;
  const socket=net.createConnection(path.join(this.root,'serial.sock'));socket.setEncoding('utf8');
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  this.serial=socket;socket.on('error',e=>{this.error=e.message;});
  socket.on('data',text=>{
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
  requireControl(this);
  if(this.phase==='ready' && this.pid() && this.saved.controlIsolationVersion===1 && this.saved.resourceBootstrapVersion===2){await this.engine.available();return;}
  this.phase='starting';this.error=null;this.scriptSent=false;this.nonce=crypto.randomBytes(8).toString('hex');
  if(this.serial&&!this.serial.destroyed)this.serial.write('\n');
  if(!this.pid()){
   for(const name of ['serial.sock','qmp.sock','qemu.pid'])try{fs.unlinkSync(path.join(this.root,name));}catch(e){if(e.code!=='ENOENT')throw e;}
   const stat=fs.statfsSync(this.root);if(stat.bavail*stat.bsize<2*1024**3)throw Error('Less than 2 GiB host reserve; worker not started');
   const forwards=['hostfwd=tcp:127.0.0.1:19075-:2375'];
   for(let n=0;n<this.cfg.portCount;n++)forwards.push('hostfwd=tcp:127.0.0.1:'+(this.cfg.firstPort+n)+'-:'+(this.cfg.firstPort+n));
   const args=['-name','stratadashseek-docker','-accel',PILOT_WORKER_PROFILE.acceleration+',thread=single','-smp',String(PILOT_WORKER_PROFILE.vcpus),'-m',String(PILOT_WORKER_PROFILE.memoryMiB),'-cpu','max','-display','none','-monitor','none','-no-reboot',
    '-chardev','socket,id=console,path='+this.root+'/serial.sock,server=on,wait=off','-serial','chardev:console','-qmp','unix:'+this.root+'/qmp.sock,server=on,wait=off','-pidfile',this.root+'/qemu.pid',
    '-kernel',this.root+'/vmlinuz-virt','-initrd',this.root+'/initramfs-virt','-cdrom',this.root+'/alpine.iso','-drive','file='+this.root+'/volume.raw,format=raw,if=virtio,cache=writeback',
    '-append','console=ttyS0 alpine_dev=cdrom:iso9660 modules=loop,squashfs,sd-mod,usb-storage,virtio_blk quiet cgroup_no_v1=all swapaccount=1','-netdev','user,id=net0,'+forwards.join(','),'-device','virtio-net-pci,netdev=net0'];
   const log=fs.openSync(path.join(this.root,'qemu.log'),'a',0o600);this.child=cp.spawn('nice',['-n','19','qemu-system-x86_64',...args],{cwd:this.root,stdio:['ignore',log,log]});fs.closeSync(log);
   this.child.on('error',e=>{this.error=e.message;});this.child.on('exit',()=>{this.serial?.destroy();this.serial=null;if(!this.stopping){this.phase='asleep';this.error='Worker exited; next operation will recover it';}});
  }
  const deadline=Date.now()+(this.saved.initialized?300000:900000);
  try{
   while(Date.now()<deadline){
    const bootExit=this.buffer.match(new RegExp('HARNESS_BOOT_EXIT_'+this.nonce+'=(\\d+)'));if(bootExit&&Number(bootExit[1])!==0)throw Error('Guest setup failed with exit '+bootExit[1]+'; inspect the worker console');
    if(!this.serial||this.serial.destroyed)try{await this.connectSerial();}catch{}
    if(!this.scriptSent||!this.buffer.includes('HARNESS_READY_'+this.nonce)||!bootExit){await pause(250);continue;}
    try{
     const info=await this.engine.json('GET','/info',{timeout:2000});
     if(!info.Labels?.includes('io.stratadashseek.worker='+this.manifest.volumeId))throw Error('Unexpected Docker worker identity');
     if(info.CgroupVersion!=='2')throw Object.assign(Error('Unified cgroup v2 was not reported by the managed Docker worker; cold reconciliation is required'),{code:'APPS_CGROUP_V2_REQUIRED'});
     this.observedStorageDriver=info.Driver;this.storageObservedAt=Date.now();
     this.phase='restoring';this.saved.initialized=true;this.saved.controlIsolationVersion=1;this.saved.resourceBootstrapVersion=2;this.save();
     const resumeIds=this.saved.resumeIds||[];
     if(resumeIds.length){if(typeof this.validateResume!=='function')throw Error('Published application resume identities require the application controller');await this.validateResume(resumeIds);}
     for(const id of resumeIds){if(typeof this.startManagedContainer!=='function')throw Error('Managed container resource admission requires the application controller');await this.startManagedContainer(id);}
     this.phase='ready';this.touch();await this.diskFree();this.save();return;
    }catch(e){if(this.phase!=='starting'||e.code==='APPS_CGROUP_V2_REQUIRED')throw e;}
    await pause(1000);
   }
   throw Error('Docker worker startup exceeded five minutes; inspect its console');
  }catch(e){this.phase='error';this.error=e.message;throw e;}
 }
 async diskFree(){
  requireControl(this);
  if(!this.serial||this.serial.destroyed)await this.connectSerial();const nonce=crypto.randomBytes(8).toString('hex');
  this.serial.write("df -Pk /var/lib/harness | tail -n 1 | awk '{printf \"HARNESS_TOTAL_"+nonce+"=%s\\nHARNESS_USED_"+nonce+"=%s\\nHARNESS_FREE_"+nonce+"=%s\\n\", $2, $3, $4}'; df -Pi /var/lib/harness | tail -n 1 | awk '{printf \"HARNESS_ITOTAL_"+nonce+"=%s\\nHARNESS_INODES_"+nonce+"=%s\\n\", $2, $4}'\n");
  const deadline=Date.now()+5000;while(Date.now()<deadline){const read=label=>{const found=this.buffer.match(new RegExp('HARNESS_'+label+'_'+nonce+'=(\\d+)'));return found?Number(found[1]):null;},available=read('FREE'),inodes=read('INODES');if(available!==null&&inodes!==null){this.freeBytes=available*1024;this.freeInodes=inodes;this.totalBytes=read('TOTAL')===null?null:read('TOTAL')*1024;this.usedBytes=read('USED')===null?null:read('USED')*1024;this.totalInodes=read('ITOTAL');this.diskCheckedAt=Date.now();return this.freeBytes;}await pause(100);}throw Error('Worker disk space and inodes could not be verified');
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
   const deadline=Date.now()+70000;while(Date.now()<deadline){const done=this.buffer.match(new RegExp('(?:^|\\n)HARNESS_OVERLAY_DONE_'+nonce+'=(\\d+)(?:\\r?\\n|$)'));if(done){const result=parseOverlayProbe(this.buffer,nonce),rc=Number(done[1]);if(rc===124||rc===125)throw Error('Overlay probe wrapper cleanup or preparation failed');if(result.supported&&rc!==0)throw Error('Overlay probe success conflicts with its exit status');const report={...result,checkedAt:Date.now()};this.saved.overlayProbe={...report,volumeId:this.manifest.volumeId,alpineSHA256:this.manifest.alpineSHA256};this.save();return report;}await pause(100);}throw Error('Bounded overlay probe did not return a complete result');
  }finally{this.overlayProbePending=null;}
 }
 async remember(){requireControl(this);if(this.phase!=='ready')return;const rows=(await this.engine.list()).filter(c=>c.Labels?.[LABEL+'.role']!=='test');this.saved.containers=rows;this.saved.resumeIds=rows.filter(c=>c.State==='running').map(c=>c.Id);this.save();}
 async stop(){
  requireControl(this);
  if(this.pending)throw Error('Docker worker is starting');if(this.stopping)throw Error('Docker worker is already stopping');
  if(!this.pid()){this.phase='asleep';return;}
  this.stopping=true;
  try{
   if(this.phase!=='ready')throw Error('Worker is not in a verified state; refusing automatic poweroff');
   await this.remember();this.phase='saving';
   // Inspect before stopping: a stop can hold daemon locks for its full grace period.
   await Promise.all(this.saved.resumeIds.map(id=>this.engine.owned(id)));
   const stops=await Promise.allSettled(this.saved.resumeIds.map(id=>this.engine.request('POST','/containers/'+id+'/stop?t=15',{timeout:45000})));
   const failed=stops.find(r=>r.status==='rejected');if(failed)throw failed.reason;
   if(!this.serial||this.serial.destroyed)await this.connectSerial();this.serial.write('\nkill -TERM $(pidof dockerd) 2>/dev/null || true; for n in $(seq 1 30); do pidof dockerd >/dev/null || break; sleep 1; done; if pidof dockerd >/dev/null; then echo HARNESS_DOCKER_SHUTDOWN_FAILED; else sync; poweroff; fi\n');
   const deadline=Date.now()+60000;while(this.pid()&&Date.now()<deadline)await pause(500);
   if(this.pid())throw Error('Guest did not power off cleanly; host sleep was cancelled');
   this.phase='asleep';this.serial?.destroy();this.serial=null;this.error=null;
  }catch(e){this.phase='error';this.error=e.message;throw e;}finally{this.stopping=false;}
 }
}
module.exports={DockerVM,bootstrap,controlFirewall};
