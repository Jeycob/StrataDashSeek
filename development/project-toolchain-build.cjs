'use strict';
// Offline operator recipe only. No curl, npm install, image build, lifecycle
// scripts, global environment discovery or copies from a live Harness tree.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const toolchain=require('./project-toolchain.cjs');
const {PINS,NPM_VERSION,NPM_INTEGRITY,SOURCE_FILES,MANIFEST}=toolchain;
const digest=(bytes,algorithm='sha256')=>crypto.createHash(algorithm).update(bytes).digest('hex');
function prepare(recipe){
 if(recipe?.version!==1||!/^[a-f0-9]{40}$/.test(recipe.sourceCommit??'')||typeof recipe.sourceRepo!=='string'||!path.isAbsolute(recipe.sourceRepo)||!recipe.artifacts)throw Error('TOOLCHAIN_RECIPE_INVALID');
 const a=recipe.artifacts,inputs={codeServer:{version:PINS.codeServer,sha256:PINS.codeServerSHA256},dotnet:{version:PINS.dotnet,sha512:PINS.dotnetSHA512},playwright:{version:PINS.playwright,integrity:PINS.playwrightIntegrity},playwrightCore:{version:PINS.playwright,integrity:PINS.playwrightCoreIntegrity},npm:{version:NPM_VERSION,integrity:NPM_INTEGRITY},browsers:a.browsers?.map(({name,revision,sha256,executable})=>({name,revision,sha256,executable}))};
 toolchain.checkPins(inputs);
 const archives=[
  {file:a.codeServer,destination:'code-server',format:'tar',strip:1,algorithm:'sha256',expected:PINS.codeServerSHA256},
  {file:a.dotnet,destination:'dotnet',format:'tar',strip:0,algorithm:'sha512',expected:PINS.dotnetSHA512},
  {file:a.playwright,destination:'playwright/node_modules/playwright',format:'tar',strip:1,algorithm:'sha512',expected:Buffer.from(PINS.playwrightIntegrity.slice(7),'base64').toString('hex')},
  {file:a.playwrightCore,destination:'playwright/node_modules/playwright-core',format:'tar',strip:1,algorithm:'sha512',expected:Buffer.from(PINS.playwrightCoreIntegrity.slice(7),'base64').toString('hex')},
  {file:a.npm,destination:'npm',format:'tar',strip:1,algorithm:'sha512',expected:Buffer.from(NPM_INTEGRITY.slice(7),'base64').toString('hex')},
  ...a.browsers.map(b=>({file:b.file,destination:'playwright/browsers/'+b.name.replaceAll('-','_')+'-'+b.revision,format:'zip',strip:0,algorithm:'sha256',expected:b.sha256})),
 ];
 for(const archive of archives)if(typeof archive.file!=='string'||!path.isAbsolute(archive.file))throw Error('TOOLCHAIN_OFFLINE_ARTIFACT_REQUIRED');
 return{inputs,archives};
}
function readSource(repo,commit,name){
 return cp.execFileSync('/usr/bin/git',['--no-pager','-c','safe.directory='+repo,'-C',repo,'show','--no-textconv',commit+':'+name],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'},maxBuffer:2*1024**2,timeout:10000});
}
function transformSource(name,bytes){
 let text=bytes.toString('utf8');
 if(name==='development/doctor.cjs')text=text.replaceAll('/data/harness/dev/browser/node_modules/playwright','/opt/playwright/node_modules/playwright').replaceAll('/data/harness/dev/browsers','/opt/playwright/browsers').replaceAll('/data/harness/dev/dotnet/dotnet','/opt/dotnet/dotnet').replaceAll('/data/harness/state/development','/tmp/homeai-development');
 if(name==='workspace/tool-recovery.mjs')text=text.replaceAll('/data/harness/app/quality/README.md','/opt/homeai/quality/README.md');
 return Buffer.from(text);
}
function auditSources(files){
 const allowed=new Set(Object.values(SOURCE_FILES).map(name=>name.slice('homeai/'.length)));
 for(const[source,destination]of Object.entries(SOURCE_FILES)){
  if(!/\.(?:mjs|cjs)$/.test(source))continue;
  const code=files.get(source).installed.toString('utf8'),at=destination.slice('homeai/'.length);
  for(const match of code.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)){
   const spec=match[1];if(spec.startsWith('node:'))continue;
   if(spec.startsWith('.')){if(!allowed.has(path.posix.normalize(path.posix.join(path.posix.dirname(at),spec))))throw Error('TOOLCHAIN_SOURCE_DEPENDENCY_UNLISTED');}
   else if(!['/opt/playwright/node_modules/playwright','/opt/playwright/node_modules/playwright/package.json'].includes(spec))throw Error('TOOLCHAIN_SOURCE_DEPENDENCY_UNLISTED');
  }
 }
}
function write(root,name,bytes,mode=0o444){
 const full=path.join(root,name);fs.mkdirSync(path.dirname(full),{recursive:true,mode:0o700});const fd=fs.openSync(full,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function seal(root,sealRoot=true){
 const dir=fs.opendirSync(root);try{for(let child;(child=dir.readSync());){const full=path.join(root,child.name),s=fs.lstatSync(full);if(s.isDirectory())seal(full);else if(s.isFile())fs.chmodSync(full,0o444|(s.mode&0o111));else if(!s.isSymbolicLink())throw Error('TOOLCHAIN_SPECIAL_FILE');}}finally{dir.closeSync();}
 // Root remains owner-writable until the manifest is durably published.
 if(sealRoot)fs.chmodSync(root,0o555);const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function buildOffline(recipe,output){
 if(process.platform!=='linux'||process.getuid()!==0)throw Error('TOOLCHAIN_ROOT_OFFLINE_BUILDER_REQUIRED');
 if(typeof output!=='string'||!path.isAbsolute(output)||output==='/'||path.normalize(output)!==output||fs.realpathSync(path.dirname(output))!==path.dirname(output))throw Error('TOOLCHAIN_NEW_CANONICAL_OUTPUT_REQUIRED');
 for(let parent=path.dirname(output);;parent=path.dirname(parent)){const info=fs.lstatSync(parent);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||info.mode&0o022)throw Error('TOOLCHAIN_TRUSTED_OUTPUT_PARENT_REQUIRED');if(parent==='/')break;}
 const plan=prepare(recipe),repo=fs.realpathSync(recipe.sourceRepo);
 if(repo!==recipe.sourceRepo)throw Error('TOOLCHAIN_CANONICAL_REPOSITORY_REQUIRED');
 const lock=JSON.parse(readSource(repo,recipe.sourceCommit,'development/project-toolchain-lock.json'));
 if(toolchain.canonical(lock.codeServer)!==toolchain.canonical(plan.inputs.codeServer)||toolchain.canonical(lock.dotnet)!==toolchain.canonical(plan.inputs.dotnet)||toolchain.canonical(lock.playwright)!==toolchain.canonical(plan.inputs.playwright)||toolchain.canonical(lock.playwrightCore)!==toolchain.canonical(plan.inputs.playwrightCore)||toolchain.canonical(lock.npm)!==toolchain.canonical(plan.inputs.npm)||lock.nodeVersion!=='24.22.1')throw Error('TOOLCHAIN_SOURCE_LOCK_MISMATCH');
 const ciLock=JSON.parse(readSource(repo,recipe.sourceCommit,'development/ci/package-lock.json'));
 for(const[name,expected]of [['playwright',plan.inputs.playwright],['playwright-core',plan.inputs.playwrightCore]]){const row=ciLock.packages?.['node_modules/'+name];if(row?.version!==expected.version||row.integrity!==expected.integrity)throw Error('TOOLCHAIN_SOURCE_LOCK_MISMATCH');}
 const sources=new Map(Object.keys(SOURCE_FILES).map(name=>{const original=readSource(repo,recipe.sourceCommit,name);return[name,{original,installed:transformSource(name,original)}];}));auditSources(sources);
 // Exclusive destination; failures leave an UNPUBLISHED tree for inspection.
 // Never recursively delete a caller-selected artifact directory.
 fs.mkdirSync(output,{mode:0o700});const descriptors=[];let remainingBytes=toolchain.LIMITS.bytes-[...sources.values()].reduce((n,s)=>n+s.installed.length,0)-toolchain.LIMITS.manifestBytes-1024*1024,remainingEntries=toolchain.LIMITS.entries-128;
 try{
  for(const archive of plan.archives){
   const fd=fs.openSync(archive.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);descriptors.push(fd);const s=fs.fstatSync(fd);
   if(!s.isFile()||s.nlink!==1||s.size<1||s.size>2*1024**3)throw Error('TOOLCHAIN_ARTIFACT_INVALID');
   const h=crypto.createHash(archive.algorithm),buffer=Buffer.alloc(1024*1024);let offset=0;
   for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,offset));){offset+=n;if(offset>s.size)throw Error('TOOLCHAIN_ARTIFACT_CHANGED');h.update(buffer.subarray(0,n));}
   if(h.digest('hex')!==archive.expected)throw Error('TOOLCHAIN_ARTIFACT_INTEGRITY');
   const destination=path.join(output,archive.destination);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
   const report=JSON.parse(cp.execFileSync('/usr/bin/python3',[path.join(__dirname,'project-toolchain-unpack.py'),'--fd','3','--destination',destination,'--strip',String(archive.strip),'--format',archive.format,'--max-bytes',String(remainingBytes),'--max-entries',String(remainingEntries)],{stdio:['ignore','pipe','pipe',fd],env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},timeout:125000,maxBuffer:4096}));
   if(!Number.isSafeInteger(report.bytes)||report.bytes<0||report.bytes>remainingBytes||!Number.isSafeInteger(report.entries)||report.entries<0||report.entries>remainingEntries)throw Error('TOOLCHAIN_EXTRACTION_REPORT_INVALID');remainingBytes-=report.bytes;remainingEntries-=report.entries;
   const after=fs.fstatSync(fd);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>s[k]!==after[k]))throw Error('TOOLCHAIN_ARTIFACT_CHANGED');
  }
  const sourceFiles=[];
  for(const[source,destination]of Object.entries(SOURCE_FILES)){
   const {original,installed}=sources.get(source);write(output,destination,installed);
   sourceFiles.push({source,destination,sourceSha256:digest(original),installedSha256:digest(installed)});
  }
  const npmBin=fs.lstatSync(path.join(output,'npm/bin'));if(!npmBin.isDirectory()||npmBin.isSymbolicLink())throw Error('TOOLCHAIN_NPM_BIN_INVALID');
  for(const[name,content]of Object.entries(toolchain.NPM_WRAPPERS)){
   const full=path.join(output,'npm/bin',name);try{const s=fs.lstatSync(full);if(s.isDirectory())throw Error('TOOLCHAIN_NPM_WRAPPER_INVALID');fs.unlinkSync(full);}catch(error){if(error.code!=='ENOENT')throw error;}
   write(output,'npm/bin/'+name,Buffer.from(content),0o555);
  }
  write(output,'playwright/package.json',Buffer.from('{"name":"homeai-prepared-playwright","private":true,"version":"1.0.0"}\n'));
  write(output,'playwright/package-lock.json',Buffer.from(toolchain.canonical({name:'homeai-prepared-playwright',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'homeai-prepared-playwright',version:'1.0.0',dependencies:{playwright:PINS.playwright}},'node_modules/playwright':{version:PINS.playwright,integrity:PINS.playwrightIntegrity,dependencies:{'playwright-core':PINS.playwright}},'node_modules/playwright-core':{version:PINS.playwright,integrity:PINS.playwrightCoreIntegrity}}})+'\n'));
  // Retain the exact audited dependency pin evidence, not the Harness SDK or
  // the CI-only Wrangler tree. No npm lifecycle commands are executed here.
  write(output,'playwright/pinned-inputs.json',Buffer.from(toolchain.canonical({playwright:plan.inputs.playwright,playwrightCore:plan.inputs.playwrightCore})+'\n'));
  seal(output,false);
  const value=toolchain.createManifest(output,{sourceCommit:recipe.sourceCommit,inputs:plan.inputs,sourceFiles});
  write(output,MANIFEST,Buffer.from(value.bytes));
  fs.chmodSync(output,0o555);
  const fd=fs.openSync(output,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return toolchain.verifyToolchain(output,{expectedDigest:value.manifestSha256,expectedUid:0});
 }finally{for(const fd of descriptors)fs.closeSync(fd);}
}
module.exports={prepare,readSource,transformSource,auditSources,buildOffline};
if(require.main===module){try{if(process.argv.length!==4)throw Error('TOOLCHAIN_USAGE');const input=fs.lstatSync(process.argv[2]);if(!input.isFile()||input.isSymbolicLink()||input.size>65536)throw Error('TOOLCHAIN_RECIPE_INVALID');const result=buildOffline(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.argv[3]);console.log(JSON.stringify(result));}catch{console.error('TOOLCHAIN_BUILD_REFUSED_UNPUBLISHED');process.exitCode=1;}}
