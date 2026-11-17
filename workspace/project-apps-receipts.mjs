import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const {atomicJson}=createRequire(import.meta.url)('../mobile/private-json.cjs');
const id=/^[A-Za-z0-9_-]{1,128}$/,hex16=/^[a-f0-9]{16}$/,hex32=/^[a-f0-9]{32}$/;
function valid(row){return row&&Object.keys(row).every(k=>['requestId','ownerId','projectId','appsJobId','startedAt'].includes(k))&&hex32.test(row.requestId??'')&&id.test(row.ownerId??'')&&hex16.test(row.projectId??'')&&(row.appsJobId===null||hex16.test(row.appsJobId??''))&&Number.isSafeInteger(row.startedAt)&&row.startedAt>=0;}
// Private Native metadata; roots/config/credentials are never persisted here.
// One Native service owns this file. Startup must reconcile ALL entries before
// permitting new heavy work; unknown is never a proof of non-admission.
export function createProjectAppsReceiptStore(privateRoot,{assertActive=()=>{}}={}){
 if(typeof privateRoot!=='string'||!path.isAbsolute(privateRoot))throw Error('PROJECT_APPS_RECEIPT_ROOT_INVALID');
 const file=path.join(privateRoot,'project-apps-admissions.json');let queue=Promise.resolve();
 async function read(){
  let info;try{info=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return[];throw Error('PROJECT_APPS_RECEIPT_UNAVAILABLE');}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>512*1024)throw Error('PROJECT_APPS_RECEIPT_INVALID');
  let data;try{data=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw Error('PROJECT_APPS_RECEIPT_INVALID');}
  if(data?.version!==1||!Array.isArray(data.pending)||data.pending.length>1024||!data.pending.every(valid)||new Set(data.pending.map(r=>r.requestId)).size!==data.pending.length)throw Error('PROJECT_APPS_RECEIPT_INVALID');
  return data.pending;
 }
 function mutate(action,guard=false){const job=queue.then(async()=>{const rows=await read();const next=action(rows);if(next.length>1024)throw Error('PROJECT_APPS_RECEIPT_LIMIT');if(guard)assertActive();atomicJson(file,{version:1,pending:next});});queue=job.catch(()=>{});return job;}
 return{list:()=>queue.then(read),save(row){if(!valid(row))return Promise.reject(Error('PROJECT_APPS_RECEIPT_INVALID'));const copy={...row};return mutate(rows=>{const old=rows.find(r=>r.requestId===copy.requestId);if(old&&(old.ownerId!==copy.ownerId||old.projectId!==copy.projectId||old.startedAt!==copy.startedAt||old.appsJobId&&old.appsJobId!==copy.appsJobId))throw Error('PROJECT_APPS_RECEIPT_MISMATCH');return[...rows.filter(r=>r.requestId!==copy.requestId),copy];},true);},remove(requestId){if(!hex32.test(requestId??''))return Promise.reject(Error('PROJECT_APPS_RECEIPT_INVALID'));return mutate(rows=>rows.filter(r=>r.requestId!==requestId));}};
}
