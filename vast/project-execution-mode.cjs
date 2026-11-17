'use strict';
// Standalone contract only: importing this module performs no I/O. Production
// paths and authority are fixed; dependencies are for trusted synthetic tests.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='/data/harness',CONTRACT='project-execution-v1',MAX_BYTES=4096;
const POLICY_FILE=ROOT+'/root-secrets/runtime/state/project-execution-policy.json';
const PUBLIC_FILE=ROOT+'/runtime-status/project-execution.json';
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POLICY_KEYS=['version','contract','mode','policyEpoch','activationSourceCommit'];
const PUBLIC_KEYS=[...POLICY_KEYS,'policySha256','sourceCommit','launchId'];
const fail=code=>Object.assign(Error(code),{code});
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function canonical(value){
 if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value);
}
const hash=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
function policyFields(value){return Object.fromEntries(POLICY_KEYS.map(key=>[key,value[key]]));}
function validatePolicy(value){
 if(!exact(value,POLICY_KEYS)||value.version!==1||value.contract!==CONTRACT||!['host-compat','isolated-guest'].includes(value.mode)||!matches(UUID,value.policyEpoch)||!matches(SHA,value.activationSourceCommit))throw fail('PROJECT_EXECUTION_POLICY_INVALID');
 return Object.freeze(policyFields(value));
}
function validateProjection(value){
 if(!exact(value,PUBLIC_KEYS))throw fail('PROJECT_EXECUTION_PROJECTION_INVALID');
 let policy;try{policy=validatePolicy(policyFields(value));}catch{throw fail('PROJECT_EXECUTION_PROJECTION_INVALID');}
 if(!matches(HASH,value.policySha256)||value.policySha256!==hash(policy)||!matches(SHA,value.sourceCommit)||!matches(UUID,value.launchId))throw fail('PROJECT_EXECUTION_PROJECTION_INVALID');
 return Object.freeze({...policy,policySha256:value.policySha256,sourceCommit:value.sourceCommit,launchId:value.launchId});
}

function createExecutionModeContract({filesystem=fs,atomic,verifySource,platform=process.platform,getuid=()=>process.getuid?.(),newLaunchId=()=>crypto.randomUUID(),rootDirectory=ROOT}={}){
 // Trusted factory composition only. No environment, policy, browser or
 // per-operation argument can redirect these protected paths.
 if(typeof rootDirectory!=='string'||!path.posix.isAbsolute(rootDirectory)||path.posix.normalize(rootDirectory)!==rootDirectory||rootDirectory.endsWith('/')||rootDirectory.includes('\0'))throw fail('PROJECT_EXECUTION_ROOT_INVALID');
 const policyFile=rootDirectory+'/root-secrets/runtime/state/project-execution-policy.json',publicFile=rootDirectory+'/runtime-status/project-execution.json';
 const publish=atomic??((file,bytes)=>require('./runtime-paths.cjs').atomic(file,bytes,0o644));
 const sourceProof=verifySource??(sourceCommit=>{
  const release=require('./runtime-release.cjs');
  if(release.currentCommit(rootDirectory)!==sourceCommit)throw fail('PROJECT_EXECUTION_SOURCE_CHANGED');
  release.verifySync(rootDirectory,sourceCommit);
 });
 function linux(){if(platform!=='linux')throw fail('PROJECT_EXECUTION_LINUX_REQUIRED');}
 function root(){linux();if(getuid()!==0)throw fail('PROJECT_EXECUTION_ROOT_REQUIRED');}
 function parents(file){
  const rows=[];let current='/';
  for(const part of ['',...path.posix.dirname(file).slice(1).split('/')]){
   if(part)current=path.posix.join(current,part);
   const stat=filesystem.lstatSync(current);
   if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||stat.mode&0o022||filesystem.realpathSync(current)!==current)throw fail('PROJECT_EXECUTION_FILE_UNSAFE');
   rows.push([current,stat.dev,stat.ino]);
  }
  return rows;
 }
 const safe=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===0&&stat.nlink===1&&!(stat.mode&0o022)&&Number.isSafeInteger(stat.size)&&stat.size>0&&stat.size<=MAX_BYTES;
 const identity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 const stable=(a,b)=>identity(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
 function read(file,missingCode){
  linux();let fd;
  try{
   const ancestors=parents(file),before=filesystem.lstatSync(file);
   if(!safe(before)||filesystem.realpathSync(file)!==file)throw fail('PROJECT_EXECUTION_FILE_UNSAFE');
   fd=filesystem.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   const opened=filesystem.fstatSync(fd);if(!safe(opened)||!stable(before,opened))throw fail('PROJECT_EXECUTION_FILE_CHANGED');
   // Read no more than the bounded observed length plus one byte, including
   // when an external writer grows the file after open.
   const buffer=Buffer.alloc(opened.size+1);let used=0;
   while(used<buffer.length){const count=filesystem.readSync(fd,buffer,used,buffer.length-used,used);if(!count)break;used+=count;}
   const after=filesystem.fstatSync(fd),named=filesystem.lstatSync(file);
   if(used!==opened.size||!safe(after)||!safe(named)||!stable(opened,after)||!stable(after,named)||canonical(parents(file))!==canonical(ancestors))throw fail('PROJECT_EXECUTION_FILE_CHANGED');
   let value;const bytes=buffer.subarray(0,used);
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!bytes.equals(Buffer.from(canonical(value))))throw Error('noncanonical');}catch{throw fail('PROJECT_EXECUTION_FILE_INVALID');}
   return value;
  }catch(error){
   if(error.code==='ENOENT')throw fail(missingCode);
   if(/^PROJECT_EXECUTION_/.test(error.code||''))throw error;
   throw fail('PROJECT_EXECUTION_FILE_UNAVAILABLE');
  }finally{if(fd!==undefined)filesystem.closeSync(fd);}
 }
 function readPolicy(){root();return validatePolicy(read(policyFile,'PROJECT_EXECUTION_POLICY_REQUIRED'));}
 function readProjection(){return validateProjection(read(publicFile,'PROJECT_EXECUTION_PUBLICATION_REQUIRED'));}
 function publishForSupervisor(input){
  root();if(!exact(input,['sourceCommit'])||!matches(SHA,input.sourceCommit))throw fail('PROJECT_EXECUTION_SOURCE_INVALID');
  const sourceCommit=input.sourceCommit;sourceProof(sourceCommit);
  const policy=readPolicy(),policySha256=hash(policy),launchId=newLaunchId();
  const projection=validateProjection({...policy,policySha256,sourceCommit,launchId});
  if(hash(readPolicy())!==policySha256)throw fail('PROJECT_EXECUTION_POLICY_CHANGED');
  // No persistent policy writer or default is provided. Only the public
  // projection is regenerated, after the existing signed/root startup gate.
  publish(publicFile,canonical(projection));
  if(hash(readPolicy())!==policySha256)throw fail('PROJECT_EXECUTION_POLICY_CHANGED');
  sourceProof(sourceCommit);
  if(canonical(readProjection())!==canonical(projection))throw fail('PROJECT_EXECUTION_PUBLICATION_CHANGED');
  return projection;
 }
 function bindForService(input){
  if(!exact(input,['sourceCommit','launchId'])||!matches(SHA,input.sourceCommit)||!matches(UUID,input.launchId))throw fail('PROJECT_EXECUTION_BINDING_INVALID');
  const snapshot=readProjection();
  if(snapshot.sourceCommit!==input.sourceCommit||snapshot.launchId!==input.launchId)throw fail('PROJECT_EXECUTION_BINDING_CHANGED');
  const expected=canonical(snapshot);
  return Object.freeze({snapshot,assertUnchanged(){
   const current=readProjection();
   if(canonical(current)!==expected)throw fail('PROJECT_EXECUTION_BINDING_CHANGED');
   return snapshot;
  }});
 }
 return Object.freeze({readPolicy,publishForSupervisor,bindForService});
}
module.exports={CONTRACT,POLICY_FILE,PUBLIC_FILE,MAX_BYTES,canonical,validatePolicy,validateProjection,createExecutionModeContract};
