import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {WorkbenchError} from './policy.mjs';
const {protectedJSON}=createRequire(import.meta.url)('../mobile/runtime-readiness.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const stamp=value=>Number.isSafeInteger(value)&&value>0;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u001f\u007f]/u.test(value);
const fail=code=>new WorkbenchError(code,'The bounded QA receipt could not be confirmed.',409);
const human=message=>message?.role==='user'&&message.source?.kind==='user'&&text(message.id);
const fresh=(at,now)=>stamp(at)&&now>=at&&now-at<=20000;
export function projectQaEvents(events){
 const admissions=events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.outcome!=='canceled').flatMap(event=>(event.data.inserted??[]).filter(human).map(message=>({event,message})));
 // This opt-in smoke covers one original text prompt, not continued/repaired
 // conversations. An ambiguous or additional human request cannot borrow it.
 if(admissions.length!==1)return{state:'unconfirmed'};
 const {event:admission,message}=admissions[0],entered=events.filter(event=>event.type==='user/message'&&event.data.id===message.id&&human(event.data));
 if(entered.length!==1||entered[0].seq<=admission.seq||!stamp(admission.time))return{state:'unconfirmed'};
 const content=message.content;
 if(!Array.isArray(content)||content.length!==1||content[0]?.type!=='text'||typeof content[0].text!=='string'||Buffer.byteLength(content[0].text)>65536)return{state:'unconfirmed'};
 const start=events.findLast(event=>event.type==='turn/start'&&event.seq<entered[0].seq),end=start&&events.find(event=>event.type==='turn/end'&&event.data.turn===start.data.turn&&event.seq>entered[0].seq);
 if(!end||!stamp(end.time)||end.time<admission.time||end.data.reason?.kind!=='completed')return{state:'unconfirmed'};
 if(events.some(event=>event.type==='turn/start'&&event.seq>end.seq))return{state:'unconfirmed'};
 const messages=events.filter(event=>['assistant/message','assistant/attempt'].includes(event.type)&&event.seq>start.seq&&event.seq<end.seq);
 const complete=messages.length>0&&messages.every(event=>event.data.source?.kind==='model'&&text(event.data.source.provider)&&text(event.data.source.model));
 const routes=complete?[...new Map(messages.map(event=>{const {provider,model}=event.data.source;return[provider+'\0'+model,{provider,model}];})).values()]:null;
 return{state:'completed',messageId:message.id,admissionSeq:admission.seq,admittedAt:admission.time,turn:start.data.turn,endSeq:end.seq,finishedAt:end.time,promptSha256:sha(content[0].text),requestRoutes:routes};
}
export function createQaReceipts(ctx,manager,{sourceCommit,now=Date.now,readStatus=name=>protectedJSON('/data/harness/runtime-status',name)}={}){
 function runtime(){try{const value=readStatus('runtime-admission.json');return value?.enabled===true&&value.sourceCommit===sourceCommit&&/^[a-f0-9]{40}$/.test(sourceCommit)&&text(value.epoch)&&fresh(value.observedAt,now())?{sourceCommit,epoch:value.epoch}:null;}catch{return null;}}
 return async(sessionId,afterSeq,signal)=>{
  const {live,header}=await manager.projectFor(sessionId);if(header.origin==='subagent')throw fail('QA_ORDINARY_SESSION_REQUIRED');
  const workspace=manager.workspaceFor(live??{id:sessionId,header});if(!workspace)throw fail('QA_WORKSPACE_REQUIRED');
  if(afterSeq!==undefined&&(!Number.isSafeInteger(afterSeq)||afterSeq< -1))throw fail('QA_CURSOR_INVALID');
  const before=runtime(),records=await ctx.sessionQuery.listEvents(sessionId),cursor=records.at(-1)?.seq??-1;
  if(afterSeq>cursor)throw fail('QA_CURSOR_INVALID');
  const selected=afterSeq===undefined?[]:records.filter(row=>row.seq>afterSeq&&['agent/inbox/spliced','user/message','turn/start','turn/end','assistant/message','assistant/attempt'].includes(row.type));
  if(cursor-(afterSeq??cursor)>4096||selected.length>256)throw fail('QA_RECEIPT_LIMIT');
  const events=[];for(const record of selected){signal?.throwIfAborted();const window=await ctx.sessionQuery.readEvent({sessionId,seq:record.seq},signal);if(window.session.id!==sessionId||window.target.seq!==record.seq||window.target.type!==record.type||window.target.time!==record.time)throw fail('QA_RECEIPT_CHANGED');events.push(window.target);}
  const latest=await ctx.sessionQuery.listEvents(sessionId);if((latest.at(-1)?.seq??-1)!==cursor||live&&live.seq!==cursor+1)throw fail('QA_RECEIPT_CHANGED');
  let telemetry;try{telemetry=readStatus('telemetry.json');}catch{}
  const at=now(),after=runtime(),identity=before&&after&&before.epoch===after.epoch?after:null;
  const sampled=identity&&fresh(telemetry?.at,at)&&stamp(telemetry.monitorStartedAt)&&telemetry.monitorStartedAt<=telemetry.at;
  const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const shared=sampled?{at:telemetry.at,monitorStartedAt:telemetry.monitorStartedAt,ramScope:['container','host'].includes(telemetry.ram?.scope)?telemetry.ram.scope:null,ramUsedBytes:number(telemetry.ram?.used),gpuScope:'whole-gpu',gpuUsedBytes:Number.isFinite(telemetry.gpu?.vramUsedMiB)&&telemetry.gpu.vramUsedMiB>=0?number(Math.round(telemetry.gpu.vramUsedMiB*1048576)):null,model:telemetry.model?.loaded===true&&text(telemetry.model.id)?telemetry.model.id:null,contextTokens:number(telemetry.model?.contextMax)}:null;
  const configured=manager.data?.generationProfiles?.selected?.[sessionId],settings=manager.settings?.(live??{id:sessionId,header});
  const configuration=settings?{name:configured?.name??null,profileId:configured?.profileId??null,profileVersion:configured?.profileVersion??null,requestedQuantization:configured?.expectedQuantization??null,sampling:Object.fromEntries(['maxTokens','thinkingBudget','temperature','topP'].map(key=>[key,settings[key]]))}:null;
  return{version:1,kind:'qa-session-receipt',sessionId,workspaceId:workspace.id,cursor,observedAt:at,runtime:identity,configuration,request:afterSeq===undefined?null:projectQaEvents(events),sharedTelemetry:shared};
 };
}
export function installQaReceipts(ctx,manager,options){
 const read=createQaReceipts(ctx,manager,options);
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/qa-receipt',methods:['GET'],async fetch(request){
  let value,status=200;try{const q=new URL(request.url).searchParams;if([...q.keys()].some(key=>!['sessionId','afterSeq'].includes(key)))throw fail('QA_QUERY_INVALID');const raw=q.get('afterSeq');if(raw!==null&&!/^-?\d+$/.test(raw))throw fail('QA_CURSOR_INVALID');value=await read(q.get('sessionId'),raw===null?undefined:Number(raw),request.signal);}catch(error){status=error.status??409;value={code:error.code??'QA_RECEIPT_UNAVAILABLE'};}
  return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }}));
}
