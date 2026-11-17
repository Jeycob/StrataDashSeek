'use strict';
// Stable bootstrap owner: the admission broker outlives the replaceable UI
// supervisor. Model and Tailscale processes survive a startup-only rollback.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
const runtime=require('./runtime-paths.cjs'),release=require('./runtime-release.cjs'),update=require('./startup-update.cjs');
const {createRootAdmission}=require('./runtime-admission-server.cjs'),{createRuntimeRecovery}=require('./runtime-recovery.cjs');
const fault=code=>Object.assign(Error(code),{code});
function agentProcesses(uid){
 if(process.platform!=='linux'||process.getuid?.()!==0||!Number.isInteger(uid)||uid<1)throw fault('RUNTIME_LAUNCH_ROOT_REQUIRED');
 const result=[];for(const name of fs.readdirSync('/proc'))if(/^[1-9][0-9]*$/.test(name))try{const s=fs.statSync('/proc/'+name);if(s.uid===uid)result.push(Number(name));}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw fault('RUNTIME_LAUNCH_PROCESS_UNKNOWN');}return result;
}
function assertNoAgentProcesses(uid){if(agentProcesses(uid).length)throw fault('RUNTIME_LAUNCH_USER_PROCESS_ACTIVE');}
function inheritedLease(root){
 const file=runtime.lockFile(root),expected=fs.lstatSync(file);let held;try{held=fs.fstatSync(9);}catch{throw fault('RUNTIME_LAUNCH_LEASE_REQUIRED');}
 if(!held.isFile()||held.uid!==0||held.nlink!==1||held.dev!==expected.dev||held.ino!==expected.ino)throw fault('RUNTIME_LAUNCH_LEASE_REQUIRED');
 const checked=cp.spawnSync('/usr/bin/flock',['-n','9'],{stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',9],timeout:1000,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});if(checked.status!==0)throw fault('RUNTIME_LAUNCH_LEASE_BUSY');
}
async function listen(server,port){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
class RuntimeLauncher{
 constructor({root,uid,gid}){Object.assign(this,{root,uid,gid});this.supervisor=null;this.controller=null;this.readiness=null;this.pending=false;this.closing=false;this.gatedLaunch=null;}
 async initialize(){
  // The inherited supervisor flock excludes another trusted launcher. Refuse
  // any pre-existing agent/terminal/VM process before the cold-start boundary.
  inheritedLease(this.root);assertNoAgentProcesses(this.uid);runtime.prepare(this.root,{uid:this.uid,gid:this.gid});
  const current=()=>release.currentCommit(this.root);
  this.broker=createRootAdmission({root:this.root,sourceCommit:current(),currentCommit:current,controller:{status:()=>this.controller?.status()??Promise.resolve({phase:'uninitialized'}),admitWork:(...args)=>{if(!this.controller)throw fault('RUNTIME_RECOVERY_NOT_ENROLLED');return this.controller.admitWork(...args);}},quiescence:async()=>{
   const absent=agentProcesses(this.uid).length===0;
   // This is a root-owned dispatch proof, not a PID or open-port health check:
   // no grant has been issued since the verified cold boundary and every known
   // model/tool/API/socket/Apps ingress is held by admission protocol 1.
   const gated=this.gatedLaunch?.epoch===this.broker.state.epoch&&this.broker.state.acceptedWork===0;
   return{activeRequests:absent||gated?0:null,activeJobs:absent||gated?0:null,processesAbsent:absent,observedAt:Date.now()};
  }});
  this.server=this.broker.createServer();await listen(this.server,3094);
  this.heartbeat=setInterval(()=>{try{this.broker.heartbeat();}catch{this.broker.state.open=false;}},3000);this.heartbeat.unref();
  await update.update(this.root,{onVerified:({commit,digest})=>{
   const proof=release.attest(this.root,commit,{commitSignatureVerified:true,sourceDigest:digest});
   if(!this.controller)this.controller=createRuntimeRecovery({root:this.root,lockModule:pathToFileURL(path.join(__dirname,'process-lock.mjs')).href,policy:{enabled:true,compatibilityId:proof.compatibilityId,minimumSecurityEpoch:2,deniedCommits:[]},hooks:{
    verifyRelease:({commit,signal})=>release.verify(this.root,commit,{signal}),currentCommit:async()=>current(),fence:args=>this.broker.fence(args),
    switchRelease:async intent=>{
     if(this.broker.state.open||this.broker.state.acceptedWork||this.broker.state.epoch!==intent.attemptId||current()!==intent.from||this.broker.state.fenceToken!==intent.fenceToken)throw fault('RUNTIME_LAUNCH_FENCE_CHANGED');
     const from=await release.verify(this.root,intent.from),to=await release.verify(this.root,intent.to);if(from.digest!==intent.fromDigest||to.digest!==intent.toDigest)throw fault('RUNTIME_LAUNCH_RELEASE_CHANGED');
     await this.stopUi();assertNoAgentProcesses(this.uid);
     update.activate(this.root,path.join(this.root,'releases',intent.to),intent.to);update.statusWriter(this.root)({phase:'ready',appliedCommit:intent.to,targetCommit:intent.to,signatureVerified:true,error:null});
    },restart:async()=>this.launchUi()
   }});
  },beforeActivate:async({commit})=>{
   const state=await this.controller.status();if(state.phase==='uninitialized')return;
   const attempt=await this.controller.begin(commit);if(attempt.phase!=='monitoring')throw fault('RUNTIME_LAUNCH_RECOVERY_REQUIRED');
  }});
  await this.launchUi();this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();await this.tick();return this;
 }
 async launchUi(){
  if(this.supervisor)throw fault('RUNTIME_LAUNCH_SUPERVISOR_EXISTS');const commit=release.currentCommit(this.root);await release.verify(this.root,commit);
  // Runs on every cold/recovery start, under FD9, before any Native/plugin
  // writer is spawned. An unfinished purge must reconcile or keep Native shut.
  await require('./offline-purge-maintenance.cjs').beforeNativeStart({root:this.root,uid:this.uid,broker:this.broker,assertNoAgentProcesses,inheritedLease});
  this.gatedLaunch={epoch:this.broker.state.epoch,sourceCommit:commit};
  let attempt=runtime.readPrivate(this.root,'runtime-launch-attempt.json');if(attempt?.sourceCommit!==commit)attempt={version:1,sourceCommit:commit,startedAt:Date.now(),phase:'starting'};runtime.writePrivate(this.root,'runtime-launch-attempt.json',attempt);this.launchAttempt=attempt;
  const out=runtime.openLog(this.root,'supervisor'),child=cp.spawn(process.execPath,[path.join(this.root,'releases',commit,'vast/supervisor.cjs')],{cwd:path.join(this.root,'workspaces'),env:{...process.env,HARNESS_RUNTIME_LAUNCHER:'1'},stdio:['ignore',out,out,'ipc','ignore','ignore','ignore','ignore','ignore',9]});fs.closeSync(out);this.supervisor=child;
  child.on('error',()=>{});child.once('exit',()=>{if(this.supervisor===child)this.supervisor=null;});
  const cfg=JSON.parse(fs.readFileSync(path.join(this.root,'config.json'),'utf8')),{createRuntimeReadiness}=require(path.join(this.root,'releases',commit,'mobile/runtime-readiness.cjs'));
  this.readiness=createRuntimeReadiness(cfg,{infrastructureOnly:true});
 }
 async stopUi(){
  const child=this.supervisor;if(!child)return;const id=crypto.randomUUID();
  await new Promise((resolve,reject)=>{let acknowledged=false;const timer=setTimeout(()=>finish(fault('RUNTIME_LAUNCH_STOP_UNCERTAIN')),2500),message=value=>{if(value?.id!==id)return;if(value.op==='runtime-ui-stopped')acknowledged=true;else if(value.op==='runtime-ui-stop-uncertain')finish(fault('RUNTIME_LAUNCH_STOP_UNCERTAIN'));},exit=()=>finish(acknowledged?null:fault('RUNTIME_LAUNCH_STOP_UNCERTAIN')),finish=error=>{clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exit);error?reject(error):resolve();};child.on('message',message);child.once('exit',exit);child.send({op:'shutdown-for-runtime-recovery',id},error=>{if(error)finish(fault('RUNTIME_LAUNCH_STOP_UNCERTAIN'));});});
 }
 publishStatus(state){let sourceCommit=null;try{sourceCommit=release.currentCommit(this.root);}catch{}const dto={...state,sourceCommit,observedAt:Date.now()};runtime.writePrivate(this.root,'runtime-recovery-status.json',dto);runtime.publish(this.root,'runtime-recovery.json',dto);}
 async tick(){if(this.pending||this.closing)return;this.pending=true;try{
  let state=await this.controller.status(),health=await this.readiness.sample();
  if(state.phase==='uninitialized'){
   if(health.sourceReady&&health.runtimeReady)state=await this.controller.adoptHealthy(release.currentCommit(this.root),health);
   else if(Date.now()-this.launchAttempt.startedAt>=90000){await this.broker.closeAdmission();runtime.writePrivate(this.root,'runtime-launch-attempt.json',{...this.launchAttempt,phase:'recovery_required',reasonCode:'RUNTIME_RECOVERY_LAST_GOOD_REQUIRED'});this.publishStatus({version:1,phase:'recovery_required',reasonCode:'RUNTIME_RECOVERY_LAST_GOOD_REQUIRED'});return;}
  }else if(state.phase==='monitoring')state=await this.controller.observe(state.attemptId,health);
  else if(['rollback_intent','rollback_switched','recovery_required'].includes(state.phase))state=await this.controller.reconcile(state.attemptId,health);
  if(['healthy','rolled_back'].includes(state.phase)&&require('./runtime-recovery.cjs').healthy(health,release.currentCommit(this.root),Date.now())){await this.broker.open(health);runtime.writePrivate(this.root,'runtime-launch-attempt.json',{...this.launchAttempt,phase:'healthy'});}else await this.broker.closeAdmission();
  this.publishStatus(state);
 }catch(error){await this.broker.closeAdmission().catch(()=>{});try{this.publishStatus({version:1,phase:'recovery_required',reasonCode:/^[A-Z_]+$/.test(error.code||'')?error.code:'RUNTIME_LAUNCH_OBSERVATION_FAILED'});}catch{}}finally{this.pending=false;}}
}
module.exports={RuntimeLauncher,agentProcesses,assertNoAgentProcesses,inheritedLease};
if(require.main===module){const root=process.argv[2]||'/data/harness';let owner;Promise.resolve().then(async()=>{const uid=Number(cp.execFileSync('id',['-u','harness'],{encoding:'utf8'})),gid=Number(cp.execFileSync('id',['-g','harness'],{encoding:'utf8'}));owner=new RuntimeLauncher({root,uid,gid});await owner.initialize();}).catch(error=>{console.error('Runtime remains closed: '+(error.code||'INITIALIZATION_FAILED'));clearInterval(owner?.heartbeat);clearInterval(owner?.timer);owner?.server?.close();process.exitCode=1;});}
