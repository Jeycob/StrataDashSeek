'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validatePlan,assessCapacity,sha256,canonical,runGrowth}=require('./guest-disk-grow.cjs');
const {validateCapacity}=require('../vast/apps-worker-growth-policy.cjs');
const {qualifyReadOnlyFsck}=require('./guest-disk-fsck.cjs');
const GiB=1024**3,MiB=1024**2,copy=value=>JSON.parse(JSON.stringify(value));
const tool={path:'/usr/sbin/e2fsck',sha256:'f'.repeat(64),dev:'1',ino:'99',size:'128',uid:0,gid:0,mode:0o100755,mtimeNs:'100',ctimeNs:'100'};
function fsckProof(fs,warning=''){
 const stdout=Buffer.from('Pass 1: Checking inodes, blocks, and sizes\nPass 2: Checking directory structure\nPass 3: Checking directory connectivity\nPass 4: Checking reference counts\nPass 5: Checking group summary information\n'+warning+'fixture: '+(fs.inodeCount-fs.freeInodes)+'/'+fs.inodeCount+' files (0.0% non-contiguous), '+(fs.blockCount-fs.freeBlocks)+'/'+fs.blockCount+' blocks\n');
 return qualifyReadOnlyFsck({stdout,stderr:Buffer.from('e2fsck 1.47.2 (1-Jan-2025)\n'),code:0,closed:true,tool});
}
function fixture(){
 const manifest={version:1,volumeId:'a'.repeat(32),diskBytes:3*GiB,vcpus:1,memoryMiB:2048,alpineSHA256:'f'.repeat(64)},fs={uuid:'b'.repeat(32),blockSize:4096,blockCount:786432,freeBlocks:4104,inodeCount:196608,freeInodes:128809};
 const plan={version:1,kind:'raw-ext4-grow-v1',migrationId:'c'.repeat(32),installationRoot:'/data/harness',workerRoot:'/data/harness/docker-worker',appsStateDir:'/data/harness/state/applications',serviceUid:1001,serviceGid:1001,coldFence:{epoch:'11111111-2222-3333-4444-555555555555',sourceCommit:'e'.repeat(40)},source:{volumeId:manifest.volumeId,manifestSha256:sha256(manifest),dev:1,ino:2,uid:1001,gid:1001,bytes:3*GiB,allocatedBytes:3*GiB+4096,fs},targetBytes:4*GiB,capacity:{reserveBytes:2*GiB,guestReserveBytes:512*MiB,guestReserveInodes:16384,guestNewBytes:128*MiB,guestNewInodes:4000,additionalHostBytes:GiB,workBytes:64*MiB,copyUpBytes:3*GiB,metadataGrowthBytes:128*MiB,evidenceSha256:'d'.repeat(64)},toolTimeoutMs:30000};
 const observation={raw:{dev:1,ino:2,uid:1001,gid:1001,bytes:3*GiB,allocatedBytes:3*GiB+4096,links:1,mode:0o600},fs:{...fs,clean:true},manifest:copy(manifest),manifestSha256:sha256(manifest),host:{availableBytes:16*GiB,availableInodes:100000,backing:'overlay'}},calls=[],journals=[];let journal,guard;
 const ops={assertCold:async()=>{calls.push('cold');},assertConsumer:async()=>{calls.push('consumer');},readJournal:async()=>journal,readGuard:async()=>guard,inspect:async()=>copy(observation),writeJournal:async value=>{calls.push('journal:'+value.phase);journal=JSON.parse(canonical(value));journals.push(copy(value));},writeGuard:async value=>{calls.push('guard:'+value.phase);guard=copy(value);},fsck:async()=>{calls.push('fsck');return fsckProof(observation.fs);},allocate:async delta=>{calls.push('allocate');observation.raw.allocatedBytes+=delta;observation.host.availableBytes-=delta;},extend:async bytes=>{calls.push('extend');observation.raw.bytes=bytes;},resize:async blocks=>{calls.push('resize');observation.fs.blockCount=blocks;observation.fs.freeBlocks+=(plan.targetBytes-plan.source.bytes-plan.capacity.metadataGrowthBytes)/4096;},sealAllocation:async bytes=>{calls.push('sealAllocation');observation.raw.allocatedBytes=Math.max(observation.raw.allocatedBytes,bytes);},writeManifest:async value=>{calls.push('manifest');observation.manifest=copy(value);observation.manifestSha256=sha256(value);}};
 return{plan,ops,observation,calls,journals,get journal(){return journal;},get guard(){return guard;},setJournal:value=>{journal=value;},setGuard:value=>{guard=value;}};
}
test('explicit complete inputs are mandatory; no target, artifact, metadata or copy-up defaults',()=>{
 const f=fixture();assert.equal(validatePlan(f.plan).targetBytes,4*GiB);
 for(const key of ['targetBytes','toolTimeoutMs'])for(const missing of [null,undefined,NaN]){const plan=copy(f.plan);plan[key]=missing;assert.throws(()=>validatePlan(plan),/^Error: GROW_/);}
 for(const key of ['additionalHostBytes','workBytes','copyUpBytes','metadataGrowthBytes','guestNewBytes','guestNewInodes']){const plan=copy(f.plan);plan.capacity[key]=null;assert.throws(()=>validatePlan(plan),{code:'GROW_CAPACITY_INPUTS_REQUIRED'});}
 for(const change of [p=>p.targetBytes=p.source.bytes,p=>p.targetBytes=2*GiB,p=>p.source.allocatedBytes=GiB,p=>p.capacity.reserveBytes=GiB,p=>p.capacity.guestReserveBytes=MiB,p=>p.workerRoot='/other',p=>p.capacity.extra=true]){const plan=copy(f.plan);change(plan);assert.throws(()=>validatePlan(plan),/^Error: GROW_/);}
});
test('physical headroom includes delta, complete overlay copy-up, work, future artifacts and reserve',()=>{
 const f=fixture(),cap=assessCapacity(f.plan,f.observation.host);assert.equal(cap.requiredHostBytes,7*GiB+64*MiB);
 assert.throws(()=>assessCapacity(f.plan,{...f.observation.host,availableBytes:2837479424}),{code:'GROW_HOST_CAPACITY'});
 const plan=copy(f.plan);plan.capacity.copyUpBytes=0;assert.throws(()=>assessCapacity(plan,f.observation.host),{code:'GROW_COPYUP_BUDGET_REQUIRED'});assert.doesNotThrow(()=>assessCapacity(plan,{...f.observation.host,backing:'direct'}));
 const tiny=copy(f.plan);tiny.targetBytes=3.5*GiB;assert.throws(()=>assessCapacity(tiny,f.observation.host),{code:'GROW_GUEST_CAPACITY'},'actual free4104blocks is not old DU or a half-GiB of spare filesystem space');
});
test('intents and pending gate precede raw writes; manifest publishes only after both fsck checks and exact proof',async()=>{
 const f=fixture(),record=await runGrowth(f.plan,f.ops);assert.equal(record.phase,'complete');
 assert(Buffer.byteLength(canonical(f.journal))<16384,'two complete sanitized witnesses fit the existing bounded journal reader');
 for(const [intent,action]of [['guard:running','allocate'],['journal:allocation_intent','allocate'],['journal:length_intent','extend'],['journal:resize_intent','resize'],['journal:physical_finalize_intent','sealAllocation'],['journal:manifest_intent','manifest']])assert(f.calls.indexOf(intent)<f.calls.indexOf(action));
 assert.equal(f.calls.filter(value=>value==='fsck').length,2);assert(f.calls.lastIndexOf('fsck')<f.calls.indexOf('manifest'));assert.equal(f.observation.manifest.volumeId,f.plan.source.volumeId);assert.equal(f.observation.manifest.version,2);assert.equal(f.guard.phase,'approved');
 assert.equal(validateCapacity({guard:f.guard,manifest:f.observation.manifest,manifestSha256:f.observation.manifestSha256,raw:f.observation.raw,workerRoot:f.plan.workerRoot}).allowed,true);
 const length=f.calls.length;await runGrowth(f.plan,f.ops);assert(f.calls.slice(length).every(value=>['cold','consumer'].includes(value)),'completed rerun observes; it does not replay any write/tool');
});
test('missing actual runtime consumer or cold proof fails before journal, guard or raw mutation',async()=>{
 for(const key of ['assertConsumer','assertCold']){const f=fixture();f.ops[key]=async()=>{throw Object.assign(Error('unsupported'),{code:'GROW_RUNTIME_CONSUMER_REQUIRED'});};await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RUNTIME_CONSUMER_REQUIRED'});assert.equal(f.journal,undefined);assert.equal(f.guard,undefined);assert(!f.calls.includes('allocate'));}
});
test('all ambiguous prior journals and unrelated pending guards refuse fresh work without replay',async()=>{
 for(const phase of ['prepared','allocation_intent','allocated','length_intent','extended','resize_intent','resized','physical_finalize_intent','physically_sealed','fsck_after','verified','manifest_intent','recovery_required']){const f=fixture();f.setJournal({version:1,planSha256:sha256(f.plan),phase});await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(!f.calls.includes('allocate'));}
 for(const guard of [null,{}, {version:1,contract:'raw-ext4-grow-v1',phase:'running',migrationId:'c'.repeat(32),planSha256:'d'.repeat(64),workerRoot:'/data/harness/docker-worker'}]){const f=fixture();f.setGuard(guard);await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert.equal(f.journal,undefined);}
});
test('identity changes and uncertain mutating tools leave recovery_required/OFF with no shrink, reformat or manifest commit',async()=>{
 for(const where of ['allocate','extend','resize','sealAllocation','writeManifest']){const f=fixture(),original=f.ops[where];f.ops[where]=async(...args)=>{await original(...args);throw Object.assign(Error('uncertain'),{code:'GROW_TOOL_TIMEOUT'});};await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert.equal(f.journal.phase,'recovery_required');assert.equal(f.guard.phase,'recovery_required');const before=f.calls.filter(x=>x===where).length;await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert.equal(f.calls.filter(x=>x===where).length,before);if(where!=='writeManifest')assert(!f.calls.includes('manifest'));assert(f.observation.raw.bytes>=f.plan.source.bytes);}
 const f=fixture();f.observation.raw.ino++;await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_IDENTITY_CHANGED'});assert.equal(f.journal,undefined);
});
test('a previously grown source without its approval guard refuses a new migration before any writes',async()=>{
 const f=fixture();await runGrowth(f.plan,f.ops);
 const start=f.calls.length,raw=f.observation.raw,geometry=f.observation.fs;
 f.setJournal(undefined);f.setGuard(undefined);f.plan.migrationId='d'.repeat(32);f.plan.targetBytes=5*GiB;
 f.plan.source={...f.plan.source,manifestSha256:f.observation.manifestSha256,bytes:raw.bytes,allocatedBytes:raw.allocatedBytes,fs:Object.fromEntries(['uuid','blockSize','blockCount','freeBlocks','inodeCount','freeInodes'].map(key=>[key,geometry[key]]))};
 await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});
 assert.equal(f.journal,undefined);assert.equal(f.guard,undefined);
 assert(f.calls.slice(start).every(value=>['cold','consumer'].includes(value)));
 assert.equal(f.observation.raw.bytes,4*GiB);
});
test('clean bit never substitutes for real fsck success and post-growth capacity remains mandatory',async()=>{
 const before=fixture();before.ops.fsck=async()=>{throw Object.assign(Error('fsck exit4'),{code:'GROW_TOOL_FAILED'});};await assert.rejects(runGrowth(before.plan,before.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(!before.calls.includes('allocate'));assert.equal(before.guard.phase,'recovery_required');
 const after=fixture();after.ops.resize=async()=>{after.observation.fs.blockCount=after.plan.targetBytes/4096;after.observation.fs.freeBlocks=1;};await assert.rejects(runGrowth(after.plan,after.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(!after.calls.includes('manifest'));assert.equal(after.observation.raw.bytes,after.plan.targetBytes);
});
test('reader blocks every pending/unknown guard while allowing only exact legacy3GiB without a guard',()=>{
 const f=fixture(),base={manifest:f.observation.manifest,manifestSha256:f.observation.manifestSha256,raw:f.observation.raw,workerRoot:f.plan.workerRoot};assert.equal(validateCapacity(base).allowed,true);
 assert.equal(validateCapacity({...base,raw:{...base.raw,bytes:4*GiB}}).allowed,false);
 for(const guard of [null,{},[],{phase:'approved'},...['planned','running','recovery_required','other'].map(phase=>({version:1,contract:'raw-ext4-grow-v1',migrationId:'c'.repeat(32),planSha256:'d'.repeat(64),workerRoot:f.plan.workerRoot,phase}))])assert.equal(validateCapacity({...base,guard}).allowed,false);
});
test('approved status binds the exact manifest, plan, volume, physical identity and permissions',async()=>{
 const f=fixture();await runGrowth(f.plan,f.ops);const base={guard:f.guard,manifest:f.observation.manifest,manifestSha256:f.observation.manifestSha256,raw:f.observation.raw,workerRoot:f.plan.workerRoot};assert.equal(validateCapacity(base).allowed,true);
 for(const change of [s=>s.manifestSha256='0'.repeat(64),s=>s.guard.planSha256='0'.repeat(64),s=>s.guard.volumeId='0'.repeat(32),s=>s.guard.fsckVerified=false,s=>s.raw.ino++,s=>s.raw.dev++,s=>s.raw.uid++,s=>s.raw.gid++,s=>s.raw.links=2,s=>s.raw.bytes--,s=>s.raw.allocatedBytes=0,s=>s.raw.mode=0o666,s=>s.workerRoot='/other',s=>s.guard.extra=true]){const state=copy(base);change(state);assert.equal(validateCapacity(state).allowed,false);}
});
test('a metadata hole from resize2fs is physically resealed, never accepted as sparse budget',async()=>{
 const f=fixture(),resize=f.ops.resize;f.ops.resize=async(...args)=>{await resize(...args);f.observation.raw.allocatedBytes=f.plan.targetBytes-4096;};await runGrowth(f.plan,f.ops);assert.equal(f.observation.raw.allocatedBytes,f.plan.targetBytes);assert(f.calls.indexOf('sealAllocation')>f.calls.indexOf('resize'));
 const bad=fixture();bad.ops.sealAllocation=async()=>{bad.observation.raw.allocatedBytes=bad.plan.targetBytes-4096;};await assert.rejects(runGrowth(bad.plan,bad.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(!bad.calls.includes('manifest'));
});

test('exit0 filesystem warning before grow is not an fsck proof',async()=>{
 const f=fixture();f.ops.fsck=async()=>fsckProof(f.observation.fs,'Free blocks count wrong (620672, counted=453338).\nFix? no\n');
 await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(!f.calls.includes('allocate'));assert.equal(f.guard.phase,'recovery_required');
});

test('exit0 filesystem warning after resize never publishes the manifest',async()=>{
 const f=fixture(),clean=f.ops.fsck;let checks=0;f.ops.fsck=async(...args)=>++checks===1?clean(...args):fsckProof(f.observation.fs,'Free inodes count wrong (172758, counted=164190).\nFix? no\n');
 await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(f.calls.includes('resize'));assert(!f.calls.includes('manifest'));assert.equal(f.guard.phase,'recovery_required');
});

test('unknown incomplete timeout and unsafe tool receipts stop at each fsck boundary',async()=>{
 for(const phase of ['before','after'])for(const change of [p=>p.clipped=true,p=>p.expired=true,p=>p.streamError=true,p=>p.toolStable=false,p=>p.inputStable=false,p=>p.tool.path='/usr/sbin/resize2fs',p=>p.stdout.text+='\n[REDACTED_LINE sha256='+'a'.repeat(64)+']']){
  const f=fixture(),clean=f.ops.fsck;let n=0;f.ops.fsck=async()=>{const p=await clean();if(++n===(phase==='before'?1:2))change(p);return p;};
  await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert.equal(f.guard.phase,'recovery_required');assert(!f.calls.includes('manifest'));if(phase==='before')assert(!f.calls.includes('allocate'));
 }
});

test('late filesystem or proof changes are rechecked before allocation and manifest publication',async()=>{
 for(const where of ['allocation_intent','manifest_intent','proof']){
  const f=fixture(),write=f.ops.writeJournal;f.ops.writeJournal=async value=>{await write(value);if(value.phase===(where==='allocation_intent'?'allocation_intent':'manifest_intent')){if(where==='proof')value.afterFsck.warningFree=false;else f.observation.fs.freeInodes--;}};
  await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(!f.calls.includes('manifest'));if(where==='allocation_intent')assert(!f.calls.includes('allocate'));assert.equal(f.guard.phase,'recovery_required');
 }
});

test('legacy completed exit0/hash-only journal is not silently upgraded or replayed',async()=>{
 const f=fixture();await runGrowth(f.plan,f.ops);f.setJournal({...f.journal,beforeFsck:{code:0,outputSha256:'a'.repeat(64)}});const start=f.calls.length;
 await assert.rejects(runGrowth(f.plan,f.ops),{code:'GROW_RECOVERY_REQUIRED'});assert(f.calls.slice(start).every(x=>['cold','consumer'].includes(x)));
});
