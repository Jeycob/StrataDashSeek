'use strict';
// Root-owned migration gate, read-only from the unprivileged Apps controller.
// This file does not change the default pilot or install any runtime callsite.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const CONTRACT='raw-ext4-grow-v1',LEGACY_BYTES=3*1024**3,MAX=16384;
const hex=(value,n)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(value);
const number=value=>Number.isSafeInteger(value)&&value>=0;
const blocked=(phase='unknown',reasonCode='WORKER_CAPACITY_RECOVERY_REQUIRED')=>({version:1,allowed:false,phase,reasonCode});
function validateCapacity({guard,manifest,manifestSha256,raw,workerRoot}){
 if(guard===undefined)return manifest?.version===1&&hex(manifest.volumeId,32)&&manifest.diskBytes===LEGACY_BYTES&&manifest.vcpus===1&&manifest.memoryMiB===2048&&raw?.bytes===LEGACY_BYTES&&raw.links===1&&number(raw.mode)&&!(raw.mode&0o022)&&raw.allocatedBytes>=raw.bytes?{version:1,allowed:true,phase:'legacy',diskBytes:LEGACY_BYTES,manifestSha256}:blocked('unknown','WORKER_CAPACITY_APPROVAL_REQUIRED');
 if(!guard||typeof guard!=='object'||Array.isArray(guard))return blocked();
 if(guard.version!==1||guard.contract!==CONTRACT||!hex(guard.migrationId,32)||!hex(guard.planSha256,64))return blocked();
 if(guard.workerRoot!==workerRoot)return blocked('unknown','WORKER_CAPACITY_IDENTITY_CHANGED');
 if(guard.phase!=='approved')return blocked(['planned','running','recovery_required'].includes(guard.phase)?guard.phase:'unknown');
 if(Object.keys(guard).length!==11||Object.keys(guard).some(key=>!['version','contract','phase','migrationId','planSha256','workerRoot','volumeId','raw','manifestSha256','fsUuid','fsckVerified'].includes(key)))return blocked();
 const p=manifest?.capacityProfile;
 if(manifest?.version!==2||manifest.vcpus!==1||manifest.memoryMiB!==2048||!number(manifest.diskBytes)||manifest.diskBytes<=LEGACY_BYTES||!p||p.version!==1||p.contract!==CONTRACT||p.migrationId!==guard.migrationId||p.planSha256!==guard.planSha256||p.toBytes!==manifest.diskBytes||!number(p.fromBytes)||p.fromBytes>=p.toBytes||p.fsUuid!==guard.fsUuid||!hex(guard.fsUuid,32)||guard.fsckVerified!==true||!hex(guard.manifestSha256,64)||guard.manifestSha256!==manifestSha256||!hex(manifest.volumeId,32)||guard.volumeId!==manifest.volumeId||!guard.raw||['dev','ino','uid','gid','bytes'].some(key=>!number(raw?.[key])||raw[key]!==guard.raw[key])||raw.bytes!==manifest.diskBytes||raw.links!==1||!number(raw.mode)||raw.mode&0o022||raw.allocatedBytes<raw.bytes)return blocked('approved','WORKER_CAPACITY_IDENTITY_CHANGED');
 return{version:1,allowed:true,phase:'approved',diskBytes:manifest.diskBytes,manifestSha256};
}
function parent(file){let current=path.parse(file).root;for(const part of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)&&!(s.mode&0o1000))throw Error('parent');}}
function read(file,{rootOwned=false,optional=false}={}){
 if(rootOwned)parent(file);let fd;
 try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size<2||s.size>MAX||rootOwned&&(s.uid!==0||s.mode&0o022))throw Error('file');const bytes=Buffer.alloc(s.size+1),n=fs.readSync(fd,bytes,0,bytes.length,0),again=fs.lstatSync(file);if(n!==s.size||again.isSymbolicLink()||again.dev!==s.dev||again.ino!==s.ino)throw Error('changed');return{value:JSON.parse(bytes.subarray(0,n).toString('utf8')),sha256:crypto.createHash('sha256').update(bytes.subarray(0,n)).digest('hex')};}
 catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function inspectWorkerCapacity({workerRoot,guardFile='/data/harness/runtime-status/worker-capacity.json'}){
 try{
  if(!path.isAbsolute(workerRoot)||fs.realpathSync(workerRoot)!==workerRoot||!path.isAbsolute(guardFile)||fs.realpathSync(path.dirname(guardFile))!==path.dirname(guardFile))return blocked();
  const record=read(guardFile,{rootOwned:true,optional:true}),guard=record===null?undefined:record.value;
  // Read-only status can explain a pending gate without opening an unsafe raw.
  if(record&&guard?.phase!=='approved')return validateCapacity({guard,workerRoot});
  const manifest=read(path.join(workerRoot,'manifest.json')),file=path.join(workerRoot,'volume.raw'),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())return blocked();
  return validateCapacity({guard,manifest:manifest.value,manifestSha256:manifest.sha256,workerRoot,raw:{dev:s.dev,ino:s.ino,uid:s.uid,gid:s.gid,bytes:s.size,allocatedBytes:s.blocks*512,links:s.nlink,mode:s.mode&0o777}});
 }catch{return blocked('unknown','WORKER_CAPACITY_STATE_UNSAFE');}
}
function assertWorkerCapacity(options){const status=inspectWorkerCapacity(options);if(!status.allowed)throw Object.assign(Error(status.reasonCode),{code:status.reasonCode});return status;}
module.exports={CONTRACT,LEGACY_BYTES,validateCapacity,inspectWorkerCapacity,assertWorkerCapacity};
