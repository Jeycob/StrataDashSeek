'use strict';
const fs=require('node:fs'),MIB=1024**2;
const fail=(code,details)=>Object.assign(Error(code),{code,status:409,details});
function amount(value,name){if(!Number.isSafeInteger(value)||value<0)throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:name});return value;}
function budget({images,candidateMemoryMiB,existingMemoryMiB,testMemoryMiB=512,sourceBytes,dataBytes=0,sourceFiles=0,containerCount=1,hostReserveBytes=2*1024**3,guestReserveBytes=512*MIB}={}){
 if(!Array.isArray(images)||!images.length||images.length>8)throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'images'});
 let imageBytes=0,imageInodes=0;for(const image of images){if(!/^sha256:[a-f0-9]{64}$/.test(image?.Id||''))throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'imageId'});const size=amount(image.Size,'image.Size'),inodes=amount(image.InodeCount,'image.InodeCount');if(!size||!inodes)throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'image.footprint'});imageBytes+=size;imageInodes+=inodes;}
 for(const[key,value]of Object.entries({candidateMemoryMiB,existingMemoryMiB,testMemoryMiB,sourceBytes,dataBytes,sourceFiles,containerCount,hostReserveBytes,guestReserveBytes}))amount(value,key);
 if(!containerCount||containerCount>8||containerCount!==images.length)throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'containerCount'});
 // VFS copies filesystems for EACH container, even when images are identical.
 // Reserve candidate, independent tests and fresh final containers concurrently
 // on disk; stopped candidates still consume their full writable filesystems.
 const guestBytes=imageBytes*3+dataBytes*3+guestReserveBytes;
 // The guest disk may be sparse. Conservatively reserve its entire projected
 // growth on the host as well; do not assume a 3 GiB logical file is allocated.
 const hostBytes=sourceBytes*2+dataBytes+guestBytes+hostReserveBytes;
 const guestInodes=16384+imageInodes*3,hostInodes=4096+sourceFiles*2;
 const memoryBytes=(candidateMemoryMiB+existingMemoryMiB+testMemoryMiB+256)*MIB;
 for(const value of[guestBytes,hostBytes,guestInodes,hostInodes,memoryBytes])if(!Number.isSafeInteger(value))throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'overflow'});
 return{version:1,guestBytes,hostBytes,guestInodes,hostInodes,memoryBytes,imageBytes,driverAccounting:'vfs-full-copies',candidateAndIndependentTests:true};
}
function admit(required,sample){
 if(!required||typeof required!=='object')throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'requirements'});
 const deficits={};for(const[key,value]of Object.entries({hostBytes:required.hostBytes,hostInodes:required.hostInodes,guestBytes:required.guestBytes,guestInodes:required.guestInodes,memoryBytes:required.memoryBytes})){const need=amount(value,'required.'+key),available=amount(sample?.[key],key);if(available<need)deficits[key]={required:need,available,missing:need-available};}
 if(Object.keys(deficits).length)throw fail('DEPLOYMENT_CAPACITY_INSUFFICIENT',deficits);
 return{version:1,admitted:true,required,sample,observedAt:Date.now()};
}
async function verifyCapacity(manager,job,options){
 if(manager.busy!==job.id)throw fail('DEPLOYMENT_OPERATION_NOT_OWNED');
 const required=budget({...options,hostReserveBytes:manager.cfg.minFreeBytes??2*1024**3});
 const worker=manager.worker,status=worker?.status();
 if(!worker||status?.phase!=='ready'||status.controlIsolation?.verified!==true)throw fail('DEPLOYMENT_CAPACITY_UNKNOWN',{field:'isolated-worker'});
 const guestBytes=await worker.diskFree(),host=fs.statfsSync(manager.cfg.stateDir),profile=worker.status().profile;
 const sample={guestBytes,guestInodes:worker.freeInodes,hostBytes:host.bavail*host.bsize,hostInodes:host.ffree,memoryBytes:profile?.memoryMiB*MIB};
 const proof=admit(required,sample);manager.log(job,'Deployment capacity admitted: '+JSON.stringify(proof)+'\n');return proof;
}
module.exports={budget,admit,verifyCapacity};
