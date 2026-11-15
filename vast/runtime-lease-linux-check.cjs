'use strict';
// Explicit Linux-root gate. Actual launchUi/supervisor spawn code + real kernel
// OFD flock; release/readiness are controlled, infra processes are synthetic.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict'),{spawn,spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),commit='a'.repeat(40),AGENT_UID=61071;
function loadLauncher(root){const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'runtime-launcher.cjs'),'utf8'),{module:m,exports:m.exports,__dirname,require(name){if(name==='./runtime-release.cjs')return{currentCommit:()=>commit,verify:async()=>({})};if(['./startup-update.cjs','./runtime-admission-server.cjs','./runtime-recovery.cjs'].includes(name))return{};return require(name.startsWith('.')?path.join(__dirname,name):name);},process,console,setTimeout,clearTimeout,setInterval,clearInterval,Date,Promise});return m.exports;}
async function parent(root){const {RuntimeLauncher,inheritedLease}=loadLauncher(root);inheritedLease(root);const owner=new RuntimeLauncher({root,uid:AGENT_UID,gid:AGENT_UID});owner.broker={state:{epoch:'synthetic-epoch'}};await owner.launchUi();fs.writeFileSync(path.join(root,'parent.json'),JSON.stringify({parent:process.pid,supervisor:owner.supervisor.pid}));setInterval(()=>{},1000);}
async function supervisor(root){
 const source=fs.readFileSync(path.join(__dirname,'supervisor.cjs'),'utf8'),realChildren=[],fakeChildren=[];
 const runtime={prepare(){},adoptSignedStatus:()=>({appliedCommit:commit}),atomic(){},readPrivate:()=>({}),writePrivate(){},publish(){},openLog:()=>fs.openSync(path.join(root,'infra.log'),'a'),lockFile:()=>path.join(root,'unused-billing.lock'),withoutRootLease:require('./runtime-paths.cjs').withoutRootLease};
 const childProcess={execFileSync(exe){if(exe==='id')return Buffer.from(String(AGENT_UID));throw Error('synthetic Tailscale not started');},spawn(exe,args,options){
  const role=args.includes('/data/start-strata.sh')?'model':exe==='/usr/sbin/tailscaled'?'tailscale':args.includes('3090')?'agent':null;
  if(role){const marker=role==='agent'?path.join(root,'agent-state','agent'):path.join(root,role),child=spawn('/bin/bash',['-c','printf %s "$$" > "$2.ready"; exec -a "$1" /bin/sleep 1000','owned-infra',path.join(root,role),marker],{...options,cwd:path.join(root,'workspaces'),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});realChildren.push({pid:child.pid,role});fs.writeFileSync(path.join(root,'infra.json'),JSON.stringify({supervisor:process.pid,children:realChildren}));return child;}
  const child=new EventEmitter();child.pid=10000000+fakeChildren.length;child.kill=()=>{setImmediate(()=>child.emit('exit',0));return true;};fakeChildren.push(child);return child;
 }};
 const files={readFileSync:()=>JSON.stringify({publicHost:'fixture.example.ts.net'}),existsSync:()=>false,unlinkSync(){},closeSync:fd=>fs.closeSync(fd)};
 const http={get(){const request={on(event,fn){if(event==='error')queueMicrotask(()=>fn(Error('synthetic model absent')));return request;},setTimeout(){},destroy(){}};return request;}};
 vm.runInNewContext(source,{require(name){if(name==='node:fs')return files;if(name==='node:http')return http;if(name==='node:child_process')return childProcess;if(name==='./runtime-paths.cjs')return runtime;return require(name.startsWith('.')?path.join(__dirname,name):name);},process,console:{log(){},error(){}},setTimeout,setInterval,clearInterval,Date,Map,Set});
}
if(process.argv[2]==='--lease-parent'){parent(process.argv[3]).catch(error=>{console.error(error.code||'PARENT_FIXTURE_FAILED');process.exit(2);});}
else if(process.argv[2]==='--lease-supervisor'){supervisor(process.argv[3]).catch(()=>process.exit(2));}
else{
 const test=require('node:test');
 const closed=child=>new Promise(resolve=>child.once('close',resolve));
 async function until(fn,ms=5000){const end=Date.now()+ms;while(Date.now()<end){const value=fn();if(value)return value;await wait(10);}throw Error('Bounded owned-process observation expired');}
 function alive(pid){try{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(') ')+2).split(' ')[0]!=='Z';}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return false;throw error;}}
 function killOwned(pid,root,signal='SIGKILL'){try{const cmd=fs.readFileSync('/proc/'+pid+'/cmdline');assert(cmd.includes(Buffer.from(root)),'Refuse unrelated PID');process.kill(pid,signal);}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}}
 function contend(file){return spawnSync('/usr/bin/flock',['-n',file,'true'],{timeout:1000,encoding:'utf8'});}
 async function fixture(t){assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const root=await fsp.mkdtemp(path.join(os.tmpdir(),'runtime-lease-gate-')),pids=new Set();
  t.after(async()=>{for(const file of ['parent.json','infra.json'])try{const v=JSON.parse(fs.readFileSync(path.join(root,file)));for(const pid of [v.parent,v.supervisor,...(v.children||[]).map(c=>c.pid)])if(Number.isInteger(pid))pids.add(pid);}catch{}for(const pid of pids)killOwned(pid,root);await until(()=>[...pids].every(pid=>!alive(pid)));const real=await fsp.realpath(root);assert.equal(path.dirname(real),await fsp.realpath(os.tmpdir()));assert(path.basename(real).startsWith('runtime-lease-gate-'));assert.equal((await fsp.lstat(root)).isSymbolicLink(),false);await fsp.rm(real,{recursive:true,force:true});});return{root,pids};
 }
 test('the actual inheritedLease boundary rejects a missing or unrelated descriptor',{timeout:10000},async t=>{
  const f=await fixture(t),file=path.join(f.root,'supervisor.lock');fs.writeFileSync(file,'',{mode:0o600});const code="try{require(process.argv[1]).inheritedLease(process.argv[2]);process.exit(3);}catch(e){console.log(e.code);process.exit(e.code==='RUNTIME_LAUNCH_LEASE_REQUIRED'?0:4);}";
  const result=spawnSync(process.execPath,['-e',code,path.join(__dirname,'runtime-launcher.cjs'),f.root],{timeout:3000,encoding:'utf8',stdio:['ignore','pipe','pipe']});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/RUNTIME_LAUNCH_LEASE_REQUIRED/);assert.equal(fs.statSync(file).nlink,1);
 });
 test('actual supervisor retains the inherited OFD after parent SIGKILL, while model and Tailscale children never own it',{timeout:20000},async t=>{
  const f=await fixture(t),directory=path.join(f.root,'releases',commit),vast=path.join(directory,'vast'),mobile=path.join(directory,'mobile');await fsp.mkdir(vast,{recursive:true});await fsp.mkdir(mobile);
  await fsp.chmod(f.root,0o755);const agentState=path.join(f.root,'agent-state');await fsp.mkdir(agentState,{mode:0o700});await fsp.chown(agentState,AGENT_UID,AGENT_UID);
  // launchUi invokes this wrapper without fixture arguments. It still executes
  // actual supervisor source; only its dependency services are synthetic.
  fs.writeFileSync(path.join(vast,'supervisor.cjs'),"process.argv[2]='--lease-supervisor';process.argv[3]="+JSON.stringify(f.root)+";require("+JSON.stringify(__filename)+");");
  fs.writeFileSync(path.join(mobile,'runtime-readiness.cjs'),'exports.createRuntimeReadiness=()=>({});');fs.writeFileSync(path.join(f.root,'config.json'),'{}');await fsp.mkdir(path.join(f.root,'workspaces'));
  const lease=path.join(f.root,'supervisor.lock'),args=['-c','umask 077; exec 9>"$1"; flock -n 9 || exit 3; exec "$2" "$3" --lease-parent "$4"','owned-runtime-lease',lease,process.execPath,__filename,f.root];
  const child=spawn('/bin/bash',args,{stdio:['ignore','pipe','pipe']});f.pids.add(child.pid);const parentClosed=closed(child);let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-2048));child.stdout.resume();
  const records=await until(()=>{try{const a=JSON.parse(fs.readFileSync(path.join(f.root,'parent.json'))),b=JSON.parse(fs.readFileSync(path.join(f.root,'infra.json')));if(b.children.length===3)return{...a,children:b.children};}catch{}assert(child.exitCode===null,'Parent failed: '+stderr);});f.pids.add(records.supervisor);for(const c of records.children)f.pids.add(c.pid);
  await until(()=>records.children.every(c=>{try{return Number(fs.readFileSync(path.join(f.root,c.role==='agent'?'agent-state/agent.ready':c.role+'.ready'),'utf8'))===c.pid;}catch{return false;}}));assert.equal(fs.statSync('/proc/'+records.children.find(c=>c.role==='agent').pid).uid,AGENT_UID);
  const inode=fs.statSync(lease),supervisorFd=fs.statSync('/proc/'+records.supervisor+'/fd/9');assert.equal(supervisorFd.dev,inode.dev);assert.equal(supervisorFd.ino,inode.ino);assert.equal(contend(lease).status,1);
  killOwned(records.parent,f.root);await parentClosed;assert(alive(records.supervisor));assert.equal(contend(lease).status,1,'Parent death must not release the live supervisor lease');
  killOwned(records.supervisor,f.root);await until(()=>!alive(records.supervisor));assert(records.children.every(c=>alive(c.pid)),'Synthetic infrastructure stays alive');
  const holders=records.children.filter(c=>c.role!=='agent').map(c=>({role:c.role,fds:fs.readdirSync('/proc/'+c.pid+'/fd').filter(fd=>{try{const stat=fs.statSync('/proc/'+c.pid+'/fd/'+fd);return stat.dev===inode.dev&&stat.ino===inode.ino;}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return false;throw error;}})}));assert(holders.every(c=>c.fds.length===0),'Infrastructure descriptor leak');await until(()=>contend(lease).status===0,1000);t.diagnostic(JSON.stringify({remainingLeaseHolders:holders,agentUid:AGENT_UID,agentLeaseExcludedBySuccessfulKernelContention:true}));
  const after=fs.statSync(lease);assert.equal(after.dev,inode.dev);assert.equal(after.ino,inode.ino);assert.equal(after.nlink,1);t.diagnostic(JSON.stringify({actualLaunchUi:true,actualSupervisorSpawn:true,kernelFlock:true,parentSIGKILL:true,secondOwnerHeldWhileSupervisorAlive:true,releasedAfterSupervisorExit:true,syntheticModelAndTailscaleStillAlive:true,sameLockInode:true,realModelStarted:false}));
 });
}
