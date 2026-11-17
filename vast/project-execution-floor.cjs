'use strict';
// Standalone stable-bootstrap helper. No I/O at import or construction, no
// policy writer, and no source signature/attestation substitute.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {CONTRACT,canonical,createExecutionModeContract}=require('./project-execution-mode.cjs');
const RELEASES='/data/harness/releases',DESCRIPTOR='vast/project-execution-compatibility.json',MAX_DESCRIPTOR_BYTES=4096;
const SHA=/^[a-f0-9]{40}$/;
const fail=code=>Object.assign(Error(code),{code});
const hash=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const exact=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3&&['version','contract','sourceProtocol'].every(key=>Object.hasOwn(value,key));

function createExecutionFloor({filesystem=fs,platform=process.platform,getuid=()=>process.getuid?.(),rootDirectory='/data/harness'}={}){
 // The same protected reader, schema and canonical policy bytes used by the
 // supervisor contract own policy validation here. Test dependencies are
 // factory-only; no call accepts a replacement policy or an opt-out boolean.
 const policy=createExecutionModeContract({filesystem,platform,getuid,rootDirectory}),releases=path.posix.join(rootDirectory,'releases');
 function parents(file){
  const rows=[];let current='/';
  for(const part of ['',...path.posix.dirname(file).slice(1).split('/')]){
   if(part)current=path.posix.join(current,part);
   const stat=filesystem.lstatSync(current);
   if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||stat.mode&0o022||filesystem.realpathSync(current)!==current)throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNSAFE');
   rows.push([current,stat.dev,stat.ino]);
  }
  return rows;
 }
 const safe=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===0&&stat.nlink===1&&!(stat.mode&0o022)&&Number.isSafeInteger(stat.size)&&stat.size>0&&stat.size<=MAX_DESCRIPTOR_BYTES;
 const stable=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
 function descriptor(directory){
  const file=path.posix.join(directory,DESCRIPTOR);let fd;
  try{
   const ancestors=parents(file);let before;
   try{before=filesystem.lstatSync(file);}catch(error){
    if(error.code!=='ENOENT')throw error;
    // Only this absent file is legacy. Missing/unsafe parent directories, a
    // newly appeared file, and a replaced ancestor are not protocol zero.
    if(canonical(parents(file))!==canonical(ancestors))throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED');
    try{filesystem.lstatSync(file);}catch(again){
     if(again.code!=='ENOENT')throw again;
     if(canonical(parents(file))!==canonical(ancestors))throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED');
     return 0;
    }
    throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED');
   }
   if(!safe(before)||filesystem.realpathSync(file)!==file)throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNSAFE');
   fd=filesystem.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   const opened=filesystem.fstatSync(fd);if(!safe(opened)||!stable(before,opened))throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED');
   const buffer=Buffer.alloc(opened.size+1);let used=0;
   while(used<buffer.length){const count=filesystem.readSync(fd,buffer,used,buffer.length-used,used);if(!count)break;used+=count;}
   const after=filesystem.fstatSync(fd),named=filesystem.lstatSync(file);
   if(used!==opened.size||!safe(after)||!safe(named)||!stable(opened,after)||!stable(after,named)||canonical(parents(file))!==canonical(ancestors))throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED');
   let value;const bytes=buffer.subarray(0,used);
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!bytes.equals(Buffer.from(canonical(value))))throw Error('noncanonical');}catch{throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_INVALID');}
   if(!exact(value)||value.version!==1||value.contract!==CONTRACT||value.sourceProtocol!==1)throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_INVALID');
   return 1;
  }catch(error){
   if(/^PROJECT_EXECUTION_FLOOR_/.test(error.code||''))throw error;
   throw fail('PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNAVAILABLE');
  }finally{if(fd!==undefined)filesystem.closeSync(fd);}
 }
 function capturePolicy(){
  const snapshot=policy.readPolicy(),policySha256=hash(snapshot);
  function assertPolicyUnchanged(){
   if(hash(policy.readPolicy())!==policySha256)throw fail('PROJECT_EXECUTION_FLOOR_POLICY_CHANGED');
   return snapshot;
  }
  function assertDirectoryAllowed(directory){
   if(typeof directory!=='string'||path.posix.dirname(directory)!==releases||path.posix.normalize(directory)!==directory)throw fail('PROJECT_EXECUTION_FLOOR_DIRECTORY_INVALID');
   if(snapshot.mode==='isolated-guest'&&!SHA.test(path.posix.basename(directory)))throw fail('PROJECT_EXECUTION_FLOOR_RELEASE_ID_INVALID');
   assertPolicyUnchanged();const sourceProtocol=descriptor(directory);assertPolicyUnchanged();
   if(snapshot.mode==='isolated-guest'&&sourceProtocol!==1)throw fail('PROJECT_EXECUTION_FLOOR_PROTOCOL_REQUIRED');
   return Object.freeze({directory,sourceProtocol});
  }
  return Object.freeze({snapshot,policySha256,assertPolicyUnchanged,assertDirectoryAllowed,assertLegacyAppAllowed(){
   assertPolicyUnchanged();if(snapshot.mode!=='host-compat')throw fail('PROJECT_EXECUTION_FLOOR_PROTOCOL_REQUIRED');
   const directory=path.posix.join(rootDirectory,'app'),sourceProtocol=descriptor(directory);assertPolicyUnchanged();return Object.freeze({directory,sourceProtocol});
  },assertReleaseAllowed(sourceCommit){
   if(typeof sourceCommit!=='string'||!SHA.test(sourceCommit))throw fail('PROJECT_EXECUTION_FLOOR_RELEASE_ID_INVALID');
   const {sourceProtocol}=assertDirectoryAllowed(path.posix.join(releases,sourceCommit));
   // A separate capability result: never merge this into the persisted
   // release proof, recovery policyHash or securityEpoch/ABI identity.
   return Object.freeze({sourceCommit,sourceProtocol});
  }});
 }
 return Object.freeze({capturePolicy});
}
module.exports={RELEASES,DESCRIPTOR,MAX_DESCRIPTOR_BYTES,createExecutionFloor};
