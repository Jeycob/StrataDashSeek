'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const{Readable}=require('node:stream'),{encryptSnapshot}=require('./backup-envelope.cjs'),{receiveSnapshot}=require('./backup-pull.cjs');
const key=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),other=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'backup-pull-'));await fs.chmod(root,0o700);t.after(()=>fs.rm(root,{recursive:true,force:true}));const remote=path.join(root,'remote');await fs.mkdir(remote,{mode:0o700});const destination=path.join(remote,'cold.haenc'),receipt=await encryptSnapshot({source:Readable.from(['synthetic cold snapshot']),sourceComplete:Promise.resolve(),destination,recipientPublicKey:key.publicKey,maxBytes:1024,reserveBytes:0,assertFence:()=>({version:1,kind:'cold-start',sourceCommit:'a'.repeat(40),fenceWitnessHash:'b'.repeat(64)})});return{root,receipt,bytes:await fs.readFile(destination)};}
test('pull authenticates bytes before acknowledgement and safely retries an unacknowledged local copy',async t=>{
 const f=await fixture(t);let acknowledgements=0;const input={receipt:f.receipt,destinationParent:f.root,recipientPrivateKey:key.privateKey,source:Readable.from([f.bytes]),sourceComplete:Promise.resolve(),acknowledge:async()=>{acknowledgements++;throw Error('ack offline');}};
 await assert.rejects(receiveSnapshot(input),/ack offline/);assert.equal(acknowledgements,1);
 const copy=path.join(f.root,'cold-'+f.receipt.sha256+'.haenc');assert.deepEqual(await fs.readFile(copy),f.bytes);
 const retry=await receiveSnapshot({...input,source:null,sourceComplete:null,acknowledge:async()=>{acknowledgements++;}});assert.equal(retry.alreadyPresent,true);assert.equal(acknowledgements,2);assert.equal((await fs.readdir(f.root)).some(n=>n.includes('.partial-')),false);
});
test('wrong keys, corrupted or excessive bytes, failed producers and mismatched receipts never acknowledge or publish',async t=>{
 const f=await fixture(t);
 for(const mode of ['key','corrupt','short','long','producer','receipt']){
  const dir=path.join(f.root,mode);await fs.mkdir(dir,{mode:0o700});let ack=0,bytes=Buffer.from(f.bytes),receipt={...f.receipt};
  if(mode==='corrupt')bytes[bytes.length-1]^=1;if(mode==='short')bytes=bytes.subarray(0,-1);if(mode==='long')bytes=Buffer.concat([bytes,Buffer.from('extra')]);if(mode==='receipt')receipt.capture={...receipt.capture,sourceCommit:'c'.repeat(40)};
  const done=mode==='producer'?Promise.reject(Error('failed producer')):Promise.resolve();done.catch(()=>{});
  await assert.rejects(receiveSnapshot({receipt,source:Readable.from([bytes]),sourceComplete:done,destinationParent:dir,recipientPrivateKey:mode==='key'?other.privateKey:key.privateKey,acknowledge:async()=>{ack++;}}));
  assert.equal(ack,0,mode);assert.deepEqual(await fs.readdir(dir),[],mode);
 }
});
