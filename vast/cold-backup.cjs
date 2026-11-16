'use strict';
// Optional root-owned cold-start capture. No live maintenance endpoint exists.
// Native, editor, tools and the guest must remain absent under the FD9 lease.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const runtime=require('./runtime-paths.cjs'),release=require('./runtime-release.cjs');
const fail=code=>Object.assign(Error(code),{code});
const outbox=root=>path.join(runtime.control(root).control,'backup-outbox');
function validReceipt(r){return r?.version===2&&r.encrypted===true&&r.algorithm==='RSA-OAEP-SHA256+AES-256-GCM'&&/^[a-f0-9]{64}$/.test(r.sha256||'')&&/^[a-f0-9]{64}$/.test(r.recipient||'')&&typeof r.createdAt==='string'&&Number.isFinite(Date.parse(r.createdAt))&&r.capture?.version===1&&r.capture.kind==='cold-start'&&/^[a-f0-9]{40}$/.test(r.capture.sourceCommit||'')&&/^[a-f0-9]{64}$/.test(r.capture.fenceWitnessHash||'')&&Number.isSafeInteger(r.archiveBytes)&&r.archiveBytes>0&&r.archiveBytes<=256*1024**2&&Number.isSafeInteger(r.bytes)&&r.bytes>r.archiveBytes&&r.bytes<=r.archiveBytes+8192;}
function pendingSnapshot(root){
 const pending=runtime.readPrivate(root,'backup-pending.json');if(!pending)return null;
 if(pending.version!==1||typeof pending.file!=='string'||path.dirname(pending.file)!==outbox(root)||!/^cold-[0-9]+-[a-f0-9]{16}\.haenc$/.test(path.basename(pending.file))||!validReceipt(pending.receipt))throw fail('BACKUP_RECEIPT_INVALID');
 const stat=runtime.trustedFile(pending.file);if(stat.size!==pending.receipt.bytes)throw fail('BACKUP_RECEIPT_MISMATCH');return pending;
}
function acknowledge(root,{file,sha256}){
 const pending=pendingSnapshot(root);if(!pending||pending.file!==file||pending.receipt.sha256!==sha256)throw fail('BACKUP_ACK_MISMATCH');
 // Persist acknowledgement before unlink: a crash leaves a harmless retained
 // ciphertext, never a false claim that an untransferred snapshot was pulled.
 runtime.writePrivate(root,'backup-transferred.json',{version:1,at:Date.now(),file,receipt:pending.receipt});
 runtime.writePrivate(root,'backup-pending.json',null);fs.unlinkSync(file);
 runtime.writePrivate(root,'backup-status.json',{version:1,status:'transferred',at:Date.now(),capturedAt:pending.receipt.createdAt,bytes:pending.receipt.bytes,sourceCommit:pending.receipt.capture.sourceCommit});
 return{version:1,status:'transferred'};
}
async function captureWithFence({root,uid,broker,assertNoAgentProcesses,inheritedLease,readLease=()=>fs.fstatSync(9),sourceCommit,capture}){
 let epoch,held;try{await broker.closeAdmission();inheritedLease(root);assertNoAgentProcesses(uid);epoch=broker.state.epoch;held=readLease();}catch(error){throw Object.assign(fail('BACKUP_FENCE_CHANGED'),{cause:error});}
 const fenceWitnessHash=crypto.createHash('sha256').update(JSON.stringify({epoch,sourceCommit,dev:held.dev,ino:held.ino})).digest('hex');
 const assertFence=()=>{try{const current=readLease();if(broker.state.open!==false||broker.state.epoch!==epoch||current.dev!==held.dev||current.ino!==held.ino)throw fail('BACKUP_FENCE_CHANGED');inheritedLease(root);assertNoAgentProcesses(uid);return{version:1,kind:'cold-start',sourceCommit,fenceWitnessHash};}catch(error){throw Object.assign(fail('BACKUP_FENCE_CHANGED'),{cause:error});}};
 assertFence();const result=await capture(assertFence);assertFence();return result;
}
function stopProducer(child){return new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
async function captureBeforeNativeStart({root,uid,broker,assertNoAgentProcesses,inheritedLease}){
 const cfg=runtime.readPrivate(root,'backup-config.json');if(!cfg||cfg.enabled===false)return{status:'not-configured'};
 if(cfg.version!==1||cfg.enabled!==true||!Number.isSafeInteger(cfg.maxBytes)||cfg.maxBytes<1024**2||cfg.maxBytes>256*1024**2||!Number.isSafeInteger(cfg.timeoutMs)||cfg.timeoutMs<1000||cfg.timeoutMs>300000)throw fail('BACKUP_CONFIGURATION_INVALID');
 const control=runtime.control(root),keyFile=path.join(control.privateState,'backup-recipient.pem');runtime.trustedFile(keyFile);
 const sourceCommit=release.currentCommit(root),releaseRoot=path.join(root,'releases',sourceCommit);release.verifySync(root,sourceCommit);
 const primitive=path.join(releaseRoot,'development/backup-envelope.cjs'),producer=path.join(releaseRoot,'development/backup-capture.py');runtime.trustedFile(primitive);runtime.trustedFile(producer);
 const pending=pendingSnapshot(root);
 if(pending){
  runtime.writePrivate(root,'backup-status.json',{version:1,status:'deferred',reason:'UNACKNOWLEDGED_SNAPSHOT_RETAINED',at:Date.now(),capturedAt:pending.receipt.createdAt});return{status:'deferred'};
 }
 const execute=()=>captureWithFence({root,uid,broker,assertNoAgentProcesses,inheritedLease,sourceCommit,async capture(assertFence){
  const directory=outbox(root);runtime.ensureDirectory(directory);
  // An interrupted/unacknowledged file is preserved for operator reconciliation.
  // Never silently accumulate another archive or delete older data to make room.
  if(fs.readdirSync(directory).length)throw fail('BACKUP_OUTBOX_RECONCILIATION_REQUIRED');
  const file=path.join(directory,'cold-'+Date.now()+'-'+crypto.randomBytes(8).toString('hex')+'.haenc');
  const child=cp.spawn('/usr/bin/python3',[producer,'--root',root],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',PYTHONDONTWRITEBYTECODE:'1'},stdio:runtime.withoutRootLease('pipe','pipe')});
  let stderrBytes=0;child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>4096)child.kill('SIGTERM');});
  const sourceComplete=new Promise((resolve,reject)=>{child.once('error',()=>reject(fail('BACKUP_SOURCE_UNAVAILABLE')));child.once('close',code=>code===0?resolve():reject(fail('BACKUP_SOURCE_INCOMPLETE')));});sourceComplete.catch(()=>{});
  try{
   const receipt=await require(primitive).encryptSnapshot({source:child.stdout,sourceComplete,destination:file,recipientPublicKey:fs.readFileSync(keyFile),assertFence,maxBytes:cfg.maxBytes,reserveBytes:2*1024**3,timeoutMs:cfg.timeoutMs});
   assertFence();runtime.writePrivate(root,'backup-pending.json',{version:1,file,receipt});runtime.writePrivate(root,'backup-status.json',{version:1,status:'captured-awaiting-transfer',at:Date.now(),capturedAt:receipt.createdAt,bytes:receipt.bytes,sourceCommit});return{status:'captured-awaiting-transfer'};
  }finally{await stopProducer(child);}
 }});
 return await execute();
}
async function withFailureStatus(operation,writeStatus){
 try{return await operation();}catch(error){
  const code=/^(?:BACKUP|RUNTIME)_[A-Z_]+$/.test(error.code||'')?error.code:'BACKUP_CAPTURE_FAILED';
  writeStatus({version:1,status:'failed',at:Date.now(),code});
  // Backup availability does not make Native unavailable. A broken writer
  // exclusion invariant still blocks startup; it is not a recoverable backup error.
  if(code==='BACKUP_FENCE_CHANGED'||code.startsWith('RUNTIME_'))throw error;
  return{status:'failed',code};
 }
}
async function beforeNativeStart(args){return withFailureStatus(()=>captureBeforeNativeStart(args),value=>runtime.writePrivate(args.root,'backup-status.json',value));}
module.exports={captureWithFence,beforeNativeStart,pendingSnapshot,acknowledge,withFailureStatus,validReceipt};
