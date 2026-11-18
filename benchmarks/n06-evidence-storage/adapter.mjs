// SOURCE ONLY. No CLI, login, credential discovery, session creation or QA code.
import http from 'node:http';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
export const limits=Object.freeze({rpcMs:4000,requestBytes:262144,responseBytes:4194304,snapshotBytes:2097152,maxCheckpointCount:2048,maxCheckpointBudgetBytes:67108864});
export const checkpointPolicy=Object.freeze({observationIntervalMs:10000,observationBudgetBytes:4194304,criticalWrites:4}); // intent + two final writes + one finalizer retention
const fail=code=>Object.assign(Error(code),{code});
const need=(ok,code)=>{if(!ok)throw fail(code);};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const keys=(value,required,optional=[])=>plain(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
function validateTarget(target){
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(k=>typeof target[k]==='string'&&target[k].length>0&&target[k].length<=256),'OWN_TARGET_REQUIRED');
 return Object.freeze(Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,target[k]])));
}
function validatePayload(method,data,target){
 const sid=value=>value===target.sessionId,integer=value=>Number.isSafeInteger(value)&&value>=0;
 if(['session/state','session/cancel'].includes(method))need(keys(data,['sessionId'])&&sid(data.sessionId),'RPC_TARGET_OR_SHAPE');
 else if(method==='session/page')need(keys(data,['address','throughSeq','maxMessages'],['beforeSeq'])&&keys(data.address,['kind','sessionId'])&&data.address.kind==='session'&&sid(data.address.sessionId)&&integer(data.throughSeq)&&data.maxMessages===64&&(!Object.hasOwn(data,'beforeSeq')||integer(data.beforeSeq)&&data.beforeSeq<=data.throughSeq+1),'RPC_TARGET_OR_SHAPE');
 else if(method==='session/prompt')need(keys(data,['sessionId','requestId','mode','content'])&&sid(data.sessionId)&&uuid(data.requestId)&&data.mode==='queue'&&Array.isArray(data.content)&&data.content.length===1&&keys(data.content[0],['type','text'])&&data.content[0].type==='text'&&typeof data.content[0].text==='string','RPC_TARGET_OR_SHAPE');
 else if(method==='session/updateQueue')need(keys(data,['sessionId','itemId','action'])&&sid(data.sessionId)&&typeof data.itemId==='string'&&data.itemId.length>0&&data.itemId.length<=256&&keys(data.action,['kind'])&&data.action.kind==='remove','RPC_TARGET_OR_SHAPE');
 else throw fail('RPC_METHOD_REFUSED');
}
function ownerHeaders(host,cookie){
 need(typeof host==='string'&&host.length>0&&host.length<=256&&!/[^A-Za-z0-9.:[\]-]/.test(host),'OWNER_HOST_REQUIRED');
 let parsed;try{parsed=new URL('https://'+host);}catch{}
 need(parsed&&parsed.hostname&&!parsed.username&&!parsed.password&&parsed.pathname==='/'&&!parsed.search&&!parsed.hash,'OWNER_HOST_REQUIRED');
 need(typeof cookie==='string'&&cookie.length>0&&cookie.length<=8192&&!/[^\x20-\x7e]/.test(cookie),'OWNER_COOKIE_REQUIRED');
 return Object.freeze({Host:host,Origin:'https://'+host,Cookie:cookie});
}
// The second argument is a trusted source-test seam, never runtime/user config.
// Production defaults use real Node HTTP/async FS, Date.now and local timers.
export function createRootIOAdapter({target,attemptId,ownerHost,ownerCookie,checkpointDirectory,checkpointBudgetBytes,checkpointBudgetCount},trusted={}){
 const own=validateTarget(target),headers=ownerHeaders(ownerHost,ownerCookie);
 need(typeof attemptId==='string'&&attemptId.length>0&&attemptId.length<=256,'ATTEMPT_ID_REQUIRED');
 need(typeof checkpointDirectory==='string'&&path.posix.isAbsolute(checkpointDirectory)&&path.posix.resolve(checkpointDirectory)===checkpointDirectory&&checkpointDirectory!=='/','CHECKPOINT_DIRECTORY_REQUIRED');
 need(Number.isSafeInteger(checkpointBudgetBytes)&&checkpointBudgetBytes>=16384&&checkpointBudgetBytes<=limits.maxCheckpointBudgetBytes&&Number.isSafeInteger(checkpointBudgetCount)&&checkpointBudgetCount>0&&checkpointBudgetCount<=limits.maxCheckpointCount,'CHECKPOINT_BUDGET_REQUIRED');
 const request=trusted.request??http.request,files=trusted.fs??fs,now=trusted.now??Date.now,timer=trusted.setTimeout??setTimeout,clear=trusted.clearTimeout??clearTimeout,platform=trusted.platform??process.platform,getuid=trusted.getuid??(()=>process.getuid?.());
 const secretValues=[ownerCookie,...ownerCookie.split(';').map(p=>p.slice(p.indexOf('=')+1).trim()).filter(v=>v.length>=8)],secrets=secretValues.flatMap(value=>[value,JSON.stringify(value).slice(1,-1)]),credentialFree=text=>!secrets.some(secret=>text.includes(secret));
 const store={busy:false,quarantined:false,prepared:false,identity:null,lastDurable:null,requestId:null,intentDurable:false,promptAttempted:false,count:0,bytes:0,ids:new Set()};
 const maxId='f'.repeat(8)+'-'+ 'f'.repeat(4)+'-'+ 'f'.repeat(4)+'-'+ 'f'.repeat(4)+'-'+ 'f'.repeat(12);
 const maxEnvelopeBytes=limits.snapshotBytes+Buffer.byteLength(JSON.stringify({version:1,checkpointId:maxId,phase:'observation',attemptId,target:own,requestId:maxId,previousCheckpointId:maxId,snapshotSha256:'f'.repeat(64),snapshot:null})+'\n')-4;
 const claimBytes=Buffer.byteLength(JSON.stringify({version:1,attemptId,target:own,requestId:maxId,writerId:maxId,note:'Exclusive writer claim; filenames are not durability receipts'})+'\n');
 need(checkpointBudgetCount>=checkpointPolicy.criticalWrites&&checkpointBudgetBytes>=claimBytes+checkpointPolicy.criticalWrites*maxEnvelopeBytes,'CHECKPOINT_CRITICAL_RESERVE_REQUIRED');
 const critical={intent:0,final:0,finalizer:0};let lastObservationHash=null,lastObservationAt=-Infinity,observationBytes=0;
 function phaseDeadline(deadline){need(Number.isFinite(deadline)&&Number.isSafeInteger(deadline),'DEADLINE_REQUIRED');return Math.min(deadline,now()+limits.rpcMs);}
 function guard(deadline,signal){need(!signal?.aborted,'OPERATION_ABORTED');need(now()<deadline,'OPERATION_DEADLINE');}
 function bounded(deadline,signal,work,onFailure=()=>{},onSuccess=value=>value){
  return new Promise((resolve,reject)=>{
   let ended=false,handle;
   const finish=(error,value)=>{if(ended)return;ended=true;clear(handle);signal?.removeEventListener('abort',abort);if(error){onFailure();reject(error);}else resolve(value);};
   const check=()=>{need(!ended,'OPERATION_CLOSED');guard(deadline,signal);};
   const abort=()=>finish(fail('OPERATION_ABORTED'));
   try{guard(deadline,signal);}catch(error){finish(error);return;}
   handle=timer(()=>finish(fail('OPERATION_DEADLINE')),Math.max(0,deadline-now()));signal?.addEventListener('abort',abort,{once:true});
   Promise.resolve().then(()=>{check();return work(check);}).then(value=>{try{check();finish(null,onSuccess(value));}catch(error){finish(error);}},error=>finish(error?.code?error:fail('CHECKPOINT_IO_FAILED')));
  });
 }
 async function rpc(method,data,{signal,deadline}={}){
  validatePayload(method,data,own);const end=phaseDeadline(deadline);guard(end,signal);
  if(method==='session/prompt'){need(!store.quarantined&&store.intentDurable&&data.requestId===store.requestId,'DURABLE_ATTEMPT_INTENT_REQUIRED');need(!store.promptAttempted,'PROMPT_ALREADY_ATTEMPTED');store.promptAttempted=true;}
  const body=Buffer.from(JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args:{request:data}}}));need(body.length<=limits.requestBytes&&credentialFree(body.toString('utf8')),'RPC_BODY_REFUSED');
  return new Promise((resolve,reject)=>{
   let req,res,ended=false,timeout,bytes=0;const chunks=[];
   const done=(error,value)=>{if(ended)return;ended=true;clear(timeout);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
   const stop=(code,context)=>{done(Object.assign(fail(code),context));try{req?.destroy();}catch{}try{res?.destroy();}catch{}};
   const abort=()=>stop('RPC_ABORTED');
   timeout=timer(()=>stop('RPC_DEADLINE'),Math.max(0,end-now()));signal?.addEventListener('abort',abort,{once:true});
   try{
    guard(end,signal);
    req=request({protocol:'http:',hostname:'127.0.0.1',port:3090,method:'POST',path:'/api/'+method,agent:false,headers:{...headers,Accept:'application/json','Content-Type':'application/json','Content-Length':body.length}},incoming=>{
     res=incoming;if(ended){res.destroy();return;}
     if(res.statusCode!==200){stop('RPC_HTTP_STATUS',{rpcMethod:method,httpStatus:Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null});return;}
     if(res.headers?.['content-encoding']&&res.headers['content-encoding']!=='identity'){stop('RPC_ENCODING_REFUSED');return;}
     const length=res.headers?.['content-length'];if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>limits.responseBytes)){stop('RPC_RESPONSE_LIMIT');return;}
     res.on('aborted',()=>stop('RPC_RESPONSE_ABORTED'));res.on('error',()=>stop('RPC_TRANSPORT_FAILED'));
     res.on('data',chunk=>{if(ended)return;const b=Buffer.from(chunk);bytes+=b.length;if(bytes>limits.responseBytes){stop('RPC_RESPONSE_LIMIT');return;}chunks.push(b);});
     res.on('end',()=>{if(ended)return;try{guard(end,signal);const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes));need(credentialFree(text),'RPC_CREDENTIAL_ECHO');const value=JSON.parse(text);need(value?.result?.ok===true&&Object.hasOwn(value.result,'value'),'RPC_REMOTE_REJECTED');need(credentialFree(JSON.stringify(value.result.value)),'RPC_CREDENTIAL_ECHO');guard(end,signal);done(null,value.result.value);}catch(error){stop(['OPERATION_ABORTED','OPERATION_DEADLINE','RPC_CREDENTIAL_ECHO','RPC_REMOTE_REJECTED'].includes(error.code)?error.code:'RPC_RESPONSE_INVALID');}});
    });
    req.on('error',()=>stop('RPC_TRANSPORT_FAILED'));if(ended){req.destroy();return;}req.end(body);
   }catch{stop(signal?.aborted?'RPC_ABORTED':now()>=end?'RPC_DEADLINE':'RPC_TRANSPORT_FAILED');}
  });
 }
 const directory=checkpointDirectory;
 function safeDirectory(s,privateLeaf=false){return s.isDirectory()&&!s.isSymbolicLink?.()&&s.uid===0&&!(s.mode&0o022)&&(!privateLeaf||!(s.mode&0o077));}
 const sameDirectory=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.gid===b.gid&&(a.mode&0o777)===(b.mode&0o777);
 async function openDirectory(check){
  need(platform==='linux'&&getuid()===0,'CHECKPOINT_LINUX_ROOT_REQUIRED');let at='/';
  for(const part of directory.slice(1).split('/')){at=path.posix.join(at,part);check();const s=await files.lstat(at);check();need(safeDirectory(s,at===directory),'CHECKPOINT_PROTECTED_DIRECTORY_REQUIRED');}
  check();need(await files.realpath(directory)===directory,'CHECKPOINT_CANONICAL_DIRECTORY_REQUIRED');check();
  const handle=await files.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{check();const opened=await handle.stat();check();need(safeDirectory(opened,true),'CHECKPOINT_PROTECTED_DIRECTORY_REQUIRED');const named=await files.lstat(directory);check();need(sameDirectory(opened,named)&&(!store.identity||sameDirectory(opened,store.identity)),'CHECKPOINT_DIRECTORY_CHANGED');return{handle,identity:opened};}catch(error){await handle.close().catch(()=>{});throw error;}
 }
 async function writeExclusive(name,bytes,check){
  let handle;
  try{check();handle=await files.open(path.posix.join(directory,name),'wx',0o600);check();await handle.writeFile(bytes);check();const s=await handle.stat();check();need(s.isFile()&&s.uid===0&&s.nlink===1&&(s.mode&0o777)===0o600&&s.size===bytes.length,'CHECKPOINT_FILE_UNSAFE');await handle.sync();check();}finally{if(handle)await handle.close();}
 }
 async function checkpoint(snapshot,{signal,deadline,checkpointId,phase,critical:purpose}={}){
  need(!store.quarantined,'CHECKPOINT_WRITER_QUARANTINED');need(!store.busy,'CHECKPOINT_WRITER_BUSY');
  const end=phaseDeadline(deadline);guard(end,signal);need(uuid(checkpointId)&&['intent','observation','final'].includes(phase),'CHECKPOINT_ID_OR_PHASE_REQUIRED');need(!store.ids.has(checkpointId),'CHECKPOINT_ID_REUSED');
  need(snapshot?.attemptId===attemptId&&Object.entries(own).every(([k,v])=>snapshot.identity?.[k]===v),'CHECKPOINT_TARGET_MISMATCH');
  const requestId=snapshot.operator?.requestId;need(uuid(requestId)&&(!store.requestId||requestId===store.requestId),'CHECKPOINT_REQUEST_MISMATCH');
  need((store.prepared?phase!=='intent':phase==='intent')&&snapshot.operator?.persistence?.lastDurableCheckpointId===store.lastDurable,'CHECKPOINT_CHAIN_MISMATCH');
  if(Object.hasOwn(snapshot.operator.persistence,'pendingCheckpointId'))need(snapshot.operator.persistence.pendingCheckpointId===checkpointId,'CHECKPOINT_PENDING_ID_MISMATCH');
  need(purpose===undefined||phase==='observation'&&purpose==='finalizer','CHECKPOINT_CRITICAL_PURPOSE_REFUSED');
  const kind=phase==='observation'?purpose:phase;
  if(kind)need(critical[kind]<(kind==='final'?2:1),'CHECKPOINT_CRITICAL_COUNT_EXCEEDED');
  let text;try{text=JSON.stringify(snapshot);}catch{throw fail('CHECKPOINT_JSON_REQUIRED');}
  need(typeof text==='string'&&Buffer.byteLength(text)<=limits.snapshotBytes&&credentialFree(text),'CHECKPOINT_SNAPSHOT_REFUSED');guard(end,signal);
  const data=JSON.parse(text),envelope=Buffer.from(JSON.stringify({version:1,checkpointId,phase,attemptId,target:own,requestId,previousCheckpointId:store.lastDurable,snapshotSha256:sha(Buffer.from(text)),snapshot:data})+'\n');
  const claim=Buffer.from(JSON.stringify({version:1,attemptId,target:own,requestId,writerId:randomUUID(),note:'Exclusive writer claim; filenames are not durability receipts'})+'\n');
  const reserved=envelope.length+(store.prepared?0:claim.length);
  let observationHash;
  if(!kind){
   const meaningful=JSON.parse(text);delete meaningful.operator.persistence.pendingCheckpointId;delete meaningful.operator.persistence.lastDurableCheckpointId;
   observationHash=sha(Buffer.from(JSON.stringify(meaningful)));
   const remaining=checkpointPolicy.criticalWrites-critical.intent-critical.final-critical.finalizer;
   const reason=observationHash===lastObservationHash?'unchanged':now()-lastObservationAt<checkpointPolicy.observationIntervalMs?'sample_interval':observationBytes+reserved>checkpointPolicy.observationBudgetBytes||store.count+1+remaining>checkpointBudgetCount||store.bytes+reserved+remaining*maxEnvelopeBytes>checkpointBudgetBytes?'observation_budget':null;
   if(reason){guard(end,signal);return Object.freeze({checkpointId,durable:false,skipped:true,reason});}
  }
  need(store.count<checkpointBudgetCount&&store.bytes+reserved<=checkpointBudgetBytes,'CHECKPOINT_BUDGET_EXHAUSTED');
  if(kind)critical[kind]++;
  else observationBytes+=reserved;
  store.busy=true;store.ids.add(checkpointId);store.count++;store.bytes+=reserved;
  return bounded(end,signal,async check=>{
   let opened;
   try{
    opened=await openDirectory(check);check();
    if(!store.prepared){const names=await files.readdir(directory);check();need(names.length===0,'CHECKPOINT_DIRECTORY_NOT_EMPTY');await writeExclusive('.writer.json',claim,check);check();await opened.handle.sync();check();store.identity=opened.identity;store.requestId=requestId;store.prepared=true;}
    await writeExclusive(checkpointId+'.json',envelope,check);check();await opened.handle.sync();check();
    const named=await files.lstat(directory);check();need(sameDirectory(opened.identity,named),'CHECKPOINT_DIRECTORY_CHANGED');
   }finally{if(opened)await opened.handle.close();}
   check();return Object.freeze({checkpointId,durable:true,sha256:sha(envelope),bytes:envelope.length});
  },()=>{store.quarantined=true;store.busy=false;},receipt=>{store.lastDurable=checkpointId;if(phase==='intent')store.intentDurable=true;if(!kind){lastObservationHash=observationHash;lastObservationAt=now();}store.busy=false;return receipt;});
 }
 return Object.freeze({rpc,checkpoint});
}
