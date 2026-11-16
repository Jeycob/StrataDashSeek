'use strict';
const crypto=require('node:crypto');
const {LABEL}=require('./apps-engine.cjs');
const {prepareManagedCreate,bindManagedCreate}=require('./apps-managed-resources.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const unresolved=record=>['pending','unknown','cleanup-pending'].includes(record.state);
const legacyPending=job=>job.status==='failed'&&job.stage==='candidate'&&job.action==='verify'&&!job.legacyCreationOutcome&&job.error==='Docker operation timed out: POST /containers/create';
const SLOT=/^[a-z][a-z0-9-]{0,31}$/;
function recordName(record){return 'sdsh-'+(record.role==='test'?'test-':'')+record.projectId+'-'+record.jobId+(record.slot?'-'+record.slot:'');}
function validRecord(record,job){return record&&/^[a-f0-9]{16}$/.test(record.projectId||'')&&record.jobId===job.id&&/^[a-f0-9]{16}$/.test(job.id||'')&&['test','candidate'].includes(record.role)&&(record.slot===undefined||typeof record.slot==='string'&&SLOT.test(record.slot))&&record.name===recordName(record)&&/^[a-f0-9]{32}$/.test(record.token||'')&&/^sha256:[a-f0-9]{64}$/.test(record.imageId||'');}
function retainJobs(jobs,projects={}){const recent=new Set(jobs.slice(-100)),published=Object.values(projects),releases=new Set(published.map(p=>p.releaseId).filter(Boolean)),containers=new Set(published.map(p=>p.containerId).filter(Boolean));return jobs.filter(job=>recent.has(job)||releases.has(job.id)||(job.creations||[]).some(c=>containers.has(c.containerId))||legacyPending(job)||(job.creations||[]).some(unresolved)||(job.creations||[]).some(c=>['pending','unknown'].includes(c.resourceStart?.state))||job.deploymentPhase==='recovery_required'||job.dataOperations&&(!job.dataOperations.operations||Object.values(job.dataOperations.operations).some(operation=>operation?.state!=='complete')));}
function matches(record,c){
 const labels=c?.Config?.Labels||{};
 return /^[a-f0-9]{64}$/.test(c?.Id||'')&&c.Image===record.imageId&&c.Name==='/'+record.name&&labels[LABEL]==='managed'&&labels[LABEL+'.project']===record.projectId&&labels[LABEL+'.job']===record.jobId&&labels[LABEL+'.create']===record.token&&(record.slot===undefined||labels[LABEL+'.slot']===record.slot);
}
function neverStarted(c){return c?.State?.Status==='created'&&c.State.Running===false&&/^0001-01-01T/.test(c.State.StartedAt||'');}
async function inspect(manager,record,timeout=15000){try{return await manager.engine.json('GET','/containers/'+record.name+'/json',{timeout});}catch(e){if(e.dockerStatus===404)return null;throw e;}}
function unknown(record,cause){record.state='unknown';return new Error('Container creation outcome is unresolved for '+record.name+'; inspect the existing operation before retrying',{cause});}
async function createManagedContainer(manager,job,json,{createTimeoutMs=120000,reconcileMs=30000,intervalMs=250,slot}={}){
 const projectId=json?.Labels?.[LABEL+'.project'];
 if(!/^[a-f0-9]{16}$/.test(projectId||'')||!/^[a-f0-9]{16}$/.test(job?.id||'')||!/^sha256:[a-f0-9]{64}$/.test(json?.Image||'')||json.Labels[LABEL]!=='managed')throw Error('Managed container creation requires immutable image and project/job identities');
 if(!Number.isInteger(createTimeoutMs)||createTimeoutMs<1||createTimeoutMs>120000||!Number.isInteger(reconcileMs)||reconcileMs<1||reconcileMs>30000||!Number.isInteger(intervalMs)||intervalMs<1||intervalMs>1000)throw Error('Invalid bounded creation timing');
 if(slot!==undefined&&(typeof slot!=='string'||!SLOT.test(slot)))throw Error('Invalid managed creation slot');
 const role=json.Labels[LABEL+'.role']==='test'?'test':'candidate',record={token:crypto.randomBytes(16).toString('hex'),projectId,jobId:job.id,imageId:json.Image,role,...(slot?{slot}:{}),state:'pending',at:Date.now()};record.name=recordName(record);
 if(slot&&(job.creations||[]).some(previous=>previous.name===record.name))throw Object.assign(Error('This deployment step already has a recorded creation; reconcile its outcome before continuing'),{code:'DOCKER_CREATION_RECONCILIATION_REQUIRED',status:409});
 (job.creations??=[]).push(record);manager.save();
 const body={...json,Labels:{...json.Labels,[LABEL+'.job']:job.id,[LABEL+'.create']:record.token,...(slot?{[LABEL+'.slot']:slot}:{})}};
 manager.log(job,'Creating '+role+' container; bounded Docker deadline '+createTimeoutMs+' ms.\n');
 let createIssued=false;try{
  await prepareManagedCreate(manager,record,body);
  let created;
  try{createIssued=true;created=await manager.engine.json('POST','/containers/create?name='+record.name,{json:body,timeout:createTimeoutMs});}
  catch(cause){
   // A rejected request is different from a lost response. Never repeat POST:
   // the daemon can finish copying the filesystem after the caller times out.
   if(cause.dockerStatus>=400){record.state='rejected';throw cause;}
   const deadline=Date.now()+reconcileMs;
   while(Date.now()<deadline){
    let c;try{c=await inspect(manager,record,Math.max(1,Math.min(15000,deadline-Date.now())));}catch(e){throw unknown(record,e);}
    if(c){if(!matches(record,c)||!neverStarted(c))throw unknown(record,cause);created={Id:c.Id};record.reconciled=true;manager.log(job,'Recovered the original container after a lost create response; no second create was sent.\n');break;}
    await pause(Math.min(intervalMs,Math.max(1,deadline-Date.now())));
   }
   if(!created)throw unknown(record,cause);
  }
  if(!/^[a-f0-9]{64}$/.test(created?.Id||''))throw unknown(record,Error('Invalid created container id'));
  await bindManagedCreate(manager,record,created.Id);record.state='confirmed';record.containerId=created.Id;return created;
 }catch(e){if(record.state==='pending')record.state=createIssued?'unknown':'rejected';if(!createIssued&&e.resourceDiagnostic)record.resourceAdmission=e.resourceDiagnostic;throw e;}
 finally{manager.save();}
}
async function reconcilePendingCreations(manager){
 for(const job of manager.store.jobs)for(const record of job.creations||[]){
  if(!unresolved(record))continue;
  if(!validRecord(record,job))throw Error('Invalid unresolved container identity; automatic Docker mutation refused');
  const c=await inspect(manager,record);
  if(!c){if(record.state==='cleanup-pending'){record.state='cleaned';manager.save();continue;}throw unknown(record);}
  if(!matches(record,c)||!neverStarted(c)||JSON.stringify(manager.store.projects).includes(c.Id)){record.state='unknown';manager.save();throw Error('Unresolved container is changed, started or referenced; refusing automatic cleanup');}
  record.state='cleanup-pending';record.containerId=c.Id;manager.save();
  // Only this failed operation's nonce-bound, never-started container. No force,
  // volume deletion, image deletion or broad prune is allowed.
  await manager.engine.request('DELETE','/containers/'+c.Id,{timeout:120000});
  record.state='cleaned';record.cleanedAt=Date.now();manager.save();
 }
}
async function reconcileLegacyCreations(manager){
 for(const job of manager.store.jobs){
  if(!legacyPending(job))continue;
  if(!/^[a-f0-9]{16}$/.test(job.id||'')||!/^[a-f0-9]{16}$/.test(job.projectId||'')||!Number.isFinite(job.startedAt)||!Number.isFinite(job.endedAt))throw Error('Invalid legacy creation journal');
  const worker=manager.worker?.status();
  if(worker?.phase!=='ready'||!worker.controlIsolation?.verified||!(worker.profile?.storageObservedAt>job.endedAt))throw Error('Restart the managed worker before reconciling a legacy timed-out creation; no duplicate create was sent');
  const {Releases}=require('./apps-releases.cjs'),path=require('node:path'),release=await new Releases(path.join(manager.cfg.stateDir,'releases')).get(job.projectId,job.id);
  if(release.status!=='failed'||release.id!==job.id||release.projectId!==job.projectId||!/^sha256:[a-f0-9]{64}$/.test(release.imageId||''))throw Error('Legacy failed release identity could not be verified');
  const name='sdsh-'+job.projectId+'-'+job.id,c=await inspect(manager,{name});
  // A fresh, verified daemon boot means the old process cannot still finish
  // an absent create request. This exception is only for pre-journal releases.
  if(!c){job.legacyCreationOutcome='absent-after-worker-restart';manager.save();continue;}
  const labels=c.Config?.Labels||{},created=Date.parse(c.Created);
  if(!/^[a-f0-9]{64}$/.test(c.Id||'')||c.Name!=='/'+name||c.Image!==release.imageId||labels[LABEL]!=='managed'||labels[LABEL+'.project']!==job.projectId||!neverStarted(c)||!Number.isFinite(created)||created<job.startedAt||created>job.endedAt+120000||c.HostConfig?.Privileged!==false||!c.HostConfig.CapDrop?.includes('ALL')||!Array.isArray(c.Mounts)||c.Mounts.length||JSON.stringify(manager.store.projects).includes(c.Id))throw Error('Legacy timed-out container is changed, started, mounted or referenced; refusing cleanup');
  await manager.engine.request('DELETE','/containers/'+c.Id,{timeout:120000});
  job.legacyCreationOutcome='removed-never-started';job.legacyContainerId=c.Id;job.legacyReconciledAt=Date.now();manager.log(job,'Recovered after worker restart: removed only this failed operation\'s verified never-started container; image, volumes and reports retained.\n');manager.save();
 }
}
module.exports={createManagedContainer,reconcilePendingCreations,reconcileLegacyCreations,retainJobs,matches,neverStarted};
