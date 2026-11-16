'use strict';
// Operator-only combined proof. No production startup import or runtime hooks.
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const PREFIX='/dev/shm/homeai-container-share-probe-';
const ROOT='/data/harness/docker-worker',GiB=1024**3,ISO_SHA256='157d353f8e54252cad2d9812a0d56bb7fa2231fc154a110e1d180d7480ef8b4f';
function validate(nonce){if(!/^[a-f0-9]{16}$/.test(nonce))throw Error('NONCE_INVALID');}
function replaceOnce(source,old,replacement){if(source.split(old).length!==2)throw Error('PROBE_TEMPLATE_CHANGED');return source.replace(old,replacement);}
function qemuArgs(base){
 if(base[base.indexOf('-nic')+1]!=='none'||base.some(x=>/fsdev|virtfs|hostfwd|daemonize/.test(x)))throw Error('UNSAFE_BASE_PLAN');
 const blocks=base.flatMap((x,i)=>x==='-blockdev'?[JSON.parse(base[i+1])]:[]);
 if(blocks.length!==2||blocks.some(x=>x['read-only']!==true)||!blocks.some(x=>x.filename==='/proc/self/fd/6'))throw Error('OLD_DISK_NOT_READONLY');
 return [...base,'-fsdev','local,id=combined-projects,path=/proc/self/fd/7,security_model=none,multidevs=forbid,writeout=immediate','-device','virtio-9p-pci,fsdev=combined-projects,mount_tag=combined-projects',
 '-fsdev','local,id=combined-transport,path=/proc/self/fd/8,security_model=none,multidevs=forbid,readonly=on','-device','virtio-9p-pci,fsdev=combined-transport,mount_tag=combined-transport'];
}
function guestScript(nonce,proof=require('./guest-container-isolation-probe.cjs')){
 validate(nonce);
 let script=proof.guestScript(nonce);
 const setup=`
modprobe 9p
modprobe 9pnet_virtio
mkdir /mnt/combined-projects /mnt/combined-transport
mount -t 9p -o trans=virtio,version=9p2000.L,cache=none,msize=262144,access=client combined-projects /mnt/combined-projects
mount -t 9p -o ro,trans=virtio,version=9p2000.L,cache=none,msize=262144,access=client combined-transport /mnt/combined-transport
grep -q ' /mnt/combined-transport 9p ro,' /proc/mounts
test "$(cat /mnt/combined-projects/project-a/live.txt)" = HOST_INITIAL_${nonce}
test "$(cat /mnt/combined-projects/project-b/host-sibling)" = HOST_SIBLING_${nonce}
test "$(cat /mnt/combined-transport/scope-b/gen-b/canary)" = TRANSPORT_SIBLING_${nonce}
echo COMBINED_TRUSTED_GUEST_SEES_SYNTHETIC_SIBLINGS=expected
`;
 script=replaceOnce(script,'echo ISOLATION_SCOPE=fresh_guest_RAM_synthetic_no_production_project',setup+'\necho ISOLATION_SCOPE=fresh_guest_RAM_synthetic_no_production_project');
 script=script.replaceAll('/tmp/isolation-a','/mnt/combined-projects/project-a').replaceAll('/tmp/isolation-b','/mnt/combined-projects/project-b');
 script=replaceOnce(script,'mkdir /tmp/isolation-docker /tmp/isolation-rootfs /mnt/combined-projects/project-a /mnt/combined-projects/project-b','mkdir /tmp/isolation-docker /tmp/isolation-rootfs');
 script=replaceOnce(script,'/tmp/isolation-rootfs/tmp','/tmp/isolation-rootfs/tmp /tmp/isolation-rootfs/run/homeai-transport');
 const containerChecks=`
test "$($bb cat /workspace/live.txt)" = HOST_INITIAL_${nonce}
printf GUEST_WRITE_${nonce} > /workspace/live.txt
index=0
for file in /workspace/host-absolute /workspace/host-relative /workspace/sibling-link /workspace/../project-b/host-sibling; do
 if $bb cat "$file" > /tmp/combined-read 2>/tmp/combined-error; then echo COMBINED_PRIVATE_READ_ALLOWED; exit 61; else status=$?; fi
 test "$status" -eq 1
 echo COMBINED_READ_NEGATIVE_$index=$status
 if { printf forbidden > "$file"; } 2>/tmp/combined-error; then echo COMBINED_PRIVATE_WRITE_ALLOWED; exit 62; else status=$?; fi
 test "$status" -eq 1
 echo COMBINED_WRITE_NEGATIVE_$index=$status
 index=$((index+1))
done
echo COMBINED_GUEST_WRITE_${nonce}=ready
`;
 script=replaceOnce(script,'\nISOLATION_CHECK\n','\n'+containerChecks+'\nISOLATION_CHECK\n');
 const wait=`
attempt=0
until test "$(cat /mnt/combined-projects/project-a/live.txt)" = HOST_SECOND_${nonce}; do attempt=$((attempt+1)); test "$attempt" -lt 15; sleep 1; done
echo COMBINED_HOST_WRITE_VISIBLE=passed
`;
 const afterPrimary='test "$(cat /mnt/combined-projects/project-a/own)" = OWN_WRITTEN\ntest "$(cat /mnt/combined-projects/project-b/private)" = SIBLING_PRIVATE';
 script=replaceOnce(script,afterPrimary,wait+'\n'+afterPrimary);
 const transport=`
# A relay-like transport container receives ONE synthetic generation only.
timeout 10 docker -H unix:///tmp/isolation.sock run --name homeai-transport-scope --network=none --user=1001:1001 --read-only --cap-drop=ALL --security-opt=no-new-privileges=true --cgroupns=private --memory=64m --memory-swap=64m --cpus=.5 --pids-limit=32 --tmpfs /tmp:rw,nosuid,nodev,size=16777216,mode=1777 --mount type=bind,source=/mnt/combined-transport/scope-a/gen-a,target=/run/homeai-transport,readonly,bind-propagation=rprivate --entrypoint /bin/busybox "$image" sh -c '
 set -eu
 bb=/bin/busybox
 test "$($bb cat /run/homeai-transport/canary)" = TRANSPORT_OWN_${nonce}
 echo COMBINED_TRANSPORT_POSITIVE=passed
 index=0
 for file in /run/homeai-transport/../gen-b/canary /run/homeai-transport/../../scope-b/gen-b/canary /mnt/combined-transport/scope-b/gen-b/canary /run/homeai-transport/foreign-link; do
  if $bb cat "$file" > /tmp/out 2>/tmp/err; then exit 63; else status=$?; fi
  test "$status" -eq 1
  echo COMBINED_TRANSPORT_NEGATIVE_$index=$status
  index=$((index+1))
 done
 if { printf forbidden > /run/homeai-transport/canary; } 2>/tmp/err; then exit 64; else status=$?; fi
 test "$status" -eq 1
 echo COMBINED_TRANSPORT_READONLY=passed
 '
test "$(cat /mnt/combined-transport/scope-a/gen-a/canary)" = TRANSPORT_OWN_${nonce}
test "$(cat /mnt/combined-transport/scope-b/gen-b/canary)" = TRANSPORT_SIBLING_${nonce}
test "$(cat /mnt/combined-projects/project-b/host-sibling)" = HOST_SIBLING_${nonce}
echo COMBINED_RESULT=passed
`;
 script=replaceOnce(script,'echo ISOLATION_RESULT=passed',transport+'\necho ISOLATION_RESULT=passed');
 return script;
}
function evidence(output){return ['CENSUS_OLD_DISK_READONLY=1','ISOLATION_REQUIRED_DAEMON_CAPABILITIES=passed','ISOLATION_UID_CAPS_NNP_CGROUP_READBACK=passed','ISOLATION_PROJECT_READONLY=passed','COMBINED_HOST_WRITE_VISIBLE=passed','COMBINED_TRANSPORT_POSITIVE=passed','COMBINED_TRANSPORT_READONLY=passed','COMBINED_RESULT=passed',
 ...[0,1,2,3].flatMap(i=>['COMBINED_READ_NEGATIVE_'+i+'=1','COMBINED_WRITE_NEGATIVE_'+i+'=1','COMBINED_TRANSPORT_NEGATIVE_'+i+'=1'])].every(marker=>output.split(/\r?\n/).includes(marker));}
function cleanup(root){if(!new RegExp('^'+PREFIX+'[a-f0-9]{16}$').test(root))throw Error('UNSAFE_CLEANUP');const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(root)!==root)throw Error('UNSAFE_CLEANUP');fs.rmSync(root,{recursive:true});}
function fixture(nonce){
 validate(nonce);if(fs.statfsSync('/dev/shm').type!==0x01021994)throw Error('TMPFS_REQUIRED');
 const root=PREFIX+nonce;fs.mkdirSync(root,{mode:0o700});
 try{
  for(const part of ['projects/project-a','projects/project-b','transport/scope-a/gen-a','transport/scope-b/gen-b'])fs.mkdirSync(root+'/'+part,{recursive:true,mode:0o700});
  const write=(part,text)=>fs.writeFileSync(root+'/'+part,text,{flag:'wx',mode:0o600});
  write('outside-canary','HOST_CANARY_'+nonce);write('projects/project-a/live.txt','HOST_INITIAL_'+nonce);write('projects/project-b/host-sibling','HOST_SIBLING_'+nonce);
  write('transport/scope-a/gen-a/canary','TRANSPORT_OWN_'+nonce);write('transport/scope-b/gen-b/canary','TRANSPORT_SIBLING_'+nonce);
  fs.symlinkSync(root+'/outside-canary',root+'/projects/project-a/host-absolute');fs.symlinkSync('../../outside-canary',root+'/projects/project-a/host-relative');fs.symlinkSync('../project-b/host-sibling',root+'/projects/project-a/sibling-link');
  fs.symlinkSync('../../scope-b/gen-b/canary',root+'/transport/scope-a/gen-a/foreign-link');
  return{root,projects:root+'/projects',transport:root+'/transport',live:root+'/projects/project-a/live.txt'};
 }catch(error){cleanup(root);throw error;}
}
async function runProbe({helpers=require('./guest-capability-probe.cjs'),census=require('./guest-volume-census.cjs'),proof=require('./guest-container-isolation-probe.cjs')}={}){
 if(process.platform!=='linux'||process.getuid()===0)throw Error('UNPRIVILEGED_LINUX_OPERATOR_REQUIRED');
 const memory=census.admission({meminfo:fs.readFileSync('/proc/meminfo','utf8'),cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8'),read:p=>fs.readFileSync(p,'utf8')});
 const descriptors=[];let synthetic;
 try{
  for(const name of ['vmlinuz-virt','initramfs-virt','alpine.iso','volume.raw']){
   const fd=fs.openSync(ROOT+'/'+name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);descriptors.push(fd);const s=fs.fstatSync(fd);
   if(!s.isFile()||s.size<1||(name==='volume.raw'?s.size!==3*GiB:s.size>256*1024**2))throw Error('READONLY_ARTIFACT_INVALID');
  }
  if(helpers.digest(descriptors[2])!==ISO_SHA256)throw Error('PINNED_ISO_MISMATCH');
  const boot=helpers.isoBootFiles(descriptors[2]);for(let i=0;i<2;i++)if(helpers.digest(descriptors[i])!==helpers.digest(descriptors[2],boot[i].start,boot[i].size))throw Error('BOOT_ISO_MISMATCH');
  const before=fs.fstatSync(descriptors[3]),nonce=crypto.randomBytes(8).toString('hex');synthetic=fixture(nonce);
  const liveBefore=fs.statSync(synthetic.live);
  for(const directory of [synthetic.projects,synthetic.transport])descriptors.push(fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));
  const commands=guestScript(nonce,proof),args=qemuArgs(census.qemuArgs(nonce,helpers)),started=Date.now(),startedAt=new Date().toISOString();
  const child=cp.spawn('/usr/bin/nice',['-n','19','qemu-system-x86_64',...args],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',TERM:'dumb'},stdio:['pipe','pipe','pipe',...descriptors]});
  let output='',sent=false,loggingIn=false,stopped=false,reason='GUEST_EXITED_BEFORE_RESULT',forced,peakRssBytes=0,guestWriteObserved=false,sameInode=false,hostWriteSent=false;
  const stop=value=>{if(stopped)return;stopped=true;reason=value;child.kill('SIGTERM');forced=setTimeout(()=>child.kill('SIGKILL'),2000);forced.unref();};
  const timer=setTimeout(()=>stop('DEADLINE_EXCEEDED'),178000),monitor=setInterval(()=>{try{const rss=Number(fs.readFileSync('/proc/'+child.pid+'/status','utf8').match(/^VmRSS:\s+(\d+)/m)?.[1])*1024;peakRssBytes=Math.max(peakRssBytes,rss||0);if(rss>2560*1024**2)stop('HOST_RSS_LIMIT');}catch{}},500);
  const interrupted=()=>stop('OPERATOR_INTERRUPTED');process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  function data(chunk){try{
   output+=chunk.toString();if(Buffer.byteLength(output)>256*1024){output=output.slice(-128*1024);stop('CONSOLE_LIMIT');return;}
   const clean=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
   if(!loggingIn&&/login:\s*$/.test(clean)){loggingIn=true;child.stdin.write('root\n');}
   if(!sent&&/(?:localhost:~|\/\s*)#\s*$/.test(clean)){sent=true;const encoded=Buffer.from(commands).toString('base64').match(/.{1,160}/g).join('\n');child.stdin.write("stty -echo\nbase64 -d > /tmp/combined-probe.sh <<'COMBINED_SCRIPT'\n"+encoded+"\nCOMBINED_SCRIPT\nsh /tmp/combined-probe.sh; printf '\\nCOMBINED_DONE_"+nonce+"=%s\\n' \"$?\"\n");}
   if(!hostWriteSent&&clean.split(/\r?\n/).includes('COMBINED_GUEST_WRITE_'+nonce+'=ready')){
    guestWriteObserved=fs.readFileSync(synthetic.live,'utf8')==='GUEST_WRITE_'+nonce;const now=fs.statSync(synthetic.live);sameInode=now.dev===liveBefore.dev&&now.ino===liveBefore.ino;
    if(!guestWriteObserved||!sameInode){stop('LIVE_INODE_OR_WRITE_FAILED');return;}
    const fd=fs.openSync(synthetic.live,fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW);try{fs.writeFileSync(fd,'HOST_SECOND_'+nonce);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}hostWriteSent=true;
   }
   const done=clean.match(new RegExp('(?:^|\\n)COMBINED_DONE_'+nonce+'=(\\d+)(?:\\r?\\n|$)'));
   if(done)stop(Number(done[1])===0&&evidence(clean)?'COMBINED_OBSERVED':'GUEST_PROBE_FAILED');
  }catch{stop('HOST_VERIFICATION_FAILED');}}
  child.stdout.on('data',data);child.stderr.on('data',data);child.stdin.on('error',()=>{});
  try{await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});}finally{clearTimeout(timer);clearTimeout(forced);clearInterval(monitor);process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);}
  const after=fs.fstatSync(descriptors[3]),sourceMetadataUnchanged=['dev','ino','size','mtimeMs','ctimeMs'].every(k=>before[k]===after[k]);
  const hostCanariesUnchanged=fs.readFileSync(synthetic.root+'/outside-canary','utf8')==='HOST_CANARY_'+nonce&&fs.readFileSync(synthetic.projects+'/project-b/host-sibling','utf8')==='HOST_SIBLING_'+nonce&&fs.readFileSync(synthetic.transport+'/scope-a/gen-a/canary','utf8')==='TRANSPORT_OWN_'+nonce&&fs.readFileSync(synthetic.transport+'/scope-b/gen-b/canary','utf8')==='TRANSPORT_SIBLING_'+nonce;
  if(!sourceMetadataUnchanged||!hostCanariesUnchanged)reason='SOURCE_OR_CANARY_CHANGED';
  if(reason==='COMBINED_OBSERVED'&&(!guestWriteObserved||!sameInode||!hostWriteSent))reason='MISSING_HOST_EVIDENCE';
  return{version:1,startedAt,durationMs:Date.now()-started,reason,memory,peakRssBytes,guestMemoryMiB:2048,hostRssLimitMiB:2560,deadlineMs:178000,vcpus:1,networkAdapters:0,hostWritableDisks:0,syntheticExports:2,sourceMetadataUnchanged,hostCanariesUnchanged,guestWriteObserved,sameInode,hostWriteSent,combinedEvidence:evidence(output),isoSHA256:ISO_SHA256,output,limits:'Synthetic 9p plus tiny Docker bind isolation only. No actual editor/toolchain, mTLS transport, production project, network bridge, OOM or backup acceptance.'};
 }finally{for(const fd of descriptors)fs.closeSync(fd);if(synthetic)cleanup(synthetic.root);}
}
module.exports={qemuArgs,guestScript,evidence,fixture,cleanup,runProbe};
if(require.main===module){if(process.argv[2]!=='run-disposable'){console.error('Operator only: run-disposable; fresh quiescence required.');process.exitCode=2;}else runProbe().then(result=>{console.log(JSON.stringify(result));if(result.reason!=='COMBINED_OBSERVED')process.exitCode=1;},()=>{console.error('COMBINED_PROBE_FAILED');process.exitCode=1;});}
