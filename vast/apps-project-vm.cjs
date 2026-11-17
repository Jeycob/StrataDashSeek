'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), https = require('node:https');
const fail = code => Object.assign(Error(code), { code, status: 409 });
const PROJECTS = '/srv/homeai/projects', TRANSPORT = '/srv/homeai/transport', TOOLCHAIN = '/srv/homeai/toolchain';
const HEX32 = /^[a-f0-9]{32}$/, HEX16 = /^[a-f0-9]{16}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function kernelFingerprint(vm) {
  const fd=fs.openSync(path.join(vm.root,'vmlinuz-virt'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try { const info=fs.fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.size<1||info.size>64*1024*1024)throw fail('PROJECT_RUNTIME_KERNEL_UNVERIFIED');const bytes=Buffer.alloc(info.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0);if(count!==info.size)throw fail('PROJECT_RUNTIME_KERNEL_UNVERIFIED');return crypto.createHash('sha256').update(bytes.subarray(0,count)).digest('hex'); }
  finally { fs.closeSync(fd); }
}
function openDirectory(directory, uid, gid) {
  if (!path.isAbsolute(directory || '') || directory === path.parse(directory).root || fs.realpathSync(directory) !== directory) throw fail('PROJECT_RUNTIME_EXPORT_PATH_INVALID');
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isDirectory() || s.uid !== uid || s.gid !== gid || s.mode & 0o022) throw fail('PROJECT_RUNTIME_EXPORT_OWNER_INVALID');
    return { fd, path: directory, dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function openExports(cfg) {
  if (!cfg.projectRuntime?.enabled) return null;
  const settings = cfg.projectRuntime, uid = process.getuid?.(), gid = process.getgid?.();
  if (process.platform !== 'linux' || uid < 1000 || uid > 65534 || settings.uid !== uid || settings.gid !== gid) throw fail('PROJECT_RUNTIME_HOST_IDENTITY_INVALID');
  const transportRoot = settings.editorTransportRoot || '/data/harness/secrets/editor-transport', transport = path.join(transportRoot, 'guest-server');
  if (!path.isAbsolute(transportRoot) || !path.isAbsolute(settings.projectsRoot || '') || transportRoot.startsWith(settings.projectsRoot + path.sep) || settings.projectsRoot.startsWith(transportRoot + path.sep) || settings.projectsRoot === transportRoot) throw fail('PROJECT_RUNTIME_EXPORT_PATH_INVALID');
  fs.mkdirSync(transport, { recursive: true, mode: 0o700 });
  const result = { projects: openDirectory(settings.projectsRoot, uid, gid), transport: null, toolchain: null, transportRoot, uid, gid };
  try {
    result.transport = openDirectory(transport, uid, gid);
    if (settings.toolchain !== undefined) {
      const value = settings.toolchain;
      if (!value || Object.keys(value).some(key=>!['root','manifestSha256'].includes(key)) || !path.isAbsolute(value.root || '') || !/^[a-f0-9]{64}$/.test(value.manifestSha256 || '') || [settings.projectsRoot,transportRoot].some(root=>value.root===root||value.root.startsWith(root+path.sep)||root.startsWith(value.root+path.sep))) throw fail('PROJECT_RUNTIME_TOOLCHAIN_UNAVAILABLE');
      // This verifier is a packaging contract, never a downloader or installer.
      const checked = require('../development/project-toolchain.cjs').verifyToolchain(value.root,{expectedDigest:value.manifestSha256,expectedUid:0});
      if (checked?.version !== 1 || checked.root !== value.root || checked.manifestSha256 !== value.manifestSha256 || checked.uid !== 0) throw fail('PROJECT_RUNTIME_TOOLCHAIN_UNAVAILABLE');
      result.toolchain = {...openDirectory(value.root,0,checked.gid),manifestSha256:checked.manifestSha256};
      if (result.toolchain.dev !== checked.dev || result.toolchain.ino !== checked.ino) throw fail('PROJECT_RUNTIME_TOOLCHAIN_CHANGED');
    }
    return result;
  } catch (error) { closeExports(result); throw error; }
}
function closeExports(exports) { if (exports) for (const item of [exports.projects, exports.transport, exports.toolchain]) if (Number.isInteger(item?.fd)) { fs.closeSync(item.fd); item.fd = null; } }
function qemuArguments(toolchain = false) {
  return ['-fsdev', 'local,id=homeai-projects,path=/proc/self/fd/3,security_model=none,multidevs=forbid,writeout=immediate', '-device', 'virtio-9p-pci,fsdev=homeai-projects,mount_tag=homeai-projects', '-fsdev', 'local,id=homeai-transport,path=/proc/self/fd/4,security_model=none,multidevs=forbid,readonly=on', '-device', 'virtio-9p-pci,fsdev=homeai-transport,mount_tag=homeai-transport', ...(toolchain ? ['-fsdev','local,id=homeai-toolchain,path=/proc/self/fd/5,security_model=none,multidevs=forbid,readonly=on','-device','virtio-9p-pci,fsdev=homeai-toolchain,mount_tag=homeai-toolchain'] : [])];
}
function forwards() { return Array.from({ length: 64 }, (_, n) => 'hostfwd=tcp:127.0.0.1:' + (19180 + n) + '-:' + (19180 + n)); }
function verifyProcessExports(vm) {
  const exports = vm.projectExports, pid = vm.pid();
  if (!exports || !Number.isInteger(pid) || pid < 1) throw fail('PROJECT_RUNTIME_EXPORT_UNVERIFIED');
  const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
  for (const arg of qemuArguments(Boolean(exports.toolchain))) if (!command.includes(arg)) throw fail('PROJECT_RUNTIME_EXPORT_UNVERIFIED');
  for (const [fd, item] of [[3, exports.projects], [4, exports.transport], ...(exports.toolchain ? [[5,exports.toolchain]] : [])]) {
    const held = fs.statSync('/proc/' + pid + '/fd/' + fd), current = fs.lstatSync(item.path);
    if (!current.isDirectory() || current.isSymbolicLink() || fs.realpathSync(item.path) !== item.path || held.dev !== item.dev || held.ino !== item.ino || current.dev !== item.dev || current.ino !== item.ino || current.uid !== item.uid || current.gid !== item.gid || current.mode & 0o022) throw fail('PROJECT_RUNTIME_EXPORT_CHANGED');
  }
  return pid;
}
function toolchainScript(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw fail('PROJECT_RUNTIME_TOOLCHAIN_UNAVAILABLE');
  return `set -eu
mkdir -p ${TOOLCHAIN}
if ! mountpoint -q ${TOOLCHAIN}; then mount -t 9p -o ro,trans=virtio,version=9p2000.L,cache=none,msize=262144,access=client homeai-toolchain ${TOOLCHAIN}; fi
awk '$1=="homeai-toolchain" && $2=="${TOOLCHAIN}" && $3=="9p" && $4 ~ /(^|,)ro(,|$)/ {ok++} END {exit ok==1?0:1}' /proc/mounts
test "$(stat -c %u ${TOOLCHAIN})" = '0'
test "$(sha256sum ${TOOLCHAIN}/.homeai-toolchain.json | cut -d ' ' -f 1)" = '${digest}'
if printf forbidden > ${TOOLCHAIN}/.homeai-toolchain.json 2>/dev/null; then exit 71; fi
for directory in code-server homeai dotnet playwright npm; do test -d ${TOOLCHAIN}/$directory && test ! -L ${TOOLCHAIN}/$directory; done
`;
}
function bootScript(nonce, uid, gid) {
  if (!HEX16.test(nonce || '') || !Number.isInteger(uid) || uid < 1000 || uid > 65534 || !Number.isInteger(gid) || gid < 1000 || gid > 65534) throw fail('PROJECT_RUNTIME_PROBE_INVALID');
  const marker = '.homeai-share-' + nonce;
  return `set -eu
modprobe 9p
modprobe 9pnet_virtio
mkdir -p ${PROJECTS} ${TRANSPORT}
if ! mountpoint -q ${PROJECTS}; then mount -t 9p -o trans=virtio,version=9p2000.L,cache=none,msize=262144,access=client homeai-projects ${PROJECTS}; fi
if ! mountpoint -q ${TRANSPORT}; then mount -t 9p -o ro,trans=virtio,version=9p2000.L,cache=none,msize=262144,access=client homeai-transport ${TRANSPORT}; fi
awk '$1=="homeai-projects" && $2=="${PROJECTS}" && $3=="9p" && $4 ~ /(^|,)rw(,|$)/ {ok++} END {exit ok==1?0:1}' /proc/mounts
awk '$1=="homeai-transport" && $2=="${TRANSPORT}" && $3=="9p" && $4 ~ /(^|,)ro(,|$)/ {ok++} END {exit ok==1?0:1}' /proc/mounts
test "$(stat -c %u:%g ${PROJECTS})" = '${uid}:${gid}'
test "$(stat -c %u:%g ${TRANSPORT})" = '${uid}:${gid}'
test "$(cat ${PROJECTS}/${marker})" = 'project-${nonce}'
test "$(cat ${TRANSPORT}/${marker})" = 'transport-${nonce}'
if printf forbidden > ${TRANSPORT}/${marker} 2>/dev/null; then exit 71; fi
printf 'guest-${nonce}' > ${PROJECTS}/${marker}
mkdir -p /run/homeai-runtime /var/lib/harness/editor-state
chmod 0700 /run/homeai-runtime /var/lib/harness/editor-state
`;
}
async function guestScript(vm, script, timeoutMs = 10000) {
  if (vm.projectSerialPending || !vm.pid() || vm.phase !== 'ready' && vm.phase !== 'restoring' || !vm.serial || vm.serial.destroyed) throw fail('PROJECT_RUNTIME_SUPERVISOR_UNAVAILABLE');
  const nonce = crypto.randomBytes(8).toString('hex'), file = '/tmp/homeai-supervisor-' + nonce + '.sh', encoded = Buffer.from(script).toString('base64');
  if (encoded.length > 16384) throw fail('PROJECT_RUNTIME_SUPERVISOR_PAYLOAD_INVALID');
  vm.projectSerialPending = true;
  try {
    // Only fixed trusted scripts and validated hex/UID/basename values enter
    // serial. TLS material never goes through console or shell arguments.
    vm.serial.write("( umask 077; set -C; base64 -d > '" + file + "' <<'HOMEAI_SCRIPT_" + nonce + "'\n" + encoded.match(/.{1,512}/g).join('\n') + "\nHOMEAI_SCRIPT_" + nonce + "\nif test -f '" + file + "' && test ! -L '" + file + "'; then timeout -s TERM -k 2 " + Math.ceil(timeoutMs / 1000) + " sh '" + file + "'; rc=$?; rm -f -- '" + file + "'; else rc=125; fi; printf 'HOMEAI_SUPERVISOR_" + nonce + "=%s\\n' \"$rc\" )\n");
    const deadline = Date.now() + timeoutMs + 3000;
    while (Date.now() < deadline) {
      const result = vm.buffer.match(new RegExp('(?:^|\\n)HOMEAI_SUPERVISOR_' + nonce + '=(\\d+)(?:\\r?\\n|$)'));
      if (result) { if (Number(result[1]) !== 0) throw fail('PROJECT_RUNTIME_SUPERVISOR_FAILED'); return; }
      await pause(50);
    }
    throw fail('PROJECT_RUNTIME_SUPERVISOR_TIMEOUT');
  } finally { vm.projectSerialPending = false; }
}
async function proveExports(vm) {
  if (!vm.cfg.projectRuntime?.enabled) return;
  if (!vm.projectExports) { vm.projectExports = openExports(vm.cfg); closeExports(vm.projectExports); }
  const pid = verifyProcessExports(vm), e = vm.projectExports, nonce = crypto.randomBytes(8).toString('hex'), marker = '.homeai-share-' + nonce;
  const created = [];
  try {
    for (const [kind, item] of [['project',e.projects],['transport',e.transport]]) {
      const file = path.join(item.path, marker); fs.writeFileSync(file, kind + '-' + nonce, { flag: 'wx', mode: 0o600 }); created.push([file,fs.lstatSync(file)]);
    }
    await guestScript(vm, bootScript(nonce, e.uid, e.gid)); verifyProcessExports(vm);
    if (e.toolchain) { await guestScript(vm,toolchainScript(e.toolchain.manifestSha256)); verifyProcessExports(vm); }
    for (const [index, expected] of [[0,'guest-'],[1,'transport-']]) {
      const [file, before] = created[index], fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { const after = fs.fstatSync(fd); if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size > 64 || fs.readFileSync(fd,'utf8') !== expected + nonce) throw fail('PROJECT_RUNTIME_SHARE_WITNESS_FAILED'); }
      finally { fs.closeSync(fd); }
    }
    const sourceCommit=path.basename(fs.realpathSync(path.join(__dirname,'..'))),kernelSha256=vm.projectBootKernelSha256??null;
    if(kernelSha256!==null&&kernelFingerprint(vm)!==kernelSha256)throw fail('PROJECT_RUNTIME_KERNEL_CHANGED');
    vm.projectRuntimeIsolation = { version: 1, verified: true, bootPid: pid, projectsRoot: e.projects.path, guestProjectsRoot: PROJECTS, hostDev: e.projects.dev, hostIno: e.projects.ino, uid: e.uid, gid: e.gid, transportRoot: e.transport.path, guestTransportRoot: TRANSPORT, transportDev: e.transport.dev, transportIno: e.transport.ino, transportReadOnly: true, kernelSha256, runtimeSourceCommit:/^[a-f0-9]{40}$/.test(sourceCommit)?sourceCommit:null, ...(e.toolchain ? {toolchain:{version:1,verified:true,bootPid:pid,root:e.toolchain.path,guestRoot:TOOLCHAIN,manifestSha256:e.toolchain.manifestSha256,hostDev:e.toolchain.dev,hostIno:e.toolchain.ino,readOnly:true}} : {}) };
  } finally {
    for (const [file, before] of created) { const current = fs.lstatSync(file); if (current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw fail('PROJECT_RUNTIME_SHARE_CLEANUP_REFUSED'); fs.unlinkSync(file); }
  }
}
function transportStore(vm) {
  if (!vm.projectTransportStore) {
    const { EditorTransportStore } = require('../workspace/editor-transport.cjs');
    vm.projectTransportStore = new EditorTransportStore(vm.projectExports.transportRoot);
  }
  return vm.projectTransportStore;
}
function preparationScript({ scopeId, generation, guestRoot, uid, gid }) {
  if (!HEX32.test(scopeId || '') || !HEX32.test(generation || '') || !/^\/srv\/homeai\/projects\/[A-Za-z0-9_-]{1,128}$/.test(guestRoot || '') || !Number.isInteger(uid) || uid < 1000 || uid > 65534 || !Number.isInteger(gid) || gid < 1000 || gid > 65534) throw fail('PROJECT_RUNTIME_PREPARATION_INVALID');
  return `set -eu
test -d '${guestRoot}' && test ! -L '${guestRoot}'
test "$(readlink -f '${guestRoot}')" = '${guestRoot}'
test "$(stat -c %u:%g '${guestRoot}')" = '${uid}:${gid}'
test -d ${TRANSPORT}/${scopeId}/${generation}
for name in ca.crt server.crt server.key; do test -f ${TRANSPORT}/${scopeId}/${generation}/$name && test ! -L ${TRANSPORT}/${scopeId}/${generation}/$name; done
for directory in /run/homeai-runtime/${scopeId} /var/lib/harness/editor-state/${scopeId}; do
 if test -e "$directory"; then test -d "$directory" && test ! -L "$directory"; else mkdir "$directory"; fi
 test "$(readlink -f "$directory")" = "$directory"
done
mkdir /run/homeai-runtime/${scopeId}/${generation}
chown ${uid}:${gid} /run/homeai-runtime/${scopeId}/${generation} /var/lib/harness/editor-state/${scopeId}
chmod 0700 /run/homeai-runtime/${scopeId}/${generation} /var/lib/harness/editor-state/${scopeId}
`;
}
async function prepare(vm, input) {
  verifyProcessExports(vm);
  if (!vm.projectRuntimeIsolation?.verified || vm.projectRuntimeIsolation.bootPid !== vm.pid() || input.uid !== vm.projectExports.uid || input.gid !== vm.projectExports.gid) throw fail('PROJECT_RUNTIME_EXPORT_UNVERIFIED');
  const script = preparationScript(input), store = transportStore(vm), material = await store.prepare(input.scopeId,input.generation);
  if (material.serverDirectory !== path.join(vm.projectExports.transport.path,input.scopeId,input.generation) || material.serverName !== input.scopeId+'.'+input.generation+'.editor.homeai.invalid') throw fail('PROJECT_RUNTIME_TRANSPORT_UNVERIFIED');
  await guestScript(vm,script); verifyProcessExports(vm);
  return { version: 1, mtls: true, scopeId: input.scopeId, generation: input.generation, serverName: material.serverName };
}
function egressPreparationScript({scopeId,generation,uid,gid}) {
  if(!HEX32.test(scopeId||'')||!HEX32.test(generation||'')||!Number.isInteger(uid)||uid<1000||uid>65534||!Number.isInteger(gid)||gid<1000||gid>65534)throw fail('PROJECT_RUNTIME_PREPARATION_INVALID');
  return `set -eu
mkdir -p /run/homeai-egress
test -d /run/homeai-egress && test ! -L /run/homeai-egress
test "$(readlink -f /run/homeai-egress)" = '/run/homeai-egress'
chmod 0700 /run/homeai-egress
if test -e /run/homeai-egress/${scopeId}; then test -d /run/homeai-egress/${scopeId} && test ! -L /run/homeai-egress/${scopeId}; else mkdir /run/homeai-egress/${scopeId}; fi
test "$(readlink -f /run/homeai-egress/${scopeId})" = '/run/homeai-egress/${scopeId}'
mkdir /run/homeai-egress/${scopeId}/${generation}
chown ${uid}:${gid} /run/homeai-egress/${scopeId}/${generation}
chmod 0700 /run/homeai-egress/${scopeId}/${generation}
`;
}
async function prepareEgress(vm,input) {
  verifyProcessExports(vm);
  if(!vm.projectRuntimeIsolation?.toolchain?.verified||vm.projectRuntimeIsolation.bootPid!==vm.pid()||input.uid!==vm.projectExports.uid||input.gid!==vm.projectExports.gid)throw fail('PROJECT_RUNTIME_EXPORT_UNVERIFIED');
  await guestScript(vm,egressPreparationScript(input));verifyProcessExports(vm);
  return{version:1,profile:'public-https-unix-v1',scopeId:input.scopeId,generation:input.generation};
}
async function egressHealth(vm,{scopeId,generation}) {
  if(!HEX32.test(scopeId||'')||!HEX32.test(generation||''))throw fail('PROJECT_RUNTIME_PREPARATION_INVALID');verifyProcessExports(vm);
  const socket='/run/homeai-egress/'+scopeId+'/'+generation+'/proxy.sock';
  try{await guestScript(vm,`set -eu\ntest -S '${socket}' && test ! -L '${socket}'\ntest "$(stat -c %u:%g:%a '${socket}')" = '${vm.projectExports.uid}:${vm.projectExports.gid}:600'\n`,2000);return true;}catch{return false;}
}
async function health(vm, { scopeId, generation, guestPort, serverName, timeoutMs = 2000 }) {
  if (!HEX32.test(scopeId || '') || !HEX32.test(generation || '') || serverName !== scopeId+'.'+generation+'.editor.homeai.invalid' || !Number.isInteger(guestPort) || guestPort < 19180 || guestPort > 19243) throw fail('PROJECT_RUNTIME_TRANSPORT_UNVERIFIED');
  verifyProcessExports(vm); const identity = await transportStore(vm).clientIdentity(scopeId,generation);
  return new Promise(resolve => {
    let done=false; const finish=value=>{if(done)return;done=true;clearTimeout(timer);request.destroy();resolve(value);};
    const request=https.request({hostname:'127.0.0.1',port:guestPort,path:'/healthz',method:'GET',servername:serverName,ca:identity.ca,cert:identity.cert,key:identity.key,minVersion:'TLSv1.3',rejectUnauthorized:true,agent:false},response=>{const ok=response.socket.authorized===true&&response.statusCode===200;response.destroy();finish(ok);});
    const timer=setTimeout(()=>finish(false),Math.max(100,Math.min(2000,timeoutMs)));timer.unref();request.on('error',()=>finish(false));request.end();
  });
}
module.exports = { openExports, closeExports, qemuArguments, forwards, verifyProcessExports, kernelFingerprint, bootScript, toolchainScript, guestScript, proveExports, preparationScript, prepare, egressPreparationScript, prepareEgress, egressHealth, health };
