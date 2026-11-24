import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,EPOCH=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const operations=new Set(['start_turn','model_step','session_create','file_mutation','tool_dispatch','apps_enqueue','socket_enqueue']);
const fail=(code,reasonCode)=>Object.assign(Error(code),{code,...(reasonCode?{reasonCode}:{})});
const requiredLocation=process.platform==='linux'&&/^\/data\/harness\/(?:releases\/[a-f0-9]{40}|app)\/workspace\//.test(fileURLToPath(import.meta.url));
const fingerprint=key=>crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');

// The server signs these exact UTF-8 bytes, in this order; no arbitrary JSON
// serialization or caller-selected fields may enter the signature envelope.
export function admissionPayload(value){return Buffer.from(JSON.stringify({version:value.version,sourceCommit:value.sourceCommit,epoch:value.epoch,challenge:value.challenge,admitted:value.admitted,issuedAt:value.issuedAt,expiresAt:value.expiresAt,reasonCode:value.reasonCode}),'utf8');}

async function protectedBytes(file,maxBytes,signal,{replaceable=false}={}){
 if(process.platform!=='linux'||!path.isAbsolute(file))throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');
 const absolute=path.resolve(file),parent=path.dirname(absolute);
 const safeMetadata=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===0&&!(stat.mode&0o022)&&stat.size>0&&stat.size<=maxBytes;
 const sameInode=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 for(let attempt=0;attempt<3;attempt++){
  let cursor=path.parse(parent).root;
  for(const part of ['',...parent.slice(cursor.length).split(path.sep).filter(Boolean)]){signal.throwIfAborted();if(part)cursor=path.join(cursor,part);const stat=await fs.lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||stat.mode&0o022&&!(stat.mode&0o1000))throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');}
  const before=await fs.lstat(absolute);
  if(!safeMetadata(before)||before.nlink!==1)throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');
  const handle=await fs.open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const stat=await handle.stat();
   if(!safeMetadata(stat))throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');
   if(stat.nlink===1&&sameInode(stat,before)){
    const buffer=Buffer.alloc(maxBytes+1);let used=0;
    while(used<buffer.length){signal.throwIfAborted();const read=await handle.read(buffer,used,buffer.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead;}
    if(used>maxBytes)throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');
    return buffer.subarray(0,used);
   }
   // The root broker publishes status by rename. Discard a descriptor that raced
   // with a verified replacement and check a fresh generation from the start.
   if(!replaceable||attempt===2||stat.nlink>1)throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');
   signal.throwIfAborted();
   const current=await fs.lstat(absolute);
   if(!safeMetadata(current)||current.nlink!==1||sameInode(current,before))throw fail('RUNTIME_ADMISSION_TRUST_UNSAFE');
  }finally{await handle.close();}
 }
}
export async function readAdmissionTrust({publicKeyFile,statusFile,signal}){
 const [pem,raw]=await Promise.all([protectedBytes(publicKeyFile,8192,signal),protectedBytes(statusFile,4096,signal,{replaceable:true})]);
 let key,status;try{key=crypto.createPublicKey(pem);status=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw fail('RUNTIME_ADMISSION_TRUST_INVALID');}
 if(key.asymmetricKeyType!=='ed25519'||!status||status.publicKeyFingerprint!==fingerprint(key))throw fail('RUNTIME_ADMISSION_TRUST_INVALID');return{key,status};
}
export function postAdmission({port,body,signal}){return new Promise((resolve,reject)=>{
 const request=http.request({hostname:'127.0.0.1',port,path:'/v1/admit',method:'POST',agent:false,signal,headers:{'Content-Type':'application/json','Accept':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
  if(response.statusCode!==200){response.resume();request.destroy();return reject(fail('RUNTIME_ADMISSION_HTTP_REJECTED'));}
  let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>8192){request.destroy();reject(fail('RUNTIME_ADMISSION_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});response.on('end',()=>{try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}catch{reject(fail('RUNTIME_ADMISSION_ACK_INVALID'));}});response.on('aborted',()=>reject(fail('RUNTIME_ADMISSION_RESPONSE_ABORTED')));response.on('error',()=>reject(fail('RUNTIME_ADMISSION_UNAVAILABLE')));
 });request.on('error',()=>reject(fail('RUNTIME_ADMISSION_UNAVAILABLE')));request.end(body);
});}
function validateTrust(trust,expectedCommit,port,now){
 const status=trust?.status,keys=['version','enabled','sourceCommit','epoch','port','publicKeyFingerprint','observedAt'];
 if(!status||typeof status!=='object'||Array.isArray(status)||Object.keys(status).some(key=>!keys.includes(key))||status.version!==1||status.enabled!==true||status.sourceCommit!==expectedCommit||!EPOCH.test(status.epoch||'')||status.port!==port||!HASH.test(status.publicKeyFingerprint||'')||!Number.isSafeInteger(status.observedAt)||now-status.observedAt>15000||status.observedAt>now+1000||trust.key?.asymmetricKeyType!=='ed25519'||fingerprint(trust.key)!==status.publicKeyFingerprint)throw fail('RUNTIME_ADMISSION_STATUS_UNTRUSTED');return status;
}
function validateAck(ack,request,key,sentAt,now){
 const keys=['version','sourceCommit','epoch','challenge','admitted','issuedAt','expiresAt','reasonCode','signature'];
 if(!ack||typeof ack!=='object'||Array.isArray(ack)||Object.keys(ack).some(name=>!keys.includes(name))||ack.version!==1||ack.sourceCommit!==request.sourceCommit||ack.epoch!==request.epoch||ack.challenge!==request.challenge||typeof ack.admitted!=='boolean'||!Number.isSafeInteger(ack.issuedAt)||!Number.isSafeInteger(ack.expiresAt)||ack.issuedAt<sentAt-1000||ack.issuedAt>now+1000||now-ack.issuedAt>5000||ack.expiresAt<=now||ack.expiresAt>ack.issuedAt+5000||ack.expiresAt<=ack.issuedAt||!/^([A-Z][A-Z0-9_]{0,79})$/.test(ack.reasonCode||'')||!/^[A-Za-z0-9_-]{86}$/.test(ack.signature||''))throw fail('RUNTIME_ADMISSION_ACK_INVALID');
 const signature=Buffer.from(ack.signature,'base64url');if(signature.length!==64||signature.toString('base64url')!==ack.signature||!crypto.verify(null,admissionPayload(ack),key,signature))throw fail('RUNTIME_ADMISSION_SIGNATURE_INVALID');
 if(ack.admitted!==true)throw fail('RUNTIME_ADMISSION_DENIED',ack.reasonCode);if(ack.reasonCode!=='USER_WORK_ADMITTED')throw fail('RUNTIME_ADMISSION_ACK_INVALID');
 return{admitted:true,enforced:true,sourceCommit:ack.sourceCommit,epoch:ack.epoch,challenge:ack.challenge,expiresAt:ack.expiresAt};
}

// Hooks/dependencies are for a controlled fixture or trusted integration only.
// In production this must run from the immutable root-managed Native plugin.
export function createRuntimeAdmission(config={},dependencies={}){
 const required=requiredLocation||process.env.HARNESS_RUNTIME_ADMISSION_REQUIRED==='1'||config.production===true;
 const port=config.port??3094,expectedCommit=config.expectedCommit,publicKeyFile=config.publicKeyFile??'/data/harness/runtime-status/admission-public.pem',statusFile=config.statusFile??'/data/harness/runtime-status/runtime-admission.json';
 const readTrust=dependencies.readTrust??readAdmissionTrust,transport=dependencies.transport??postAdmission,now=dependencies.now??Date.now,newChallenge=dependencies.challenge??(()=>crypto.randomBytes(32).toString('hex'));
 async function bounded(action,external){
  if(!SHA.test(expectedCommit||'')||!Number.isInteger(port)||port<1024||port>65535||!path.isAbsolute(publicKeyFile)||!path.isAbsolute(statusFile))throw fail('RUNTIME_ADMISSION_CONFIGURATION_REQUIRED');
  const abort=new AbortController();let timedOut=false;const cancel=()=>abort.abort();if(external?.aborted)throw fail('RUNTIME_ADMISSION_ABORTED');external?.addEventListener('abort',cancel,{once:true});let timer;
  try{return await Promise.race([Promise.resolve().then(()=>action(abort.signal)),new Promise((_,reject)=>{abort.signal.addEventListener('abort',()=>reject(fail(timedOut?'RUNTIME_ADMISSION_TIMEOUT':'RUNTIME_ADMISSION_ABORTED')),{once:true});timer=setTimeout(()=>{timedOut=true;abort.abort();},1500);})]);}
  catch(error){if(abort.signal.aborted)throw fail(timedOut?'RUNTIME_ADMISSION_TIMEOUT':'RUNTIME_ADMISSION_ABORTED');if(/^RUNTIME_ADMISSION_[A-Z_]+$/.test(error.code||''))throw error;throw fail('RUNTIME_ADMISSION_UNAVAILABLE');}
  finally{clearTimeout(timer);external?.removeEventListener('abort',cancel);}
 }
 return{required,async status({signal}={}){if(!required)return{version:1,enabled:false,enforced:false};return bounded(async abort=>{const trust=await readTrust({publicKeyFile,statusFile,signal:abort});abort.throwIfAborted();const status=validateTrust(trust,expectedCommit,port,now());return{version:1,enabled:true,enforced:true,sourceCommit:status.sourceCommit,epoch:status.epoch,observedAt:status.observedAt};},signal);},
  async admit(operation,{signal}={}){
   if(!required)return{admitted:true,enforced:false};if(!operations.has(operation))throw fail('RUNTIME_ADMISSION_OPERATION_INVALID');
   return bounded(async abort=>{const trust=await readTrust({publicKeyFile,statusFile,signal:abort});abort.throwIfAborted();const status=validateTrust(trust,expectedCommit,port,now()),challenge=newChallenge();if(!HASH.test(challenge))throw fail('RUNTIME_ADMISSION_CHALLENGE_INVALID');const request={version:1,sourceCommit:expectedCommit,epoch:status.epoch,challenge,operation},sentAt=now();const ack=await transport({port,body:JSON.stringify(request),signal:abort});abort.throwIfAborted();return validateAck(ack,request,trust.key,sentAt,now());},signal);
  }};
}
