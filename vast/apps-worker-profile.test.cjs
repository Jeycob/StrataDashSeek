'use strict';
const {hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const{PILOT_WORKER_PROFILE,validatePilot,workerProfile}=require('./apps-worker-profile.cjs');
const{DockerVM,bootstrap}=require('./apps-vm.cjs');
const manifest={version:1,vcpus:1,memoryMiB:2048,diskBytes:3*1024**3,volumeId:'a'.repeat(32),privateCanary:'never-return-this'};
test('declared pilot limits match bootstrap and immutable profile without filesystem operations',()=>{
 assert.ok(Object.isFrozen(PILOT_WORKER_PROFILE));const p=workerProfile(manifest);
 assert.equal(p.vcpus,1);assert.equal(p.memoryMiB,2048);assert.equal(p.diskBytes,3*1024**3);assert.equal(p.acceleration,'tcg');assert.equal(p.configuredStorageDriver,'vfs');assert.equal(p.configuredLayerCopies,'full-parent-directory');assert.equal(p.peakBuildBytesKnown,false);
 assert.equal(p.observedStorageDriver,null);assert.equal(p.observedInRunningBoot,false);assert.doesNotMatch(JSON.stringify(p),/never-return-this|volumeId/);
 assert.match(bootstrap(manifest,false,'b'.repeat(16)),new RegExp('--storage-driver='+p.configuredStorageDriver+' '));
});
test('profiling never accepts enlarged or malformed pilot resources',()=>{
 for(const value of [null,{}, {...manifest,vcpus:2},{...manifest,memoryMiB:4096},{...manifest,diskBytes:4*1024**3},{...manifest,vcpus:'1'}]){assert.throws(()=>validatePilot(value),/approved pilot/);assert.throws(()=>workerProfile(value),/approved pilot/);}
});
test('observed driver requires actual measured metadata and is distinguished from configured driver',()=>{
 const p=workerProfile(manifest,{driver:'overlay2',at:1234,ready:true});assert.equal(p.configuredStorageDriver,'vfs');assert.equal(p.observedStorageDriver,'overlay2');assert.equal(p.storageObservedAt,1234);assert.equal(p.observedInRunningBoot,true);
 for(const driver of ['secret-token',{},undefined]){const unknown=workerProfile(manifest,{driver,at:1234,ready:true});assert.equal(unknown.observedStorageDriver,null);assert.equal(unknown.storageObservedAt,null);assert.equal(unknown.observedInRunningBoot,false);}
 assert.equal(workerProfile(manifest,{driver:'vfs',at:1234,ready:false}).observedInRunningBoot,false);
});
test('passive VM status reports profile without waking or treating stale observations as current',async()=>{
 const {fixture}=require('./fixtures/vm-ownership.cjs'),f=fixture(),vm=f.worker;vm.observedStorageDriver='vfs';vm.storageObservedAt=1234;
 const before=f.events.length,s=vm.status();assert.equal(s.profile.diskBytes,manifest.diskBytes);assert.equal(s.profile.observedInRunningBoot,false);assert.equal(s.controlIsolation.verified,false);assert.equal(f.events.length,before);
 await vm.start();assert.equal(vm.status().profile.observedInRunningBoot,true);f.setRecord(null);f.exit();f.close();
});
