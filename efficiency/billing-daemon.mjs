import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sampleBilling,billingWindows} from './billing-sample.mjs';

export function resolveBillingKeyFile(guard,env=process.env){
  const file=env.HARNESS_VAST_KEY_FILE??guard.vastApiKeyFile??'/data/harness/root-secrets/vast-api.key';
  if(typeof file!=='string'||file.length>4096||file.includes('\0')||!path.isAbsolute(file))throw Error('Vast credential file must be an absolute path.');
  return file;
}

export async function collectBilling({directory,instanceId,keyFile,previous,sample=sampleBilling,maxBytes=8*1024*1024,signal}={}){
  await fs.mkdir(directory,{recursive:true});
  if(process.getuid?.()===0){const owner=await fs.stat(path.dirname(directory));await fs.chown(directory,owner.uid,owner.gid);}
  const file=path.join(directory,'billing-observations.jsonl'),windows=path.join(directory,'billing-windows.jsonl');
  const stat=await fs.stat(file).catch(()=>null);
  if((stat?.size??0)>maxBytes){await fs.writeFile(file+'.stopped.json',JSON.stringify({at:Date.now(),reason:'BILLING_CAPACITY'}),{mode:0o640});throw Error('Billing observation capacity reached; export the ledger before continuing.');}
  if(stat){const handle=await fs.open(file,'r');try{const buffer=Buffer.alloc(Math.min(8192,stat.size));await handle.read(buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));previous=undefined;for(const line of buffer.toString().trim().split('\n').reverse())try{previous=JSON.parse(line);break;}catch{}}finally{await handle.close();}}
  const observation=await sample({instanceId,keyFile,signal});
  const intervals=billingWindows([...(previous?[previous]:[]),observation]);
  await fs.appendFile(file,JSON.stringify(observation)+'\n',{mode:0o640});
  if(intervals.length)await fs.appendFile(windows,intervals.map(x=>JSON.stringify(x)).join('\n')+'\n',{mode:0o640});
  // Root retains the credential; Harness can read only sanitized measurements.
  if(process.getuid?.()===0){const {gid}=await fs.stat(directory);for(const target of [file,windows])try{await fs.chown(target,0,gid);await fs.chmod(target,0o640);}catch(e){if(e.code!=='ENOENT')throw e;}}
  await fs.writeFile(path.join(directory,'billing-status.json'),JSON.stringify({at:Date.now(),pid:process.pid,lastObservationAt:observation.at,source:observation.source}),{mode:0o644});
  return observation;
}
async function main(){
  const root='/data/harness',directory=root+'/state/efficiency',controller=new AbortController();let previous,stopped=false;
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;controller.abort();});
  while(!stopped){try{const guard=JSON.parse(await fs.readFile(root+'/root-secrets/guard.json','utf8'));previous=await collectBilling({directory,instanceId:guard.instanceId,keyFile:resolveBillingKeyFile(guard),previous,signal:controller.signal});}catch(e){if(!stopped)console.error('Billing measurement unavailable: '+e.message);}
    if(!stopped)await new Promise(r=>{let timer;const finish=()=>{clearTimeout(timer);process.removeListener('SIGTERM',finish);process.removeListener('SIGINT',finish);r();};timer=setTimeout(finish,60000);process.once('SIGTERM',finish);process.once('SIGINT',finish);});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
