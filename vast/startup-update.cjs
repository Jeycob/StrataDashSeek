'use strict';
// Runs before any Harness process. Trust and persistent data live outside releases.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const REPOSITORY='Jeycob/StrataDashSeek',MIB=1024*1024;
function atomic(file,value,mode=0o600){const tmp=file+'.tmp-'+crypto.randomBytes(12).toString('hex'),fd=fs.openSync(tmp,'wx',mode);try{fs.writeFileSync(fd,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);if(process.platform==='linux'){const parent=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}}}
function commitPayload(input){
 const text=input.toString('utf8');if(!Buffer.from(text).equals(input))throw Error('Invalid commit encoding');
 const split=text.indexOf('\n\n');if(split<0)throw Error('Invalid commit object');
 const headers=text.slice(0,split).split('\n'),kept=[];let signature='',inside=false;
 for(const line of headers){if(line.startsWith('gpgsig ')){if(signature)throw Error('Multiple commit signatures');signature=line.slice(7)+'\n';inside=true;}else if(inside&&line.startsWith(' '))signature+=line.slice(1)+'\n';else{inside=false;kept.push(line);}}
 if(!signature.startsWith('-----BEGIN PGP SIGNATURE-----\n'))throw Error('A trusted PGP commit signature is required');
 return{signature,payload:kept.join('\n')+text.slice(split)};
}
function config(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1||raw.repository!==REPOSITORY||raw.branch!=='main')throw Error('Unsupported update source');
 if(!Array.isArray(raw.signers)||!raw.signers.length||raw.signers.some(x=>!/^([A-F0-9]{40}|[A-F0-9]{64})$/.test(x)))throw Error('Pinned signing fingerprints are required');
 const minimumFreeBytes=raw.minimumFreeBytes??2*1024*MIB;
 if(!Number.isSafeInteger(minimumFreeBytes)||minimumFreeBytes<0)throw Error('Disk reserve must be a finite nonnegative integer');
 if(raw.enabled!==true)throw Error('The signed startup update policy must be enabled before Harness can start');
 return{...raw,minimumFreeBytes:Math.max(minimumFreeBytes,2*1024*MIB)};
}
function safeEnvironment(root){return{PATH:process.env.PATH??'/usr/bin:/bin',HOME:path.join(root,'update-cache/home'),LANG:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};}
function program(command,args,{root,timeout=30000,maxBuffer=64*MIB,...options}={}){const result=cp.spawnSync(command,args,{encoding:null,timeout,maxBuffer,env:safeEnvironment(root),...options});if(result.error||result.status!==0)throw Error(path.basename(command)+' failed');return result.stdout??Buffer.alloc(0);}
function rootOwned(file){const info=fs.lstatSync(file);if(info.isSymbolicLink()||info.uid!==0||(info.mode&0o022))throw Error('Update trust or bootstrap is writable outside root');return info;}
function verifySignature(commit,keyring,signers,directory,{runner=program,root=directory}={}){
 const value=commitPayload(commit),sig=path.join(directory,'commit.sig'),payload=path.join(directory,'commit.payload');
 fs.writeFileSync(sig,value.signature,{mode:0o600});fs.writeFileSync(payload,value.payload,{mode:0o600});
 const status=runner('gpgv',['--homedir',path.join(root,'update-cache/home'),'--keyring',keyring,'--status-fd=1',sig,payload],{root,maxBuffer:MIB}).toString();
 const valid=status.split('\n').filter(x=>x.startsWith('[GNUPG:] VALIDSIG ')).map(x=>x.split(' '));
 if(valid.length!==1||!signers.some(f=>[valid[0][2],valid[0].at(-1)].includes(f)))throw Error('Commit signer is not pinned');
 return true;
}
function linkTo(target,link){const temp=link+'.update-'+process.pid;try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}fs.symlinkSync(target,temp,'dir');fs.renameSync(temp,link);}
function readJSON(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function managedPointer(root,name,collection){
 const file=path.join(root,name),info=fs.lstatSync(file);rootOwned(fs.realpathSync(file));
 if(!info.isSymbolicLink())return{path:file,legacy:path.join(root,collection,'legacy-'+Date.now()),directory:true};
 const resolved=fs.realpathSync(file),base=path.join(root,collection)+path.sep;if(!resolved.startsWith(base))throw Error('Release pointer is outside managed storage');return{path:file,legacy:resolved,directory:false};
}
function restoreTransaction(root){
 const journal=path.join(root,'root-secrets/startup-update-transaction.json'),transaction=readJSON(journal,null);if(!transaction)return false;
 const base=path.join(root,'releases')+path.sep;
 if(typeof transaction.previous!=='string'||path.dirname(path.resolve(transaction.previous))!==path.resolve(root,'releases')||transaction.link!==path.join(root,'app'))throw Error('Update recovery journal requires operator review');
 if(!fs.existsSync(transaction.previous)&&fs.existsSync(transaction.link)&&!fs.lstatSync(transaction.link).isSymbolicLink()){rootOwned(transaction.link);fs.unlinkSync(journal);return true;}
 if(!fs.existsSync(transaction.previous))throw Error('Update recovery release is missing');
 const current=fs.existsSync(transaction.link)?fs.lstatSync(transaction.link):null;
 if(current&&!current.isSymbolicLink())throw Error('Update recovery would overwrite an unmanaged directory');
 rootOwned(transaction.previous);linkTo(transaction.previous,transaction.link);
 const applied=path.join(root,'root-secrets/startup-update-applied.json');if(transaction.previousApplied)atomic(applied,transaction.previousApplied);else if(fs.existsSync(applied))fs.unlinkSync(applied);
 fs.unlinkSync(journal);return true;
}
function activate(root,candidate,sha,{afterSwitch=()=>{}}={}){
 const journal=path.join(root,'root-secrets/startup-update-transaction.json'),pointer=managedPointer(root,'app','releases');
 if(path.dirname(path.resolve(candidate))!==path.resolve(root,'releases'))throw Error('Candidate is outside managed releases');
 const digest=releaseDigest(candidate),applied=path.join(root,'root-secrets/startup-update-applied.json'),previousApplied=readJSON(applied,null);
 // Persist intent before the first rename. The stable bootstrap can recover a gap.
 atomic(journal,{version:1,link:pointer.path,previous:pointer.legacy,target:candidate,previousApplied});
 if(pointer.directory)fs.renameSync(pointer.path,pointer.legacy);
 try{linkTo(candidate,pointer.path);afterSwitch();atomic(applied,{commit:sha,digest,previous:pointer.legacy,at:new Date().toISOString()});fs.unlinkSync(journal);}
 catch(error){linkTo(pointer.legacy,pointer.path);if(previousApplied)atomic(applied,previousApplied);else if(fs.existsSync(applied))fs.unlinkSync(applied);fs.unlinkSync(journal);throw error;}
}
function sameRuntime(candidate,root){return['package.json','package-lock.json'].every(name=>fs.readFileSync(path.join(candidate,'runtime',name)).equals(fs.readFileSync(path.join(root,'runtime',name))));}
function releaseDigest(directory){rootOwned(directory);const hash=crypto.createHash('sha256');function visit(relative){for(const entry of fs.readdirSync(path.join(directory,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const name=path.join(relative,entry.name),file=path.join(directory,name),info=rootOwned(file);hash.update(name.split(path.sep).join('/')+'\0');if(entry.isDirectory()){hash.update('directory\0');visit(name);}else if(entry.isFile()){hash.update('file:'+(info.mode&0o111?'x':'-')+'\0');hash.update(fs.readFileSync(file));hash.update('\0');}else throw Error('Unsafe release entry');}}visit('');return hash.digest('hex');}
function statusWriter(root){let state={version:1,enabled:true,phase:'checking',checkedAt:null,appliedCommit:readJSON(path.join(root,'root-secrets/startup-update-applied.json'),{})?.commit??null,targetCommit:null,error:null,signatureVerified:false};return patch=>{state={...state,...patch,checkedAt:new Date().toISOString()};atomic(path.join(root,'state/startup-update.json'),state,0o644);return state;};}
async function update(root='/data/harness',{checkOnly=false}={}){
 const configFile=path.join(root,'root-secrets/startup-update.json');
 let checked={};const write=checkOnly?(patch=>checked={...checked,...patch}):statusWriter(root);
 const cache=path.join(root,'update-cache'),releases=path.join(root,'releases');
 let work;try{
 if(!fs.existsSync(configFile))throw Error('Signed startup update policy is missing; install the trusted startup gate before starting Harness');
 // Parse only as data; trust ownership is still required before using policy,
 // running any external command or staging a release.
 const settings=config(readJSON(configFile));rootOwned(configFile);
 for(const directory of[cache,path.join(cache,'home'),releases]){fs.mkdirSync(directory,{recursive:true,mode:directory===releases?0o755:0o700});rootOwned(directory);}
 rootOwned(path.join(root,'root-secrets/startup-update-signers.gpg'));
  if(checkOnly&&fs.existsSync(path.join(root,'root-secrets/startup-update-transaction.json')))throw Error('An unfinished activation requires startup recovery');
  if(!checkOnly&&restoreTransaction(root))write({phase:'rollback',error:'An interrupted activation was rolled back; checking current main again.'});
  write({phase:'checking',error:null});
  const repo=path.join(cache,'repository.git'),gitArgs=['-c','protocol.allow=never','-c','protocol.https.allow=always','-c','core.hooksPath=/dev/null','--git-dir='+repo];
  if(!fs.existsSync(repo))program('git',['init','--bare',repo],{root});else rootOwned(repo);
  program('git',[...gitArgs,'fetch','--depth=1','--no-tags','https://github.com/'+REPOSITORY+'.git','refs/heads/main'],{root,timeout:90000,maxBuffer:4*MIB});
  const sha=program('git',[...gitArgs,'rev-parse','FETCH_HEAD'],{root}).toString().trim();if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid update commit');
  work=fs.mkdtempSync(path.join(cache,'stage-'));fs.chmodSync(work,0o700);write({phase:'verifying',targetCommit:sha});
  verifySignature(program('git',[...gitArgs,'cat-file','commit',sha],{root,maxBuffer:MIB}),path.join(root,'root-secrets/startup-update-signers.gpg'),settings.signers,work,{root});
  write({signatureVerified:true});
  const applied=readJSON(path.join(root,'root-secrets/startup-update-applied.json'),{});
  if(applied.commit===sha&&fs.realpathSync(path.join(root,'app'))===path.join(releases,sha)){if(!applied.digest||releaseDigest(path.join(releases,sha))!==applied.digest)throw Error('Applied release differs from its verified source');return write({phase:'ready',appliedCommit:sha});}
  const space=fs.statfsSync(root);if(Number(space.bavail)*Number(space.bsize)<settings.minimumFreeBytes+96*MIB)throw Error('Insufficient disk reserve for a safe code update');
  write({phase:'staging'});const archive=path.join(work,'release.tar');fs.writeFileSync(archive,program('git',[...gitArgs,'archive','--format=tar',sha],{root}));
  const candidate=path.join(releases,sha);
  // A previous failed stage may exist. Validate its exact tree rather than trust it.
  const staging=path.join(work,'app');program('python3',[path.join(__dirname,'startup-extract.py'),archive,staging],{root});
  if(!sameRuntime(staging,root))throw Error('The new version requires a runtime dependency upgrade; maintenance is required before queries can start');
  for(const file of['vast/supervisor.cjs','vast/startup-update.cjs','workspace/plugin.mjs','workspace/manager.mjs','vast/apps-service.cjs'])program(process.execPath,['--check',path.join(staging,file)],{root,maxBuffer:MIB});
  program('bash',['-n',path.join(staging,'vast/startup-bootstrap.sh')],{root});
  if(Number(fs.statfsSync(root).bavail)*Number(fs.statfsSync(root).bsize)<settings.minimumFreeBytes)throw Error('Disk reserve fell below the configured minimum');
  if(fs.existsSync(candidate)&&releaseDigest(candidate)!==releaseDigest(staging))throw Error('An existing release differs from its signed source');
  if(checkOnly)return{...checked,checkOnly:true,verified:true,commit:sha};
  if(!fs.existsSync(candidate))fs.renameSync(staging,candidate);
  // Keep recovery code stable; its upgrades are separate explicit maintenance.
  activate(root,candidate,sha);
  return write({phase:'ready',appliedCommit:sha,error:null});
 }catch(error){
  // A first installation may not have state/ yet. A failed diagnostic write
  // must never turn rejected policy into success or hide its original error.
  try{write({phase:'blocked',error:error.code?'Update filesystem operation failed ('+String(error.code).replace(/[^A-Z0-9_]/g,'')+').':error instanceof SyntaxError?'Startup update policy contains invalid JSON.':error.message,appliedCommit:readJSON(path.join(root,'root-secrets/startup-update-applied.json'),{})?.commit??null});}catch{}
  throw error;
 }
 finally{if(work&&path.resolve(work).startsWith(path.resolve(cache)+path.sep+'stage-'))fs.rmSync(work,{recursive:true,force:true});}
}
module.exports={commitPayload,config,verifySignature,activate,restoreTransaction,sameRuntime,update,statusWriter,atomic,releaseDigest};
if(require.main===module)update(process.argv[2]??'/data/harness',{checkOnly:process.argv.includes('--check')}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error('Startup update blocked: '+error.message);process.exitCode=1;});
