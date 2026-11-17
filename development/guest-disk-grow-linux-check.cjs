'use strict';
// Explicit Linux-root synthetic fixture only. Formatting exists ONLY here,
// for one new exclusive blank32MiB image grown to64MiB; never a caller path.
// The fixture is retained for review. No mounts, QEMU, installs or old data.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const {runGrowth,sha256,canonical}=require('./guest-disk-grow.cjs'),{createLinuxOperations,createFixtureOperations,superblock}=require('./guest-disk-grow-linux.cjs'),{inspectWorkerCapacity}=require('../vast/apps-worker-growth-policy.cjs');
const MiB=1024**2,GiB=1024**3;
const initialMiB=Number(process.env.HOMEAI_GROW_FIXTURE_MIB??32);assert([1,4,8,32].includes(initialMiB));const initial=initialMiB*MiB,target=2*initial;
test('actual exclusive tiny ext4 grow preserves synthetic file data, proves allocation and retains an observable pending gate',{timeout:60000},async()=>{
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
 const capacity=fs.statfsSync('/tmp');assert(capacity.bavail*capacity.bsize>=GiB,'fixture needs at least1GiB free');
 const retained=fs.readdirSync('/tmp').filter(name=>/^homeai-grow-fixture-[a-f0-9]{16}$/.test(name)).reduce((sum,name)=>{try{return sum+fs.lstatSync('/tmp/'+name+'/docker-worker/volume.raw').size;}catch(error){if(error.code==='ENOENT')return sum;throw error;}},0);assert(retained+initial+target<=128*MiB,'retained fixtures plus this source+target must stay within128MiB; do not auto-delete earlier evidence');
 const root='/tmp/homeai-grow-fixture-'+crypto.randomBytes(8).toString('hex');fs.mkdirSync(root,{mode:0o755});
 const worker=root+'/docker-worker',state=root+'/root-secrets/runtime/state',apps=root+'/state/applications',uid=65534;
 for(const dir of [worker,state,apps,root+'/runtime-status',root+'/inputs'])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 // Mark every fixture private ancestor root-owned; only the two new service
 // directories belong to the synthetic unprivileged identity.
 fs.chownSync(worker,uid,uid);fs.chownSync(apps,uid,uid);fs.chmodSync(root+'/runtime-status',0o755);
 for(const [file,owner]of [[root+'/supervisor.lock',0],[apps+'/apps-service.lock.oslock',uid]]){const fd=fs.openSync(file,'wx',0o600);fs.fchownSync(fd,owner,owner);fs.closeSync(fd);}
 fs.writeFileSync(root+'/apps-config.json',canonical({enabled:false,vm:{enabled:false,root:worker},stateDir:apps}),{flag:'wx',mode:0o600});
 const coldFence={epoch:crypto.randomUUID(),sourceCommit:'e'.repeat(40)};fs.writeFileSync(state+'/runtime-admission-controller.json',canonical({version:1,...coldFence,open:false,acceptedWork:0}),{flag:'wx',mode:0o600});
 const witness='Only synthetic fixture content. Preserve this exact file through ext4 grow.\n';fs.writeFileSync(root+'/inputs/witness.txt',witness,{flag:'wx',mode:0o600});
 const image=worker+'/volume.raw',fd=fs.openSync(image,'wx+',0o600);let source;
 try{
  cp.execFileSync('/usr/bin/fallocate',['--length',String(initial),'/proc/self/fd/3'],{stdio:['ignore','ignore','pipe',fd],timeout:5000});
  // No production module imports or invokes mke2fs. -d contains only the
  // fresh witness above; nodiscard preserves the explicit physical allocation.
  cp.execFileSync('/usr/sbin/mke2fs',['-q','-t','ext4','-b','4096','-m','0','-E','nodiscard,lazy_itable_init=0,lazy_journal_init=0','-d',root+'/inputs','/proc/self/fd/3'],{stdio:['ignore','ignore','pipe',fd],timeout:10000});
  // Some formatter zeroing paths punch regular-file holes even with nodiscard.
  // Re-establish physical allocation on this new fixture, preserving its data.
  cp.execFileSync('/usr/bin/fallocate',['--length',String(initial),'/proc/self/fd/3'],{stdio:['ignore','ignore','pipe',fd],timeout:5000});
  fs.fchownSync(fd,uid,uid);fs.fsyncSync(fd);source=superblock(fd);
 }finally{fs.closeSync(fd);}
 const readWitness=()=>cp.execFileSync('/usr/sbin/debugfs',['-R','cat /witness.txt',image],{stdio:['ignore','pipe','ignore'],timeout:5000,encoding:'utf8'});assert.equal(readWitness(),witness);
 const raw=fs.lstatSync(image);assert(raw.isFile()&&!raw.isSymbolicLink()&&raw.nlink===1&&raw.size===initial&&raw.blocks*512>=initial,JSON.stringify({root,bytes:raw.size,allocated:raw.blocks*512,links:raw.nlink}));
 const manifest={version:1,volumeId:crypto.randomBytes(16).toString('hex'),vcpus:1,memoryMiB:2048,diskBytes:initial,alpineSHA256:'a'.repeat(64)},manifestBytes=canonical(manifest);fs.writeFileSync(worker+'/manifest.json',manifestBytes,{flag:'wx',mode:0o600});fs.chownSync(worker+'/manifest.json',uid,uid);
 const {clean,...geometry}=source,plan={version:1,kind:'raw-ext4-grow-v1',migrationId:crypto.randomBytes(16).toString('hex'),installationRoot:root,workerRoot:worker,appsStateDir:apps,serviceUid:uid,serviceGid:uid,coldFence,source:{volumeId:manifest.volumeId,manifestSha256:sha256(manifestBytes),dev:raw.dev,ino:raw.ino,uid,gid:uid,bytes:initial,allocatedBytes:raw.blocks*512,fs:geometry},targetBytes:target,capacity:{reserveBytes:GiB,guestReserveBytes:MiB,guestReserveInodes:1,guestNewBytes:4096,guestNewInodes:1,additionalHostBytes:0,workBytes:MiB,copyUpBytes:0,metadataGrowthBytes:(target-initial)/2,evidenceSha256:'f'.repeat(64)},toolTimeoutMs:10000};
 const planFile=state+'/approved-plan.json';fs.writeFileSync(planFile,canonical(plan),{flag:'wx',mode:0o600});const owner=await createFixtureOperations(planFile,{expectedPlanSha256:sha256(plan)});let fscks=0;
 try{
  await assert.rejects(createLinuxOperations(planFile,{expectedPlanSha256:sha256(plan),fixture:true}),{code:'GROW_SOURCE_INVALID'},'the production entry cannot select the fixture bypass');
  const inspect=owner.ops.inspect;const before=await inspect();assert.equal(before.fs.clean,true);const check=owner.ops.fsck;owner.ops.fsck=async(...args)=>{fscks++;return check(...args);};
  // A second actual controller flock cannot enter this owned cold boundary.
  const contender=cp.spawnSync('/usr/bin/flock',['-n',root+'/supervisor.lock','/usr/bin/true'],{stdio:'ignore',timeout:1000});assert.notEqual(contender.status,0);
  const record=await runGrowth(plan,owner.ops);assert.equal(record.phase,'complete');assert.equal(record.beforeFsck.code,0);assert.equal(record.afterFsck.code,0);assert.equal(fscks,2);const grown=await inspect();assert.equal(grown.raw.bytes,target);assert(grown.raw.allocatedBytes>=target);assert.equal(grown.raw.ino,raw.ino);assert.equal(grown.fs.uuid,geometry.uuid);assert.equal(grown.fs.blockCount*grown.fs.blockSize,target);assert.equal(grown.fs.clean,true);assert.equal(readWitness(),witness);
  assert.equal((await runGrowth(plan,owner.ops)).observedOnly,true);assert.equal(fscks,2,'completed rerun invokes no tools');
  const guard=root+'/runtime-status/worker-capacity.json',approved=JSON.parse(fs.readFileSync(guard,'utf8'));fs.writeFileSync(guard,canonical({...approved,phase:'running',fsckVerified:false}),{mode:0o644});
  const pending=inspectWorkerCapacity({workerRoot:worker,guardFile:guard});assert.equal(pending.allowed,false);assert.equal(pending.phase,'running');
  await assert.rejects(runGrowth(plan,owner.ops),{code:'GROW_RECOVERY_REQUIRED'});assert.equal(fscks,2,'pending final publication is never replayed');
  const admissionFile=state+'/runtime-admission-controller.json',admissionBytes=fs.readFileSync(admissionFile);fs.writeFileSync(admissionFile,canonical({version:1,...coldFence,open:true,acceptedWork:0}));await assert.rejects(Promise.resolve().then(()=>owner.ops.assertCold()),{code:'GROW_ADMISSION_NOT_CLOSED'});fs.writeFileSync(admissionFile,admissionBytes);
  const total=directory=>fs.readdirSync(directory,{withFileTypes:true}).reduce((sum,row)=>{const file=directory+'/'+row.name,s=fs.lstatSync(file);assert(!s.isSymbolicLink());return sum+(row.isDirectory()?total(file):s.size);},0);const logicalBytes=total(root);assert(logicalBytes<=128*MiB);assert(initial+target<=128*MiB);
  console.log('GROW_FIXTURE_EVIDENCE '+JSON.stringify({root,sourceBytes:initial,targetBytes:target,finalAllocatedBytes:grown.raw.allocatedBytes,fixtureLogicalBytes:logicalBytes,uuidPreserved:true,witnessPreserved:true,fsckPasses:fscks,retained:true,productionAcceptance:false}));
 }finally{await owner.close();}
});
