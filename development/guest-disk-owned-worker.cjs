'use strict';
// One private worker owns the complete RO -> RW -> unshare -> grow lifetime.
// The parent never opens the raw or inherits an operator/root FD9 into it.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {validateOwnedPlan}=require('./guest-disk-owned-copyup.cjs'),{sha256}=require('./guest-disk-grow.cjs');
const fail=code=>Object.assign(Error(code),{code}),NODE='/data/harness/node/bin/node';
function readPlan(file,pin){
 if(typeof file!=='string'||path.dirname(file)!=='/data/harness/root-secrets/runtime/state'||!file.endsWith('.json')||!/^[a-f0-9]{64}$/.test(pin||''))throw fail('COPYUP_PLAN_INVALID');
 let at='/';for(const part of path.dirname(file).slice(1).split('/')){at=path.join(at,part);const s=fs.lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.mode&0o022)throw fail('COPYUP_PLAN_UNSAFE');}
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd,{bigint:true});if(!s.isFile()||s.uid!==0n||s.gid!==0n||s.nlink!==1n||s.mode&0o022n||s.size<1n||s.size>16384n)throw fail('COPYUP_PLAN_UNSAFE');const b=Buffer.alloc(Number(s.size)+1);let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}const key=x=>['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].map(k=>String(x[k])).join(':');if(n!==Number(s.size)||key(s)!==key(fs.fstatSync(fd,{bigint:true}))||key(s)!==key(fs.lstatSync(file,{bigint:true}))||sha256(b.subarray(0,n))!==pin)throw fail('COPYUP_PLAN_CHANGED');return validateOwnedPlan(JSON.parse(b.subarray(0,n)));}finally{fs.closeSync(fd);}
}
function rootEnvironment(){if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.env.NODE_OPTIONS||process.env.NODE_PATH)throw fail('COPYUP_ROOT_REQUIRED');}
function source(g){const release='/data/harness/releases/'+g.cold.sourceCommit;if(fs.realpathSync(__dirname)!==release+'/development'||fs.realpathSync(process.execPath)!==fs.realpathSync(NODE))throw fail('COPYUP_SIGNED_SOURCE_REQUIRED');const runtime=require('../vast/runtime-release.cjs');if(runtime.currentCommit('/data/harness')!==g.cold.sourceCommit)throw fail('COPYUP_SOURCE_CHANGED');runtime.verifySync('/data/harness',g.cold.sourceCommit);}
// This function is exercised with owned fake ChildProcess handles in tests.
// Actual settlement waits for close (leader reaped), then the owned group to be
// observed absent. A kill request or exit event is never reported as settlement.
function supervise(child,deadline,{now=Date.now,timer=setTimeout,clear=clearTimeout,groupAlive=pid=>{try{process.kill(-pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}},killGroup=pid=>{try{process.kill(-pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}},sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 return new Promise((resolve,reject)=>{let message,error,bytes=0,expired=false,clipped=false,killError,leaderExited=false;
  child.once('exit',()=>{leaderExited=true;});
  const stop=()=>{expired=true;if(leaderExited||child.exitCode!=null||child.signalCode!=null)return;try{if(Number.isSafeInteger(child.pid)&&child.pid>1)killGroup(child.pid);else child.kill('SIGKILL');}catch(e){killError=e;}};
  const alarm=timer(stop,Math.max(0,deadline-now()));
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes>4096){clipped=true;stop();}});
  child.on('message',m=>{try{if(message!==undefined||Buffer.byteLength(JSON.stringify(m))>32768)throw fail('COPYUP_WORKER_OUTPUT');message=m;}catch(e){error=e;stop();}});child.once('error',e=>error=e);
  child.once('close',async(code,signal)=>{leaderExited=true;clear(alarm);if(now()>=deadline)expired=true;try{const end=Math.min(deadline,now()+5000);while(Number.isSafeInteger(child.pid)&&groupAlive(child.pid)){if(now()>=end)throw fail('COPYUP_SETTLEMENT_UNKNOWN');await sleep(10);}if(now()>=deadline)expired=true;if(killError)throw fail('COPYUP_SETTLEMENT_UNKNOWN');if(error||clipped||expired||signal||code!==0||message?.ok!==true||message.record?.phase!=='complete')throw fail(message?.code&&/^[A-Z][A-Z0-9_]{0,95}$/.test(message.code)?message.code:expired?'COPYUP_WORKER_DEADLINE':'COPYUP_WORKER_UNCONFIRMED');resolve({...message.record,ownedWorkerClosed:true,ownedWorkerGroupAbsent:true});}catch(e){reject(e);}});
  if(now()>=deadline)stop();
 });
}
async function launchOwnedWorker(input){
 rootEnvironment();const start=Date.now(),document=readPlan(input?.planFile,input?.expectedPlanSha256),deadline=start+document.operationTimeoutMs;source(document);if(Date.now()>=deadline)throw fail('COPYUP_WORKER_DEADLINE');
 const child=cp.spawn(NODE,[__filename,input.planFile,input.expectedPlanSha256,String(deadline)],{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'},detached:true,stdio:['ignore','pipe','pipe','ipc','ignore','ignore','ignore','ignore','ignore','ignore'],windowsHide:true});return supervise(child,deadline);
}
async function worker(){
 rootEnvironment();if(typeof process.send!=='function'||process.argv.length!==5)throw fail('COPYUP_PRIVATE_WORKER_REQUIRED');const[planFile,expectedPlanSha256,end]=process.argv.slice(2),deadline=Number(end),document=readPlan(planFile,expectedPlanSha256);if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>Date.now()+document.operationTimeoutMs)throw fail('COPYUP_WORKER_DEADLINE');source(document);
 const owner=await require('./guest-disk-owned-linux.cjs').createOwnedOperations({planFile,expectedPlanSha256},deadline);try{return await require('./guest-disk-grow.cjs').runOwnedGrowth(owner.plan,owner.ops);}finally{owner.close();}
}
module.exports={launchOwnedWorker,supervise};
if(require.main===module){worker().then(record=>process.send({ok:true,record},()=>process.disconnect()),error=>{const code=/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code||'')?error.code:'COPYUP_WORKER_UNCONFIRMED';if(process.send)process.send({ok:false,code},()=>{process.exitCode=2;process.disconnect();});else process.exitCode=2;});}
