'use strict';
const {LABEL}=require('./apps-engine.cjs');
const {used}=require('./apps-export-secrets.cjs');
const ID=/^[a-f0-9]{16}$/,CID=/^[a-f0-9]{64}$/;
const unavailable=()=>Object.assign(Error('LOG_REDACTION_UNAVAILABLE: Logs are withheld because redaction for this container cannot be verified. Verify and deploy reviewed source with runtime-only or no credential references to restore readable logs.'),{code:'LOG_REDACTION_UNAVAILABLE',status:409});

// Metadata only: no credential value, value digest, vault record or connection.
async function releaseEvidence(manager,projectId,releaseId,data){
 const credentials=manager.project(projectId).credentials,seen=manager.credentialBindings?.get(releaseId);
 let origin='fresh';
 if(data.rollbackOf){
  const previous=await manager.releases.get(projectId,data.rollbackOf);
  // Retained images/source may contain a historical build/runtime value. A new
  // empty mapping cannot reclassify that retained content as credential-free.
  if(previous.requiresCredentialProof!==false||previous.credentialUse?.origin==='retained-unknown')origin='retained-unknown';
 }
 const runtimeNames=[...new Set(seen?.runtimeNames||[])].sort(),buildUsed=seen?.buildUsed===true||Object.keys(credentials?.build||{}).length>0;
 return{requiresCredentialProof:used(credentials)||seen?.required===true||origin==='retained-unknown',credentialUse:{version:1,origin,runtimeNames,buildUsed}};
}

async function containerLogValues(manager,container){
 try{
  const labels=container?.Config?.Labels||{},projectId=labels[LABEL+'.project'],jobId=labels[LABEL+'.job'];
  if(!ID.test(projectId||'')||!ID.test(jobId||'')||!CID.test(container?.Id||'')||labels[LABEL]!=='managed')throw unavailable();
  const records=manager.store.jobs.filter(job=>job.id===jobId).flatMap(job=>(job.creations||[]).filter(record=>record.containerId===container.Id).map(record=>({job,record})));
  if(records.length!==1)throw unavailable();const{job,record}=records[0];
  if(!['confirmed','created'].includes(record.state)||record.projectId!==projectId||record.jobId!==job.id||record.imageId!==container.Image||container.Name!=='/'+record.name||labels[LABEL+'.create']!==record.token)throw unavailable();
  const release=await manager.releases.get(projectId,jobId),use=release.credentialUse;
  if(release.id!==jobId||release.projectId!==projectId||typeof release.requiresCredentialProof!=='boolean')throw unavailable();
  const names=record.credentialLogEnvironment;
  if(release.requiresCredentialProof===false){
   if(names!==undefined&&(!Array.isArray(names)||names.length)||use?.buildUsed===true||use?.origin==='retained-unknown')throw unavailable();
   return[];
  }
  if(use?.version!==1||use.origin!=='fresh'||use.buildUsed!==false||!Array.isArray(names)||!names.length||names.length>50||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)))throw unavailable();
  const environment=container.Config.Env;if(!Array.isArray(environment)||environment.length>1000||environment.some(value=>typeof value!=='string'||value.length>65700))throw unavailable();
  return names.map(name=>{const found=environment.filter(value=>value.startsWith(name+'='));if(found.length!==1)throw unavailable();return found[0].slice(name.length+1);});
 }catch{throw unavailable();}
}
module.exports={releaseEvidence,containerLogValues};
