'use strict';
// The root controller records acceptance BEFORE returning a signed dispatch
// grant. A pending or lost grant permanently consumes this epoch's rollback
// eligibility; expiry never makes accepted user work safe to undo.
const crypto=require('node:crypto'),http=require('node:http'),path=require('node:path');
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const operations=new Set(['start_turn','model_step','session_create','file_mutation','tool_dispatch','apps_enqueue','socket_enqueue']);
const fault=code=>Object.assign(Error(code),{code,status:409});
const payload=v=>Buffer.from(JSON.stringify({version:v.version,sourceCommit:v.sourceCommit,epoch:v.epoch,challenge:v.challenge,admitted:v.admitted,issuedAt:v.issuedAt,expiresAt:v.expiresAt,reasonCode:v.reasonCode}));
const fingerprint=key=>crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
function validState(s){if(!s||s.version!==1||!UUID.test(s.epoch||'')||!SHA.test(s.sourceCommit||'')||typeof s.open!=='boolean'||!Number.isSafeInteger(s.acceptedWork)||s.acceptedWork<0||s.fenceToken!==undefined&&!HASH.test(s.fenceToken))throw fault('RUNTIME_ADMISSION_STATE_UNTRUSTED');return s;}
class RuntimeAdmissionBroker{
 constructor({store,privateKey,sourceCommit,controller,currentCommit,quiescence,publish=()=>{},port=3094,now=Date.now}){
  if(!SHA.test(sourceCommit||'')||privateKey?.asymmetricKeyType!=='ed25519'||typeof store?.read!=='function'||typeof store?.write!=='function'||typeof currentCommit!=='function'||typeof quiescence!=='function')throw fault('RUNTIME_ADMISSION_CONFIGURATION_REQUIRED');
  Object.assign(this,{store,privateKey,controller,currentCommit,quiescence,publish,port,now});this.publicKey=crypto.createPublicKey(privateKey);this.queue=Promise.resolve();
  this.state=validState(store.read()??{version:1,epoch:crypto.randomUUID(),sourceCommit,open:false,acceptedWork:0});
  // A root process restart closes access; it never resets acceptance or opens a
  // previous grant epoch on the strength of an old JSON boolean.
  this.state.open=false;this.save();
 }
 exclusive(fn){const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next;}
 save(){this.store.write(structuredClone(this.state));this.heartbeat();}
 heartbeat(){const s=this.state;this.publish({version:1,enabled:s.open,sourceCommit:s.sourceCommit,epoch:s.epoch,port:this.port,publicKeyFingerprint:fingerprint(this.publicKey),observedAt:this.now()});}
 async fence({attemptId,commit,signal}){return this.exclusive(async()=>{
  if(!UUID.test(attemptId||'')||!SHA.test(commit||''))throw fault('RUNTIME_ADMISSION_FENCE_INVALID');
  this.state.open=false;this.save();signal?.throwIfAborted();const q=await this.quiescence({signal});signal?.throwIfAborted();
  if(!q||q.activeRequests!==0||q.activeJobs!==0||!Number.isSafeInteger(q.observedAt)||this.now()-q.observedAt>1000||q.observedAt>this.now()+1000)throw fault('RUNTIME_ADMISSION_WORK_UNEXCLUDED');
  if(this.state.epoch!==attemptId){
   if(this.state.acceptedWork!==0&&q.processesAbsent!==true)throw fault('RUNTIME_ADMISSION_OLD_GRANTS_UNEXCLUDED');
   this.state={version:1,epoch:attemptId,sourceCommit:commit,open:false,acceptedWork:0};this.save();
  }else if(this.state.sourceCommit!==commit){if(this.state.acceptedWork)throw fault('RUNTIME_ADMISSION_OLD_GRANTS_UNEXCLUDED');this.state.sourceCommit=commit;this.save();}
  this.state.fenceToken=crypto.randomBytes(32).toString('hex');this.save();
  return{attemptId,commit,admissionClosed:true,acceptedWork:this.state.acceptedWork,activeRequests:q.activeRequests,activeJobs:q.activeJobs,fenceToken:this.state.fenceToken,observedAt:this.now()};
 });}
 async closeAdmission(){return this.exclusive(async()=>{if(this.state.open){this.state.open=false;this.save();}else this.heartbeat();});}
 async open(observation){const status=await this.controller.status(),commit=await this.currentCommit();return this.exclusive(async()=>{
  if(!require('./runtime-recovery.cjs').healthy(observation,commit,this.now())||!['healthy','rolled_back'].includes(status.phase)||status.attemptId!==this.state.epoch||status.servingCommit!==commit||!SHA.test(commit||'')||this.state.sourceCommit!==commit&&this.state.acceptedWork)throw fault('RUNTIME_ADMISSION_RUNTIME_UNPROVEN');
  this.state.sourceCommit=commit;this.state.open=true;this.save();return true;
 });}
 async admit(request){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).sort().join(',')!==['challenge','epoch','operation','sourceCommit','version'].join(',')||request.version!==1||!SHA.test(request.sourceCommit||'')||!UUID.test(request.epoch||'')||!HASH.test(request.challenge||'')||!operations.has(request.operation))throw fault('RUNTIME_ADMISSION_REQUEST_INVALID');
  let admitted=false;
  const matches=()=>this.state.open&&this.state.epoch===request.epoch&&this.state.sourceCommit===request.sourceCommit;
  if(matches())try{
   // Do not hold the broker lock while entering the recovery lock: recovery
   // closes the broker while holding its own lock. A second check below denies
   // an ACK if that fence won the race, while the root latch stays conservative.
   const ack=await this.controller.admitWork(request.epoch,request.sourceCommit);
   if(ack?.admitted===true)admitted=await this.exclusive(async()=>{
    if(!matches()||await this.currentCommit()!==request.sourceCommit)return false;
    if(this.state.acceptedWork===Number.MAX_SAFE_INTEGER)throw fault('RUNTIME_ADMISSION_COUNTER_LIMIT');
    this.state.acceptedWork++;this.save();return true;
   });
  }catch{admitted=false;}
  const issuedAt=this.now(),ack={version:1,sourceCommit:request.sourceCommit,epoch:request.epoch,challenge:request.challenge,admitted,issuedAt,expiresAt:issuedAt+3000,reasonCode:admitted?'USER_WORK_ADMITTED':'RUNTIME_RECOVERY_ADMISSION_CLOSED'};
  return{...ack,signature:crypto.sign(null,payload(ack),this.privateKey).toString('base64url')};
 }
 createServer(){
  let active=0;const server=http.createServer(async(req,res)=>{
   if(req.method!=='POST'||req.url!=='/v1/admit'){res.writeHead(405,{Allow:'POST'});return res.end();}
   if(active>=32){res.writeHead(503);return res.end();}active++;const timer=setTimeout(()=>res.destroy(),1500);timer.unref();
   try{let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)throw fault('RUNTIME_ADMISSION_REQUEST_INVALID');chunks.push(chunk);}const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),ack=await this.admit(request);if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(ack));}}
   catch{if(!res.destroyed&&!res.headersSent){res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"code":"RUNTIME_ADMISSION_REQUEST_INVALID"}');}}
   finally{clearTimeout(timer);active--;}
  });server.headersTimeout=1500;server.requestTimeout=1500;server.keepAliveTimeout=1000;server.maxConnections=64;return server;
 }
}
function createRootAdmission({root='/data/harness',sourceCommit,controller,currentCommit,quiescence,port=3094}){
 const runtime=require('./runtime-paths.cjs');runtime.control(root);
 let key=runtime.readPrivate(root,'runtime-admission-key.json');
 if(key===null){const pair=crypto.generateKeyPairSync('ed25519');key={version:1,pem:pair.privateKey.export({type:'pkcs8',format:'pem'})};runtime.writePrivate(root,'runtime-admission-key.json',key);}
 if(key.version!==1||typeof key.pem!=='string'||key.pem.length>8192)throw fault('RUNTIME_ADMISSION_KEY_UNTRUSTED');
 const privateKey=crypto.createPrivateKey(key.pem);if(privateKey.asymmetricKeyType!=='ed25519')throw fault('RUNTIME_ADMISSION_KEY_UNTRUSTED');
 runtime.atomic(path.join(runtime.paths(root).publicState,'admission-public.pem'),crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'}),0o644);
 return new RuntimeAdmissionBroker({sourceCommit,controller,currentCommit,quiescence,port,privateKey,store:{read:()=>runtime.readPrivate(root,'runtime-admission-controller.json'),write:value=>runtime.writePrivate(root,'runtime-admission-controller.json',value)},publish:value=>runtime.atomic(path.join(runtime.paths(root).publicState,'runtime-admission.json'),value,0o644)});
}
module.exports={RuntimeAdmissionBroker,createRootAdmission,payload,fingerprint};
