'use strict';
// Synchronous bounded validation of a separately provisioned immutable tree.
// Never downloads, executes artifacts or discovers/adopts a host toolchain.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MANIFEST='.homeai-toolchain.json',SHA=/^[a-f0-9]{64}$/;
const PINS=Object.freeze({codeServer:'4.145.2',codeServerSHA256:'2f6db6c3e8b733dd6b3aeee83532e148b2bae2e392353ba85452d03572348962',playwright:'1.65.1',playwrightIntegrity:'sha512-vJ1FuoOrNwOKHUIVEvSt3jT1L+wjjDpwhwIstKtfvTh8XIG4FG4bIFuvNdMxi81LGfAhUgUZleVFaOLY4RIUUw==',playwrightCoreIntegrity:'sha512-hqPpz7blSMPxWVdoeE1yiBSzXsKiVOd2k+kjCvmUywD2GPO2Dd9HfcWnq9NN0GHbNZDFgZ9JfBFr+X5/BLo0qw==',dotnet:'10.0.404',dotnetSHA512:'577d0eb17fec33d029104c5c63a1ab0accc3e28776274abef2218dbac5af18d2109b5406d26b31d76f5c245215e3ba0926a94c20246c672c41847c9e1eb1dc50'});
const SOURCE_FILES=Object.freeze({
 'quality/core.mjs':'homeai/quality/core.mjs','quality/browser.mjs':'homeai/quality/browser.mjs','quality/cli.mjs':'homeai/quality/cli.mjs','quality/README.md':'homeai/quality/README.md',
 'quality/browser-server-contract.mjs':'homeai/quality/browser-server-contract.mjs','quality/browser-server-client.mjs':'homeai/quality/browser-server-client.mjs',
 'quality/browser-server-diagnostic.mjs':'homeai/quality/browser-server-diagnostic.mjs',
 'quality/criteria.mjs':'homeai/quality/criteria.mjs',
 'workspace/tool-recovery.mjs':'homeai/workspace/tool-recovery.mjs','workspace/source-private.cjs':'homeai/workspace/source-private.cjs','workspace/process-lock.mjs':'homeai/workspace/process-lock.mjs',
 'development/test-command.cjs':'homeai/development/test-command.cjs','development/versions.json':'homeai/development/versions.json','development/doctor.cjs':'homeai/development/doctor.cjs','runtime/require.cjs':'homeai/runtime/require.cjs',
 'workspace/editor-runtime/socket-relay.cjs':'homeai/socket-relay.cjs','workspace/egress-runtime/egress-launch.cjs':'homeai/egress-launch.cjs','workspace/egress-runtime/connect-proxy.cjs':'homeai/connect-proxy.cjs'});
const REQUIRED=Object.freeze([...Object.values(SOURCE_FILES),'code-server/lib/node','code-server/bin/code-server','code-server/package.json','dotnet/dotnet','playwright/node_modules/playwright/package.json','playwright/node_modules/playwright-core/package.json','playwright/node_modules/playwright-core/browsers.json','npm/package.json','npm/bin/npm-cli.js','npm/bin/npx-cli.js','npm/bin/npm','npm/bin/npx']);
const LIMITS=Object.freeze({entries:100000,bytes:8*1024**3,fileBytes:2*1024**3,manifestBytes:32*1024**2,depth:48,milliseconds:15000});
const NPM_VERSION='12.2.2',NPM_INTEGRITY='sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==';
const NPM_WRAPPERS=Object.freeze(Object.fromEntries(['npm','npx'].map(name=>[name,'#!/bin/sh\nexec /opt/code-server/lib/node /opt/npm/bin/'+name+'-cli.js "$@"\n'])));
const error=code=>Error('TOOLCHAIN_'+code);
function canonical(value){if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function relative(name){return typeof name==='string'&&name.length>0&&name.length<=1024&&!name.includes('\\')&&!/[\x00-\x1f\x7f]/.test(name)&&!path.posix.isAbsolute(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..');}
function fingerprint(s){return[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');}
function checkPins(inputs){
 if(!inputs||inputs.codeServer?.version!==PINS.codeServer||inputs.codeServer.sha256!==PINS.codeServerSHA256||inputs.dotnet?.version!==PINS.dotnet||inputs.dotnet.sha512!==PINS.dotnetSHA512||inputs.playwright?.version!==PINS.playwright||inputs.playwright.integrity!==PINS.playwrightIntegrity||inputs.playwrightCore?.version!==PINS.playwright||inputs.playwrightCore.integrity!==PINS.playwrightCoreIntegrity)throw error('INPUT_PIN_MISMATCH');
 if(inputs.npm?.version!==NPM_VERSION||inputs.npm.integrity!==NPM_INTEGRITY)throw error('NPM_PIN_MISMATCH');
 if(!Array.isArray(inputs.browsers)||inputs.browsers.length<3||inputs.browsers.length>16)throw error('BROWSER_PINS_REQUIRED');
 const names=new Set();for(const b of inputs.browsers){if(!/^[a-z][a-z0-9-]{0,63}$/.test(b.name??'')||names.has(b.name)||!/^\d{1,10}$/.test(b.revision??'')||!SHA.test(b.sha256??'')||!relative(b.executable)||!b.executable.startsWith('playwright/browsers/'+b.name.replaceAll('-','_')+'-'+b.revision+'/'))throw error('BROWSER_PIN_INVALID');names.add(b.name);}
 for(const name of ['chromium','chromium-headless-shell','ffmpeg'])if(!names.has(name))throw error('REQUIRED_BROWSER_MISSING');
}
function scan(root,{expectedUid=0,limits=LIMITS}={}){
 if(process.platform!=='linux'||!Number.isInteger(expectedUid)||expectedUid<0)throw error('LINUX_OWNER_REQUIRED');
 if(typeof root!=='string'||!path.isAbsolute(root)||root==='/'||path.normalize(root)!==root||fs.realpathSync(root)!==root)throw error('CANONICAL_ROOT_REQUIRED');
 const started=Date.now(),entries=[],buffer=Buffer.alloc(1024*1024);let bytes=0;
 const check=()=>{if(Date.now()-started>limits.milliseconds)throw error('DEADLINE');};
 function infoCheck(s){if(s.uid!==expectedUid||!s.isSymbolicLink()&&(s.mode&0o6022))throw error('OWNER_OR_WRITABLE_MODE');}
 const rootInfo=fs.lstatSync(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw error('DIRECTORY_REQUIRED');infoCheck(rootInfo);
 function walk(directory,depth){
  check();if(depth>limits.depth)throw error('DEPTH_LIMIT');
  const before=fs.lstatSync(directory);infoCheck(before);const dir=fs.opendirSync(directory);
  try{for(let child;(child=dir.readSync());){
   check();const full=path.join(directory,child.name),name=path.relative(root,full).split(path.sep).join('/');if(name===MANIFEST)continue;
   if(!relative(name)||entries.length>=limits.entries)throw error('PATH_OR_ENTRY_LIMIT');
   if(!['code-server','homeai','dotnet','playwright','npm'].includes(name.split('/')[0]))throw error('UNAPPROVED_COMPONENT');
   if(name.startsWith('homeai/')&&!Object.values(SOURCE_FILES).some(p=>p===name||p.startsWith(name+'/')))throw error('UNAPPROVED_TRUSTED_SOURCE');
   if(name.split('/').some(p=>['.dsh','.ssh','.aws','.npmrc','root-secrets','@deepseek-ai'].includes(p)))throw error('PRIVATE_OR_SDK_PATH');
   const s=fs.lstatSync(full);infoCheck(s);if(s.dev!==rootInfo.dev)throw error('NESTED_FILESYSTEM_REFUSED');
   if(s.isDirectory()){entries.push({path:name,type:'directory',mode:s.mode&0o777});walk(full,depth+1);}
   else if(s.isSymbolicLink()){
    const target=fs.readlinkSync(full);if(!target||target.length>2048||!relative(target)&&!(typeof target==='string'&&!path.isAbsolute(target)&&!target.includes('\\')&&!/[\x00-\x1f]/.test(target)))throw error('SYMLINK_TARGET_INVALID');
    const resolved=fs.realpathSync(full),rel=path.relative(root,resolved);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw error('OUTSIDE_SYMLINK');
    entries.push({path:name,type:'symlink',target});
   }else if(s.isFile()){
    if(s.nlink!==1||s.size>limits.fileBytes||bytes+s.size>limits.bytes)throw error('FILE_OR_BYTE_LIMIT');bytes+=s.size;
    const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),digest=crypto.createHash('sha256');
    try{if(fingerprint(fs.fstatSync(fd))!==fingerprint(s))throw error('SOURCE_CHANGED');let offset=0;for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,offset));){check();offset+=n;if(offset>s.size)throw error('SOURCE_CHANGED');digest.update(buffer.subarray(0,n));}if(offset!==s.size||fingerprint(fs.fstatSync(fd))!==fingerprint(s))throw error('SOURCE_CHANGED');}finally{fs.closeSync(fd);}
    entries.push({path:name,type:'file',mode:s.mode&0o777,size:s.size,sha256:digest.digest('hex')});
   }else throw error('SPECIAL_FILE');
  }}finally{dir.closeSync();}
  if(fingerprint(fs.lstatSync(directory))!==fingerprint(before))throw error('SOURCE_CHANGED');
 }
 walk(root,0);entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 if(fingerprint(fs.lstatSync(root))!==fingerprint(rootInfo))throw error('SOURCE_CHANGED');
 return{entries,totalFileBytes:bytes,rootInfo};
}
function metadata(root,name){const full=path.join(root,name),s=fs.lstatSync(full);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>1024*1024)throw error('PACKAGE_METADATA_INVALID');return JSON.parse(fs.readFileSync(full,'utf8'));}
function elf(root,name){const full=path.join(root,name),s=fs.lstatSync(full);if(!s.isFile()||s.isSymbolicLink()||!(s.mode&0o111)||s.size<20)throw error('ELF_EXECUTABLE_REQUIRED');const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),header=Buffer.alloc(20);try{if(fs.readSync(fd,header,0,20,0)!==20||header.subarray(0,6).toString('hex')!=='7f454c460201'||header.readUInt16LE(18)!==62)throw error('LINUX_X64_ELF_REQUIRED');}finally{fs.closeSync(fd);}}
function checkStructure(root,manifest){
 if(manifest.version!==1||manifest.platform!=='linux-x64'||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit??''))throw error('MANIFEST_INVALID');checkPins(manifest.inputs);
 const byPath=new Map(manifest.entries.map(e=>[e.path,e]));for(const name of REQUIRED)if(byPath.get(name)?.type!=='file')throw error('REQUIRED_FILE_MISSING');
 if(!Array.isArray(manifest.sourceFiles)||manifest.sourceFiles.length!==Object.keys(SOURCE_FILES).length)throw error('SOURCE_CLOSURE_INVALID');
 for(const[src,dst]of Object.entries(SOURCE_FILES)){const rows=manifest.sourceFiles.filter(row=>row.source===src&&row.destination===dst);if(rows.length!==1||!SHA.test(rows[0].sourceSha256??'')||rows[0].installedSha256!==byPath.get(dst)?.sha256)throw error('SOURCE_CLOSURE_INVALID');}
 if(metadata(root,'code-server/package.json').version!==PINS.codeServer||metadata(root,'npm/package.json').version!==manifest.inputs.npm.version||metadata(root,'playwright/node_modules/playwright/package.json').version!==PINS.playwright||metadata(root,'playwright/node_modules/playwright-core/package.json').version!==PINS.playwright)throw error('PACKAGE_VERSION_MISMATCH');
 for(const[name,content]of Object.entries(NPM_WRAPPERS))if(byPath.get('npm/bin/'+name)?.sha256!==hash(content)||!(byPath.get('npm/bin/'+name)?.mode&0o111))throw error('FIXED_NODE_NPM_WRAPPER_REQUIRED');
 const versions=metadata(root,'homeai/development/versions.json');if(versions.playwright!==PINS.playwright||versions.playwrightIntegrity!==PINS.playwrightIntegrity||versions.dotnetVersion!==PINS.dotnet||versions.dotnetSHA512!==PINS.dotnetSHA512)throw error('SOURCE_VERSION_PIN_MISMATCH');
 const browsers=metadata(root,'playwright/node_modules/playwright-core/browsers.json').browsers;
 for(const b of manifest.inputs.browsers){if(!Array.isArray(browsers)||!browsers.some(row=>row.name===b.name&&String(row.revision)===b.revision)||byPath.get(b.executable)?.type!=='file')throw error('BROWSER_REVISION_MISMATCH');elf(root,b.executable);}
 elf(root,'code-server/lib/node');elf(root,'dotnet/dotnet');
}
function createManifest(root,{sourceCommit,inputs,sourceFiles},options={}){
 checkPins(inputs);const {entries,totalFileBytes}=scan(root,options);const manifest={version:1,platform:'linux-x64',sourceCommit,inputs,sourceFiles:[...sourceFiles].sort((a,b)=>Buffer.compare(Buffer.from(a.source),Buffer.from(b.source))),entries,totalFileBytes};
 checkStructure(root,manifest);const bytes=canonical(manifest)+'\n';if(Buffer.byteLength(bytes)>LIMITS.manifestBytes)throw error('MANIFEST_LIMIT');return{manifest,bytes,manifestSha256:hash(bytes)};
}
function verifyToolchain(root,{expectedDigest,expectedUid=0}={}){
 if(!SHA.test(expectedDigest??''))throw error('PROTECTED_DIGEST_REQUIRED');
 if(typeof root!=='string'||!path.isAbsolute(root)||root==='/'||path.normalize(root)!==root||fs.realpathSync(root)!==root)throw error('CANONICAL_ROOT_REQUIRED');
 const file=path.join(root,MANIFEST),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==expectedUid||s.mode&0o6022||s.size>LIMITS.manifestBytes)throw error('MANIFEST_FILE_INVALID');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),bytes=Buffer.alloc(s.size);try{if(fingerprint(fs.fstatSync(fd))!==fingerprint(s))throw error('SOURCE_CHANGED');let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw error('SOURCE_CHANGED');offset+=n;}if(fingerprint(fs.fstatSync(fd))!==fingerprint(s))throw error('SOURCE_CHANGED');}finally{fs.closeSync(fd);}
 if(hash(bytes)!==expectedDigest)throw error('MANIFEST_DIGEST_MISMATCH');
 let manifest;try{manifest=JSON.parse(bytes);}catch{throw error('MANIFEST_INVALID');}
 if(canonical(manifest)+'\n'!==bytes.toString('utf8')||!Array.isArray(manifest.entries))throw error('CANONICAL_MANIFEST_REQUIRED');
 const actual=scan(root,{expectedUid});if(canonical(actual.entries)!==canonical(manifest.entries)||actual.totalFileBytes!==manifest.totalFileBytes)throw error('TREE_DIGEST_MISMATCH');checkStructure(root,manifest);
 return{version:1,root,manifestSha256:expectedDigest,dev:actual.rootInfo.dev,ino:actual.rootInfo.ino,uid:actual.rootInfo.uid,gid:actual.rootInfo.gid};
}
module.exports={verifyToolchain,createManifest,scan,canonical,PINS,NPM_VERSION,NPM_INTEGRITY,NPM_WRAPPERS,SOURCE_FILES,REQUIRED,MANIFEST,LIMITS,checkPins};
