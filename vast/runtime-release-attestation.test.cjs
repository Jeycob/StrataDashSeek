'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const release=require('./runtime-release.cjs');
test('the signed release ABI declares every persistent format needed for safe rollback',()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'release-compatibility.json')));assert.equal(manifest.version,1);assert.equal(manifest.securityEpoch,2);assert.deepEqual(manifest.abi,release.ABI);
});
if(process.env.HARNESS_RUNTIME_RELEASE_ROOT_TEST==='1'){
test('root attestation binds verified source bytes and ABI, and linked or changed records never authorize fallback',async t=>{
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const f=require('./fixtures/execution-floor-root.cjs').rootFixture(t),root=f.root,commit='a'.repeat(40),directory=f.source(commit,0);fs.writeFileSync(path.join(directory,'app.txt'),'trusted fixture',{mode:0o644});f.point(commit);
 const digest=require('./startup-update.cjs').releaseDigest(directory);assert.throws(()=>release.attest(root,commit,{sourceDigest:digest}),{code:'RUNTIME_RELEASE_SIGNATURE_REQUIRED'});const proof=release.attest(root,commit,{commitSignatureVerified:true,sourceDigest:digest});assert.equal(proof.securityEpoch,2);assert.equal(release.currentCommit(root),commit);assert.deepEqual(await release.verify(root,commit),release.verifySync(root,commit));
 const state=path.join(root,'root-secrets/runtime/state/release-'+commit+'.json');assert.equal(fs.statSync(state).mode&0o077,0);fs.linkSync(state,path.join(root,'linked'));assert.throws(()=>release.verifySync(root,commit),/Untrusted privileged file/);fs.unlinkSync(path.join(root,'linked'));
 fs.writeFileSync(path.join(directory,'app.txt'),'changed fixture');await assert.rejects(release.verify(root,commit),{code:'RUNTIME_RELEASE_VERIFY_FAILED'});fs.writeFileSync(path.join(directory,'app.txt'),'trusted fixture');const manifest=path.join(directory,'vast/release-compatibility.json'),value=JSON.parse(fs.readFileSync(manifest));value.abi.deviceCredentials=1;fs.writeFileSync(manifest,JSON.stringify(value));assert.throws(()=>release.verifySync(root,commit),{code:'RUNTIME_RELEASE_COMPATIBILITY_UNKNOWN'});
});
test('the actual Linux cold-start fence rejects an existing service-UID process without terminating it',async()=>{
 const {assertNoAgentProcesses,agentProcesses}=require('./runtime-launcher.cjs'),uid=60055;assertNoAgentProcesses(uid);const child=cp.spawn('setpriv',['--reuid='+uid,'--regid='+uid,'--clear-groups','--bounding-set=-all',process.execPath,'-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),exited=new Promise(resolve=>child.once('exit',resolve));
 try{const deadline=Date.now()+2000;while(!agentProcesses(uid).includes(child.pid)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert(agentProcesses(uid).includes(child.pid));assert.throws(()=>assertNoAgentProcesses(uid),{code:'RUNTIME_LAUNCH_USER_PROCESS_ACTIVE'});assert.equal(child.exitCode,null);}finally{child.kill('SIGTERM');await exited;}assertNoAgentProcesses(uid);
});
}
