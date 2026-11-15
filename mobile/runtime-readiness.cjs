'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createNativeHealth}=require('./native-health.cjs');
const SHA=/^[a-f0-9]{40}$/,MAX=32768;

function protectedJSON(directory,name){
 const file=path.join(directory,name),absolute=path.resolve(directory);let cursor=path.parse(absolute).root;
 for(const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,part);const s=fs.lstatSync(cursor);
  if(!s.isDirectory()||s.isSymbolicLink()||process.platform==='linux'&&(s.uid!==0||s.mode&0o022&&!(s.mode&0o1000)))throw Error('Untrusted runtime status directory');
 }
 const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX||process.platform==='linux'&&(before.uid!==0||before.mode&0o022))throw Error('Untrusted runtime status file');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
 try{const s=fs.fstatSync(fd);if(s.dev!==before.dev||s.ino!==before.ino||s.nlink!==1||s.size>MAX)throw Error('Runtime status changed');const buffer=Buffer.alloc(MAX+1),count=fs.readSync(fd,buffer,0,buffer.length,0);if(count>MAX)throw Error('Runtime status exceeds limit');return JSON.parse(buffer.subarray(0,count).toString('utf8'));}finally{fs.closeSync(fd);}
}
function probe(port,route,{json=false,timeoutMs=1500,hostHeader,cookie,captureCookies=false}={}){
 return new Promise(resolve=>{let done=false,request,timer;const finish=value=>{if(done)return;done=true;clearTimeout(timer);request?.destroy();resolve(value);};
  request=http.get({hostname:'127.0.0.1',port,path:route,headers:{Accept:'application/json',...(hostHeader?{Host:hostHeader}:{}),...(cookie?{Cookie:cookie}:{})},agent:false},response=>{
   if(!json){response.resume();return finish({status:response.statusCode,...(captureCookies?{cookies:response.headers['set-cookie']||[]}: {})});}
   const chunks=[];let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)return finish(null);chunks.push(chunk);});response.on('end',()=>{try{finish(response.statusCode===200?JSON.parse(Buffer.concat(chunks).toString('utf8')):null);}catch{finish(null);}});response.on('error',()=>finish(null));
  });request.on('error',()=>finish(null));timer=setTimeout(()=>finish(null),timeoutMs);
 });
}
function createRuntimeReadiness(cfg={},deps={}){
 const now=deps.now||Date.now,read=deps.read||((name)=>protectedJSON(cfg.runtimeStatusDir||'/data/harness/runtime-status',name));
 const native=deps.native||createNativeHealth(cfg,probe);
 const model=deps.model||(()=>probe(cfg.modelPort||8080,'/health',{json:true}));
 let pending=null,cached=null,until=0;
 async function collect(){
  let update=null,services=null;try{update=read('startup-update.json');}catch{}try{services=read('service-health.json');}catch{}
  const [host,health]=await Promise.all([native().catch(()=>null),model().catch(()=>null)]);
  const sourceReady=update?.version===1&&update.enabled===true&&update.phase==='ready'&&update.signatureVerified===true&&SHA.test(update.appliedCommit||'');
  const fresh=Number.isSafeInteger(services?.at)&&now()-services.at>=-5000&&now()-services.at<15000;
  const matching=services?.sourceCommit===update?.appliedCommit;
  const runtimeReady=!!(sourceReady&&fresh&&matching&&services.phase==='ready'&&host?.status===200&&host.workspaceReady===true&&host.sourceCommit===update.appliedCommit);
  const modelReady=health?.loaded===true;
  const ready=sourceReady&&runtimeReady&&modelReady;
  let phase='verifying_update',reasonCode='VERIFIED_SOURCE_UNAVAILABLE';
  if(update?.phase==='blocked'){phase='failed';reasonCode='SIGNED_UPDATE_BLOCKED';}
  else if(sourceReady&&fresh&&matching&&services.phase==='failed'){phase='failed';reasonCode='SERVICE_RESTART_LIMIT';}
  else if(sourceReady&&!runtimeReady){phase='starting_services';reasonCode=fresh?'NATIVE_RUNTIME_STARTING':'SERVICE_HEARTBEAT_STALE';}
  else if(runtimeReady&&!modelReady){phase='model_loading';reasonCode='MODEL_NOT_LOADED';}
  else if(ready){phase='ready';reasonCode='ALL_CHECKS_READY';}
  return{version:1,phase,reasonCode,retryAfterSeconds:phase==='failed'?30:2,observedAt:new Date(now()).toISOString(),sourceCommit:SHA.test(update?.appliedCommit||'')?update.appliedCommit:null,sourcePhase:sourceReady?'ready':update?.phase==='blocked'?'failed':'verifying_update',runtimePhase:runtimeReady?'ready':phase==='failed'?'failed':'starting_services',sourceReady,runtimeReady,modelReady,ready};
 }
 return{sample(){if(pending)return pending;if(cached&&now()<until)return Promise.resolve({...cached});pending=collect().then(value=>{cached=value;until=now()+1000;return{...value};}).finally(()=>{pending=null;});return pending;}};
}
module.exports={createRuntimeReadiness,protectedJSON,probe};
