'use strict';
// Root writes never traverse the agent-owned state tree. This module is also
// copied into the stable bootstrap only by an explicit operator upgrade.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const flags=fs.constants,NAME=/^[a-z0-9][a-z0-9.-]{0,100}$/;
// FD9 is the inherited root supervisor flock. libuv may preserve a pre-existing
// non-CLOEXEC descriptor outside the requested stdio range. Explicitly replace
// it for every helper and privilege drop; only the UI supervisor inherits it.
function withoutRootLease(stdout='pipe',stderr=stdout){return['ignore',stdout,stderr,'ignore','ignore','ignore','ignore','ignore','ignore','ignore'];}
function paths(root='/data/harness'){
 root=path.resolve(root);const control=path.join(root,'root-secrets/runtime');
 return{root,control,privateState:path.join(control,'state'),privateLogs:path.join(control,'logs'),legacy:path.join(control,'legacy'),publicState:path.join(root,'runtime-status'),serviceLogs:path.join(root,'logs'),agentState:path.join(root,'state')};
}
function requireRoot(){if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Privileged runtime paths require Linux root');}
function directoryTree(directory){
 requireRoot();const absolute=path.resolve(directory),parts=absolute.split(path.sep).filter(Boolean);let current=path.parse(absolute).root;
 for(const part of ['',...parts]){if(part)current=path.join(current,part);const s=fs.lstatSync(current);
  // A root-owned sticky ancestor (e.g. /tmp in isolated tests) cannot have a
  // root-owned child renamed by another UID. All actual runtime parents below
  // the selected root must be non-writable outside root.
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||((s.mode&0o022)&&!(s.mode&0o1000)))throw Error('Untrusted privileged path ancestor');
 }
 return fs.lstatSync(absolute);
}
function ensureDirectory(directory,mode=0o700,gid=0){
 directoryTree(path.dirname(directory));let created=false;
 try{fs.mkdirSync(directory,{mode});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
 const s=directoryTree(directory);if(s.mode&0o022)throw Error('Runtime directory is writable outside root');
 const fd=fs.openSync(directory,flags.O_RDONLY|flags.O_DIRECTORY|flags.O_NOFOLLOW);try{if(fs.fstatSync(fd).uid!==0)throw Error('Runtime directory changed');fs.fchownSync(fd,0,gid);fs.fchmodSync(fd,mode);}finally{fs.closeSync(fd);}
 return directory;
}
function trustedFile(file,{optional=false}={}){
 directoryTree(path.dirname(file));let s;try{s=fs.lstatSync(file);}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o022))throw Error('Untrusted privileged file');return s;
}
function syncDirectory(directory){const fd=fs.openSync(directory,flags.O_RDONLY|flags.O_DIRECTORY|flags.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function atomic(file,value,mode=0o600){
 trustedFile(file,{optional:true});const temp=path.join(path.dirname(file),'.'+path.basename(file)+'.'+crypto.randomBytes(12).toString('hex'));
 let fd;try{fd=fs.openSync(temp,flags.O_WRONLY|flags.O_CREAT|flags.O_EXCL|flags.O_NOFOLLOW,mode);fs.writeFileSync(fd,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  directoryTree(path.dirname(file));trustedFile(file,{optional:true});fs.renameSync(temp,file);const parent=fs.openSync(path.dirname(file),flags.O_RDONLY|flags.O_DIRECTORY|flags.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function control(root){
 const p=paths(root);if(directoryTree(p.root).mode&0o022)throw Error('Runtime root is writable outside root');ensureDirectory(path.join(p.root,'root-secrets'));ensureDirectory(p.control);ensureDirectory(p.privateState);ensureDirectory(p.privateLogs);ensureDirectory(p.legacy);ensureDirectory(p.publicState,0o755);return p;
}
function identity(){return{uid:Number(cp.execFileSync('/usr/bin/id',['-u','harness'],{encoding:'utf8',stdio:withoutRootLease()})),gid:Number(cp.execFileSync('/usr/bin/id',['-g','harness'],{encoding:'utf8',stdio:withoutRootLease()}))};}
function validIdentity(value){if(!Number.isInteger(value.uid)||value.uid<1||!Number.isInteger(value.gid)||value.gid<1)throw Error('A non-root service identity is required');return value;}
function readPrivate(root,name,fallback=null){if(!NAME.test(name))throw Error('Invalid runtime state name');const p=control(root),file=path.join(p.privateState,name);if(!trustedFile(file,{optional:true}))return fallback;const fd=fs.openSync(file,flags.O_RDONLY|flags.O_NOFOLLOW|flags.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(s.nlink!==1||s.uid!==0||!s.isFile()||s.size>2*1024**2)throw Error('Invalid private runtime state');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
function writePrivate(root,name,value){if(!NAME.test(name))throw Error('Invalid runtime state name');atomic(path.join(control(root).privateState,name),value);}
const PUBLIC_NAMES=new Set(['services.json','service-health.json','telemetry.json','idle-status.json','startup-update.json','preview-status.json','billing-status.json','runtime-recovery.json']);
const publicString=value=>String(value).slice(0,500).replace(/https?:\/\/\S*[?&](?:token|key|secret)=[^\s]*/gi,'[redacted authentication URL]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]');
function sanitize(value){if(value===null||typeof value==='boolean')return value;if(typeof value==='number')return Number.isFinite(value)?value:null;if(typeof value==='string')return publicString(value);if(Array.isArray(value))return value.slice(0,60).map(sanitize);if(value&&typeof value==='object'){const out={};for(const[k,v]of Object.entries(value)){if(/secret|password|cookie|authorization|harness.?log|launch.?url/i.test(k)||/token/i.test(k)&&typeof v!=='number')continue;out[k]=sanitize(v);}return out;}return null;}
function publicValue(name,value){
 if(!PUBLIC_NAMES.has(name))throw Error('Unsupported public runtime status');
 const keys={
  'services.json':['pids','names'],
  'service-health.json':['version','at','sourceCommit','phase','reasonCode','failedService'],
  'runtime-recovery.json':['version','sourceCommit','phase','reasonCode','observedAt','candidateCommit','servingCommit','lastGoodCommit','acceptedWork','deadline'],
  'startup-update.json':['version','enabled','phase','checkedAt','appliedCommit','targetCommit','error','signatureVerified','bootstrapUpgradeRequired'],
  'telemetry.json':['at','source','gpu','cpu','ram','disk','storage','model','agentQueue','last','requests','history','liveTokensPerSecond','energyWhSinceMonitorStart','monitorStartedAt','idle'],
  'idle-status.json':['at','canStop','reason','idleTimeoutSeconds','idleSeconds'],
  'preview-status.json':['configured','enabled','verified','ports','scope','at','requestId','error'],
  'billing-status.json':['at','pid','lastObservationAt','source']
 }[name];return sanitize(Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])));
}
function publish(root,name,value){atomic(path.join(control(root).publicState,name),publicValue(name,value),0o644);}
function openLog(root,name,{serviceGroup=null}={}){
 if(!NAME.test(name))throw Error('Invalid service log name');const p=control(root),directory=serviceGroup===null?p.privateLogs:p.serviceLogs;directoryTree(directory);const file=path.join(directory,name+'.log');
 let fresh=false,fd;try{fd=fs.openSync(file,flags.O_WRONLY|flags.O_APPEND|flags.O_CREAT|flags.O_EXCL|flags.O_NOFOLLOW,serviceGroup===null?0o600:0o640);fresh=true;}catch(e){if(e.code!=='EEXIST')throw e;trustedFile(file);fd=fs.openSync(file,flags.O_WRONLY|flags.O_APPEND|flags.O_NOFOLLOW|flags.O_NONBLOCK);}
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o022))throw Error('Unsafe service log inode');if(serviceGroup!==null){fs.fchownSync(fd,0,serviceGroup);fs.fchmodSync(fd,0o640);}return fd;}catch(e){fs.closeSync(fd);throw e;}
}
function lockFile(root,name='supervisor.lock'){
 if(!NAME.test(name))throw Error('Invalid runtime lock name');const p=paths(root);directoryTree(p.root);if(fs.statSync(p.root).mode&0o022)throw Error('Unsafe runtime lock parent');const file=path.join(p.root,name);trustedFile(file,{optional:true});const fd=fs.openSync(file,flags.O_WRONLY|flags.O_CREAT|flags.O_NOFOLLOW|flags.O_NONBLOCK,0o600);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o022))throw Error('Unsafe runtime lock');}finally{fs.closeSync(fd);}return file;
}
function adoptSignedStatus(root){
 // An older stable gate still writes its diagnostic in the legacy directory.
 // Never trust that agent-controlled diagnostic. After gate completion the
 // supervisor derives status from the protected applied record and exact tree.
 const p=control(root),file=path.join(p.root,'root-secrets/startup-update-applied.json');trustedFile(file);const applied=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!/^[a-f0-9]{40}$/.test(applied.commit||''))throw Error('Missing verified applied release');const release=fs.realpathSync(path.join(p.root,'app'));
 if(release!==path.join(p.root,'releases',applied.commit)||require('./startup-update.cjs').releaseDigest(release)!==applied.digest)throw Error('Applied source differs from the verified release');
 const entries=[['start.sh','startup-bootstrap.sh'],['runtime-paths.cjs','runtime-paths.cjs'],['startup-update.cjs','startup-update.cjs'],['startup-extract.py','startup-extract.py'],['process-lock.mjs','../workspace/process-lock.mjs'],['runtime-recovery.cjs','runtime-recovery.cjs'],['runtime-admission-server.cjs','runtime-admission-server.cjs'],['runtime-release.cjs','runtime-release.cjs'],['offline-purge-maintenance.cjs','offline-purge-maintenance.cjs'],['runtime-launcher.cjs','runtime-launcher.cjs']];
 const bootstrapUpgradeRequired=entries.some(([name,source])=>{const target=path.join(p.root,'bootstrap',name);return!trustedFile(target,{optional:true})||!fs.readFileSync(target).equals(fs.readFileSync(path.join(__dirname,source)));});
 const state={version:1,enabled:true,phase:'ready',checkedAt:new Date().toISOString(),appliedCommit:applied.commit,targetCommit:applied.commit,error:null,signatureVerified:true,bootstrapUpgradeRequired};writePrivate(root,'startup-update.json',state);publish(root,'startup-update.json',state);return state;
}
function readAgent(root,relative,{uid,gid}=identity(),limit=1024*1024){
 validIdentity({uid,gid});if(typeof relative!=='string'||relative.split('/').some(x=>!x||x==='.'||x==='..')||!Number.isInteger(limit)||limit<1||limit>2*1024**2)throw Error('Invalid agent-state read');
 const result=cp.spawnSync('/usr/bin/setpriv',['--reuid',String(uid),'--regid',String(gid),'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',process.execPath,__filename,'read-agent',path.resolve(root),relative,String(limit)],{encoding:'utf8',timeout:5000,maxBuffer:limit+4096,stdio:withoutRootLease(),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});
 if(result.status!==0)throw Error('Agent state is unavailable or unsafe');return JSON.parse(result.stdout);
}
function agentCLI(root,relative,limit){
 if(process.getuid?.()===0)throw Error('Agent reads must drop privilege');const p=paths(root),file=path.resolve(p.agentState,relative);if(!file.startsWith(p.agentState+path.sep))throw Error('Invalid agent path');
 const fd=fs.openSync(file,flags.O_RDONLY|flags.O_NOFOLLOW|flags.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>limit)throw Error('Invalid agent file');const raw=Buffer.alloc(limit+1),count=fs.readSync(fd,raw,0,raw.length,0);if(count>limit)throw Error('Agent state too large');process.stdout.write(JSON.stringify(JSON.parse(raw.subarray(0,count).toString('utf8'))));}finally{fs.closeSync(fd);}
}
function compatibility(root){
 if(process.getuid?.()===0)throw Error('Compatibility aliases must be created unprivileged');const p=paths(root);
 for(const name of['services.json','telemetry.json','idle-status.json','startup-update.json','efficiency/billing-observations.jsonl','efficiency/billing-windows.jsonl','efficiency/billing-status.json']){
  const file=path.join(p.agentState,name),target=path.join(p.publicState,path.basename(name));
  if(name.includes('/')){const directory=path.dirname(file);try{fs.mkdirSync(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const parent=fs.lstatSync(directory);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Unsafe compatibility parent');}
  let s;try{s=fs.lstatSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(s?.isSymbolicLink()&&fs.readlinkSync(file)===target)continue;
  if(s)fs.renameSync(file,file+'.legacy-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'));fs.symlinkSync(target,file);
 }
}
function prepare(root='/data/harness',account=identity(),{afterLogMove}={}){
 validIdentity(account);const p=control(root),marker=path.join(p.control,'layout.json');let layout=trustedFile(marker,{optional:true})&&JSON.parse(fs.readFileSync(marker,'utf8'));
 if(!layout){layout={version:1,logsBackup:null};atomic(marker,layout);}
 if(layout.pendingLogs){
  const pending=layout.pendingLogs;if(path.dirname(pending)!==p.legacy||!/^logs-[0-9]+-[a-f0-9]+$/.test(path.basename(pending)))throw Error('Invalid retained log migration');
  if(fs.existsSync(pending)){layout.logsBackup=pending;layout.logsPrepared=false;layout.pendingLogs=null;atomic(marker,layout);}
  else if(!fs.existsSync(p.serviceLogs))throw Error('Interrupted log migration requires operator recovery');
 }
 let logs;try{logs=fs.lstatSync(p.serviceLogs);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(logs&&(!layout.logsPrepared||logs.uid!==0||!logs.isDirectory()||logs.isSymbolicLink()||(logs.mode&0o022))){
  const dest=layout.pendingLogs||path.join(p.legacy,'logs-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex'));layout.pendingLogs=dest;atomic(marker,layout);fs.renameSync(p.serviceLogs,dest);syncDirectory(p.root);syncDirectory(p.legacy);afterLogMove?.();layout.logsBackup=dest;layout.pendingLogs=null;layout.logsPrepared=false;atomic(marker,layout);
 }
 ensureDirectory(p.serviceLogs,0o750,account.gid);layout.logsPrepared=true;
 // This directory remains agent-writable. Never recurse/chown an existing
 // agent-controlled tree, and never use it as a privileged output parent.
 for(const name of['state','home','workspaces','secrets']){const directory=path.join(p.root,name);
  try{const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||![0,account.uid].includes(s.uid))throw Error('Agent data must be a real service-owned directory');if(s.uid===0){const fd=fs.openSync(directory,flags.O_RDONLY|flags.O_DIRECTORY|flags.O_NOFOLLOW);try{fs.fchownSync(fd,account.uid,account.gid);}finally{fs.closeSync(fd);}}}catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(directory,{mode:0o700});fs.chownSync(directory,account.uid,account.gid);}
 }
 atomic(marker,layout);
 const aliases=cp.spawnSync('/usr/bin/setpriv',['--reuid',String(account.uid),'--regid',String(account.gid),'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',process.execPath,__filename,'compat',p.root],{encoding:'utf8',timeout:5000,maxBuffer:4096,stdio:withoutRootLease(),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});
 if(aliases.status!==0)throw Error('Unprivileged compatibility setup failed; original state remains retained');
 return{version:1,privateState:p.privateState,publicState:p.publicState,logsPrepared:true,legacyLogsRetained:!!layout.logsBackup,bootstrapAutomaticallyUpgraded:false};
}
module.exports={paths,directoryTree,ensureDirectory,trustedFile,atomic,control,prepare,openLog,lockFile,adoptSignedStatus,readPrivate,writePrivate,publish,readAgent,publicValue,withoutRootLease,identity};
if(require.main===module){try{const[action,root,relative,limit]=process.argv.slice(2);if(action==='read-agent')agentCLI(root,relative,Number(limit));else if(action==='compat')compatibility(root);else if(action==='prepare')console.log(JSON.stringify(prepare(root)));else if(action==='lock-file')lockFile(root);else throw Error('Supported operation: prepare ROOT');}catch(error){console.error(error.message);process.exitCode=1;}}
