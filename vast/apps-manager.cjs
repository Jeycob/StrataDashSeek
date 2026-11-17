'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {DockerEngine,LABEL}=require('./apps-engine.cjs');
const {startManagedContainer,assertStartOutcomesKnown,diagnosticFor}=require('./apps-managed-resources.cjs');
const {projectAt,snapshot,inside}=require('./apps-project.cjs');
const {StringDecoder}=require('node:string_decoder');
const {DockerVM}=require('./apps-vm.cjs');
const {redact}=require('./apps-command.cjs');
const {createManagedContainer,reconcilePendingCreations,reconcileLegacyCreations,retainJobs}=require('./apps-container-create.cjs');
const {atomicJson:atomic}=require('../mobile/private-json.cjs');
const {assertDeploymentIdle,publishedContainer,validateResume,deploymentRecovery,cancelSavedResume}=require('./apps-deployment-guard.cjs');
const {bindAppsExecution,assertAppsExecution,checkedAppsExecution}=require('./apps-execution-mode.cjs');
function boundedRuntimeLog(text,limit){const bytes=Buffer.from(text);return{text:bytes.subarray(0,limit).toString(),truncated:bytes.length>limit||text.split('\n').length>1000};}
function cleanContainer(c,manager){return{...(manager?{canStart:publishedContainer(manager,{Id:c.Id,Config:{Labels:c.Labels||{}}})}:{}),role:c.Labels?.[LABEL+'.role']||null,dataGeneration:c.Labels?.[LABEL+'.generation']||null,id:c.Id,name:(c.Names?.[0]||'').replace(/^\//,''),projectId:c.Labels?.[LABEL+'.project'],service:c.Labels?.['com.docker.compose.service']||null,releaseId:c.Labels?.[LABEL+'.release']||null,state:c.State,status:c.Status,image:c.Image,createdAt:c.Created*1000,ports:(c.Ports||[]).filter(p=>p.PublicPort).map(p=>({private:p.PrivatePort,public:p.PublicPort}))};}
class AppsManager {
 constructor(cfg={},engine,worker,executionBinding){
  Object.defineProperty(this,'execution',{value:bindAppsExecution(executionBinding),enumerable:true});
  this.cfg={enabled:false,workspaceRoot:'/data/harness/workspaces',stateDir:'/data/harness/state/applications',applicationHost:'127.0.0.1',checkHost:'127.0.0.1',publishAddress:'127.0.0.1',firstPort:18080,portCount:8,minFreeBytes:2*1024**3,...cfg};
  for(const key of ['applicationHost','checkHost','publishAddress'])if(!/^[a-zA-Z0-9.:-]+$/.test(this.cfg[key]))throw Error('Invalid application address');
  if(!Number.isInteger(this.cfg.firstPort)||this.cfg.firstPort<1024||!Number.isInteger(this.cfg.portCount)||this.cfg.portCount<1||this.cfg.portCount>32||this.cfg.firstPort+this.cfg.portCount>65536)throw Error('Invalid application port pool');
  this.engine=engine||new DockerEngine(cfg.docker);this.busy=null;this.lastActivity=Date.now();this.previewRequests=0;this.drain=null;this.ticking=false;
  fs.mkdirSync(this.cfg.stateDir,{recursive:true});this.storeFile=path.join(this.cfg.stateDir,'projects.json');
  this.store=fs.existsSync(this.storeFile)?JSON.parse(fs.readFileSync(this.storeFile,'utf8')):{projects:{},jobs:[]};
  for(const job of this.store.jobs){if(require('./apps-project-runtime.cjs').activeStates.has(job.projectRuntime?.state)){job.projectRuntime.state='reconciliation_required';job.status='recovery_required';job.error='PROJECT_RUNTIME_RECONCILIATION_REQUIRED';}else if(['queued','running'].includes(job.status)){job.status='interrupted';job.error='Service restarted; inspect containers before retrying';job.endedAt=Date.now();}}
  this.holdUntil=Math.min(this.store.holdUntil||0,Date.now()+3600000);this.worker=worker||(cfg.vm?.enabled?new DockerVM(this.cfg,this.engine,this.execution):null);
  if(this.worker){this.worker.validateResume=ids=>validateResume(this,ids);this.worker.startManagedContainer=(id,options)=>startManagedContainer(this,id,options);}
  this.save();this.archivedCleanup=new (require('./apps-archived-cleanup.cjs').ArchivedDockerCleanup)(this);this.heartbeat();
 }
 save(){this.store.jobs=retainJobs(this.store.jobs,this.store.projects);atomic(this.storeFile,this.store);}
 heartbeat(){const w=this.worker?.status();atomic(this.cfg.activityFile||path.join(this.cfg.stateDir,'activity.json'),{at:Date.now(),enabled:this.cfg.enabled===true,active:this.busy||this.previewRequests||this.holdUntil>Date.now()||require('./apps-project-runtime.cjs').active(this)?1:0,lastActivity:this.lastActivity,holdUntil:this.holdUntil,previewRequests:this.previewRequests,servicePid:process.pid,worker:w||null,draining:!!this.sleepToken()});}
 setBusy(value){this.busy=value;this.lastActivity=Date.now();this.heartbeat();}
 requireEnabled(){assertAppsExecution(this);if(this.serviceClosing)throw Object.assign(Error('Application service is shutting down'),{status:503,code:'APPS_SERVICE_CLOSING'});if(this.archivedCleanup?.data.operation&&['running','reconciliation_required'].includes(this.archivedCleanup.data.operation.state))throw Object.assign(Error('CLEANUP_RECONCILIATION_REQUIRED'),{status:409,code:'CLEANUP_RECONCILIATION_REQUIRED'});if(!this.cfg.enabled)throw Object.assign(Error('Docker worker is not enabled'),{status:409,code:'APPS_WORKER_DISABLED'});}
 sleepToken(){if(this.drain&&this.drain.until<=Date.now())this.drain=null;return this.drain?.token;}
 acceptActivity(){assertAppsExecution(this);if(this.serviceClosing)throw Object.assign(Error('Application service is shutting down'),{status:503,code:'APPS_SERVICE_CLOSING'});if(this.sleepToken()){this.drain=null;this.heartbeat();throw Object.assign(Error('Server sleep was cancelled; retry this action shortly'),{status:409});}this.lastActivity=Date.now();this.worker?.touch();this.heartbeat();}
 async ready(){this.requireEnabled();assertStartOutcomesKnown(this);assertDeploymentIdle(this);if(this.worker)await checkedAppsExecution(this,()=>this.worker.ensure());else await checkedAppsExecution(this,()=>this.engine.available());await checkedAppsExecution(this,()=>reconcilePendingCreations(this));await checkedAppsExecution(this,()=>reconcileLegacyCreations(this));}
 previewPortFor(project){const reserved=new Set(Object.values(this.store.projects).filter(p=>p.id!==project.id).map(p=>p.previewPort??p.hostPort));const previous=project.previewPort??project.hostPort;if(previous&&!reserved.has(previous))return previous;for(let port=this.cfg.firstPort;port<this.cfg.firstPort+this.cfg.portCount;port++)if(!reserved.has(port))return port;throw Error('Application preview port pool is full');}
 canSleep(){return!this.busy&&!this.previewRequests&&this.holdUntil<=Date.now()&&!this.worker?.pending&&!this.worker?.stopping&&!require('./apps-project-runtime.cjs').active(this);}
 hold(minutes){this.requireEnabled();if(!Number.isInteger(minutes)||minutes<0||minutes>60)throw Error('Hold must be 0–60 minutes');this.acceptActivity();this.holdUntil=minutes?Date.now()+minutes*60000:0;this.store.holdUntil=this.holdUntil;this.save();this.heartbeat();return{holdUntil:this.holdUntil};}
 async prepareSleep(){
  // A disabled controller must never adopt or power off an existing guest.
  this.requireEnabled();
  if(!this.canSleep())throw Object.assign(Error('Application work or an awake lease is active'),{status:409});
  const token=crypto.randomBytes(16).toString('hex');this.drain={token,until:Date.now()+120000};this.heartbeat();
  try{if(this.worker)await this.worker.stop();if(this.sleepToken()!==token||!this.canSleep())throw Error('New activity cancelled sleep');return{ready:true,token};}catch(e){this.drain=null;throw e;}
 }
 confirmSleep(token){if(!token||this.sleepToken()!==token||!this.canSleep()||this.worker?.pid())throw Object.assign(Error('Sleep preparation is no longer valid'),{status:409});return{ready:true};}
 cancelSleep(token){if(!token||this.drain?.token===token)this.drain=null;this.heartbeat();return{ok:true};}
 previewSettings(){const file=this.cfg.previewStatusFile||(this.cfg.stateDir==='/data/harness/state/applications'?'/data/harness/runtime-status/preview-status.json':path.join(this.cfg.stateDir,'preview-status.json'));return this.cfg.preview?.enabled&&fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{configured:false,enabled:false,ports:[]};}
 enqueuePreviewSettings(enabled){
  this.requireEnabled();if(!this.cfg.preview?.enabled||typeof enabled!=='boolean')throw Error('Preview setting must be a boolean for the configured private gateway');if(this.busy)throw Object.assign(Error('Another application operation is running'),{status:409});this.acceptActivity();
  const job={id:crypto.randomBytes(8).toString('hex'),action:'preview-settings',status:'queued',startedAt:Date.now()};this.setBusy(job.id);this.store.jobs.push(job);this.save();
  queueMicrotask(async()=>{job.status='running';this.save();try{assertAppsExecution(this);atomic(path.join(this.cfg.stateDir,'preview-request.json'),{id:job.id,enabled});let confirmed=false;for(let n=0;n<240;n++){const state=this.previewSettings();if(state.requestId===job.id){if(!state.verified||state.error||state.enabled!==enabled)throw Error(state.error||'Private preview setting was not confirmed');confirmed=true;break;}await new Promise(r=>setTimeout(r,250));}if(!confirmed)throw Error('Preview setting is still unconfirmed; inspect its current state before retrying');job.status='passed';this.log(job,enabled?'Private Tailscale previews enabled on ports 18080–18087.\n':'Private Tailscale previews disabled.\n');}catch(e){job.status='failed';job.error=e.message;this.log(job,e.message+'\n');}finally{this.redactions?.delete(job.id);job.endedAt=Date.now();this.setBusy(null);this.save();}});return job;
 }
 enqueuePower(action){
  this.requireEnabled();if(!this.worker||!['wake','sleep'].includes(action))throw Error('Unsupported worker action');if(this.busy||this.previewRequests||action==='sleep'&&(this.holdUntil>Date.now()||require('./apps-project-runtime.cjs').active(this)))throw Object.assign(Error('Application work or an awake lease is active'),{status:409});this.acceptActivity();
  const job={id:crypto.randomBytes(8).toString('hex'),action,status:'queued',startedAt:Date.now()};this.setBusy(job.id);this.store.jobs.push(job);this.save();
  queueMicrotask(async()=>{job.status='running';this.save();try{assertAppsExecution(this);if(action==='wake')await this.ready();else await this.worker.stop();job.status='passed';this.log(job,action==='wake'?'Docker worker is ready.\n':'Docker worker saved and asleep.\n');}catch(e){job.status='failed';job.error=e.message;this.log(job,e.message+'\n');}finally{this.redactions?.delete(job.id);job.endedAt=Date.now();this.setBusy(null);this.save();}});return job;
 }
 async tick(){
  assertAppsExecution(this);
  await require('./apps-resources.cjs').expireResources(this.archivedCleanup);
  this.heartbeat();if(!this.cfg.enabled||this.serviceClosing||this.ticking||!this.worker||!this.canSleep()||this.sleepToken())return;
  if(this.worker.phase==='recovering'||this.worker.phase==='ready'&&Date.now()-this.worker.lastUsed>(this.cfg.vm.idleSeconds||120)*1000){
   this.ticking=true;try{assertStartOutcomesKnown(this);assertDeploymentIdle(this,{allowCurrent:false});if(this.worker.phase==='recovering')await this.worker.ensure();else await this.worker.stop();}catch(e){this.worker.error=e.message;}finally{this.ticking=false;this.heartbeat();}
  }
  else await require('./apps-storage-telemetry.cjs').refreshStorage(this);
 }
 async beginPreview(port){
  this.requireEnabled();this.acceptActivity();const p=Object.values(this.store.projects).find(p=>(p.previewPort??p.hostPort)===port&&p.containerId);if(!p)throw Object.assign(Error('No application is deployed on this port'),{status:404});
  this.previewRequests++;this.heartbeat();let released=false;const release=()=>{if(released)return;released=true;this.previewRequests--;this.lastActivity=Date.now();this.worker?.touch();this.heartbeat();};
  try{await this.ready();const c=await this.engine.owned(p.containerId,p.id);if(!c.State.Running)throw Object.assign(Error('Application is stopped; start it from Harness'),{status:409});release.backendPort=p.hostPort;return release;}catch(e){release();throw e;}
 }
 project(id){if(!/^[a-f0-9]{16}$/.test(id)||!this.store.projects[id])throw Object.assign(Error('Unknown project'),{status:404});return this.store.projects[id];}
 async register(relative,expectedProjectId){
  this.requireEnabled();if(this.busy)throw Object.assign(Error('Wait for the current application operation before registering'),{status:409});
  this.acceptActivity();const p=await checkedAppsExecution(this,()=>projectAt(relative,this.cfg)),canonical=await checkedAppsExecution(this,()=>fsp.realpath(p.directory));
  if(this.busy)throw Object.assign(Error('An application operation started during registration'),{status:409});
  if(canonical!==p.directory||crypto.createHash('sha256').update(canonical).digest('hex').slice(0,16)!==p.id||expectedProjectId!==undefined&&p.id!==expectedProjectId)throw Object.assign(Error('Project target changed before registration'),{status:409,code:'PROJECT_CONTEXT_MISMATCH'});
  const old=this.store.projects[p.id];this.store.projects[p.id]={...old,...p};this.save();return this.publicProject(this.store.projects[p.id]);
 }
 publicProject(p){const {directory,...safe}=p;return safe;}
 async state(){let available=false,error=null,containers=[];const worker=this.worker?.status();if(this.cfg.enabled&&(!worker||worker.phase==='ready'))try{await this.engine.available();available=true;containers=(await this.engine.list()).map(c=>cleanContainer(c,this));}catch(e){error=e.message;}if(worker&&!available)containers=(this.worker.saved.containers||[]).map(c=>({...cleanContainer(c,this),state:c.State==='running'?'sleeping':c.State}));return{enabled:!!this.cfg.enabled,available,error,worker:worker||null,previewSettings:this.previewSettings(),holdUntil:this.holdUntil,draining:!!this.sleepToken(),busy:this.busy,deploymentRecovery:deploymentRecovery(this),projects:Object.values(this.store.projects).map(p=>this.publicProject(p)),containers,jobs:this.store.jobs.slice(-30),backend:this.cfg.docker?.socketPath?'local-socket':'loopback-worker'};}
 log(job,text){const file=path.join(this.cfg.stateDir,job.id+'.log');const old=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';fs.writeFileSync(file,(old+text).slice(-1024*1024),{mode:0o600});}
 replaceJobLog(job,output){if(!/^[a-f0-9]{16}$/.test(job.id)||!this.store.jobs.includes(job)||typeof output?.stdout!=='string'||typeof output?.stderr!=='string')throw Error('Invalid runtime job log');job.runtimeLogTruncated??={};for(const channel of ['stdout','stderr']){const bounded=boundedRuntimeLog(output[channel],channel==='stdout'?128*1024:32*1024);job.runtimeLogTruncated[channel]=bounded.truncated;fs.writeFileSync(path.join(this.cfg.stateDir,job.id+'.'+channel),bounded.text,{mode:0o600});}fs.writeFileSync(path.join(this.cfg.stateDir,job.id+'.log'),boundedRuntimeLog(output.stdout+output.stderr,32*1024).text,{mode:0o600});}
 jobOutput(id){const text=this.jobLog(id),job=this.store.jobs.find(j=>j.id===id);if(job.action!=='project-executor')return{text};const output={text,truncated:{stdout:Boolean(job.runtimeLogTruncated?.stdout),stderr:Boolean(job.runtimeLogTruncated?.stderr)}};for(const channel of ['stdout','stderr']){const file=path.join(this.cfg.stateDir,id+'.'+channel);output[channel]=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';}return output;}
 jobLog(id){if(!/^[a-f0-9]{16}$/.test(id)||!this.store.jobs.some(j=>j.id===id))throw Object.assign(Error('Unknown job'),{status:404});const file=path.join(this.cfg.stateDir,id+'.log');return fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';}
 enqueue(id,action){this.requireEnabled();const p=this.project(id);if(!['build','deploy','check'].includes(action))throw Error('Invalid project action');if(this.busy)throw Object.assign(Error('Another application operation is running'),{status:409});this.acceptActivity();
  const job={id:crypto.randomBytes(8).toString('hex'),projectId:id,action,status:'queued',startedAt:Date.now()};this.setBusy(job.id);this.store.jobs.push(job);this.save();
  queueMicrotask(async()=>{job.status='running';this.save();try{assertAppsExecution(this);if(action==='build')await require('./apps-cleanup.cjs').ensureCapacity(this,0,job);await this.ready();const project=await projectAt(p.path,this.cfg);if(project.id!==id)throw Error('Project path changed');if(action==='build')await this.build(project,job);else if(action==='deploy')await this.deploy(project,job);else await this.check(project,job);job.status='passed';}catch(e){job.resourceDiagnostic=diagnosticFor(e);job.status='failed';job.error=redact(e.message,this.redactions?.get(job.id)||[]);this.log(job,'\nERROR: '+job.error+'\n');}finally{try{await this.worker?.remember();}catch(e){this.log(job,'Worker state warning: '+e.message+'\n');}this.redactions?.delete(job.id);job.endedAt=Date.now();this.setBusy(null);this.save();}});
  return job;
 }
 async build(p,job){
  if(this.worker&&await this.worker.diskFree()<512*1024**2)throw Error('Less than 512 MiB free on the Docker worker; inspect its images before building');
  const stat=fs.statfsSync(this.cfg.stateDir);if(stat.bavail*stat.bsize<this.cfg.minFreeBytes)throw Error('Insufficient free disk space for build context');
  const dir=path.resolve(this.cfg.stateDir,'build-'+job.id);if(!inside(path.resolve(this.cfg.stateDir),dir))throw Error('Invalid snapshot directory');
  try{
   const source=await checkedAppsExecution(this,()=>snapshot(p,dir));this.log(job,'Source snapshot '+source.sha256+' ('+source.files+' files)\n');
   const tag='stratadashseek-app:'+p.id+'-'+job.id;
   const tar=cp.spawn('tar',['-cf','-','.'],{cwd:dir,stdio:['ignore','pipe','pipe']});let tarError='';tar.stderr.on('data',c=>tarError=(tarError+c).slice(-4000));
   const exited=new Promise((resolve,reject)=>{tar.on('error',reject);tar.on('exit',code=>code===0?resolve():reject(Error('Context archive failed: '+tarError)));});exited.catch(()=>{});
   let pending='',buildError=null;const decoder=new StringDecoder('utf8');
   const processLine=line=>{if(!line.trim())return;let d;try{d=JSON.parse(line)}catch{throw Error('Invalid Docker build response');}if(d.stream)this.log(job,d.stream);if(d.error)buildError=d.error;};
   const labels=encodeURIComponent(JSON.stringify({[LABEL]:'managed',[LABEL+'.project']:p.id,[LABEL+'.source']:source.sha256}));
   try{await this.engine.request('POST','/build?rm=1&forcerm=1&t='+encodeURIComponent(tag)+'&dockerfile='+encodeURIComponent(p.dockerfile)+'&labels='+labels,{stream:tar.stdout,timeout:600000,maxBytes:8*1024*1024,onChunk:c=>{pending+=decoder.write(c);let pos;while((pos=pending.indexOf('\n'))>=0){processLine(pending.slice(0,pos));pending=pending.slice(pos+1);}if(pending.length>1024*1024)throw Error('Oversized build event');}});await exited;pending+=decoder.end();if(pending)processLine(pending);}finally{tar.kill('SIGTERM');}
   if(buildError)throw Error(buildError);
   const image=await this.engine.json('GET','/images/'+encodeURIComponent(tag)+'/json');if(!/^sha256:[a-f0-9]{64}$/.test(image?.Id))throw Error('Docker did not return an immutable image id');
   const {directory,path:relative,id,...buildSpec}=p;
   Object.assign(this.store.projects[p.id],{imageId:image.Id,imageTag:tag,source,buildSpec,builtAt:Date.now()});this.log(job,'Built immutable image '+image.Id+'\n');
  }finally{if(inside(path.resolve(this.cfg.stateDir),dir))await fsp.rm(dir,{recursive:true,force:true});}
 }
 async deploy(p,job,{beforePromote,runtimeEnv={}}={}){
  const saved=this.project(p.id);if(!saved.imageId)throw Error('Build this project before deploying');p={...p,...saved.buildSpec};
  const existing=await this.engine.list(),used=new Set(existing.filter(c=>c.State==='running').flatMap(c=>(c.Ports||[]).map(v=>v.PublicPort)));
  let port;for(let n=0;n<this.cfg.portCount;n++)if(!used.has(this.cfg.firstPort+n)){port=this.cfg.firstPort+n;break;}if(!port)throw Error('Application port pool is full');
  const previewPort=this.previewPortFor(saved);
  const old=saved.containerId,key=p.port+'/tcp';
  const created=await createManagedContainer(this,job,{Image:saved.imageId,Labels:{[LABEL]:'managed',[LABEL+'.project']:p.id},Env:['PORT='+p.port,'NODE_ENV=production',...Object.entries(runtimeEnv).map(([k,v])=>k+'='+v)],ExposedPorts:{[key]:{}},HostConfig:{PortBindings:{[key]:[{HostIp:this.cfg.publishAddress,HostPort:String(port)}]},Memory:p.memoryMiB*1024**2,MemorySwap:p.memoryMiB*1024**2,NanoCpus:Math.round(p.cpus*1e9),PidsLimit:128,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],RestartPolicy:{Name:'no'}}});
  const id=created?.Id;if(!/^[a-f0-9]{64}$/.test(id||''))throw Error('Invalid created container id');
  try{await startManagedContainer(this,id);this.log(job,'Started '+id+' on port '+port+'\n');let health;for(let i=0;i<30;i++){health=await this.health(port,p.healthPath);if(health.ok)break;const inspected=await this.engine.owned(id,p.id);if(!inspected.State.Running)throw Error('Container exited: '+(await this.engine.logs(id,p.id)).slice(-2000));await new Promise(r=>setTimeout(r,1000));}if(!health?.ok)throw Error('Startup HTTP check failed');
   const candidate={containerId:id,hostPort:port,previewPort,deployedAt:Date.now(),deployedImageId:saved.imageId,test:null,health,applicationUrl:this.cfg.wakeUrl?this.cfg.wakeUrl+'?appPort='+previewPort:'http://'+this.cfg.applicationHost+':'+previewPort+'/'};
   if(beforePromote)await beforePromote(candidate);
   Object.assign(saved,candidate);this.save();
   if(old&&old!==id){try{await this.engine.owned(old,p.id);await this.engine.request('POST','/containers/'+old+'/stop?t=10');this.log(job,'Previous container retained in stopped state.\n');}catch(e){this.log(job,'WARNING: previous container could not be stopped: '+e.message+'\n');}}
   this.log(job,'HTTP availability check passed.\n');
  }catch(e){try{await this.engine.owned(id,p.id);await this.engine.request('POST','/containers/'+id+'/stop?t=2');}catch{}throw e;}
 }
 async health(port,healthPath){const url='http://'+this.cfg.checkHost+':'+port+healthPath,started=Date.now();try{const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(3000)});await r.body?.cancel();return{ok:r.status>=200&&r.status<400,status:r.status,at:Date.now(),milliseconds:Date.now()-started,url};}catch(e){return{ok:false,at:Date.now(),error:e.name,url};}}
 async check(p,job,candidate){const saved=candidate||this.project(p.id);p={...p,...(!candidate&&saved.buildSpec)};if(!saved.containerId||!saved.hostPort)throw Error('Project is not deployed');saved.test=null;const c=await this.engine.owned(saved.containerId,p.id);if(!c.State.Running)throw Error('Container is not running');saved.health=await this.health(saved.hostPort,p.healthPath);this.log(job,JSON.stringify(saved.health)+'\n');if(!saved.health.ok)throw Error('HTTP check failed');
  if(!p.testCommand){job.verification='http-only';this.log(job,'HTTP availability only; no application testCommand is configured.\n');return;}
  const test=await createManagedContainer(this,job,{Image:c.Image,Entrypoint:p.testCommand,Cmd:[],Env:['BASE_URL=http://127.0.0.1:'+p.port,'PORT='+p.port],Labels:{[LABEL]:'managed',[LABEL+'.project']:p.id,[LABEL+'.role']:'test'},HostConfig:{NetworkMode:'container:'+saved.containerId,Memory:512*1024**2,MemorySwap:512*1024**2,NanoCpus:1e9,PidsLimit:128,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],RestartPolicy:{Name:'no'}}});
  if(!/^[a-f0-9]{64}$/.test(test?.Id||''))throw Error('Invalid test container id');
  try{await startManagedContainer(this,test.Id);const result=await this.engine.json('POST','/containers/'+test.Id+'/wait?condition=not-running',{timeout:60000});this.log(job,await this.engine.logs(test.Id,p.id));job.verification='http-and-test-command';job.testExitCode=result.StatusCode;if(result.StatusCode!==0)throw Error('Application test failed with exit code '+result.StatusCode);saved.test={at:Date.now(),exitCode:result.StatusCode,imageId:c.Image};}
  finally{try{await this.engine.owned(test.Id,p.id);await this.engine.request('POST','/containers/'+test.Id+'/stop?t=1');}catch{}try{await this.engine.owned(test.Id,p.id);await this.engine.request('DELETE','/containers/'+test.Id);}catch{}}
 }
 async containerAction(id,action){this.requireEnabled();if(this.busy)throw Object.assign(Error('An application operation is running'),{status:409});if(!['start','stop'].includes(action))throw Error('Invalid container action');assertDeploymentIdle(this,{allowCurrent:false});this.acceptActivity();this.setBusy('container-action');try{if(action==='stop'&&this.worker?.phase==='asleep')return cancelSavedResume(this,id);if(action==='start')await this.ready();else await this.engine.available();const c=await this.engine.owned(id);if(action==='start'&&!publishedContainer(this,c))throw Object.assign(Error('Only the currently published application generation may be started; use a verified release for rollback'),{code:'DEPLOYMENT_HISTORICAL_START_REFUSED',status:409});if(action==='start')await startManagedContainer(this,id);else await this.engine.request('POST','/containers/'+id+'/stop?t=10');await this.worker?.remember();return{ok:true};}finally{this.setBusy(null);}}
 async logs(id){this.requireEnabled();if(this.worker?.phase==='asleep'&&!this.worker.pending&&!this.worker.stopping&&typeof this.worker.pid==='function'&&this.worker.pid()===null)return 'Pracovní prostředí je vypnuté; živé logy nejsou dostupné. Nic nebylo spuštěno.';return this.engine.logs(id);}
}
require('./apps-workflow.cjs').install(AppsManager);
require('./apps-project-runtime.cjs').install(AppsManager);
require('./apps-deployment-orchestrator.cjs').install(AppsManager);
// Every user-facing test or deploy runs on an isolated unpublished generation.
AppsManager.prototype.deploy=function(p,job){require('./apps-workflow.cjs').init(this);return this.verifyRelease(p,job);};
module.exports={AppsManager,cleanContainer};
