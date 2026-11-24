'use strict';
const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process');
const runtime=require('./runtime-paths.cjs');
const {ServiceLifecycle}=require('./service-lifecycle.cjs');
const R='/data/harness',cfg=JSON.parse(fs.readFileSync(R+'/config.json','utf8'));
const uid=Number(cp.execFileSync('id',['-u','harness'],{stdio:runtime.withoutRootLease()}).toString()),gid=Number(cp.execFileSync('id',['-g','harness'],{stdio:runtime.withoutRootLease()}).toString());
runtime.prepare(R,{uid,gid});
const sourceStatus=runtime.adoptSignedStatus(R);
// Publish once from the signed root supervisor before any service is created.
// Child restarts retain this launch identity; a new supervisor publishes a new
// identity. Admission epochs change independently and must not be used here.
const projectExecution=require('./project-execution-mode.cjs').createExecutionModeContract().publishForSupervisor({sourceCommit:sourceStatus.appliedCommit});
const admissionPatch=R+'/runtime-status/native-admission-patch.json';
runtime.atomic(admissionPatch,require('./native-isolated-profile.cjs').nativeRuntimePatch(sourceStatus.appliedCommit,R),0o644);
const children=new Map();let closing=false;
const previousRestarts=runtime.readPrivate(R,'service-restarts.json',{});
const lifecycle=new ServiceLifecycle({initial:previousRestarts.sourceCommit===sourceStatus.appliedCommit?previousRestarts:{},changed:state=>{const report={...state,sourceCommit:sourceStatus.appliedCommit};runtime.writePrivate(R,'service-restarts.json',report);runtime.publish(R,'service-health.json',report);}});
const healthTimer=setInterval(()=>runtime.publish(R,'service-health.json',{...lifecycle.snapshot(),sourceCommit:sourceStatus.appliedCommit}),3000);healthTimer.unref();
const env={...process.env,HOME:R+'/home',DSH_HOME:R+'/home/.dsh',PATH:R+'/node/bin:/usr/local/bin:/usr/bin:/bin',STRATA_GATEWAY_KEY:'local-strata',HARNESS_PROJECT_EXECUTION_LAUNCH_ID:projectExecution.launchId};
delete env.VAST_API_KEY;delete env.CLOUDFLARE_API_TOKEN;
function save(){const current=[...children].filter(([,p])=>Number.isInteger(p.pid));const state={pids:current.map(([,p])=>p.pid),names:Object.fromEntries(current.map(([name,p])=>[name,p.pid]))};runtime.writePrivate(R,'services.json',state);runtime.publish(R,'services.json',state);}
function launch(name,exe,args,asRoot=false){
 const admission=lifecycle.admission(name);if(!admission.allowed){if(admission.retryAfterMs!==null)setTimeout(()=>{if(!closing)launch(name,exe,args,asRoot);},admission.retryAfterMs);return null;}
 // Only the existing phone/local-owner login flow needs Harness stdout.
 // Other services keep private logs even when the child itself is non-root.
 const out=runtime.openLog(R,name,{serviceGroup:name==='harness'?gid:null});
 // Managed source is an immutable signed release. Python imports must not add
 // bytecode to it; preserve the separate model runtime's existing cache policy.
 const childEnv=args.some(arg=>typeof arg==='string'&&arg.startsWith(R+'/app/'))?{...env,PYTHONDONTWRITEBYTECODE:'1'}:env;
 const child=cp.spawn(exe,args,{cwd:R+'/workspaces',env:childEnv,uid:asRoot?0:uid,gid:asRoot?0:gid,stdio:runtime.withoutRootLease(out)});fs.closeSync(out);
 children.set(name,child);lifecycle.started(name);save();let exited=false;
 const finish=code=>{if(exited)return;exited=true;children.delete(name);save();if(!closing){console.log(name+' exited '+code);const plan=lifecycle.exited(name);if(plan.restart)setTimeout(()=>{if(!closing)launch(name,exe,args,asRoot);},plan.delayMs);else console.error(name+': automatic restart limit reached; inspect runtime health.');}};
 child.on('error',()=>finish('spawn-error'));child.on('exit',finish);return child;
}
function portOpen(port){return new Promise(resolve=>{const q=http.get('http://127.0.0.1:'+port+'/health',r=>{r.resume();resolve(true)});q.on('error',()=>resolve(false));q.setTimeout(2000,()=>{q.destroy();resolve(false)});});}
(async()=>{
 // Host argv and patch bytes stay unchanged. The isolated carrier receives a
 // complete private reader projection before any unprivileged service starts.
 const nativeLaunch=projectExecution.mode==='host-compat'?{script:R+'/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',args:['web','--patch',admissionPatch]}:await require('./native-isolated-profile.cjs').prepareNativeIsolatedLaunch({binding:require('./project-execution-mode.cjs').createExecutionModeContract().bindForService({sourceCommit:projectExecution.sourceCommit,launchId:projectExecution.launchId}),gid});
 const vaultPlan=R+'/root-secrets/vault-runtime.json';
 if(fs.existsSync(vaultPlan))await require('./vault-migrate.cjs').hydrate(JSON.parse(fs.readFileSync(vaultPlan,'utf8')),new (require('./apps-vault.cjs').InfisicalVault)({vaultMachineFile:R+'/root-secrets/vault-machine.json'}));
 if(!await portOpen(8080))launch('strata','bash',['/data/start-strata.sh'],true);
 let tailscaleAlive=false;try{cp.execFileSync('tailscale',['--socket='+R+'/tailscaled.sock','status','--json'],{stdio:runtime.withoutRootLease(),timeout:4000});tailscaleAlive=true;}catch{}
 if(!tailscaleAlive){try{fs.unlinkSync(R+'/tailscaled.sock')}catch{}launch('tailscaled','/usr/sbin/tailscaled',['--tun=userspace-networking','--statedir='+R+'/root-secrets/tailscale','--state='+R+'/root-secrets/tailscaled.state','--socket='+R+'/tailscaled.sock'],true);}
 launch('model-proxy',R+'/node/bin/node',[R+'/app/vast/model-proxy.cjs']);
 launch('applications',R+'/node/bin/node',[R+'/app/vast/apps-service.cjs',R+'/apps-config.json']);
 launch('harness',R+'/node/bin/node',[nativeLaunch.script,...nativeLaunch.args,'--no-open','--host','127.0.0.1','--port','3090','--public-url','https://'+cfg.publicHost+'/','--trusted-host',cfg.publicHost]);
 launch('push',R+'/node/bin/node',[R+'/app/mobile/webpush-server.cjs',R+'/push-config.json']);
 launch('proxy',R+'/node/bin/node',[R+'/app/mobile/https-proxy.cjs',R+'/config.json']);
 launch('push-watcher',R+'/venv/bin/python',[R+'/app/mobile/watch-harness-notifications.py','--session-root',R+'/home/.dsh/sessions','--key-file',R+'/secrets/webpush-internal.key']);
 launch('telemetry',R+'/node/bin/node',[R+'/app/vast/telemetry.cjs'],true);
 launch('idle-guard',R+'/venv/bin/python',[R+'/app/vast/idle-guard.py'],true);
 if(cfg.efficiencyBillingEnabled===true)launch('efficiency-billing','/usr/bin/flock',['-n','-F',runtime.lockFile(R,'billing.lock'),R+'/node/bin/node',R+'/app/vast/root-billing.mjs'],true);
 const serving=setInterval(()=>{const p=cp.spawn('tailscale',['--socket='+R+'/tailscaled.sock','serve','--bg','http://127.0.0.1:3081'],{stdio:runtime.withoutRootLease('ignore')});p.on('exit',code=>{if(code===0)clearInterval(serving)});},3000);serving.unref();
})().catch(error=>{closing=true;console.error('Supervisor startup failed: '+error.message);for(const child of children.values())child.kill('SIGTERM');setTimeout(()=>process.exit(1),2000);});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing=true;for(const child of children.values())child.kill('SIGTERM');setTimeout(()=>process.exit(),2000);});
// This IPC channel exists only when the root stable launcher spawned us. No
// network endpoint or agent-writable request file can trigger a UI rollback.
process.on('message',message=>{
 if(typeof process.send!=='function'||closing||message?.op!=='shutdown-for-runtime-recovery'||!/^[a-f0-9-]{36}$/.test(message.id||''))return;
 closing=true;clearInterval(healthTimer);
 const preserve=new Set(['strata','tailscaled']);for(const[name,child]of children)if(!preserve.has(name))child.kill('SIGTERM');
 const deadline=Date.now()+1800,wait=setInterval(()=>{
  const alive=[...children.keys()].some(name=>!preserve.has(name));
  if(!alive){clearInterval(wait);process.send({op:'runtime-ui-stopped',id:message.id},()=>process.exit(0));}
  else if(Date.now()>=deadline){clearInterval(wait);process.send({op:'runtime-ui-stop-uncertain',id:message.id});}
 },10);
});
