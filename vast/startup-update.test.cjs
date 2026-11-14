'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {commitPayload,config,verifySignature,activate,restoreTransaction,sameRuntime,atomic}=require('./startup-update.cjs');
const fixture=require('./fixtures/startup-signature.json');
function temporary(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-update-test-'));t.after(()=>{if(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'harness-update-test-'))fs.rmSync(directory,{recursive:true,force:true});});return directory;}
test('real pinned GPG signature passes; modified commit content and unpinned signer fail',t=>{
 const directory=temporary(t);fs.mkdirSync(path.join(directory,'update-cache/home'),{recursive:true});
 const keyring=path.join(directory,'signers.gpg');fs.writeFileSync(keyring,Buffer.from(fixture.publicKeyBase64,'base64'));
 const input=Buffer.from(fixture.commit,'utf8');assert.equal(verifySignature(input,keyring,[fixture.fingerprint],directory),true);
 assert.throws(()=>verifySignature(Buffer.from(fixture.commit+'tamper'),keyring,[fixture.fingerprint],directory),/gpgv failed/);
 assert.throws(()=>verifySignature(input,keyring,['0'.repeat(40)],directory),/not pinned/);
});
test('unsigned or ambiguous signatures cannot become an update',()=>{
 assert.throws(()=>commitPayload(Buffer.from('tree x\n\nmessage\n')),/signature/);
 assert.throws(()=>commitPayload(Buffer.from('tree x\ngpgsig one\ngpgsig two\n\nmessage')),/Multiple/);
 assert.throws(()=>config({version:1,repository:'evil/repo',branch:'main',signers:[fixture.fingerprint]}),/source/);
 assert.throws(()=>config({version:1,repository:'Jeycob/StrataDashSeek',branch:'main',signers:['short']}),/fingerprints/);
 for(const reserve of['invalid',NaN,Infinity,-1,1.5])assert.throws(()=>config({version:1,repository:'Jeycob/StrataDashSeek',branch:'main',signers:[fixture.fingerprint],minimumFreeBytes:reserve}),/finite nonnegative/);
});
test('bootstrap code is written as exact bytes rather than serialized Buffer data',t=>{
 const root=temporary(t),target=path.join(root,'bootstrap.cjs'),bytes=Buffer.from('#!/usr/bin/env node\nconsole.log("ready");\n');atomic(target,bytes);assert.deepEqual(fs.readFileSync(target),bytes);
});
test('dependency upgrades are detected before activation',t=>{
 const root=temporary(t),candidate=path.join(root,'candidate');for(const dir of[root,candidate]){fs.mkdirSync(path.join(dir,'runtime'),{recursive:true});for(const name of['package.json','package-lock.json'])fs.writeFileSync(path.join(dir,'runtime',name),'{}\n');}
 assert.equal(sameRuntime(candidate,root),true);fs.writeFileSync(path.join(candidate,'runtime/package-lock.json'),'{"changed":true}\n');assert.equal(sameRuntime(candidate,root),false);
});
