'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const vm=require('./apps-project-vm.cjs');
test('QEMU receives two fixed separate descriptor exports and only private loopback forward pool',()=>{
  const args=vm.qemuArguments();assert(args.includes('local,id=homeai-projects,path=/proc/self/fd/3,security_model=none,multidevs=forbid,writeout=immediate'));
  assert(args.includes('local,id=homeai-transport,path=/proc/self/fd/4,security_model=none,multidevs=forbid,readonly=on'));
  const forward=vm.forwards();assert.equal(forward.length,64);assert.equal(forward[0],'hostfwd=tcp:127.0.0.1:19180-:19180');assert.equal(forward.at(-1),'hostfwd=tcp:127.0.0.1:19243-:19243');
  assert(args.every(value=>!value.includes('host-client')));
  const withTools=vm.qemuArguments(true);assert(withTools.includes('local,id=homeai-toolchain,path=/proc/self/fd/5,security_model=none,multidevs=forbid,readonly=on'));assert.equal(withTools.filter(value=>value==='-fsdev').length,3);
});
test('trusted supervisor scripts require positive same-file challenge and a transport write denial',()=>{
  const script=vm.bootScript('a'.repeat(16),1001,1001);assert.match(script,/transport.*ro/);assert.match(script,/if printf forbidden > .* then exit 71/);assert.match(script,/printf 'guest-aaaaaaaaaaaaaaaa'/);
  assert.throws(()=>vm.bootScript('user-shell',1001,1001));
  const preparation=vm.preparationScript({scopeId:'b'.repeat(32),generation:'c'.repeat(32),guestRoot:'/srv/homeai/projects/session_one',uid:1001,gid:1001});
  assert.match(preparation,/mkdir \/run\/homeai-runtime\/b+\/c+/);assert.doesNotMatch(preparation,/host-client|client.key|rm -rf|openssl/);
  assert.throws(()=>vm.preparationScript({scopeId:'b'.repeat(32),generation:'c'.repeat(32),guestRoot:'/srv/homeai/projects/a/../../secrets',uid:1001,gid:1001}));
  const tools=vm.toolchainScript('d'.repeat(64));assert.match(tools,/homeai-toolchain.*ro/);assert.match(tools,/sha256sum.*\.homeai-toolchain\.json/);assert.match(tools,/if printf forbidden > .*\.homeai-toolchain\.json/);assert.throws(()=>vm.toolchainScript('untrusted-shell'));
  const egress=vm.egressPreparationScript({scopeId:'b'.repeat(32),generation:'c'.repeat(32),uid:1001,gid:1001});assert.match(egress,/mkdir \/run\/homeai-egress\/b+\/c+/);assert.doesNotMatch(egress,/iptables|curl|wget|host-client|server.key/);assert.throws(()=>vm.egressPreparationScript({scopeId:'../escape',generation:'c'.repeat(32),uid:1001,gid:1001}));
  if(process.platform==='linux')for(const source of [script,preparation,tools,egress])assert.equal(cp.spawnSync('/bin/sh',['-n'],{input:source}).status,0);
});
test('serial success is nonce-bound and nonzero completion never claims a verified mapping',async()=>{
  const worker={phase:'ready',pid:()=>123,buffer:'',serial:{destroyed:false,write(command){const nonce=command.match(/HOMEAI_SCRIPT_([a-f0-9]{16})/)[1];worker.buffer='\nHOMEAI_SUPERVISOR_'+nonce+'=0\n';}}};
  await vm.guestScript(worker,'set -eu\ntrue');assert.equal(worker.projectSerialPending,false);
  worker.serial.write=command=>{const nonce=command.match(/HOMEAI_SCRIPT_([a-f0-9]{16})/)[1];worker.buffer='\nHOMEAI_SUPERVISOR_'+nonce+'=1\n';};
  await assert.rejects(vm.guestScript(worker,'false'),{code:'PROJECT_RUNTIME_SUPERVISOR_FAILED'});assert.equal(worker.projectSerialPending,false);
  worker.projectSerialPending=true;await assert.rejects(vm.guestScript(worker,'true'),{code:'PROJECT_RUNTIME_SUPERVISOR_UNAVAILABLE'});
});
test('actual Linux export descriptors exclude client tree and reject linked or writable export roots',{skip:process.platform!=='linux'||process.getuid()<1000},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-vm-exports-')),projects=path.join(root,'projects'),transport=path.join(root,'secrets');fs.mkdirSync(projects,{mode:0o700});
  t.after(()=>{const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert(path.basename(actual).startsWith('homeai-vm-exports-'));fs.rmSync(actual,{recursive:true,force:true});});
  const cfg={projectRuntime:{enabled:true,projectsRoot:projects,editorTransportRoot:transport,uid:process.getuid(),gid:process.getgid()}};
  const exports=vm.openExports(cfg);assert.equal(exports.transport.path,path.join(transport,'guest-server'));assert(fs.fstatSync(exports.projects.fd).isDirectory());assert(fs.fstatSync(exports.transport.fd).isDirectory());const fd=exports.projects.fd;vm.closeExports(exports);assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
  fs.chmodSync(projects,0o777);assert.throws(()=>vm.openExports(cfg),{code:'PROJECT_RUNTIME_EXPORT_OWNER_INVALID'});fs.chmodSync(projects,0o700);
  fs.renameSync(projects,projects+'-real');fs.symlinkSync(projects+'-real',projects);assert.throws(()=>vm.openExports(cfg),{code:'PROJECT_RUNTIME_EXPORT_PATH_INVALID'});
});

test('kernel evidence hashes bounded regular bytes and refuses aliased input',{skip:process.platform!=='linux'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-kernel-proof-')),file=path.join(root,'vmlinuz-virt');fs.writeFileSync(file,'synthetic kernel');
  t.after(()=>{const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert(path.basename(actual).startsWith('homeai-kernel-proof-'));fs.rmSync(actual,{recursive:true,force:true});});
  const hash=vm.kernelFingerprint({root});assert.match(hash,/^[a-f0-9]{64}$/);fs.writeFileSync(file,'changed synthetic kernel');assert.notEqual(vm.kernelFingerprint({root}),hash);fs.linkSync(file,path.join(root,'alias'));assert.throws(()=>vm.kernelFingerprint({root}),{code:'PROJECT_RUNTIME_KERNEL_UNVERIFIED'});
});
