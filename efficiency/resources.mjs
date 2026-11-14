import fs from 'node:fs/promises';
import path from 'node:path';

export async function resourceSnapshot(stateRoot,{now=Date.now(),maxAgeMs=20000}={}){
  const read=async relative=>{try{const file=path.join(stateRoot,relative),stat=await fs.stat(file);if(!stat.isFile()||stat.size>1024*1024)return null;const data=JSON.parse(await fs.readFile(file,'utf8'));return Number.isFinite(data.at)&&data.at<=now&&now-data.at<=maxAgeMs?data:null;}catch{return null;}};
  const [host,apps]=await Promise.all([read('telemetry.json'),read('applications/activity.json')]);
  return{host:host?{cpuScope:host.cpu?.scope??null,effectiveCores:host.cpu?.effectiveCores??null,cpuPercent:host.cpu?.percent??null,ramAvailableBytes:host.ram?.available??null,gpuPercent:host.gpu?.percent??null}:null,apps:apps?{active:apps.active??null,workerPhase:apps.worker?.phase??null,draining:apps.draining??null}:null};
}
