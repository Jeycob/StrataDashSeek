import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {costReport} from './ledger.mjs';

export function summarizeRequests(events){
  const rows=events.filter(e=>e.type==='request-end'),unique=new Map();
  for(const row of rows)if(row.engine?.engineRequestId)unique.set(row.engine.engineRequestId,row.engine);
  const measured=[...unique.values()],sum=key=>measured.reduce((n,r)=>n+(Number.isFinite(r[key])?r[key]:0),0);
  const starts=new Map(events.filter(e=>e.type==='request-start').map(e=>[e.requestId,e])),appsActivity={busy:0,idle:0,unknown:0};
  for(const row of rows){const apps=starts.get(row.requestId)?.resources?.apps;appsActivity[apps===null||apps===undefined||typeof apps.active!=='number'?'unknown':apps.active>0?'busy':'idle']++;}
  return{requests:rows.length,measuredEngineRequests:measured.length,missingEngineMeasurements:rows.filter(r=>!r.engine).length,prefillMs:sum('prefillMs'),decodeMs:sum('decodeMs'),promptTokens:sum('promptTokens'),reusedTokens:sum('reusedTokens'),cacheReuseFraction:sum('promptTokens')?sum('reusedTokens')/sum('promptTokens'):null,appsActivity};
}
export async function generateReport({eventsFile,billingFile,from,to}){
  const text=await fs.readFile(eventsFile,'utf8'),events=[];let invalidLines=0;
  for(const line of text.split('\n').filter(Boolean))try{const e=JSON.parse(line);if(typeof e.id!=='string'||typeof e.type!=='string'||!Number.isFinite(e.at)||e.at<0)throw Error('Invalid event');events.push(e);}catch{invalidLines++;}
  let billing=[];const selectedBilling=billingFile??path.join(path.dirname(eventsFile),'billing-windows.jsonl');
  try{const text=await fs.readFile(selectedBilling,'utf8');billing=text.trim().startsWith('[')?JSON.parse(text):text.split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(e){if(billingFile||e.code!=='ENOENT')throw e;}
  let stopped;try{stopped=JSON.parse(await fs.readFile(eventsFile+'.stopped.json','utf8'));}catch{}
  const report=costReport(events,billing,{from,to:to??Date.now()}),measurementComplete=!stopped&&!invalidLines,window=events.filter(e=>e.at>=report.from&&e.at<=report.to);
  return{...report,tasks:report.tasks.map(task=>({...task,inference:summarizeRequests(window.filter(e=>e.taskId===task.taskId))})),measurementComplete,invalidLines,...(stopped?{stopped}:{}),...summarizeRequests(window),costPerAcceptedTaskUsd:measurementComplete?report.costPerAcceptedTaskUsd:null,acceptanceDefinition:'Latest attempt passed the declared verification contract and its source hash still matched at turn end; not independent proof of every natural-language requirement.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await generateReport({eventsFile:process.argv[2],billingFile:process.argv[3],...(process.argv[4]?{from:Number(process.argv[4])}:{}),...(process.argv[5]?{to:Number(process.argv[5])}:{})}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
