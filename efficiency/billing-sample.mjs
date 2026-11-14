import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export async function sampleBilling({instanceId,keyFile,fetcher=fetch,now=Date.now}={}){
  if(!/^\d+$/u.test(String(instanceId)))throw Error('Numeric instance id required.');
  const key=(await fs.readFile(keyFile,'utf8')).trim();
  const response=await fetcher(`https://console.vast.ai/api/v0/instances/${instanceId}/`,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`Vast billing snapshot HTTP ${response.status}`);
  const body=await response.json(),value=Array.isArray(body.instances)?body.instances.find(x=>String(x.id)===String(instanceId)):body.instances;
  if(!value||String(value.id)!==String(instanceId))throw Error('Unexpected instance response.');
  const total=value.dph_total,storage=value.storage_total_cost,status=value.actual_status;
  const valid=typeof total==='number'&&Number.isFinite(total)&&typeof storage==='number'&&Number.isFinite(storage)&&storage>=0&&total>=storage;
  const known=valid&&['running','stopped'].includes(status);
  return{at:now(),instanceId:Number(instanceId),status,computeUsdPerHour:known?(status==='running'?total-storage:0):null,storageUsdPerHour:valid?storage:null,source:'Vast instance API dph_total minus storage_total_cost; storage counted once',costBasis:'observed hourly-rate estimate, not invoice reconciliation',excluded:['network transfers','external API charges without explicit billing records']};
}
export function billingWindows(observations,{maxGapMs=120000}={}){
  const sorted=[...observations].sort((a,b)=>a.at-b.at),windows=[];
  for(let i=1;i<sorted.length;i++){const a=sorted[i-1],b=sorted[i];
    if(a.instanceId!==b.instanceId||a.status!==b.status||a.computeUsdPerHour!==b.computeUsdPerHour||a.storageUsdPerHour!==b.storageUsdPerHour||b.at<=a.at||b.at-a.at>maxGapMs||a.computeUsdPerHour===null||a.storageUsdPerHour===null)continue;
    windows.push({from:a.at,to:b.at,computeUsdPerHour:a.computeUsdPerHour,storageUsdPerHour:a.storageUsdPerHour,source:a.source,costBasis:a.costBasis});
  }
  return windows;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const value=await sampleBilling({instanceId:process.argv[2],keyFile:process.argv[3]});if(process.argv[4])await fs.appendFile(process.argv[4],JSON.stringify(value)+'\n',{mode:0o600});console.log(JSON.stringify(value));}catch(e){console.error(e.message);process.exitCode=1;}}
