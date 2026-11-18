// Source-only Root composition. No CLI, credential lookup or I/O at import.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
const fail=code=>Object.assign(Error(code),{code});
const need=(ok,code)=>{if(!ok)throw fail(code);};
export const limits=Object.freeze({operationMs:4000,responseBytes:262144,frameBytes:65536,streamBytes:262144,frames:128,jobs:128});
export const jobIdentity=row=>JSON.stringify([row?.id,row?.owner,row?.kind,row?.startedAt]);
export const terminalJob=row=>['completed','killed','failed'].includes(row?.status)&&Number.isSafeInteger(row?.finishedAt)&&row.finishedAt>=row.startedAt;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=256;
export function createNativeLifecycleTransport({target,ownerHost,ownerCookie,WebSocket},trusted={}){
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(k=>text(target[k])),'OWN_TARGET_REQUIRED');
 const own=Object.freeze(Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,target[k]])));
 need(typeof ownerHost==='string'&&/^[A-Za-z0-9.:[\]-]{1,256}$/.test(ownerHost),'OWNER_HOST_REQUIRED');
 need(typeof ownerCookie==='string'&&ownerCookie.length>0&&ownerCookie.length<=8192&&!/[^\x20-\x7e]/.test(ownerCookie),'OWNER_COOKIE_REQUIRED');
 need(typeof WebSocket==='function','PINNED_WS_CONSTRUCTOR_REQUIRED');
 const request=trusted.request??http.request,now=trusted.now??Date.now,timer=trusted.setTimeout??setTimeout,clear=trusted.clearTimeout??clearTimeout;
 const headers={Host:ownerHost,Origin:'https://'+ownerHost,Cookie:ownerCookie};
 const secretParts=[ownerCookie,...ownerCookie.split(';').map(x=>x.slice(x.indexOf('=')+1).trim()).filter(x=>x.length>=8)];
 const noSecret=value=>!secretParts.some(secret=>value.includes(secret)||value.includes(JSON.stringify(secret).slice(1,-1)));
 const endAt=options=>{need(Number.isSafeInteger(options?.deadline),'DEADLINE_REQUIRED');return Math.min(options.deadline,now()+limits.operationMs);};
 const guard=(end,signal)=>{need(!signal?.aborted,'LIFECYCLE_ABORTED');need(now()<end,'LIFECYCLE_DEADLINE');};
 function unary(method,args,options){
  const end=endAt(options),signal=options.signal;guard(end,signal);
  const body=Buffer.from(JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}}));
  return new Promise((resolve,reject)=>{
   let req,res,ended=false,handle,bytes=0;const chunks=[];
   const finish=(error,value)=>{if(ended)return;ended=true;clear(handle);signal?.removeEventListener('abort',abort);if(error){req?.destroy();res?.destroy();reject(fail(error));}else resolve(value);};
   const abort=()=>finish('LIFECYCLE_ABORTED');handle=timer(()=>finish('LIFECYCLE_DEADLINE'),Math.max(0,end-now()));signal?.addEventListener('abort',abort,{once:true});
   try{guard(end,signal);req=request({hostname:'127.0.0.1',port:3090,method:'POST',path:'/api/'+method,agent:false,headers:{...headers,'Content-Type':'application/json',Accept:'application/json','Content-Length':body.length}},incoming=>{
    res=incoming;if(ended){res.destroy();return;}
    if(res.statusCode!==200){finish('LIFECYCLE_HTTP_'+res.statusCode);return;}
    if(res.headers?.['content-encoding']&&res.headers['content-encoding']!=='identity'){finish('LIFECYCLE_ENCODING');return;}
    res.on('aborted',()=>finish('LIFECYCLE_RESPONSE_ABORTED'));res.on('error',()=>finish('LIFECYCLE_TRANSPORT'));
    res.on('data',part=>{if(ended)return;const b=Buffer.from(part);bytes+=b.length;if(bytes>limits.responseBytes){finish('LIFECYCLE_RESPONSE_LIMIT');return;}chunks.push(b);});
    res.on('end',()=>{if(ended)return;try{guard(end,signal);const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));need(noSecret(raw),'LIFECYCLE_CREDENTIAL_ECHO');const value=JSON.parse(raw);need(value?.result?.ok===true&&Object.hasOwn(value.result,'value'),'LIFECYCLE_REMOTE');need(noSecret(JSON.stringify(value.result.value)),'LIFECYCLE_CREDENTIAL_ECHO');guard(end,signal);finish(null,value.result.value);}catch(error){finish(error?.code??'LIFECYCLE_RESPONSE_INVALID');}});
   });req.on('error',()=>finish('LIFECYCLE_TRANSPORT'));if(ended)req.destroy();else req.end(body);}catch{finish('LIFECYCLE_TRANSPORT');}
  });
 }
 // Each operation owns one socket and one logical stream. Complete WS text
 // messages are the protocol frames; HTTP JSONL/SSE is not a supported carrier.
 async function stream(endpoint,requestData,options,onValue,firstOnly=false){
  const end=endAt(options),signal=options.signal;guard(end,signal);
  const streamId=randomUUID();let ws;
  return new Promise((resolve,reject)=>{
   let done=false,closed=false,closing=false,handle,bytes=0,count=0,value,error;
   const finish=()=>{if(done||!closed)return;done=true;clear(handle);signal?.removeEventListener('abort',abort);error?reject(fail(error)):resolve(value);};
   const shutdown=(code,result)=>{if(closing)return;closing=true;error=code;value=result;
    try{if(ws?.readyState===1)ws.send(JSON.stringify({type:'cancel',streamId}));}catch{}
    try{ws?.terminate();}catch{}
    if(!ws){closed=true;finish();}
   };
   const abort=()=>shutdown('LIFECYCLE_ABORTED');
   handle=timer(()=>{if(done)return;error='LIFECYCLE_DEADLINE';if(!closing)shutdown(error);else{try{ws?.terminate();}catch{}}if(!done){done=true;signal?.removeEventListener('abort',abort);reject(fail(error));}} ,Math.max(0,end-now()));
   signal?.addEventListener('abort',abort,{once:true});
   try{
    ws=new WebSocket('ws://127.0.0.1:3090/api/remote.mux',{headers,maxPayload:limits.frameBytes,perMessageDeflate:false,handshakeTimeout:Math.max(1,end-now()),followRedirects:false});
    ws.on('error',()=>shutdown('LIFECYCLE_WS_TRANSPORT'));
    ws.on('close',()=>{closed=true;if(!closing){closing=true;error='LIFECYCLE_WS_EARLY_CLOSE';}finish();});
    ws.on('unexpected-response',(_req,response)=>{response.destroy();shutdown('LIFECYCLE_WS_UPGRADE');});
    ws.on('open',()=>{if(closing){ws.terminate();return;}try{guard(end,signal);ws.send(JSON.stringify({type:'open',streamId,endpoint,payload:{args:{request:requestData}}}));}catch(e){shutdown(e?.code??'LIFECYCLE_WS_TRANSPORT');}});
    ws.on('message',(part,isBinary)=>{
     if(closing)return;
     try{
      guard(end,signal);const b=Buffer.from(part);bytes+=b.length;count++;
      need(!isBinary&&b.length<=limits.frameBytes&&bytes<=limits.streamBytes&&count<=limits.frames,'LIFECYCLE_STREAM_LIMIT');
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(b);need(noSecret(raw),'LIFECYCLE_CREDENTIAL_ECHO');const frame=JSON.parse(raw);need(noSecret(JSON.stringify(frame)),'LIFECYCLE_CREDENTIAL_ECHO');
      need(frame?.streamId===streamId&&['item','error','end'].includes(frame.type),'LIFECYCLE_STREAM_FRAME');
      if(frame.type==='error')throw fail('LIFECYCLE_STREAM_REMOTE');
      if(frame.type==='end'){const result=onValue(undefined,true);shutdown(null,result);return;}
      const result=onValue(frame.value,false);if(firstOnly)shutdown(null,result);
     }catch(e){shutdown(e?.code??'LIFECYCLE_STREAM_FRAME');}
    });
   }catch{shutdown('LIFECYCLE_WS_TRANSPORT');}
  });
 }
 function checkedRows(value){
  need(value?.type==='rows'&&Array.isArray(value.jobs)&&value.jobs.length<=limits.jobs,'LIFECYCLE_JOB_ROWS');
  const ids=new Set();for(const row of value.jobs){need(text(row?.id)&&text(row.kind)&&(row.owner===undefined||text(row.owner))&&Number.isSafeInteger(row.startedAt)&&row.startedAt>=0&&['running','stopping','completed','killed','failed'].includes(row.status)&&Number.isSafeInteger(row.output?.total)&&row.output.total>=0&&!ids.has(row.id),'LIFECYCLE_JOB_ROW');ids.add(row.id);}
  return value.jobs;
 }
 const jobsSnapshot=options=>stream('job/list',{sessionId:own.sessionId},options,(value,ended)=>{need(!ended,'LIFECYCLE_JOB_ROWS_MISSING');return checkedRows(value);},true);
 async function followJob(row,options){
  need(row?.owner===own.sessionId&&text(row.id),'LIFECYCLE_JOB_OWNER');let opened=false,terminal;
  return stream('job/follow',{sessionId:own.sessionId,jobId:row.id,from:row.output.total},options,(value,ended)=>{
   if(ended){need(opened&&terminal,'LIFECYCLE_JOB_TERMINAL_MISSING');return terminal;}
   need(value&&['opened','output','status'].includes(value.type),'LIFECYCLE_JOB_FRAME');
   if(value.type==='opened'){need(!opened&&jobIdentity(value.job)===jobIdentity(row),'LIFECYCLE_JOB_CHANGED');opened=true;}
   else if(value.type==='status'){need(opened&&!terminal&&jobIdentity(value.job)===jobIdentity(row)&&terminalJob(value.job),'LIFECYCLE_JOB_TERMINAL_INVALID');terminal=value.job;}
   else need(opened&&!terminal&&Array.isArray(value.chunks),'LIFECYCLE_JOB_OUTPUT_INVALID');
  });
 }
 async function killJob(row,options){
  need(row?.owner===own.sessionId,'LIFECYCLE_JOB_OWNER');const rows=await jobsSnapshot(options),fresh=rows.find(item=>item.id===row.id);
  need(fresh&&fresh.owner===own.sessionId&&jobIdentity(fresh)===jobIdentity(row),'LIFECYCLE_JOB_CHANGED');
  const ack=await unary('job/kill',{request:{sessionId:own.sessionId,jobId:fresh.id}},options);
  need(['requested','already-finished'].includes(ack?.outcome),'LIFECYCLE_JOB_KILL_ACK');return ack;
 }
 return Object.freeze({target:own,jobsSnapshot,followJob,killJob,
  projections:options=>unary('session/projections',{request:{sessionId:own.sessionId}},options),
  terminals:options=>unary('terminal/list',{sessionId:own.sessionId},options)});
}
