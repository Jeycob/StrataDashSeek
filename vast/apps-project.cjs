'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {isPrivateSourcePath}=require('../workspace/source-private.cjs');
const {dataPolicy}=require('./apps-data-policy.cjs');
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const blocked=new Set(['.git','.secrets','secrets','root-secrets','.ssh','.aws','.npmrc','.pypirc','.netrc','node_modules','.venv','venv','.next','.cache','.harness','.harness-quality','bin','obj']);
function excluded(name){return blocked.has(name)||isPrivateSourcePath(name)||/^\.env(?:\.|$)/i.test(name)||/\.(?:key|pem|p12|pfx)$/i.test(name);}
async function projectAt(relative,cfg){
 if(typeof relative!=='string'||!relative||relative.length>300||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||excluded(p)))throw Error('Use a project path relative to the workspace root');
 const root=await fs.realpath(cfg.workspaceRoot),dir=await fs.realpath(path.join(root,relative));if(!inside(root,dir)||dir===root)throw Error('Project is outside the workspace root');
 const manifest=path.join(dir,'.harness-app.json');if((await fs.lstat(manifest)).isSymbolicLink()||(await fs.stat(manifest)).size>16384)throw Error('Invalid application manifest');
 const data=JSON.parse(await fs.readFile(manifest,'utf8'));
 if(data.version!==1||typeof data.name!=='string'||!data.name.trim()||data.name.length>80)throw Error('Manifest requires version 1 and a name');
 const dockerfile=data.dockerfile||'Dockerfile';if(typeof dockerfile!=='string'||path.isAbsolute(dockerfile)||dockerfile.split(/[\\/]/).some(p=>p==='..'||excluded(p)))throw Error('Invalid Dockerfile path');
 if(!data.composeFile){const full=await fs.realpath(path.join(dir,dockerfile));if(!inside(dir,full)||(await fs.lstat(path.join(dir,dockerfile))).isSymbolicLink())throw Error('Dockerfile must stay inside this project');}
 if(!Number.isInteger(data.port)||data.port<1024||data.port>65535)throw Error('Manifest port must be an integer between 1024 and 65535');
 const healthPath=data.healthPath||'/';if(typeof healthPath!=='string'||!healthPath.startsWith('/')||healthPath.startsWith('//')||/[\r\n#]/.test(healthPath)||healthPath.length>300)throw Error('Invalid health path');
 const memoryMiB=data.memoryMiB??512,cpus=data.cpus??1;
 if(!Number.isInteger(memoryMiB)||memoryMiB<64||memoryMiB>2048||!Number.isFinite(cpus)||cpus<.1||cpus>2)throw Error('Application resource limit exceeded');
 const id=crypto.createHash('sha256').update(dir).digest('hex').slice(0,16);
 const testCommand=data.testCommand??null;if(testCommand!==null&&(!Array.isArray(testCommand)||!testCommand.length||testCommand.length>30||testCommand.some(v=>typeof v!=='string'||!v||v.length>2048||v.includes('\0'))))throw Error('testCommand must be a bounded argv array');
 const browserPlan=data.browserPlan??null;if(browserPlan!==null&&(typeof browserPlan!=='string'||path.isAbsolute(browserPlan)||browserPlan.split(/[\\/]/).some(p=>p==='..'||excluded(p))))throw Error('Invalid browser plan path');
 const composeFile=data.composeFile??null;if(composeFile!==null&&(typeof composeFile!=='string'||path.isAbsolute(composeFile)||composeFile.split(/[\\/]/).some(p=>p==='..'||excluded(p))||!/^[-a-zA-Z0-9_.]{1,63}$/.test(data.entryService||'')))throw Error('Declare a project-relative composeFile and entryService');
 return{id,path:path.relative(root,dir),directory:dir,name:data.name.trim(),dockerfile,port:data.port,healthPath,memoryMiB,cpus,testCommand,browserPlan,composeFile,entryService:data.entryService||null,dataPolicy:dataPolicy(data.dataPolicy)};
}
async function snapshot(project,destination,{maxBytes=128*1024*1024,maxFiles=12000}={}){
 let bytes=0,files=0;const hash=crypto.createHash('sha256');await fs.mkdir(destination,{recursive:false});
 async function copy(relative){const dir=path.join(project.directory,relative);for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(excluded(entry.name))continue;
  const rel=path.join(relative,entry.name),source=path.join(project.directory,rel),target=path.join(destination,rel),stat=await fs.lstat(source);
  if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error('Build context contains a symlink or special file: '+rel);
  if(stat.isDirectory()){await fs.mkdir(target);await copy(rel);continue;}
  if(++files>maxFiles||stat.size>maxBytes-bytes)throw Error('Build context exceeds its size limit');
  const constants=require('node:fs').constants;
  const input=await fs.open(source,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let output;
  try{
   if(!(await input.stat()).isFile())throw Error('Build source is not a regular file');
   const actual=await fs.realpath(process.platform==='linux'?'/proc/self/fd/'+input.fd:source);
   if(!inside(project.directory,actual))throw Error('Build source escaped project directory');
   output=await fs.open(target,'wx',stat.mode&511);hash.update(JSON.stringify([rel,stat.mode&511,stat.size])+'\n');let fileBytes=0;
   for await(const chunk of input.createReadStream({autoClose:false})){bytes+=chunk.length;fileBytes+=chunk.length;if(bytes>maxBytes)throw Error('Build context exceeds its size limit');hash.update(chunk);await output.writeFile(chunk);}if(fileBytes!==stat.size)throw Error('Source file changed during snapshot: '+rel);
  }finally{await input.close();await output?.close();}
 }}
 await copy('');return{version:2,bytes,files,sha256:hash.digest('hex')};
}
module.exports={projectAt,snapshot,inside,excluded};
