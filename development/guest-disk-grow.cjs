'use strict';
// Explicit operator migration only. No startup hook, default target or CLI.
const crypto=require('node:crypto'),path=require('node:path');
const GiB=1024**3,MiB=1024**2,CONTRACT='raw-ext4-grow-v1';
const fail=code=>Object.assign(Error(code),{code});
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const hex=(value,length)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+length+'}$').test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function canonical(value){if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
const sha256=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex');
function validatePlan(value,{fixture=false}={}){
 const keys=['version','kind','migrationId','installationRoot','workerRoot','appsStateDir','serviceUid','serviceGid','coldFence','source','targetBytes','capacity','toolTimeoutMs'];
 if(!exact(value,keys)||value.version!==1||value.kind!==CONTRACT||!hex(value.migrationId,32))throw fail('GROW_PLAN_INVALID');
 for(const key of ['installationRoot','workerRoot','appsStateDir'])if(typeof value[key]!=='string'||value[key].length>4096||!path.posix.isAbsolute(value[key])||path.posix.normalize(value[key])!==value[key]||/[\0\s]/u.test(value[key]))throw fail('GROW_PATH_INVALID');
 if(value.installationRoot==='/'||value.workerRoot!==value.installationRoot+'/docker-worker'||value.appsStateDir!==value.installationRoot+'/state/applications'||!integer(value.serviceUid,1000)||value.serviceUid>65534||!integer(value.serviceGid,1000)||value.serviceGid>65534)throw fail('GROW_SCOPE_INVALID');
 if(!exact(value.coldFence,['epoch','sourceCommit'])||!/^([a-f0-9]{8}-)([a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.coldFence.epoch||'')||!hex(value.coldFence.sourceCommit,40))throw fail('GROW_COLD_EPOCH_REQUIRED');
 const source=value.source,sourceKeys=['volumeId','manifestSha256','dev','ino','uid','gid','bytes','allocatedBytes','fs'];
 if(!exact(source,sourceKeys)||!hex(source.volumeId,32)||!hex(source.manifestSha256,64)||!integer(source.dev)||!integer(source.ino,1)||source.uid!==value.serviceUid||source.gid!==value.serviceGid||!integer(source.bytes,MiB)||source.bytes>1024*GiB||!integer(source.allocatedBytes,source.bytes))throw fail('GROW_SOURCE_INVALID');
 if(!fixture&&source.bytes<3*GiB)throw fail('GROW_SOURCE_INVALID');
 const fs=source.fs;
 if(!exact(fs,['uuid','blockSize','blockCount','freeBlocks','inodeCount','freeInodes'])||!hex(fs.uuid,32)||fs.blockSize!==4096||!integer(fs.blockCount,1)||fs.blockCount*fs.blockSize!==source.bytes||!integer(fs.freeBlocks)||fs.freeBlocks>fs.blockCount||!integer(fs.inodeCount,1)||!integer(fs.freeInodes)||fs.freeInodes>fs.inodeCount)throw fail('GROW_FILESYSTEM_INVALID');
 if(!integer(value.targetBytes,source.bytes+fs.blockSize)||value.targetBytes>1024*GiB||value.targetBytes%fs.blockSize!==0)throw fail('GROW_TARGET_INVALID');
 if(fixture&&(!/^\/tmp\/homeai-grow-fixture-[a-f0-9]{16}$/.test(value.installationRoot)||source.bytes+value.targetBytes>128*MiB))throw fail('GROW_FIXTURE_SCOPE');
 const cap=value.capacity,capKeys=['reserveBytes','guestReserveBytes','guestReserveInodes','guestNewBytes','guestNewInodes','additionalHostBytes','workBytes','copyUpBytes','metadataGrowthBytes','evidenceSha256'];
 if(!exact(cap,capKeys)||!integer(cap.reserveBytes,(fixture?1:2)*GiB)||!integer(cap.guestReserveBytes,fixture?1:512*MiB)||!integer(cap.guestReserveInodes,fixture?1:16384)||!integer(cap.workBytes,1)||!hex(cap.evidenceSha256,64))throw fail('GROW_CAPACITY_INPUTS_REQUIRED');
 for(const key of ['guestNewBytes','guestNewInodes','additionalHostBytes','copyUpBytes','metadataGrowthBytes'])if(!integer(cap[key]))throw fail('GROW_CAPACITY_INPUTS_REQUIRED');
 if(!integer(value.toolTimeoutMs,1000)||value.toolTimeoutMs>120000)throw fail('GROW_TOOL_DEADLINE_INVALID');
 return JSON.parse(canonical(value));
}
function assessCapacity(plan,observation){
 const cap=plan.capacity,delta=plan.targetBytes-plan.source.bytes;
 if(!observation||!integer(observation.availableBytes)||!integer(observation.availableInodes,1)||!['overlay','direct'].includes(observation.backing))throw fail('GROW_HOST_CAPACITY_UNKNOWN');
 // Never assume that an overlay file is already in its writable upper layer.
 if(observation.backing==='overlay'&&cap.copyUpBytes<plan.source.bytes)throw fail('GROW_COPYUP_BUDGET_REQUIRED');
 const requiredBytes=cap.reserveBytes+delta+cap.copyUpBytes+cap.workBytes+cap.additionalHostBytes;
 if(!integer(requiredBytes)||observation.availableBytes<requiredBytes||observation.availableInodes<32)throw fail('GROW_HOST_CAPACITY');
 const projectedFree=plan.source.fs.freeBlocks*plan.source.fs.blockSize+delta-cap.metadataGrowthBytes;
 if(projectedFree<cap.guestReserveBytes+cap.guestNewBytes||plan.source.fs.freeInodes<cap.guestReserveInodes+cap.guestNewInodes)throw fail('GROW_GUEST_CAPACITY');
 return{deltaBytes:delta,requiredHostBytes:requiredBytes,projectedGuestFreeBytes:projectedFree};
}
function assertIdentity(plan,observation,{target=false,manifestHash=plan.source.manifestSha256}={}){
 const raw=observation?.raw,fs=observation?.fs;
 if(!raw||['dev','ino','uid','gid'].some(key=>raw[key]!==plan.source[key])||raw.links!==1||raw.bytes!==(target?plan.targetBytes:plan.source.bytes)||!integer(raw.allocatedBytes,raw.bytes)||observation.manifestSha256!==manifestHash)throw fail('GROW_IDENTITY_CHANGED');
 if(!target&&raw.allocatedBytes!==plan.source.allocatedBytes)throw fail('GROW_IDENTITY_CHANGED');
 if(!fs||fs.uuid!==plan.source.fs.uuid||fs.blockSize!==plan.source.fs.blockSize||fs.blockCount*fs.blockSize!==(target?plan.targetBytes:plan.source.bytes)||!integer(fs.freeBlocks)||fs.freeBlocks>fs.blockCount||!integer(fs.freeInodes)||fs.freeInodes>fs.inodeCount)throw fail('GROW_FILESYSTEM_CHANGED');
 if(!target&&['blockCount','freeBlocks','inodeCount','freeInodes'].some(key=>fs[key]!==plan.source.fs[key]))throw fail('GROW_FILESYSTEM_CHANGED');
}
function candidateManifest(plan,current,planSha256){
 if(!current||![1,2].includes(current.version)||current.volumeId!==plan.source.volumeId||current.diskBytes!==plan.source.bytes||current.vcpus!==1||current.memoryMiB!==2048)throw fail('GROW_MANIFEST_CHANGED');
 return{...current,version:2,diskBytes:plan.targetBytes,capacityProfile:{version:1,contract:CONTRACT,migrationId:plan.migrationId,planSha256,fromBytes:plan.source.bytes,toBytes:plan.targetBytes,fsUuid:plan.source.fs.uuid}};
}
function approvedGuard(plan,record){return{version:1,contract:CONTRACT,phase:'approved',migrationId:plan.migrationId,planSha256:record.planSha256,workerRoot:plan.workerRoot,volumeId:plan.source.volumeId,raw:{dev:plan.source.dev,ino:plan.source.ino,uid:plan.source.uid,gid:plan.source.gid,bytes:plan.targetBytes},manifestSha256:record.manifestSha256,fsUuid:plan.source.fs.uuid,fsckVerified:true};}

/** Adapter seam is for synthetic fixtures. Production callers use growOffline.
 * Every mutating intent is durable before its side effect. Existing ambiguous
 * journals are never replayed, and no failure shrinks or reformats anything. */
async function runGrowth(input,ops){
 const plan=validatePlan(input,{fixture:ops.fixture===true}),planSha256=sha256(plan);
 await ops.assertCold();await ops.assertConsumer(CONTRACT);
 const prior=await ops.readJournal();
 if(prior){
  if(prior.version!==1||prior.planSha256!==planSha256||prior.phase!=='complete')throw fail('GROW_RECOVERY_REQUIRED');
  const observation=await ops.inspect();assertIdentity(plan,observation,{target:true,manifestHash:prior.manifestSha256});
  if(canonical(await ops.readGuard())!==canonical(approvedGuard(plan,prior)))throw fail('GROW_RECOVERY_REQUIRED');
  return{...prior,observedOnly:true};
 }
 const initial=await ops.inspect();assertIdentity(plan,initial);
 const existingGuard=await ops.readGuard();
 if(existingGuard!==undefined&&!require('../vast/apps-worker-growth-policy.cjs').validateCapacity({guard:existingGuard,manifest:initial.manifest,manifestSha256:initial.manifestSha256,raw:initial.raw,workerRoot:plan.workerRoot}).allowed)throw fail('GROW_RECOVERY_REQUIRED');
 const budget=assessCapacity(plan,initial.host),manifest=candidateManifest(plan,initial.manifest,planSha256),manifestSha256=sha256(manifest);
 let record={version:1,contract:CONTRACT,migrationId:plan.migrationId,planSha256,phase:'prepared',lastConfirmed:'prepared',source:plan.source,targetBytes:plan.targetBytes,manifestSha256,budget};
 const guard=()=>({...approvedGuard(plan,record),phase:record.phase==='recovery_required'?'recovery_required':'running',fsckVerified:false});
 async function stage(phase,confirmed=false){await ops.assertCold();record={...record,phase,...(confirmed?{lastConfirmed:phase}:{})};await ops.writeJournal(record);}
 async function reserve(){const host=(await ops.inspect()).host;if(!integer(host?.availableBytes)||host.availableBytes<plan.capacity.reserveBytes+plan.capacity.additionalHostBytes+plan.capacity.workBytes)throw fail('GROW_POST_RESERVE');}
 await ops.writeJournal(record);
 try{
  await ops.writeGuard(guard());
  await stage('fsck_before');const beforeFsck=await ops.fsck(plan.toolTimeoutMs);if(beforeFsck?.code!==0||!hex(beforeFsck.outputSha256,64))throw fail('GROW_FSCK_PROOF_REQUIRED');record={...record,beforeFsck};assertIdentity(plan,await ops.inspect());
  // Consumer support and physical/copy-up budgets must hold before write-open.
  await ops.assertConsumer(CONTRACT);assessCapacity(plan,(await ops.inspect()).host);
  await stage('allocation_intent');await ops.allocate(budget.deltaBytes,plan.toolTimeoutMs);await reserve();await stage('allocated',true);
  await stage('length_intent');await ops.extend(plan.targetBytes);await stage('extended',true);
  await stage('resize_intent');await ops.resize(plan.targetBytes/plan.source.fs.blockSize,plan.toolTimeoutMs);await stage('resized',true);
  // resize2fs can punch zeroed metadata blocks in regular files. Do not accept
  // an image whose named size is no longer fully backed by physical blocks.
  const resized=await ops.inspect(),holes=Math.max(0,plan.targetBytes-resized.raw.allocatedBytes);
  if(!integer(resized.host?.availableBytes)||resized.host.availableBytes<plan.capacity.reserveBytes+plan.capacity.additionalHostBytes+plan.capacity.workBytes+holes)throw fail('GROW_POST_RESERVE');
  await stage('physical_finalize_intent');await ops.sealAllocation(plan.targetBytes,plan.toolTimeoutMs);await stage('physically_sealed',true);
  await stage('fsck_after');const afterFsck=await ops.fsck(plan.toolTimeoutMs);if(afterFsck?.code!==0||!hex(afterFsck.outputSha256,64))throw fail('GROW_FSCK_PROOF_REQUIRED');
  const grown=await ops.inspect();assertIdentity(plan,grown,{target:true});
  if(grown.fs.clean!==true||grown.fs.freeBlocks*grown.fs.blockSize<plan.capacity.guestReserveBytes+plan.capacity.guestNewBytes||grown.fs.freeInodes<plan.capacity.guestReserveInodes+plan.capacity.guestNewInodes)throw fail('GROW_POST_FILESYSTEM');
  record={...record,afterFsck,verifiedFilesystem:grown.fs,verifiedRaw:grown.raw,verifiedHost:grown.host,coldFence:plan.coldFence};
  await reserve();await ops.assertConsumer(CONTRACT);await stage('verified',true);
  await stage('manifest_intent');await ops.writeManifest(manifest);
  assertIdentity(plan,await ops.inspect(),{target:true,manifestHash:manifestSha256});
  await stage('complete',true);await ops.writeGuard(approvedGuard(plan,record));
  return record;
 }catch(error){
  record={...record,phase:'recovery_required',reasonCode:/^GROW_[A-Z_]+$/.test(error.code||'')?error.code:'GROW_OPERATION_UNCERTAIN'};
  // A publication error is never a reason to clear the previous running gate.
  try{await ops.writeJournal(record);}catch{}
  try{await ops.writeGuard(guard());}catch{}
  throw Object.assign(fail('GROW_RECOVERY_REQUIRED'),{cause:error,record});
 }
}
async function growOffline(planFile,{expectedPlanSha256}={}){
 const {createLinuxOperations}=require('./guest-disk-grow-linux.cjs');
 const owner=await createLinuxOperations(planFile,{expectedPlanSha256});
 try{return await runGrowth(owner.plan,owner.ops);}finally{await owner.close();}
}
module.exports={CONTRACT,validatePlan,assessCapacity,assertIdentity,candidateManifest,canonical,sha256,runGrowth,growOffline};
