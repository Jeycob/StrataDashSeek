'use strict';
// Docker is the data boundary: the Root process never opens tenant SQLite.
const fs=require('node:fs'),crypto=require('node:crypto');
const {LABEL,decodeLogs}=require('./apps-engine.cjs');
const {createManagedContainer}=require('./apps-container-create.cjs');
const ID=/^[a-f0-9]{16}$/,CID=/^[a-f0-9]{64}$/,HASH=/^[a-f0-9]{64}$/,IMAGE=/^sha256:[a-f0-9]{64}$/,DB=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const fail=(code,recovery=false)=>Object.assign(Error(code),{code,status:409,...(recovery?{phase:'recovery_required'}:{})});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const LOADER="const M=require('node:module'),m=new M('/trusted-sqlite.cjs');m.filename='/trusted-sqlite.cjs';m.paths=[];m._compile(Buffer.from(process.argv[1],'base64').toString(),'/trusted-sqlite.cjs');const p=JSON.parse(process.argv[2]);Promise.resolve(p.migrate?m.exports.migrateSqlite(p):p.inspect?m.exports.inspectPolicy(p):m.exports.snapshotSqlite(p)).then(x=>process.stdout.write(JSON.stringify(x)+'\\n'),()=>{process.stderr.write('SQLITE_HELPER_FAILED\\n');process.exitCode=1;});";
function planOf(p){
 const olds=p?.oldContainerIds??(p?.oldContainerId?[p.oldContainerId]:[]),m=p?.migration,maxBytes=p?.maxBytes??64*1024**2;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<4096||maxBytes>256*1024**2)throw fail('DEPLOYMENT_DATA_SIZE_POLICY_INVALID');
 if(!p||!ID.test(p.projectId||'')||!ID.test(p.releaseId||'')||!ID.test(p.dataGeneration||'')||!ID.test(p.candidateDataGeneration||'')||p.candidateDataGeneration===p.dataGeneration||!/^[a-z0-9][a-z0-9-]{0,31}$/.test(p.volume||'')||!DB.test(p.database||'')||typeof p.mountPath!=='string'||!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(p.mountPath)||p.mountPath.length>160||['/','/proc','/sys','/dev','/tmp'].some(x=>p.mountPath===x||p.mountPath.startsWith(x+'/'))||!Array.isArray(olds)||olds.length>8||new Set(olds).size!==olds.length||olds.some(value=>!CID.test(value))||p.engine&&p.engine!=='sqlite')throw fail('DEPLOYMENT_DATA_UNSUPPORTED');
 if(m!=null&&(typeof m!=='object'||typeof m.sql!=='string'||!m.sql.trim()||Buffer.byteLength(m.sql)>16384||m.sql.includes('\0')||!HASH.test(m.sha256||'')||crypto.createHash('sha256').update(m.sql).digest('hex')!==m.sha256||!Number.isInteger(m.fromVersion)||!Number.isInteger(m.toVersion)||m.fromVersion<0||m.toVersion<=m.fromVersion||m.toVersion>2147483647))throw fail('DEPLOYMENT_DATA_MIGRATION_INVALID');
 return{projectId:p.projectId,releaseId:p.releaseId,dataGeneration:p.dataGeneration,candidateDataGeneration:p.candidateDataGeneration,volume:p.volume,database:p.database,mountPath:p.mountPath,oldContainerIds:[...olds].sort(),maxBytes,allowLegacy:p.allowLegacy===true,...(m?{migration:{sql:m.sql,sha256:m.sha256,fromVersion:m.fromVersion,toVersion:m.toVersion}}:{})};
}
class DockerSqliteData{
 constructor(manager,job,{createContainer=createManagedContainer,helperTimeoutMs=26000,cleanupTimeoutMs=1000}={}){
  if(!manager?.engine||!ID.test(job?.id||'')||!IMAGE.test(manager.cfg?.dataHelperImageId||'')||!Number.isInteger(helperTimeoutMs)||helperTimeoutMs<1||helperTimeoutMs>26000||!Number.isInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1||cleanupTimeoutMs>1000)throw fail('DEPLOYMENT_DATA_HELPER_UNTRUSTED');
  this.manager=manager;this.job=job;this.engine=manager.engine;this.image=manager.cfg.dataHelperImageId;this.create=createContainer;this.timeout=helperTimeoutMs;this.cleanupTimeout=cleanupTimeoutMs;
  const file=require.resolve('./apps-sqlite-snapshot.cjs'),info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>32768)throw fail('DEPLOYMENT_DATA_HELPER_UNTRUSTED');this.source=fs.readFileSync(file).toString('base64');
 }
 check(p){const plan=planOf(p);if(this.job.projectId!==plan.projectId||this.job.id!==plan.releaseId||this.manager.busy!==this.job.id)throw fail('DEPLOYMENT_DATA_OPERATION_NOT_OWNED');return plan;}
 async saved(){await this.manager.save();}
 journal(p){const value=this.job.dataOperations;if(value?.version!==1||value.identity!==digest(p)||!value.operations||typeof value.operations!=='object')throw fail('DEPLOYMENT_DATA_JOURNAL_UNTRUSTED',true);return value.operations;}
 async bounded(fn,ms){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('DEPLOYMENT_DATA_HELPER_TIMEOUT',true)),Math.max(1,ms));})]);}finally{clearTimeout(timer);}}
 async once(p,key,fn){
  const signature=digest(p);this.job.dataOperations??={version:1,identity:signature,operations:{}};const journal=this.job.dataOperations;
  if(journal.version!==1||journal.identity!==signature||!journal.operations||typeof journal.operations!=='object')throw fail('DEPLOYMENT_DATA_JOURNAL_UNTRUSTED',true);
  const prior=journal.operations[key];if(prior){if(prior.state==='complete')return structuredClone(prior.proof);throw fail('DEPLOYMENT_DATA_RECOVERY_REQUIRED',true);}
  const operation=journal.operations[key]={state:'intent'};await this.saved();
  try{const proof=await fn();operation.proof=proof;operation.state='complete';await this.saved();return structuredClone(proof);}catch(error){operation.state='recovery_required';await this.saved();throw fail(error?.code&&/^DEPLOYMENT_DATA_[A-Z_]+$/.test(error.code)?error.code:'DEPLOYMENT_DATA_RECOVERY_REQUIRED',true);}
 }
 async trustedImage(p){const image=await this.engine.json('GET','/images/'+encodeURIComponent(this.image)+'/json',{timeout:3000});if(image?.Id!==this.image||image.Config?.Labels?.[LABEL+'.data-helper']!=='sqlite-v1'||Object.values(this.manager.store?.projects||{}).some(project=>project.imageId===this.image))throw fail('DEPLOYMENT_DATA_HELPER_UNTRUSTED');}
 async volume(p,name,{writer=null,legacy=false,emptyUsers=false,onlyHelpers=false}={}){
  if(typeof name!=='string'||!/^[-A-Za-z0-9_][-.A-Za-z0-9_]{0,127}$/.test(name))throw fail('DEPLOYMENT_DATA_VOLUME_UNSAFE');
  const value=await this.engine.json('GET','/volumes/'+encodeURIComponent(name),{timeout:3000});
  if(value?.Name!==name||value.Driver!=='local'||value.Scope!=='local'||Object.keys(value.Options||{}).length)throw fail('DEPLOYMENT_DATA_VOLUME_UNSAFE');
  const labels=value.Labels||{},owned=labels[LABEL]==='managed'&&labels[LABEL+'.project']===p.projectId;
  if(!owned&&(!legacy||Object.keys(labels).length))throw fail('DEPLOYMENT_DATA_VOLUME_UNOWNED');
  const list=await this.engine.json('GET','/containers/json?all=1&filters='+encodeURIComponent(JSON.stringify({volume:[name]})),{timeout:3000});
  if(!Array.isArray(list)||list.length>32)throw fail('DEPLOYMENT_DATA_VOLUME_USAGE_UNKNOWN');
  for(const row of list){if(!CID.test(row?.Id||''))throw fail('DEPLOYMENT_DATA_VOLUME_USAGE_UNKNOWN');const c=await this.engine.owned(row.Id,p.projectId),mounts=c.Mounts;
   if(!Array.isArray(mounts))throw fail('DEPLOYMENT_DATA_VOLUME_USAGE_UNKNOWN');const matching=mounts.filter(m=>m.Type==='volume'&&m.Name===name);if(matching.length!==1)throw fail('DEPLOYMENT_DATA_VOLUME_USAGE_UNKNOWN');
   if(emptyUsers||onlyHelpers&&c.Config?.Labels?.[LABEL+'.role']!=='data-helper'||c.State?.Running&&matching[0].RW!==false&&!(Array.isArray(writer)?writer:[writer]).includes(c.Id))throw fail('DEPLOYMENT_DATA_VOLUME_BUSY');
  }
  return{owned,legacy:!owned,generation:labels[LABEL+'.generation']||null,release:labels[LABEL+'.release']||null,role:labels[LABEL+'.data-role']||null};
 }
 async fresh(p,role){
  const generation=role==='shadow'?p.candidateDataGeneration:p.dataGeneration,name='sdsh-'+p.projectId+'-'+generation+'-'+p.volume;
  return this.once(p,'volume-'+role,async()=>{
   try{await this.engine.json('GET','/volumes/'+name,{timeout:2000});throw fail('DEPLOYMENT_DATA_VOLUME_EXISTS');}catch(error){if(error.dockerStatus!==404)throw error;}
   const result=await this.engine.json('POST','/volumes/create',{timeout:3000,json:{Name:name,Driver:'local',Labels:{[LABEL]:'managed',[LABEL+'.project']:p.projectId,[LABEL+'.generation']:generation,[LABEL+'.release']:p.releaseId,[LABEL+'.data-role']:role}}});
   if(result?.Name!==name)throw fail('DEPLOYMENT_DATA_VOLUME_OUTCOME_UNKNOWN',true);const v=await this.volume(p,name,{emptyUsers:true});if(v.generation!==generation||v.release!==p.releaseId||v.role!==role)throw fail('DEPLOYMENT_DATA_VOLUME_UNOWNED');return{volume:name,volumeGen:generation};
  });
 }
 async helper(p,slot,source,target,expectedSchemaHash,{migrate=false,copyMigration=false,user=null}={}){
  return this.once(p,'helper-'+slot,async()=>{
   let container=null;const deadline=Date.now()+this.timeout,remaining=()=>Math.max(1,deadline-Date.now());await this.bounded(()=>this.trustedImage(p),remaining());
   if(migrate&&!/^[0-9]{1,10}:[0-9]{1,10}$/.test(user||''))throw fail('DEPLOYMENT_DATA_HELPER_PROOF_INVALID');
   const options={database:p.database,maxBytes:p.maxBytes,...(migrate?{migrate:true,targetRoot:'/target',sql:p.migration.sql,sha256:p.migration.sha256,expectedSourceSchemaHash:expectedSchemaHash,fromVersion:p.migration.fromVersion,toVersion:p.migration.toVersion}:{sourceRoot:'/source',...(target?{targetRoot:'/target',timeoutMs:Math.min(15000,this.timeout),...(copyMigration?{migration:p.migration}:{}),...(expectedSchemaHash?{expectedSchemaHash}:{})}:{inspect:true})})};
   const mount=(volume,destination,readOnly)=>({Type:'volume',Source:volume,Target:destination,ReadOnly:readOnly,VolumeOptions:{NoCopy:true}});
   try{
    const result=await this.bounded(()=>this.create(this.manager,this.job,{Image:this.image,User:migrate?user:'0:0',Entrypoint:['/usr/local/bin/node','-e'],Cmd:[LOADER,this.source,JSON.stringify(options)],Labels:{[LABEL]:'managed',[LABEL+'.project']:p.projectId,[LABEL+'.role']:'data-helper'},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Memory:128*1024**2,MemorySwap:128*1024**2,NanoCpus:500000000,PidsLimit:16,CapDrop:['ALL'],...(!migrate?{CapAdd:['CHOWN','DAC_READ_SEARCH']}:{}),SecurityOpt:['no-new-privileges:true'],RestartPolicy:{Name:'no'},Mounts:[...(source?[mount(source,'/source',true)]:[]),...(target?[mount(target,'/target',false)]:[])]}},{slot,createTimeoutMs:Math.min(15000,this.timeout),reconcileMs:Math.min(1000,this.timeout),intervalMs:100}),remaining());
    if(!CID.test(result?.Id||''))throw fail('DEPLOYMENT_DATA_HELPER_OUTCOME_UNKNOWN',true);
    const c=await this.bounded(()=>this.engine.owned(result.Id,p.projectId),remaining());if(c.Image!==this.image||c.Config?.Labels?.[LABEL+'.role']!=='data-helper'||c.Config.Labels[LABEL+'.job']!==this.job.id)throw fail('DEPLOYMENT_DATA_HELPER_OUTCOME_UNKNOWN',true);container=result.Id;
    await this.bounded(()=>this.engine.request('POST','/containers/'+container+'/start',{timeout:remaining()}),remaining());
    const exit=await this.bounded(()=>this.engine.json('POST','/containers/'+container+'/wait?condition=not-running',{timeout:remaining()}),remaining());if(exit?.StatusCode!==0)throw fail('DEPLOYMENT_DATA_HELPER_FAILED');
    const log=await this.bounded(()=>this.engine.request('GET','/containers/'+container+'/logs?stdout=1&stderr=0&tail=2',{timeout:remaining(),maxBytes:2048}),remaining());let proof;try{proof=JSON.parse(decodeLogs(log.body).trim());}catch{throw fail('DEPLOYMENT_DATA_HELPER_PROOF_INVALID');}
    if(proof?.version!==1||proof.database!==p.database||!HASH.test(proof.schemaHash||'')||!Number.isSafeInteger(proof.bytes)||proof.bytes<0||proof.bytes>p.maxBytes||!migrate&&!copyMigration&&expectedSchemaHash&&proof.schemaHash!==expectedSchemaHash||proof.userVersion!==undefined&&(!Number.isInteger(proof.userVersion)||proof.userVersion<0)||['uid','gid'].some(k=>proof[k]!==undefined&&(!Number.isSafeInteger(proof[k])||proof[k]<0||proof[k]>4294967295))||(migrate||copyMigration)&&(proof.userVersion!==p.migration.toVersion||proof.migrationSha256!==p.migration.sha256||proof.existingDataPreserved!==true)||copyMigration&&proof.sourceSchemaHash!==expectedSchemaHash||migrate&&(proof.fromVersion!==p.migration.fromVersion||proof.toVersion!==p.migration.toVersion)||Object.keys(proof).some(key=>!['version','kind','database','bytes','schemaHash','sourceSchemaHash','userVersion','uid','gid','migrationSha256','fromVersion','toVersion','existingDataPreserved'].includes(key)))throw fail('DEPLOYMENT_DATA_HELPER_PROOF_INVALID');
    return{version:1,schemaHash:proof.schemaHash,bytes:proof.bytes,...Object.fromEntries(['userVersion','uid','gid','migrationSha256'].filter(k=>proof[k]!==undefined).map(k=>[k,proof[k]]))};
   }finally{
    // Only the nonce-owned helper is stopped. Never touch an app writer here.
    if(container){for(const route of ['/stop?t=0','/kill?signal=KILL'])try{await this.bounded(()=>this.engine.request('POST','/containers/'+container+route,{timeout:this.cleanupTimeout}),this.cleanupTimeout);}catch{}}
   }
  });
 }
 async inspectActive(input){const p=this.check(input);if(!p.oldContainerIds.length)return{version:1,firstDeployment:true,projectId:p.projectId,dataGeneration:p.dataGeneration};
  let name;const writers=[];for(const id of p.oldContainerIds){const c=await this.engine.owned(id,p.projectId);if(c.Id!==id||c.Image===this.image||!Array.isArray(c.Mounts)||c.Mounts.length>1)throw fail('DEPLOYMENT_DATA_ACTIVE_UNSUPPORTED');if(!c.Mounts.length)continue;
   const m=c.Mounts[0];if(m.Type!=='volume'||m.Destination!==p.mountPath||m.RW!==true||!m.Name||name&&name!==m.Name)throw fail('DEPLOYMENT_DATA_ACTIVE_UNSUPPORTED');name=m.Name;writers.push(id);}
  if(!name||!writers.length)throw fail('DEPLOYMENT_DATA_ACTIVE_UNSUPPORTED');
  const ownership=await this.volume(p,name,{writer:writers,legacy:p.allowLegacy}),proof=await this.helper(p,'db-inspect-active',name);
  if(p.migration&&proof.userVersion!==p.migration.fromVersion)throw fail('DEPLOYMENT_DATA_MIGRATION_VERSION_MISMATCH');
  return{...proof,firstDeployment:false,projectId:p.projectId,dataGeneration:p.dataGeneration,volumeGen:ownership.generation,activeContainerIds:writers,activeVolume:name,legacyAdoption:ownership.legacy};
 }
 async migrate(p,role,volume,proof){if(!p.migration)return proof;if(!Number.isSafeInteger(proof.uid)||!Number.isSafeInteger(proof.gid))throw fail('DEPLOYMENT_DATA_HELPER_PROOF_INVALID');await this.volume(p,volume);return this.helper(p,'db-inspect-migrate-'+role,null,volume,proof.schemaHash,{migrate:true,user:proof.uid+':'+proof.gid});}
 async prepareShadow(input,active){const p=this.check(input);if(!active||active.projectId!==p.projectId||active.dataGeneration!==p.dataGeneration||active.firstDeployment!==!p.oldContainerIds.length)throw fail('DEPLOYMENT_DATA_PROOF_MISMATCH');
  const shadow=await this.fresh(p,'shadow');let proof={};if(p.oldContainerIds.length){const observed=await this.inspectActive(p);if(observed.activeVolume!==active.activeVolume||observed.schemaHash!==active.schemaHash)throw fail('DEPLOYMENT_DATA_PROOF_MISMATCH');await this.volume(p,shadow.volume,{emptyUsers:true});proof=await this.helper(p,'db-shadow',active.activeVolume,shadow.volume,active.schemaHash,{copyMigration:!!p.migration});}
  return this.once(p,'prepared-shadow',async()=>({version:1,projectId:p.projectId,dataGeneration:p.dataGeneration,volumeGen:p.candidateDataGeneration,shadowVolume:shadow.volume,firstDeployment:active.firstDeployment,...(active.activeVolume?{activeVolume:active.activeVolume,sourceSchemaHash:active.schemaHash}:{}),...proof}));
 }
 async verifyShadow(input,shadow,{captureBaseline=false,candidateContainerId=null}={}){const p=this.check(input);this.shadow(p,shadow);if(candidateContainerId!==null&&!CID.test(candidateContainerId))throw fail('DEPLOYMENT_DATA_PROOF_MISMATCH');
  const operations=this.journal(p),prepared=operations['prepared-shadow'];if(prepared?.state!=='complete')throw fail('DEPLOYMENT_DATA_PREPARATION_REQUIRED');
  for(const key of ['projectId','dataGeneration','volumeGen','shadowVolume','firstDeployment','activeVolume','sourceSchemaHash'])if(prepared.proof[key]!==shadow[key])throw fail('DEPLOYMENT_DATA_PROOF_MISMATCH');
  if(captureBaseline&&!shadow.firstDeployment)throw fail('DEPLOYMENT_DATA_BASELINE_UNEXPECTED');
  await this.volume(p,shadow.shadowVolume,{writer:candidateContainerId});let proof=await this.helper(p,captureBaseline?'db-inspect-baseline':'db-inspect-tested',shadow.shadowVolume);
  let migrationDisposition;
  if(shadow.firstDeployment&&captureBaseline&&p.migration){if(proof.userVersion===p.migration.fromVersion){proof=await this.migrate(p,'shadow',shadow.shadowVolume,proof);migrationDisposition='applied-before-tests';}else if(proof.userVersion===p.migration.toVersion)migrationDisposition='fresh-first-deployment-already-target';else throw fail('DEPLOYMENT_DATA_MIGRATION_VERSION_MISMATCH');}
  const expected=prepared.proof.schemaHash||operations.baseline?.proof?.schemaHash;if(expected&&proof.schemaHash!==expected||p.migration&&proof.userVersion!==p.migration.toVersion)throw fail('DEPLOYMENT_DATA_SCHEMA_CHANGE_UNSUPPORTED');
  if(shadow.firstDeployment&&captureBaseline){return this.once(p,'baseline',async()=>{const final=await this.fresh(p,'final');await this.volume(p,final.volume,{emptyUsers:true});const baseline=await this.helper(p,'db-final',shadow.shadowVolume,final.volume,proof.schemaHash);return{...shadow,...proof,...baseline,finalVolume:final.volume,finalVolumeGen:p.dataGeneration,baselineCaptured:true,...(p.migration?{migrationPreparedBeforeTests:true,migrationSha256:p.migration.sha256,migrationDisposition}:{})};});}
  if(shadow.firstDeployment&&!expected)throw fail('DEPLOYMENT_DATA_BASELINE_REQUIRED');return this.once(p,'verified-shadow',async()=>({...prepared.proof,...(shadow.firstDeployment?operations.baseline.proof:{}),...proof,verified:true}));
 }
 shadow(p,shadow){if(!shadow||shadow.projectId!==p.projectId||shadow.dataGeneration!==p.dataGeneration||shadow.volumeGen!==p.candidateDataGeneration||shadow.shadowVolume!=='sdsh-'+p.projectId+'-'+p.candidateDataGeneration+'-'+p.volume||shadow.firstDeployment!==!p.oldContainerIds.length)throw fail('DEPLOYMENT_DATA_PROOF_MISMATCH');}
 async finalizeLatest(input,shadow){const p=this.check(input);this.shadow(p,shadow);if(!shadow.verified)throw fail('DEPLOYMENT_DATA_VERIFICATION_REQUIRED');
  const operations=this.journal(p),verified=operations['verified-shadow'],tested=operations['helper-db-inspect-tested'];
  if(verified?.state!=='complete'||tested?.state!=='complete'||digest(verified.proof)!==digest(shadow)||tested.proof.schemaHash!==shadow.schemaHash||tested.proof.bytes!==shadow.bytes)throw fail('DEPLOYMENT_DATA_VERIFICATION_REQUIRED');
  // One durable cutover attempt only. Even a completed result cannot be reused:
  // a resumed old writer could have accepted data after that snapshot. Recovery
  // must reconcile separately or use a NEW release and both new generations.
  if(operations.finalization)throw fail('DEPLOYMENT_DATA_FINALIZATION_CONSUMED',true);
  if(p.oldContainerIds.length)for(const id of p.oldContainerIds){const c=await this.engine.owned(id,p.projectId);if(c.State?.Running!==false||!Array.isArray(c.Mounts)||c.Mounts.some(m=>m.Type!=='volume'||m.Name!==shadow.activeVolume||m.Destination!==p.mountPath))throw fail('DEPLOYMENT_DATA_OLD_WRITER_NOT_STOPPED');}
  // Recheck after the asynchronous writer reads, then claim synchronously.
  if(operations.finalization)throw fail('DEPLOYMENT_DATA_FINALIZATION_CONSUMED',true);
  operations.finalization={state:'intent',verifiedProofHash:digest(shadow)};
  try{await this.saved();}catch{throw fail('DEPLOYMENT_DATA_JOURNAL_UNAVAILABLE',true);}
  try{const result=await this.finalCopy(p,shadow);operations.finalization.proof=result;operations.finalization.state='complete';await this.saved();return structuredClone(result);}catch(error){operations.finalization.state='recovery_required';await this.saved();throw fail(error.code?.startsWith('DEPLOYMENT_DATA_')?error.code:'DEPLOYMENT_DATA_RECOVERY_REQUIRED',true);}
 }
 async finalCopy(p,shadow){
  if(!p.oldContainerIds.length){const baseline=this.job.dataOperations?.operations?.baseline;if(baseline?.state!=='complete'||!baseline.proof.baselineCaptured)throw fail('DEPLOYMENT_DATA_BASELINE_REQUIRED');await this.volume(p,baseline.proof.finalVolume,{onlyHelpers:true});return{version:1,projectId:p.projectId,volumeGen:p.dataGeneration,finalVolume:baseline.proof.finalVolume,schemaHash:baseline.proof.schemaHash,bytes:baseline.proof.bytes,...(baseline.proof.userVersion!==undefined?{userVersion:baseline.proof.userVersion}:{})};}
  for(const id of p.oldContainerIds){const c=await this.engine.owned(id,p.projectId);if(c.State?.Running!==false||!Array.isArray(c.Mounts)||c.Mounts.some(m=>m.Type!=='volume'||m.Name!==shadow.activeVolume||m.Destination!==p.mountPath))throw fail('DEPLOYMENT_DATA_OLD_WRITER_NOT_STOPPED');}
  await this.volume(p,shadow.activeVolume,{legacy:p.allowLegacy});const final=await this.fresh(p,'final');await this.volume(p,final.volume,{emptyUsers:true});const proof=await this.helper(p,'db-final',shadow.activeVolume,final.volume,shadow.sourceSchemaHash,{copyMigration:!!p.migration});if(proof.schemaHash!==shadow.schemaHash||p.migration&&proof.userVersion!==p.migration.toVersion)throw fail('DEPLOYMENT_DATA_SCHEMA_CHANGE_UNSUPPORTED',true);return{...proof,projectId:p.projectId,volumeGen:p.dataGeneration,finalVolume:final.volume,firstDeployment:false};
 }
}
module.exports={DockerSqliteData,planOf};
