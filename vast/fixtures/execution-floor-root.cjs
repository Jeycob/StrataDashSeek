'use strict';
// Actual protected filesystem fixture; never imported by production.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {canonical}=require('../project-execution-mode.cjs');
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),E='11111111-2222-3333-4444-555555555555';
function rootFixture(t){
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
 const root=fs.mkdtempSync('/root/homeai-execution-floor-test-');
 t.after(()=>{assert.equal(fs.realpathSync(root),root);assert.equal(path.dirname(root),'/root');assert(path.basename(root).startsWith('homeai-execution-floor-test-'));fs.rmSync(root,{recursive:true,force:true});});
 const policyFile=path.join(root,'root-secrets/runtime/state/project-execution-policy.json');
 fs.mkdirSync(path.dirname(policyFile),{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,'runtime-status'),{mode:0o755});fs.mkdirSync(path.join(root,'workspaces'),{mode:0o700});
 const writePolicy=(mode='host-compat',patch={})=>{const value={version:1,contract:'project-execution-v1',mode,policyEpoch:E,activationSourceCommit:A,...patch};require('../runtime-paths.cjs').atomic(policyFile,canonical(value));return value;};
 function source(commit,protocol=1){const directory=path.join(root,'releases',commit);fs.mkdirSync(path.join(directory,'vast'),{recursive:true,mode:0o755});fs.writeFileSync(path.join(directory,'vast/release-compatibility.json'),fs.readFileSync(path.join(__dirname,'../release-compatibility.json')),{mode:0o644});fs.writeFileSync(path.join(directory,'source.txt'),commit,{mode:0o644});if(protocol!==0)fs.writeFileSync(path.join(directory,'vast/project-execution-compatibility.json'),canonical({version:1,contract:'project-execution-v1',sourceProtocol:protocol}),{mode:0o644});return directory;}
 const point=commit=>{const app=path.join(root,'app');try{fs.unlinkSync(app);}catch(error){if(error.code!=='ENOENT')throw error;}fs.symlinkSync(path.join(root,'releases',commit),app);};
 const attest=commit=>require('../runtime-release.cjs').attest(root,commit,{commitSignatureVerified:true,sourceDigest:require('../startup-update.cjs').releaseDigest(path.join(root,'releases',commit))});
 writePolicy();return{root,policyFile,writePolicy,source,point,attest};
}
module.exports={rootFixture,A,B,C,E};
