// Root collector output is isolated from the agent's efficiency event ledger.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {collectBilling,resolveBillingKeyFile} from '../efficiency/billing-daemon.mjs';
import {isMain} from '../runtime/require.cjs';
const runtime=createRequire(import.meta.url)('./runtime-paths.cjs');
function publicLedger(raw,name){
 const keys=name==='billing-windows.jsonl'?['from','to','computeUsdPerHour','storageUsdPerHour']:['at','instanceId','computeUsdPerHour','storageUsdPerHour'];
 return raw.toString('utf8').split('\n').filter(Boolean).map(line=>{const row=JSON.parse(line),value=Object.fromEntries(keys.map(k=>[k,typeof row[k]==='number'&&Number.isFinite(row[k])?row[k]:null]));if(name!=='billing-windows.jsonl')value.status=['running','stopped','exited'].includes(row.status)?row.status:'unknown';for(const k of['source','costBasis'])value[k]=runtime.publicValue('billing-status.json',{source:row[k]}).source;return JSON.stringify(value);}).join('\n')+'\n';
}
export async function collectPrivateBilling(root,{sample,signal}={}){
 const p=runtime.control(root),directory=runtime.ensureDirectory(path.join(p.privateState,'billing'));
 for(const name of['billing-observations.jsonl','billing-windows.jsonl','billing-status.json','billing-observations.jsonl.stopped.json'])runtime.trustedFile(path.join(directory,name),{optional:true});
 const guardFile=path.join(root,'root-secrets/guard.json');runtime.trustedFile(guardFile);const guard=JSON.parse(fs.readFileSync(guardFile,'utf8'));
 const value=await collectBilling({directory,instanceId:guard.instanceId,keyFile:resolveBillingKeyFile(guard),sample,signal});
 runtime.publish(root,'billing-status.json',{at:Date.now(),pid:process.pid,lastObservationAt:value.at,source:value.source});
 // These ledgers contain the existing allowlisted hourly-rate observations,
 // never the provider response or key. Legacy agent-writable files are retained.
 for(const name of['billing-observations.jsonl','billing-windows.jsonl']){const file=path.join(directory,name);if(!runtime.trustedFile(file,{optional:true}))continue;const st=fs.statSync(file);if(st.size>8*1024**2)throw Error('Billing publication capacity reached');runtime.atomic(path.join(p.publicState,name),publicLedger(fs.readFileSync(file),name),0o644);}
 return value;
}
if(isMain(import.meta.url)){
 const controller=new AbortController();let stopped=false;
 for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;controller.abort();});
 while(!stopped){try{await collectPrivateBilling('/data/harness',{signal:controller.signal});}catch(error){if(!stopped)console.error('Billing measurement unavailable: '+error.message);}
  if(!stopped)await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);process.removeListener('SIGINT',done);process.removeListener('SIGTERM',done);resolve();};timer=setTimeout(done,60000);process.once('SIGINT',done);process.once('SIGTERM',done);});
 }
}
