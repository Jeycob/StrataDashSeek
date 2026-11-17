'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const runtime=require('./runtime-paths.cjs');
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/;
const ABI={admission:1,bootstrap:2,checkpoint:2,notificationOutbox:1,deviceCredentials:2,deploymentData:1};
const fault=code=>Object.assign(Error(code),{code});
const executionFloor=root=>require('./project-execution-floor.cjs').createExecutionFloor({rootDirectory:path.resolve(root)}).capturePolicy();
function compatibility(directory){
 const file=path.join(directory,'vast/release-compatibility.json');runtime.trustedFile(file);if(fs.statSync(file).size>4096)throw fault('RUNTIME_RELEASE_COMPATIBILITY_UNKNOWN');
 const value=JSON.parse(fs.readFileSync(file,'utf8'));
 if(value.version!==1||value.securityEpoch!==2||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['abi','securityEpoch','version'])||JSON.stringify(Object.keys(value.abi||{}).sort())!==JSON.stringify(Object.keys(ABI).sort())||Object.entries(ABI).some(([key,n])=>value.abi[key]!==n))throw fault('RUNTIME_RELEASE_COMPATIBILITY_UNKNOWN');
 const canonical={version:1,securityEpoch:2,abi:ABI};return{securityEpoch:2,admissionProtocol:1,compatibilityId:crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};
}
function currentCommit(root){const actual=fs.realpathSync(path.join(root,'app')),commit=path.basename(actual);if(!SHA.test(commit)||actual!==path.join(path.resolve(root),'releases',commit))throw fault('RUNTIME_RELEASE_POINTER_UNTRUSTED');runtime.directoryTree(actual);return commit;}
function attest(root,commit,{commitSignatureVerified=false,sourceDigest}={}){
 if(commitSignatureVerified!==true||!SHA.test(commit||'')||!HASH.test(sourceDigest||''))throw fault('RUNTIME_RELEASE_SIGNATURE_REQUIRED');
 const floor=executionFloor(root);floor.assertReleaseAllowed(commit);
 const directory=path.join(path.resolve(root),'releases',commit),traits=compatibility(directory),digest=require('./startup-update.cjs').releaseDigest(directory);
 if(digest!==sourceDigest)throw fault('RUNTIME_RELEASE_BYTES_CHANGED');
 const record={version:1,commit,digest,...traits};floor.assertReleaseAllowed(commit);runtime.writePrivate(root,'release-'+commit+'.json',record);return{...record,signatureVerified:true,rootProtected:true};
}
function verifySync(root,commit){
 if(!SHA.test(commit||''))throw fault('RUNTIME_RELEASE_IDENTITY_INVALID');const floor=executionFloor(root);floor.assertReleaseAllowed(commit);const record=runtime.readPrivate(root,'release-'+commit+'.json'),directory=path.join(path.resolve(root),'releases',commit);
 if(!record||record.version!==1||record.commit!==commit||!HASH.test(record.digest||''))throw fault('RUNTIME_RELEASE_ATTESTATION_MISSING');
 const traits=compatibility(directory);if(Object.entries(traits).some(([key,value])=>record[key]!==value)||require('./startup-update.cjs').releaseDigest(directory)!==record.digest)throw fault('RUNTIME_RELEASE_BYTES_CHANGED');
 floor.assertReleaseAllowed(commit);return{commit,digest:record.digest,...traits,signatureVerified:true,rootProtected:true};
}
function verify(root,commit,{signal,timeoutMs=1200}={}){return new Promise((resolve,reject)=>{
 if(!SHA.test(commit||'')||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>1200)return reject(fault('RUNTIME_RELEASE_IDENTITY_INVALID'));
 let floor;try{floor=executionFloor(root);floor.assertReleaseAllowed(commit);}catch(error){return reject(error);}
 let child,done=false,bytes=0,out='';const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(child&&child.exitCode===null)child.kill('SIGKILL');error?reject(error):resolve(value);},abort=()=>finish(fault('RUNTIME_RELEASE_VERIFY_ABORTED')),timer=setTimeout(()=>finish(fault('RUNTIME_RELEASE_VERIFY_TIMEOUT')),timeoutMs);
 if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});
 child=cp.spawn(process.execPath,[__filename,'verify',path.resolve(root),commit],{stdio:runtime.withoutRootLease('pipe','ignore'),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},windowsHide:true});child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2048)return finish(fault('RUNTIME_RELEASE_PROOF_INVALID'));out+=chunk;});child.on('error',()=>finish(fault('RUNTIME_RELEASE_VERIFY_FAILED')));child.on('close',code=>{if(code!==0)return finish(fault('RUNTIME_RELEASE_VERIFY_FAILED'));try{const value=JSON.parse(out);if(value.commit!==commit||!HASH.test(value.digest||'')||value.signatureVerified!==true||value.rootProtected!==true||value.admissionProtocol!==1||!HASH.test(value.compatibilityId||'')||value.securityEpoch!==2)throw Error();floor.assertReleaseAllowed(commit);finish(null,value);}catch(error){finish(/^PROJECT_EXECUTION_/.test(error.code||'')?error:fault('RUNTIME_RELEASE_PROOF_INVALID'));}});
 });}
module.exports={ABI,compatibility,currentCommit,attest,verifySync,verify};
if(require.main===module){try{if(process.argv[2]!=='verify')throw fault('RUNTIME_RELEASE_OPERATION_INVALID');process.stdout.write(JSON.stringify(verifySync(process.argv[3],process.argv[4])));}catch{process.stderr.write('RUNTIME_RELEASE_VERIFY_FAILED\n');process.exitCode=1;}}
