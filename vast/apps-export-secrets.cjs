'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{constants}=require('node:fs');
const {atomicJson}=require('../mobile/private-json.cjs'),{secretForms}=require('./apps-command.cjs'),{isPrivateSourcePath}=require('../workspace/source-private.cjs');
const PROOF='.export-credential-proof.json',LIMIT=128*1024*1024;
const messages={EXPORT_SECRET_DETECTED:'A configured credential appears in the release files. Remove it and verify a new release before exporting.',EXPORT_SECRET_CHECK_UNAVAILABLE:'The credential export check is unavailable. Verify a new release with the current project settings before exporting.',EXPORT_VAULT_UNAVAILABLE:'The configured credential values could not be checked. Retry export when the existing vault is available.'};
const fault=code=>Object.assign(Error(code+': '+messages[code]),{code});
const downloadFault=()=>Object.assign(Error('EXPORT_DOWNLOAD_REVERIFY_REQUIRED: This archive has no matching credential-check proof. Verify a new release and export it again.'),{code:'EXPORT_DOWNLOAD_REVERIFY_REQUIRED',status:409});
const pairs=value=>Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b));
const used=credentials=>['runtime','build'].some(kind=>Object.keys(credentials?.[kind]||{}).length);
const bindingDigest=(credentials,kind)=>crypto.createHash('sha256').update(JSON.stringify([credentials?.scope?.projectId,credentials?.scope?.environment,credentials?.scope?.secretPath,...(kind?[pairs(credentials?.[kind])]:[pairs(credentials?.runtime),pairs(credentials?.build)])])).digest('hex');
function detector(values){
 const patterns=secretForms(values).map(value=>Buffer.from(value)),overlap=Math.max(0,...patterns.map(value=>value.length-1));
 return()=>{let tail=Buffer.alloc(0);return bytes=>{const input=tail.length?Buffer.concat([tail,bytes]):bytes;for(const pattern of patterns)if(input.includes(pattern))throw fault('EXPORT_SECRET_DETECTED');tail=overlap?Buffer.from(input.subarray(Math.max(0,input.length-overlap))):Buffer.alloc(0);};};
}
function exportMetadata(releaseId,credentials={}){
 return{
  'required-secrets.json':JSON.stringify({runtime:Object.keys(credentials.runtime||{}),build:Object.keys(credentials.build||{}),valuesIncluded:false},null,2),
  'README.txt':'Verified application release '+releaseId+'\n\nSource: source/\nDeployment: source/.harness-app.json and Dockerfile or Compose file\nEvidence: release.json and source/.harness/ (browser reports and screenshots)\nRequired credentials: required-secrets.json (names only; supply them from your own vault)\n\nRun a single application: docker build -t exported-app source\nThen use the port and health/test settings from .harness-app.json. Pass build credentials with --secret and runtime credentials separately.\nCompose applications: review the original Compose file and supply its vault references for your environment.\nPersistent database contents are not included. Application rollback does not reverse database migrations.\n'
 };
}
const metadataDigest=(releaseId,credentials)=>crypto.createHash('sha256').update(JSON.stringify(exportMetadata(releaseId,credentials))).digest('hex');
// One bounded walker handles the release-time witness and the exact private copy
// consumed by tar. Binary files and matches crossing read chunks are included.
async function inspect(root,{values=[],destination,deadline=Date.now()+120000}={}){
 const resolved=await fs.realpath(root);if(resolved!==path.resolve(root))throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
 const makeDetector=detector(values),tree=crypto.createHash('sha256');let bytes=0,files=0,entries=0;
 async function visit(relative){
  if(Date.now()>deadline||++entries>16000)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
  if(isPrivateSourcePath(relative))return;
  const name=relative.split(path.sep).join('/');makeDetector()(Buffer.from(name));
  const source=path.join(root,relative),stat=await fs.lstat(source);
  if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
  if(stat.isDirectory()){
   if(destination)await fs.mkdir(path.join(destination,relative),{mode:0o700});
   tree.update(JSON.stringify(['directory',name,stat.mode&0o777])+'\n');
   for(const child of (await fs.readdir(source)).sort())await visit(path.join(relative,child));
   if(destination)await fs.chmod(path.join(destination,relative),stat.mode&0o777);return;
  }
  if(++files>12001||stat.nlink!==1||stat.size>LIMIT-bytes)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
  const input=await fs.open(source,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));let output;
  try{
   const opened=await input.stat(),actual=await fs.realpath(process.platform==='linux'?'/proc/self/fd/'+input.fd:source);
   if(!opened.isFile()||opened.nlink!==1||opened.dev!==stat.dev||opened.ino!==stat.ino||actual!==source)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
   if(destination)output=await fs.open(path.join(destination,relative),'wx',0o600);
   const digest=crypto.createHash('sha256'),scan=makeDetector();let count=0;
   for await(const chunk of input.createReadStream({autoClose:false,highWaterMark:64*1024})){
    count+=chunk.length;bytes+=chunk.length;if(bytes>LIMIT||Date.now()>deadline)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');scan(chunk);digest.update(chunk);if(output)await output.writeFile(chunk);
   }
   const end=await input.stat();if(count!==stat.size||end.size!==stat.size||end.mtimeMs!==stat.mtimeMs)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
   if(output)await output.chmod(stat.mode&0o777);
   tree.update(JSON.stringify(['file',name,stat.mode&0o777,count,digest.digest('hex')])+'\n');
  }finally{await output?.close();await input.close();}
 }
 try{await visit('release.json');await visit('source');return{sha256:tree.digest('hex'),bytes,files};}
 catch(error){throw messages[error.code]?error:fault('EXPORT_SECRET_CHECK_UNAVAILABLE');}
}
async function readProof(root){
 try{
  const file=path.join(root,PROOF),handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>4096)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
 }catch(error){if(error.code==='ENOENT')return null;throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');}
}
async function recordProof(manager,projectId,releaseId){
 const credentials=manager.project(projectId).credentials,seen=manager.credentialBindings?.get(releaseId);
 if(!used(credentials)&&!seen?.required)return;
 const root=manager.releases.dir(projectId,releaseId),proof={version:1,requiresCredentials:true,bindingDigest:bindingDigest(credentials),status:'unavailable'};
 try{
  if((await manager.releases.get(projectId,releaseId)).credentialUse?.origin==='retained-unknown')throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
  if(seen?.required&&!used(credentials)||['runtime','build'].some(kind=>(Object.keys(credentials?.[kind]||{}).length||seen?.[kind])&&seen?.[kind]!==bindingDigest(credentials,kind)))throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
  const values=manager.redactions.get(releaseId)||[],scan=detector(values);
  for(const[name,contents]of Object.entries(exportMetadata(releaseId,credentials))){scan()(Buffer.from(name));scan()(Buffer.from(contents));}
  proof.content=await inspect(root,{values});proof.metadata=metadataDigest(releaseId,credentials);proof.status='clean';
 }catch(error){proof.status=error.code==='EXPORT_SECRET_DETECTED'?'blocked':'unavailable';}
 // This proof never stores values, prefixes, or hashes of credential values.
 // Failure to persist leaves credential-using export unavailable, not deployment
 // falsely failed after the application has already been promoted.
 try{atomicJson(path.join(root,PROOF),proof);}catch{}
}
async function prepareExport(manager,projectId,releaseId,destination){
 const root=manager.releases.dir(projectId,releaseId),credentials=manager.project(projectId).credentials||{},proof=await readProof(root),release=await manager.releases.get(projectId,releaseId),needsCheck=used(credentials)||proof?.requiresCredentials===true||release.requiresCredentialProof===true;
 // Absence is historical uncertainty, never evidence that a release used no
 // credentials. A retained matching private witness can still prove it clean.
 if(typeof release.requiresCredentialProof!=='boolean'&&!(proof?.version===1&&proof.requiresCredentials===true))throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
 if(needsCheck){
  if(proof?.status==='blocked')throw fault('EXPORT_SECRET_DETECTED');
  if(proof?.version!==1||proof.status!=='clean'||proof.bindingDigest!==bindingDigest(credentials)||proof.metadata!==metadataDigest(releaseId,credentials)||!/^[a-f0-9]{64}$/.test(proof.content?.sha256||''))throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
 }
 let values=[];
 if(used(credentials))try{
  for(const kind of ['runtime','build'])if(Object.keys(credentials[kind]||{}).length)values.push(...Object.values(await manager.vault.resolve(credentials.scope,credentials[kind])));
 }catch{throw fault('EXPORT_VAULT_UNAVAILABLE');}
 const content=await inspect(root,{values,destination});
 if(needsCheck&&content.sha256!==proof.content.sha256)throw fault('EXPORT_SECRET_CHECK_UNAVAILABLE');
 return{content,values};
}
async function openDownload(exported){
 let handle;
 try{
  const canonical=path.resolve(exported.file);if(await fs.realpath(canonical)!==canonical)throw downloadFault();
  handle=await fs.open(canonical,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size!==exported.bytes||before.size<1||before.size>LIMIT)throw downloadFault();
  if(process.platform==='linux'&&await fs.realpath('/proc/self/fd/'+handle.fd)!==canonical)throw downloadFault();
  const digest=crypto.createHash('sha256');let bytes=0;const deadline=Date.now()+120000;
  for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>exported.bytes||Date.now()>deadline)throw downloadFault();digest.update(chunk);}
  const after=await handle.stat();if(bytes!==exported.bytes||after.size!==before.size||after.mtimeMs!==before.mtimeMs||digest.digest('hex')!==exported.sha256)throw downloadFault();
  // Transfer this very handle to the response; never reopen the path after the
  // check. Archives are private, service-owned and never modified in place.
  return{...exported,handle};
 }catch{await handle?.close();throw downloadFault();}
}
module.exports={bindingDigest,recordProof,prepareExport,inspect,used,detector,fault,exportMetadata,openDownload,downloadFault};
