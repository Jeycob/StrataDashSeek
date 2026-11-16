'use strict';
// Operator-only source. Never imported by startup or the production launcher.
// The sole writable export is a new synthetic tmpfs directory, not user data.
// Primary references: https://www.qemu.org/docs/master/system/invocation.html
// (-fsdev: passthrough needs root; none ignores failed attribute updates;
// mapped-xattr stores uid/mode/link targets in metadata) and
// https://docs.kernel.org/filesystems/9p.html (virtio transport/cache options).
// Neither coherent reads nor a bind/chroot check establishes Docker isolation.
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const BOOT_ROOT='/data/harness/docker-worker',ISO_SHA256='157d353f8e54252cad2d9812a0d56bb7fa2231fc154a110e1d180d7480ef8b4f';
const PREFIX='/dev/shm/homeai-project-share-probe-';
function validate(nonce,securityModel){if(!/^[a-f0-9]{16}$/.test(nonce))throw Error('NONCE_INVALID');if(!['none','mapped-xattr'].includes(securityModel))throw Error('SECURITY_MODEL_NOT_REVIEWED');}
function fixtureRoot(nonce){validate(nonce,'none');return PREFIX+nonce;}
function checkedCleanup(target){
 if(!new RegExp('^'+PREFIX+'[a-f0-9]{16}$').test(target))throw Error('UNSAFE_CLEANUP_PATH');
 const info=fs.lstatSync(target);if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(target)!==target)throw Error('UNSAFE_CLEANUP_TARGET');
 // Node removes symlinks themselves and does not recurse into their targets.
 fs.rmSync(target,{recursive:true,force:false});
}
function qemuArgs(baseArgs,nonce,securityModel='none'){
 validate(nonce,securityModel);
 if(baseArgs[baseArgs.indexOf('-nic')+1]!=='none'||baseArgs.filter(x=>x==='-drive').length!==1||!baseArgs.includes('file=/proc/self/fd/5,media=cdrom,readonly=on,format=raw'))throw Error('BOOT_PLAN_NOT_DISPOSABLE');
 if(baseArgs.some(x=>/fsdev|virtfs|hostfwd|volume\.raw|qmp|daemonize/.test(x)))throw Error('BOOT_PLAN_UNEXPECTED_ACCESS');
 return [...baseArgs,'-fsdev','local,id=project-probe,path=/proc/self/fd/6,security_model='+securityModel+',multidevs=forbid,writeout=immediate','-device','virtio-9p-pci,fsdev=project-probe,mount_tag=homeai-project-probe'];
}
function guestScript(nonce){
 validate(nonce,'none');const mount='/mnt/project-share-'+nonce,token='HOST_CANARY_'+nonce;
 return `#!/bin/sh
set -eu
echo SHARE_KERNEL=$(uname -r)
modprobe 9p
modprobe 9pnet_virtio
mkdir -p ${mount}
mount -t 9p -o trans=virtio,version=9p2000.L,cache=none,msize=262144,access=client homeai-project-probe ${mount}
echo SHARE_MOUNT_READY
grep ' ${mount} ' /proc/mounts
test "$(cat ${mount}/project-a/live.txt)" = HOST_INITIAL_${nonce}
test "$(cat ${mount}/project-b/other.txt)" = SIBLING_${nonce}
echo SHARE_TRUSTED_GUEST_SEES_BOTH_PROJECTS=expected
for f in ${mount}/project-a/escape-absolute ${mount}/project-a/escape-relative ${mount}/../outside-canary; do
  if cat "$f" 2>/dev/null | grep -q '${token}'; then echo SHARE_HOST_CANARY_ESCAPE=failed; exit 31; fi
done
echo SHARE_HOST_CANARY_READ=blocked
# A writable ../ path leaves the mount into disposable guest RAM, not host.
printf 'GUEST_LOCAL_ONLY' > ${mount}/../outside-canary
for f in ${mount}/project-a/escape-absolute ${mount}/project-a/escape-relative; do printf 'ESCAPE_ATTEMPT' > "$f" 2>/dev/null || true; done
printf 'GUEST_WRITE_${nonce}' > ${mount}/project-a/live.txt
printf 'guest-created' > ${mount}/project-a/guest-created.txt
ln -s live.txt ${mount}/project-a/guest-link
chmod 640 ${mount}/project-a/guest-created.txt
echo SHARE_GUEST_WRITE_${nonce}=ready
if command -v inotifyd >/dev/null 2>&1; then
  printf '#!/bin/sh\\nprintf "event\\\\n" >> /tmp/share-events\\n' > /tmp/share-event.sh
  chmod 700 /tmp/share-event.sh
  inotifyd /tmp/share-event.sh ${mount}/project-a/live.txt:cw > /tmp/share-inotify-errors 2>&1 & watch=$!
  sleep 1
  if kill -0 "$watch" 2>/dev/null; then echo SHARE_WATCHER=started; else echo SHARE_WATCHER=unavailable; fi
else watch=; echo SHARE_WATCHER=unavailable; fi
echo SHARE_HOST_WRITE_${nonce}=ready
n=0
until test "$(cat ${mount}/project-a/live.txt)" = HOST_SECOND_${nonce}; do n=$((n+1)); test "$n" -lt 20; sleep 1; done
echo SHARE_HOST_WRITE_VISIBLE=passed
sleep 2
if test -s /tmp/share-events; then echo SHARE_HOST_INOTIFY=observed; else echo SHARE_HOST_INOTIFY=not_observed; fi
if test -n "$watch"; then kill "$watch" 2>/dev/null || true; wait "$watch" 2>/dev/null || true; fi
# Independent mount/chroot proof, deliberately not represented as Docker proof.
prison=/tmp/share-prison-${nonce}
mkdir -p "$prison/bin" "$prison/lib" "$prison/workspace"
cp /bin/busybox "$prison/bin/"
for lib in /lib/ld-musl-*.so.1; do test ! -f "$lib" || cp "$lib" "$prison/lib/"; done
cat > "$prison/check.sh" <<'CHILD_PROBE'
set -eu
test "$(/bin/busybox cat /workspace/live.txt)" = HOST_SECOND_${nonce}
for f in /workspace/../project-b/other.txt /mnt/project-share-${nonce}/project-b/other.txt /workspace/escape-absolute /workspace/escape-relative; do
  if /bin/busybox cat "$f" 2>/dev/null | /bin/busybox grep -Eq "SIBLING_${nonce}|HOST_CANARY_${nonce}"; then exit 41; fi
done
CHILD_PROBE
unshare -m -p -f sh -c '
  set -eu
  mount --make-rprivate /
  mount --bind ${mount}/project-a "$1/workspace"
  chroot "$1" /bin/busybox sh /check.sh
' probe "$prison"
echo SHARE_BIND_CHILD_SCOPE=passed
echo SHARE_DONE_${nonce}=0
`;
}
function prepareFixture(nonce){
 const root=fixtureRoot(nonce);if(fs.statfsSync('/dev/shm').type!==0x01021994)throw Error('TMPFS_REQUIRED');
 fs.mkdirSync(root,{mode:0o700});const exported=root+'/projects';
 try{fs.mkdirSync(exported,{mode:0o700});for(const child of ['project-a','project-b'])fs.mkdirSync(exported+'/'+child,{mode:0o700});
  fs.writeFileSync(root+'/outside-canary','HOST_CANARY_'+nonce,{mode:0o600,flag:'wx'});
  fs.writeFileSync(exported+'/project-a/live.txt','HOST_INITIAL_'+nonce,{mode:0o600,flag:'wx'});
  fs.writeFileSync(exported+'/project-b/other.txt','SIBLING_'+nonce,{mode:0o600,flag:'wx'});
  fs.symlinkSync(root+'/outside-canary',exported+'/project-a/escape-absolute');fs.symlinkSync('../../outside-canary',exported+'/project-a/escape-relative');
  return{root,exported,live:exported+'/project-a/live.txt'};
 }catch(error){checkedCleanup(root);throw error;}
}
async function runProbe({securityModel='none',helpers}={}){
 if(process.platform!=='linux'||process.getuid()===0)throw Error('UNPRIVILEGED_LINUX_OPERATOR_REQUIRED');
 const nonce=crypto.randomBytes(8).toString('hex');validate(nonce,securityModel);
 helpers??=globalThis.HOMEAI_GUEST_PROBE_HELPERS??require('./guest-capability-probe.cjs');
 const freeKiB=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1]);if(!Number.isSafeInteger(freeKiB)||freeKiB<1024*1024)throw Error('HOST_MEMORY_RESERVE');
 const fds=[];let fixture;
 try{
  for(const name of ['vmlinuz-virt','initramfs-virt','alpine.iso']){const fd=fs.openSync(BOOT_ROOT+'/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);fds.push(fd);const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>256*1024**2)throw Error('BOOT_ARTIFACT_INVALID');}
  if(helpers.digest(fds[2])!==ISO_SHA256)throw Error('PINNED_ISO_MISMATCH');const boot=helpers.isoBootFiles(fds[2]);for(let i=0;i<2;i++)if(helpers.digest(fds[i])!==helpers.digest(fds[2],boot[i].start,boot[i].size))throw Error('BOOT_ISO_MISMATCH');
  fixture=prepareFixture(nonce);const liveBefore=fs.statSync(fixture.live);fds.push(fs.openSync(fixture.exported,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_DIRECTORY));
  const startedAt=new Date().toISOString(),started=Date.now(),args=qemuArgs(helpers.qemuArgs(nonce),nonce,securityModel);
  const child=cp.spawn('/usr/bin/nice',['-n','19','qemu-system-x86_64',...args],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',TERM:'dumb'},stdio:['pipe','pipe','pipe',...fds]});
  let output='',loggingIn=false,sent=false,finished=false,reason='GUEST_EXITED_BEFORE_RESULT',forced,peakRssBytes=0,guestWriteObserved=false,hostWriteSent=false,sameInode=false;
  const stop=value=>{if(finished)return;finished=true;reason=value;child.kill('SIGTERM');forced=setTimeout(()=>child.kill('SIGKILL'),2000);forced.unref();};
  const timer=setTimeout(()=>stop('DEADLINE_EXCEEDED'),178000),monitor=setInterval(()=>{try{const rss=Number(fs.readFileSync('/proc/'+child.pid+'/status','utf8').match(/^VmRSS:\s+(\d+)/m)?.[1])*1024;peakRssBytes=Math.max(peakRssBytes,rss||0);if(rss>640*1024**2)stop('HOST_RSS_LIMIT');}catch{}},1000);
  const interrupted=()=>stop('OPERATOR_INTERRUPTED');process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  function data(chunk){try{
   output+=chunk.toString();if(Buffer.byteLength(output)>256*1024){output=output.slice(-128*1024);stop('CONSOLE_LIMIT');return;}const clean=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
   if(!loggingIn&&/login:\s*$/.test(clean)){loggingIn=true;child.stdin.write('root\n');}
   if(!sent&&/(?:localhost:~|\/\s*)#\s*$/.test(clean)){sent=true;const encoded=Buffer.from(guestScript(nonce)).toString('base64').match(/.{1,160}/g).join('\n');child.stdin.write("stty -echo\nbase64 -d > /tmp/share-probe.sh <<'SHARE_SCRIPT'\n"+encoded+"\nSHARE_SCRIPT\nsh /tmp/share-probe.sh; printf '\\nSHARE_EXIT_"+nonce+"=%s\\n' \"$?\"\n");}
   if(!guestWriteObserved&&clean.includes('SHARE_GUEST_WRITE_'+nonce+'=ready')){guestWriteObserved=fs.readFileSync(fixture.live,'utf8')==='GUEST_WRITE_'+nonce;const after=fs.statSync(fixture.live);sameInode=after.dev===liveBefore.dev&&after.ino===liveBefore.ino;if(!guestWriteObserved||!sameInode){stop('LIVE_FILE_IDENTITY_FAILED');return;}}
   if(!hostWriteSent&&clean.includes('SHARE_HOST_WRITE_'+nonce+'=ready')){hostWriteSent=true;const fd=fs.openSync(fixture.live,fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW);try{fs.writeFileSync(fd,'HOST_SECOND_'+nonce);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
   const done=clean.match(new RegExp('(?:^|\\n)SHARE_EXIT_'+nonce+'=(\\d+)(?:\\r?\\n|$)'));if(done)stop(Number(done[1])===0?'SHARE_OBSERVED':'GUEST_PROBE_FAILED');
  }catch{stop('HOST_VERIFICATION_FAILED');}}
  child.stdout.on('data',data);child.stderr.on('data',data);child.stdin.on('error',()=>{});
  try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);clearTimeout(forced);clearInterval(monitor);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}
  const canaryUnchanged=fs.readFileSync(fixture.root+'/outside-canary','utf8')==='HOST_CANARY_'+nonce;
  const created=fixture.exported+'/project-a/guest-created.txt',link=fixture.exported+'/project-a/guest-link';
  const metadata=fs.existsSync(created)?{uid:fs.statSync(created).uid,gid:fs.statSync(created).gid,mode:fs.statSync(created).mode&0o777,hostNativeSymlink:fs.existsSync(link)&&fs.lstatSync(link).isSymbolicLink()}:null;
  return{version:1,startedAt,durationMs:Date.now()-started,reason:canaryUnchanged?reason:'HOST_CANARY_CHANGED',securityModel,peakRssBytes,guestMemoryMiB:384,tcgCacheMiB:32,hostRssLimitMiB:640,vcpus:1,hostWritableDisks:0,networkAdapters:0,syntheticTmpfsExports:1,guestWriteObserved,sameInode,hostWriteSent,hostWriteVisible:/SHARE_HOST_WRITE_VISIBLE=passed/.test(output),canaryUnchanged,metadata,watcherAvailable:/SHARE_WATCHER=started/.test(output),hostInotify:/SHARE_HOST_INOTIFY=observed/.test(output),childScope:/SHARE_BIND_CHILD_SCOPE=passed/.test(output),isoSHA256:ISO_SHA256,output,limits:'9p capability and synthetic mount/chroot scope only; no Docker, production isolation, actual editor watcher, credentials, signal or container-network acceptance.'};
 }finally{for(const fd of fds)fs.closeSync(fd);if(fixture)checkedCleanup(fixture.root);}
}
module.exports={qemuArgs,guestScript,fixtureRoot,checkedCleanup,runProbe};
if(require.main===module){if(process.argv[2]!=='run-disposable'){console.error('Operator only: project-share-probe.cjs run-disposable [none|mapped-xattr]; fresh quiescence required.');process.exitCode=2;}else runProbe({securityModel:process.argv[3]??'none'}).then(result=>{console.log(JSON.stringify(result));if(result.reason!=='SHARE_OBSERVED')process.exitCode=1;},error=>{console.error(error.message);process.exitCode=1;});}
