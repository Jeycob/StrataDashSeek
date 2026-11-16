'use strict';
// Local operator client. It never sends a private backup key to the runtime.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
const {verifySnapshot}=require('./backup-envelope.cjs'),{validReceipt}=require('../vast/cold-backup.cjs');
const fail=code=>Object.assign(Error(code),{code});
async function syncLocal(file,parent){const handle=await fsp.open(file,'r+');try{await handle.sync();}finally{await handle.close();}if(process.platform!=='win32'){const directory=await fsp.open(parent,'r');try{await directory.sync();}finally{await directory.close();}}}
async function verifyLocal(file,receipt,key){
 const stat=await fsp.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==receipt.bytes)throw fail('BACKUP_LOCAL_FILE_INVALID');
 const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);if(hash.digest('hex')!==receipt.sha256)throw fail('BACKUP_TRANSFER_HASH_MISMATCH');
 const verified=await verifySnapshot({file,recipientPrivateKey:key,maxBytes:256*1024**2});
 if(verified.recipient!==receipt.recipient||JSON.stringify(verified.capture)!==JSON.stringify(receipt.capture)||verified.archiveBytes!==receipt.archiveBytes)throw fail('BACKUP_TRANSFER_RECEIPT_MISMATCH');return verified;
}
async function receiveSnapshot({receipt,source,sourceComplete,destinationParent,recipientPrivateKey,acknowledge}){
 if(!validReceipt(receipt)||typeof acknowledge!=='function')throw fail('BACKUP_TRANSFER_RECEIPT_INVALID');
 const parent=path.resolve(destinationParent),stat=await fsp.lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||await fsp.realpath(parent)!==parent||process.platform!=='win32'&&(stat.uid!==process.getuid()||stat.mode&0o077))throw fail('BACKUP_LOCAL_DIRECTORY_UNSAFE');
 const destination=path.join(parent,'cold-'+receipt.sha256+'.haenc');
 try{await fsp.lstat(destination);await verifyLocal(destination,receipt,recipientPrivateKey);await syncLocal(destination,parent);await acknowledge();return{status:'transferred',file:destination,alreadyPresent:true,capturedAt:receipt.createdAt};}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!source||!sourceComplete?.then)throw fail('BACKUP_TRANSFER_SOURCE_REQUIRED');sourceComplete.catch(()=>{});
 const capacity=await fsp.statfs(parent);if(capacity.bavail*capacity.bsize<receipt.bytes+256*1024**2)throw fail('BACKUP_LOCAL_CAPACITY');
 const temporary=destination+'.partial-'+crypto.randomBytes(8).toString('hex');let owned=false,published=false;
 try{
  const fd=fs.openSync(temporary,'wx',0o600);owned=true;let bytes=0;
  const limit=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>receipt.bytes?fail('BACKUP_TRANSFER_SIZE_LIMIT'):null,chunk);}});
  await pipeline(source,limit,fs.createWriteStream(null,{fd,autoClose:true}));await sourceComplete;
  if(bytes!==receipt.bytes)throw fail('BACKUP_TRANSFER_INCOMPLETE');
  const handle=await fsp.open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
  await verifyLocal(temporary,receipt,recipientPrivateKey);
  await fsp.link(temporary,destination);published=true;await fsp.unlink(temporary);
  await syncLocal(destination,parent);
  await acknowledge();return{status:'transferred',file:destination,alreadyPresent:false,capturedAt:receipt.createdAt};
 }finally{if(owned&&!published)await fsp.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
function ssh(config,script,{binary=false}={}){
 if(!/^[a-zA-Z0-9.-]+$/.test(config.host||'')||!Number.isInteger(config.port)||config.port<1||config.port>65535||!path.isAbsolute(config.identityFile||'')||!path.isAbsolute(config.knownHostsFile||''))throw fail('BACKUP_SSH_CONFIGURATION_INVALID');
 const child=cp.spawn('ssh',['-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+config.knownHostsFile,'-o','ConnectTimeout=10','-i',config.identityFile,'-p',String(config.port),'root@'+config.host,'/data/harness/node/bin/node'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let count=0;child.stderr.on('data',data=>{count+=data.length;if(count>16384)child.kill();});
 const timer=setTimeout(()=>child.kill(),300000);timer.unref();
 const done=new Promise((resolve,reject)=>{child.once('error',()=>reject(fail('BACKUP_SSH_FAILED')));child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(fail('BACKUP_SSH_FAILED'));});});done.catch(()=>{});child.stdin.on('error',()=>{});child.stdin.end(script);
 return{source:child.stdout,sourceComplete:done,stop(){child.kill();}};
}
async function jsonRemote(config,script){const job=ssh(config,script);try{let raw='';for await(const chunk of job.source){raw+=chunk;if(raw.length>16384)throw fail('BACKUP_REMOTE_RESPONSE_LIMIT');}await job.sourceComplete;return JSON.parse(raw);}finally{job.stop();}}
const prelude="'use strict';const fs=require('node:fs'),b=require('/data/harness/bootstrap/cold-backup.cjs');const root='/data/harness';";
async function pull(config){
 if(config.version!==1||!path.isAbsolute(config.privateKeyFile||'')||!path.isAbsolute(config.destinationParent||''))throw fail('BACKUP_LOCAL_CONFIGURATION_INVALID');
 const pending=await jsonRemote(config,prelude+"console.log(JSON.stringify({pending:b.pendingSnapshot(root),status:require('/data/harness/bootstrap/runtime-paths.cjs').readPrivate(root,'backup-status.json')}));");
 if(!pending.pending)return{status:'no-pending-snapshot',captureStatus:pending.status};
 const {file,receipt}=pending.pending;if(!validReceipt(receipt)||!/^\/data\/harness\/root-secrets\/runtime\/backup-outbox\/cold-[0-9]+-[a-f0-9]{16}\.haenc$/.test(file))throw fail('BACKUP_REMOTE_RECEIPT_INVALID');
 const encoded=JSON.stringify({file,sha256:receipt.sha256}),job=ssh(config,prelude+'const expected='+encoded+";const p=b.pendingSnapshot(root);if(!p||p.file!==expected.file||p.receipt.sha256!==expected.sha256)throw Error('BACKUP_CHANGED');const fd=fs.openSync(p.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);fs.createReadStream(null,{fd,autoClose:true}).pipe(process.stdout);");
 try{return await receiveSnapshot({receipt,...job,destinationParent:config.destinationParent,recipientPrivateKey:fs.readFileSync(config.privateKeyFile),acknowledge:()=>jsonRemote(config,prelude+'console.log(JSON.stringify(b.acknowledge(root,'+encoded+')));')});}finally{job.stop();}
}
module.exports={receiveSnapshot,verifyLocal,pull};
if(require.main===module)Promise.resolve().then(()=>pull(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))).then(result=>console.log(JSON.stringify(result)),error=>{console.error(error.code||'BACKUP_PULL_FAILED');process.exitCode=1;});
