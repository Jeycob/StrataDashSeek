'use strict';
const fs=require('node:fs'),path=require('node:path');
const PROFILE='public-https-unix-v1',hex=/^[a-f0-9]{64}$/,image=/^sha256:[a-f0-9]{64}$/;
const fail=code=>Object.assign(Error(code),{code,status:409});
const checks=['networkNone','publicTls443','privateTargetsDenied','ownedStop','resourceLimits'];
function verifyAcceptance(value,manager){
 const cfg=manager.cfg.projectRuntime,proof=manager.worker.status().projectRuntimeIsolation;
 const keys=['version','profile','observedAt','evidenceSha256','kernelSha256','runtimeSourceCommit','toolchainManifestSha256','executorImage','proxyImage','checks'];
 if(!value||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key))||value.version!==1||value.profile!==PROFILE||!Number.isSafeInteger(value.observedAt)||value.observedAt<=0||value.observedAt>Date.now()+30000||!hex.test(value.evidenceSha256||'')||!hex.test(value.kernelSha256||'')||!/^[a-f0-9]{40}$/.test(value.runtimeSourceCommit||'')||!hex.test(value.toolchainManifestSha256||'')||!image.test(value.executorImage||'')||!image.test(value.proxyImage||'')||!value.checks||Object.keys(value.checks).length!==checks.length||!checks.every(key=>value.checks[key]===true))throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED');
 if(!proof?.verified||proof.bootPid!==manager.worker.pid()||value.kernelSha256!==proof.kernelSha256||value.runtimeSourceCommit!==proof.runtimeSourceCommit||value.toolchainManifestSha256!==cfg.toolchain?.manifestSha256||value.toolchainManifestSha256!==proof.toolchain?.manifestSha256||proof.toolchain?.verified!==true||proof.toolchain?.bootPid!==proof.bootPid||proof.toolchain?.readOnly!==true||value.executorImage!==cfg.images?.executor||value.proxyImage!==cfg.images?.egress)throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_CHANGED');
 return{profile:PROFILE,evidenceSha256:value.evidenceSha256,kernelSha256:value.kernelSha256,runtimeSourceCommit:value.runtimeSourceCommit,toolchainManifestSha256:value.toolchainManifestSha256,executorImage:value.executorImage,proxyImage:value.proxyImage};
}
function readAcceptance(manager,filesystem=fs){
 const cfg=manager.cfg.projectRuntime?.egress;
 if(cfg===undefined||cfg?.enabled===false)return null;
 if(!cfg||cfg.enabled!==true||Object.keys(cfg).some(key=>!['enabled','acceptanceFile'].includes(key))||!path.isAbsolute(cfg.acceptanceFile||''))throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED');
 let fd;
 try{
  const file=cfg.acceptanceFile;if(filesystem.realpathSync(file)!==file)throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED');
  fd=filesystem.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const info=filesystem.fstatSync(fd);
  if(!info.isFile()||info.nlink!==1||info.uid!==0||info.mode&0o022||info.size<2||info.size>16384)throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED');
  const bytes=Buffer.alloc(info.size+1),count=filesystem.readSync(fd,bytes,0,bytes.length,0),current=filesystem.lstatSync(file);
  if(count!==info.size||current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino||current.nlink!==1||current.uid!==0||current.mode&0o022)throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED');
  return verifyAcceptance(JSON.parse(bytes.subarray(0,count).toString()),manager);
 }catch(error){if(/^PROJECT_RUNTIME_EGRESS_/.test(error.code||''))throw error;throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED');}
 finally{if(fd!==undefined)filesystem.closeSync(fd);}
}
module.exports={PROFILE,verifyAcceptance,readAcceptance};
