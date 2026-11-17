'use strict';

// One source for the explicitly approved pilot; publishing metadata cannot
// enlarge it or select a different daemon/storage backend.
const PILOT_WORKER_PROFILE=Object.freeze({vcpus:1,memoryMiB:2048,diskBytes:3*1024**3,acceleration:'tcg',storageDriver:'vfs'});
const CAPACITY_MIGRATION_CONTRACT=require('./apps-worker-growth-policy.cjs').CONTRACT;
function validateWorkerShape(manifest){
 if(!manifest||['vcpus','memoryMiB'].some(key=>manifest[key]!==PILOT_WORKER_PROFILE[key]))throw Error('Worker exceeds the approved pilot');
 const legacy=manifest.version===1&&manifest.diskBytes===PILOT_WORKER_PROFILE.diskBytes;
 const grown=manifest.version===2&&Number.isSafeInteger(manifest.diskBytes)&&manifest.diskBytes>PILOT_WORKER_PROFILE.diskBytes&&manifest.capacityProfile?.version===1&&manifest.capacityProfile.contract===CAPACITY_MIGRATION_CONTRACT;
 if(!legacy&&!grown)throw Error('Worker exceeds the approved pilot or has an unknown capacity profile');
 return manifest;
}
function validatePilot(manifest,{capacity}={}){
 validateWorkerShape(manifest);
 if(capacity&&(!capacity.allowed||capacity.diskBytes!==manifest.diskBytes)||manifest.version===2&&(!capacity?.allowed||capacity.phase!=='approved'))throw Error('Worker capacity approval is required');
 return manifest;
}
function workerProfile(manifest,observation={}){
 validateWorkerShape(manifest);
 const driver=typeof observation.driver==='string'&&['vfs','overlay2','overlayfs','btrfs','zfs','devicemapper','fuse-overlayfs'].includes(observation.driver)?observation.driver:null;
 const at=Number.isSafeInteger(observation.at)&&observation.at>0?observation.at:null;
 return{...(observation.capacity?{capacity:observation.capacity}:{}),vcpus:manifest.vcpus,memoryMiB:manifest.memoryMiB,diskBytes:manifest.diskBytes,acceleration:PILOT_WORKER_PROFILE.acceleration,
  configuredStorageDriver:PILOT_WORKER_PROFILE.storageDriver,observedStorageDriver:driver,storageObservedAt:driver&&at?at:null,
  observedInRunningBoot:!!(driver&&at&&observation.ready===true),configuredLayerCopies:'full-parent-directory',peakBuildBytesKnown:false};
}
module.exports={PILOT_WORKER_PROFILE,CAPACITY_MIGRATION_CONTRACT,validateWorkerShape,validatePilot,workerProfile};
