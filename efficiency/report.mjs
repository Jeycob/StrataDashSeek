import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {costReport} from './ledger.mjs';

export function summarizeRequests(events){
  const rows=events.filter(e=>e.type==='request-end'),unique=new Map();
  for(const row of rows)if(row.engine?.engineRequestId)unique.set(row.engine.engineRequestId,row.engine);
  const measured=[...unique.values()],sum=key=>measured.reduce((n,r)=>n+(Number.isFinite(r[key])?r[key]:0),0);
  return{requests:rows.length,measuredEngineRequests:measured.length,missingEngineMeasurements:rows.filter(r=>!r.engine).length,prefillMs:sum('prefillMs'),decodeMs:sum('decodeMs'),promptTokens:sum('promptTokens'),reusedTokens:sum('reusedTokens'),cacheReuseFraction:sum('promptTokens')?sum('reusedTokens')/sum('promptTokens'):null};
}
export async function generateReport({eventsFile,billingFile,from,to}){
  const text=await fs.readFile(eventsFile,'utf8'),events=[];let invalidLines=0;
  for(const line of text.split('\n').filter(Boolean))try{events.push(JSON.parse(line));}catch{invalidLines++;}
  const billing=billingFile?JSON.parse(await fs.readFile(billingFile,'utf8')):[];
  let stopped;try{stopped=JSON.parse(await fs.readFile(eventsFile+'.stopped.json','utf8'));}catch{}
  const report=costReport(events,billing,{from,to}),measurementComplete=!stopped&&!invalidLines;
  return{...report,measurementComplete,invalidLines,...(stopped?{stopped}:{}),...summarizeRequests(events.filter(e=>e.at>=report.from&&e.at<=report.to)),costPerAcceptedTaskUsd:measurementComplete?report.costPerAcceptedTaskUsd:null,acceptanceDefinition:'Latest attempt passed the declared verification contract and its source hash still matched at turn end; not independent proof of every natural-language requirement.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await generateReport({eventsFile:process.argv[2],billingFile:process.argv[3]}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
