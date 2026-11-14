'use strict';
const cp=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
function redact(text,values=[]){let out=String(text);const forms=new Set();for(const v of values.filter(Boolean))for(const raw of[v,v.split('$').join('$$')])for(const form of[raw,Buffer.from(raw).toString('base64'),encodeURIComponent(raw),JSON.stringify(raw).slice(1,-1)])forms.add(form);for(const form of[...forms].sort((a,b)=>b.length-a.length))out=out.split(form).join('[REDACTED]');return out;}
function run(program,args,{cwd,env={},input,timeout=600000,maxBytes=8*1024*1024,values=[],onOutput}={}){
 return new Promise((resolve,reject)=>{const child=cp.spawn(program,args,{cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8',...env},stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',err='',bytes=0,ended=false;const fail=e=>{if(ended)return;ended=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();reject(e);};const timer=setTimeout(()=>fail(Error('Command timed out')),timeout);timer.unref();
  child.on('error',fail);for(const [stream,kind]of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',c=>{bytes+=c.length;if(bytes>maxBytes)return fail(Error('Command output limit exceeded'));if(kind==='out')out+=c;else err+=c;});
  child.on('close',code=>{clearTimeout(timer);if(ended)return;ended=true;const stdout=redact(out,values),stderr=redact(err,values);onOutput?.(stdout+stderr);if(code!==0)return reject(Error('Command exited '+code+': '+stderr.slice(-2000)));resolve({stdout,stderr});});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
class DockerCommand{
 constructor(cfg={}){this.cfg=cfg;this.binary=cfg.cli||'/data/harness/tools/docker';this.host=cfg.docker?.url||'http://127.0.0.1:19075';if(cfg.docker?.socketPath)this.host='unix://'+cfg.docker.socketPath;else{const u=new URL(this.host);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('Docker CLI requires a local socket or protected loopback tunnel');this.host='tcp://'+u.host;}}
 async call(args,opts={}){return run(this.binary,['--host',this.host,...args],{...opts,env:{DOCKER_CONFIG:this.cfg.cliConfigDir||'/data/harness/home/.docker-apps',HOME:this.cfg.cliHome||'/data/harness/home',...opts.env}});}
 async build({directory,dockerfile,tag,labels,secrets={},log}){
  const args=['buildx','build','--load','--progress=plain','--tag',tag,'--file',dockerfile];for(const[k,v]of Object.entries(labels||{}))args.push('--label',k+'='+v);const env={};let i=0;for(const[k,v]of Object.entries(secrets)){if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(k))throw Error('Invalid build secret id');const name='HARNESS_BUILD_SECRET_'+i++;env[name]=v;args.push('--secret','id='+k+',env='+name);}args.push('.');return this.call(args,{cwd:directory,env,values:Object.values(secrets),onOutput:log});
 }
}
async function temporarySecrets(base,values,fn){await fs.mkdir(base,{recursive:true,mode:0o700});const stat=await fs.lstat(base);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Invalid temporary secret directory');if(process.platform==='linux'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0||(await fs.statfs(base)).type!==0x01021994))throw Error('Temporary secrets require a private RAM-backed directory');const dir=path.join(base,crypto.randomBytes(16).toString('hex'));await fs.mkdir(dir,{mode:0o700});try{const files={};for(const[k,v]of Object.entries(values)){if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(k))throw Error('Invalid secret name');files[k]=path.join(dir,k);await fs.writeFile(files[k],v,{mode:0o600,flag:'wx'});}return await fn(files,dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
module.exports={DockerCommand,run,redact,temporarySecrets};
