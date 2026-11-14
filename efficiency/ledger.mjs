import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class EventLedger {
  constructor(file,{clock=Date.now,maxBytes=32*1024*1024}={}){this.file=file;this.clock=clock;this.maxBytes=maxBytes;this.bootId=crypto.randomUUID();this.sequence=0;if(file){fs.mkdirSync(path.dirname(file),{recursive:true});this.bytes=fs.existsSync(file)?fs.statSync(file).size:0;}}
  record(type,data={}){const e={version:1,id:`${this.bootId}:${++this.sequence}`,at:this.clock(),type,...data};if(this.file){const json=JSON.stringify(e)+'\n',size=Buffer.byteLength(json);if(this.bytes+size>this.maxBytes){fs.writeFileSync(this.file+'.stopped.json',JSON.stringify({at:this.clock(),reason:'LEDGER_CAPACITY',maxBytes:this.maxBytes}),{mode:0o600});throw Error('Ledger capacity reached; reporting must mark the measurement incomplete.');}fs.appendFileSync(this.file,json,{mode:0o600});this.bytes+=size;}return e;}
}
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function normalizeEngineRecord(r){
  if(!r)return null;
  const value={engineRequestId:r.id};
  for(const [dest,source]of Object.entries({promptTokens:'prompt_tokens',reusedTokens:'reused',prefillMs:'prompt_ms',decodeMs:'decode_ms',outputTokens:'output_tokens'}))value[dest]=finite(r[source])?r[source]:null;
  return value;
}
export function uniqueEngineRecord(before,after){const old=new Set((before?.requests??[]).map(r=>r.id)),fresh=(after?.requests??[]).filter(r=>!old.has(r.id));return fresh.length===1?normalizeEngineRecord(fresh[0]):null;}
export function intervalUnion(intervals){const sorted=intervals.filter(x=>finite(x[0])&&finite(x[1])&&x[1]>=x[0]).sort((a,b)=>a[0]-b[0]);let sum=0,end=-Infinity;for(const [s,e]of sorted){sum+=Math.max(0,e-Math.max(s,end));end=Math.max(end,e);}return sum;}

/** Billing is an allocation, not a claim of per-task GPU energy measurement. */
export function costReport(events,billing,{from,to}={}){
  const unique=[...new Map(events.map(e=>[e.id,e])).values()].sort((a,b)=>a.at-b.at);
  from??=Math.min(...unique.map(e=>e.at));to??=Math.max(...unique.map(e=>e.at));
  if(!finite(from)||!finite(to)||to<from)throw Error('Explicit valid report interval required.');
  const tasks=new Map(),open=new Map(),intervals=[];
  const task=id=>{if(!tasks.has(id))tasks.set(id,{taskId:id,costUsd:0,attempts:0,accepted:false,phases:{},usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},unknownCostMs:0});return tasks.get(id);};
  for(const e of unique){
    if(e.at>to)continue;
    if(e.taskId)task(e.taskId);
    if(e.type==='turn-start'){if(!e.child){task(e.taskId).attempts++;task(e.taskId).accepted=false;task(e.taskId).lastRunId=e.runId;}open.set(e.runId,{taskId:e.taskId,start:e.at});}
    if(e.type==='turn-end'&&open.has(e.runId)){const r=open.get(e.runId);intervals.push({...r,end:e.at});open.delete(e.runId);}
    if(e.type==='accepted'&&(!e.runId||task(e.taskId).lastRunId===e.runId))task(e.taskId).accepted=true;
    if(e.type==='source-changed'||e.type==='verification-failed')task(e.taskId).accepted=false;
    if(e.type==='phase'&&e.start<=to&&e.end>=from){const t=task(e.taskId);(t.phases[e.phase]??=[]).push([Math.max(from,e.start),Math.min(to,e.end)]);}
    if(e.type==='usage'&&e.at>=from&&e.at<=to){const t=task(e.taskId);for(const key of Object.keys(t.usage))if(finite(e[key]))t.usage[key]+=e[key];}
  }
  for(const r of open.values())intervals.push({...r,end:to});
  const periods=[...billing].sort((a,b)=>a.from-b.from);
  for(let i=0;i<periods.length;i++){const b=periods[i];if(!finite(b.from)||!finite(b.to)||b.to<=b.from||!finite(b.computeUsdPerHour)||!finite(b.storageUsdPerHour)||!b.source||i&&b.from<periods[i-1].to)throw Error('Billing windows need nonoverlapping intervals, explicit compute/storage rates and provenance.');}
  const points=[...new Set([from,to,...intervals.flatMap(r=>[r.start,r.end]),...periods.flatMap(b=>[b.from,b.to])].filter(x=>x>=from&&x<=to))].sort((a,b)=>a-b);
  let totalCostUsd=0,unattributedCostUsd=0,unknownCostMs=0;
  for(let i=0;i<points.length-1;i++){
    const start=points[i],end=points[i+1],ms=end-start,b=periods.find(x=>x.from<=start&&x.to>=end);
    const active=[...new Set(intervals.filter(r=>r.start<=start&&r.end>=end).map(r=>r.taskId))];
    if(!b){unknownCostMs+=ms;for(const id of active)task(id).unknownCostMs+=ms/Math.max(1,active.length);continue;}
    const cost=ms/3600000*(b.computeUsdPerHour+b.storageUsdPerHour);totalCostUsd+=cost;
    if(!active.length)unattributedCostUsd+=cost;else for(const id of active)task(id).costUsd+=cost/active.length;
  }
  for(const t of tasks.values())for(const [name,ranges]of Object.entries(t.phases))t.phases[name+'Ms']=intervalUnion(ranges);
  for(const t of tasks.values())for(const key of Object.keys(t.phases))if(!key.endsWith('Ms'))delete t.phases[key];
  const accepted=[...tasks.values()].filter(t=>t.accepted).length;
  return{from,to,allocation:'equal share among active root tasks; idle remains unattributed; phase intervals can overlap',knownCostUsd:totalCostUsd,unattributedCostUsd,unknownCostMs,acceptedTasks:accepted,costPerAcceptedTaskUsd:accepted&&unknownCostMs===0?totalCostUsd/accepted:null,tasks:[...tasks.values()]};
}
