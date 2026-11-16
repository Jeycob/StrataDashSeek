'use strict';
// Synthetic filesystem/evidence fixture only. This never publishes an operator
// acceptance artifact and is never used by a production VM or controller.
const path=require('node:path'),assert=require('node:assert/strict');
function enableEgressFixture(f){
 const cfg=f.m.cfg.projectRuntime,proof=f.m.worker.status().projectRuntimeIsolation,root=path.resolve('/synthetic-toolchain'),file=path.resolve('/synthetic-operator/egress.json'),digest='f'.repeat(64);
 cfg.toolchain={root,manifestSha256:digest};cfg.images.egress=cfg.images.executor;cfg.egress={enabled:true,acceptanceFile:file};
 proof.toolchain={version:1,verified:true,bootPid:123,root,guestRoot:'/srv/homeai/toolchain',manifestSha256:digest,hostDev:10,hostIno:7,readOnly:true};proof.kernelSha256='d'.repeat(64);proof.runtimeSourceCommit='e'.repeat(40);
 const acceptance={version:1,profile:'public-https-unix-v1',observedAt:1,evidenceSha256:'a'.repeat(64),kernelSha256:proof.kernelSha256,runtimeSourceCommit:proof.runtimeSourceCommit,toolchainManifestSha256:digest,executorImage:cfg.images.executor,proxyImage:cfg.images.egress,checks:{networkNone:true,publicTls443:true,privateTargetsDenied:true,ownedStop:true,resourceLimits:true}};
 const info={dev:10,ino:8,uid:0,gid:0,nlink:1,mode:0o444,isFile:()=>true,isSymbolicLink:()=>false},bytes=()=>Buffer.from(JSON.stringify(acceptance));
 const realpath=f.filesystem.realpathSync,lstat=f.filesystem.lstatSync;
 f.filesystem.realpathSync=p=>[root,file].includes(p)?p:realpath(p);
 f.filesystem.lstatSync=p=>p===root?{dev:10,ino:7,uid:0,gid:0,mode:0o555,isDirectory:()=>true,isSymbolicLink:()=>false}:p===file?{...info,size:bytes().length}:lstat(p);
 f.filesystem.openSync=p=>{assert.equal(p,file);return 99;};f.filesystem.fstatSync=fd=>{assert.equal(fd,99);return{...info,size:bytes().length};};
 f.filesystem.readSync=(fd,buffer,offset,length)=>{assert.equal(fd,99);return bytes().copy(buffer,offset,0,length);};f.filesystem.closeSync=fd=>assert.equal(fd,99);
 f.m.worker.prepareProjectEgress=async input=>({version:1,profile:'public-https-unix-v1',...input});f.m.worker.projectEgressHealth=async()=>true;
 return{acceptance,info,root,file};
}
module.exports={enableEgressFixture};
