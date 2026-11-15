'use strict';

// One source for the explicitly approved pilot; publishing metadata cannot
// enlarge it or select a different daemon/storage backend.
const PILOT_WORKER_PROFILE=Object.freeze({vcpus:1,memoryMiB:2048,diskBytes:3*1024**3,acceleration:'tcg',storageDriver:'vfs'});
function validatePilot(manifest){
 if(!manifest||['vcpus','memoryMiB','diskBytes'].some(key=>manifest[key]!==PILOT_WORKER_PROFILE[key]))throw Error('Worker exceeds the approved pilot');
 return manifest;
}
function workerProfile(manifest,observation={}){
 validatePilot(manifest);
 const driver=typeof observation.driver==='string'&&['vfs','overlay2','overlayfs','btrfs','zfs','devicemapper','fuse-overlayfs'].includes(observation.driver)?observation.driver:null;
 const at=Number.isSafeInteger(observation.at)&&observation.at>0?observation.at:null;
 return{vcpus:manifest.vcpus,memoryMiB:manifest.memoryMiB,diskBytes:manifest.diskBytes,acceleration:PILOT_WORKER_PROFILE.acceleration,
  configuredStorageDriver:PILOT_WORKER_PROFILE.storageDriver,observedStorageDriver:driver,storageObservedAt:driver&&at?at:null,
  observedInRunningBoot:!!(driver&&at&&observation.ready===true),configuredLayerCopies:'full-parent-directory',peakBuildBytesKnown:false};
}
module.exports={PILOT_WORKER_PROFILE,validatePilot,workerProfile};
