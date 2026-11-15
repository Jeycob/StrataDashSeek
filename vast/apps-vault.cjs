'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const HOSTS=new Set(['https://app.infisical.com','https://us.infisical.com','https://eu.infisical.com']);
const NAME=/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
// Private, per-instance authentication identity. Never report this digest or
// use it to cache secret values. Rotation of any login credential changes it.
const identity=c=>crypto.createHash('sha256').update(JSON.stringify([c.origin,c.clientId,c.clientSecret])).digest('hex');
function binding(v){if(!v||typeof v.projectId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(v.projectId)||!/^[-a-zA-Z0-9_]{1,50}$/.test(v.environment)||typeof v.secretPath!=='string'||!v.secretPath.startsWith('/')||v.secretPath.includes('..')||v.secretPath.length>250)throw Error('Invalid project vault binding');return{projectId:v.projectId,environment:v.environment,secretPath:v.secretPath};}
class InfisicalVault{
 constructor(cfg={}){this.file=cfg.vaultMachineFile||'/data/harness/secrets/vault-machine.json';this.fetch=cfg.vaultFetch||fetch;this.token=null;this.authKey=null;this.authEpoch=0;this.authFlight=null;this.configuring=null;}
 config(){if(!fs.existsSync(this.file))return null;const fd=fs.openSync(this.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>16384||(st.mode&0o077)!==0&&process.platform!=='win32')throw Error('Vault identity file must be private');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
 status(){const c=this.config();return{provider:'infisical',configured:!!c,origin:c?.origin||'https://eu.infisical.com',clientId:c?.clientId||'',expiresAt:c?.expiresAt||null,authenticatedUntil:c&&this.token?.key===identity(c)?this.token.until:null};}
 async configure(data){
  if(!HOSTS.has(data.origin)||typeof data.clientId!=='string'||!data.clientId||data.clientId.length>200||typeof data.clientSecret!=='string'||data.clientSecret.length<8||data.clientSecret.length>4096)throw Error('Enter an Infisical Cloud machine identity');
  const c={origin:data.origin,clientId:data.clientId,clientSecret:data.clientSecret,...(Number.isFinite(data.expiresAt)?{expiresAt:data.expiresAt}:{})};
  // Validate a candidate without publishing its token. Concurrent reads keep
  // using the current file's identity until its atomic replacement succeeds.
  // Serialize configuration commits, not reads or provider secret responses.
  const commit=async()=>{
   const token=await this.requestToken(c);await fsp.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+crypto.randomBytes(8).toString('hex');try{await fsp.writeFile(tmp,JSON.stringify(c),{mode:0o600,flag:'wx'});await fsp.rename(tmp,this.file);}finally{await fsp.rm(tmp,{force:true});}
   this.authEpoch++;this.authKey=null;this.authFlight=null;this.token=null;
   const current=this.config(),key=identity(c);if(!current||identity(current)!==key)throw Error('Vault identity changed; retry the operation');
   this.authKey=key;this.token={...token,key};return this.status();
  };
  const operation=this.configuring?this.configuring.then(commit):commit();
  const settled=operation.then(()=>{if(this.configuring===settled)this.configuring=null;},()=>{if(this.configuring===settled)this.configuring=null;});
  this.configuring=settled;return operation;
 }
 async request(c,route,{method='GET',body,token}={}){if(!HOSTS.has(c.origin))throw Error('Unsupported vault endpoint');let r;try{r=await this.fetch(c.origin+route,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});}catch{throw Error('Vault is unreachable');}if(!r.ok){await r.body?.cancel();throw Object.assign(Error('Vault request failed (HTTP '+r.status+')'),{vaultStatus:r.status});}const chunks=[];let size=0;for await(const bytes of r.body){size+=bytes.length;if(size>1024*1024)throw Error('Vault response exceeds limit');chunks.push(Buffer.from(bytes));}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid vault response');}}
 async requestToken(c){const r=await this.request(c,'/api/v1/auth/universal-auth/login',{method:'POST',body:{clientId:c.clientId,clientSecret:c.clientSecret}});if(typeof r.accessToken!=='string'||!r.accessToken||!Number.isFinite(r.expiresIn))throw Error('Invalid vault authentication response');return{value:r.accessToken,until:Date.now()+Math.min(r.expiresIn*1000,300000)-10000};}
 // A credential check alone must not replace the active configuration's token.
 async login(c){return(await this.requestToken(c)).value;}
 selectIdentity(key){if(this.authKey!==key){this.authEpoch++;this.authKey=key;this.token=null;this.authFlight=null;}}
 requireIdentity(key,epoch){const current=this.config();if(this.authEpoch!==epoch||!current||identity(current)!==key)throw Error('Vault identity changed; retry the operation');}
 async auth(){
  let c;try{c=this.config();}catch(error){this.selectIdentity(null);throw error;}
  if(!c){this.selectIdentity(null);throw Error('Connect the external vault in Harness settings first');}
  const key=identity(c);this.selectIdentity(key);const epoch=this.authEpoch;
  if(this.token?.key===key&&this.token.until>Date.now())return{c,token:this.token.value};
  let flight=this.authFlight;
  if(!flight){
   flight={key,epoch};this.authFlight=flight;
   flight.promise=(async()=>{try{const token=await this.requestToken(c);this.requireIdentity(key,epoch);this.token={...token,key};return token.value;}finally{if(this.authFlight===flight)this.authFlight=null;}})();
  }
  const token=await flight.promise;this.requireIdentity(key,epoch);return{c,token};
 }
 async read(scope,name){const b=binding(scope);if(!NAME.test(name))throw Error('Invalid secret name');const{c,token}=await this.auth(),q=new URLSearchParams({...b,viewSecretValue:'true',expandSecretReferences:'false'});const r=await this.request(c,'/api/v4/secrets/'+encodeURIComponent(name)+'?'+q,{token});if(typeof r.secret?.secretValue!=='string'||r.secret.secretValue.length>65536||r.secret.secretValueHidden)throw Error('Vault did not return the required project secret');return r.secret.secretValue;}
 async create(scope,name,value){const b=binding(scope);if(!NAME.test(name)||typeof value!=='string'||value.length>65536)throw Error('Invalid secret');const{c,token}=await this.auth();await this.request(c,'/api/v4/secrets/'+encodeURIComponent(name),{method:'POST',token,body:{...b,secretValue:value,type:'shared',skipMultilineEncoding:true}});if(await this.read(b,name)!==value)throw Error('Vault read-back verification failed');return{verified:true,name};}
 async resolve(scope,mapping={}){if(Object.keys(mapping).length>50)throw Error('Too many project credentials');const result={};for(const[key,name]of Object.entries(mapping)){if(!NAME.test(key)||!NAME.test(name))throw Error('Invalid credential mapping');result[key]=await this.read(scope,name);}return result;}
}
module.exports={InfisicalVault,binding,NAME,HOSTS};
