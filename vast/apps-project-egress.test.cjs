'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{verifyAcceptance}=require('./apps-project-egress.cjs');
function fixture(){
 const digest='a'.repeat(64),image='sha256:'+digest,proof={verified:true,bootPid:123,kernelSha256:digest,runtimeSourceCommit:'b'.repeat(40),toolchain:{verified:true,bootPid:123,manifestSha256:digest,readOnly:true}},manager={cfg:{projectRuntime:{toolchain:{manifestSha256:digest},images:{executor:image,egress:image}}},worker:{pid:()=>123,status:()=>({projectRuntimeIsolation:proof})}};
 const value={version:1,profile:'public-https-unix-v1',observedAt:1,evidenceSha256:digest,kernelSha256:digest,runtimeSourceCommit:'b'.repeat(40),toolchainManifestSha256:digest,executorImage:image,proxyImage:image,checks:{networkNone:true,publicTls443:true,privateTargetsDenied:true,ownedStop:true,resourceLimits:true}};return{manager,value,proof};
}
test('egress acceptance binds every immutable artifact and current kernel/release/VM identity',()=>{
 const f=fixture();assert.equal(verifyAcceptance(f.value,f.manager).profile,'public-https-unix-v1');
 for(const change of [x=>x.proof.bootPid++,x=>x.proof.kernelSha256=null,x=>x.proof.runtimeSourceCommit='c'.repeat(40),x=>x.proof.toolchain.manifestSha256='d'.repeat(64),x=>x.manager.cfg.projectRuntime.images.egress='sha256:'+'e'.repeat(64),x=>x.proof.toolchain.readOnly=false]){const x=fixture();change(x);assert.throws(()=>verifyAcceptance(x.value,x.manager),{code:'PROJECT_RUNTIME_EGRESS_ACCEPTANCE_CHANGED'});}
});
test('operator booleans, absent actual-check attestations and future evidence do not authorize egress',()=>{
 for(const change of [x=>delete x.value.evidenceSha256,x=>x.value.enabled=true,x=>x.value.profile='public-network',x=>x.value.observedAt=Date.now()+60000,x=>x.value.checks.publicTls443=false,x=>delete x.value.checks.privateTargetsDenied]){const x=fixture();change(x);assert.throws(()=>verifyAcceptance(x.value,x.manager),{code:'PROJECT_RUNTIME_EGRESS_ACCEPTANCE_REQUIRED'});}
});
