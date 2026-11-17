'use strict';
// Trusted service code. This store is outside every untrusted project export.
// Only guest-server/ may be shared read-only with the trusted guest supervisor.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const fail=code=>Object.assign(Error(code),{code}),valid=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const serverName=(scope,generation)=>scope+'.'+generation+'.editor.homeai.invalid';
async function privateDirectory(directory){await fsp.mkdir(directory,{recursive:true,mode:0o700});const s=await fsp.lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||await fsp.realpath(directory)!==path.resolve(directory)||process.platform!=='win32'&&(s.uid!==process.getuid()||s.mode&0o077))throw fail('EDITOR_TRANSPORT_DIRECTORY_UNSAFE');}
async function readPrivate(file){const fd=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const s=await fd.stat();if(!s.isFile()||s.nlink!==1||s.size<1||s.size>32768||process.platform!=='win32'&&(s.uid!==process.getuid()||s.mode&0o077))throw fail('EDITOR_TRANSPORT_FILE_UNSAFE');return await fd.readFile();}finally{await fd.close();}}
class EditorTransportStore{
 constructor(root,{openssl='/usr/bin/openssl'}={}){if(!path.isAbsolute(root||'')||!path.isAbsolute(openssl))throw fail('EDITOR_TRANSPORT_CONFIGURATION_INVALID');this.root=path.resolve(root);this.openssl=openssl;this.pending=new Map();}
 paths(scope,generation){if(!valid(scope)||!valid(generation))throw fail('EDITOR_TRANSPORT_SCOPE_INVALID');const name=scope+'-'+generation;return{scope,generation,name,serverName:serverName(scope,generation),client:path.join(this.root,'host-client',scope,generation),server:path.join(this.root,'guest-server',scope,generation),record:path.join(this.root,'records',name+'.json')};}
 async prepare(scope,generation){const p=this.paths(scope,generation);if(this.pending.has(p.name))return this.pending.get(p.name);const task=this.issue(p);this.pending.set(p.name,task);try{return await task;}finally{this.pending.delete(p.name);}}
 async verify(p){
  const record=JSON.parse(await readPrivate(p.record));if(record.version!==1||record.scopeId!==p.scope||record.generation!==p.generation||record.serverName!==p.serverName)throw fail('EDITOR_TRANSPORT_RECORD_INVALID');
  await privateDirectory(p.client);await privateDirectory(p.server);
  const ca=await readPrivate(path.join(p.client,'ca.crt')),cert=await readPrivate(path.join(p.client,'client.crt')),key=await readPrivate(path.join(p.client,'client.key'));
  const serverCA=await readPrivate(path.join(p.server,'ca.crt')),serverCert=await readPrivate(path.join(p.server,'server.crt')),serverKey=await readPrivate(path.join(p.server,'server.key'));
  const authority=new crypto.X509Certificate(ca),client=new crypto.X509Certificate(cert),server=new crypto.X509Certificate(serverCert),now=Date.now();
  if(!ca.equals(serverCA)||!authority.ca||!authority.verify(authority.publicKey)||!client.verify(authority.publicKey)||!server.verify(authority.publicKey)||!client.checkPrivateKey(crypto.createPrivateKey(key))||!server.checkPrivateKey(crypto.createPrivateKey(serverKey))||server.checkHost(p.serverName)!==p.serverName||!client.keyUsage?.includes('1.3.6.1.5.5.7.3.2')||!server.keyUsage?.includes('1.3.6.1.5.5.7.3.1')||[authority,client,server].some(c=>Date.parse(c.validFrom)>now||Date.parse(c.validTo)<now+60000)||record.caFingerprint!==authority.fingerprint256)throw fail('EDITOR_TRANSPORT_CERTIFICATE_INVALID');
  return{serverName:p.serverName,serverDirectory:p.server,clientDirectory:p.client};
 }
 async issue(p){
  for(const dir of[this.root,path.dirname(p.client),path.dirname(p.server),path.dirname(p.record)])await privateDirectory(dir);
  try{await fsp.lstat(p.record);return await this.verify(p);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const target of[p.client,p.server])try{await fsp.lstat(target);throw fail('EDITOR_TRANSPORT_RECONCILIATION_REQUIRED');}catch(error){if(error.code!=='ENOENT')throw error;}
  const stage=await fsp.mkdtemp(path.join(this.root,'.prepare-'));await fsp.chmod(stage,0o700);
  const run=args=>{try{cp.execFileSync(this.openssl,args,{cwd:stage,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['ignore','ignore','pipe'],timeout:10000,maxBuffer:4096,windowsHide:true});}catch{throw fail('EDITOR_TRANSPORT_ISSUANCE_FAILED');}};
  try{
   run(['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','7','-subj','/CN=HomeAI isolated editor CA','-keyout','ca.key','-out','ca.crt','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
   for(const kind of['server','client']){
    run(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-subj','/CN='+(kind==='server'?'HomeAI isolated editor':'HomeAI trusted broker'),'-keyout',kind+'.key','-out',kind+'.csr']);
    await fsp.writeFile(path.join(stage,kind+'.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+(kind==='server'?'serverAuth':'clientAuth')+'\n'+(kind==='server'?'subjectAltName=DNS:'+p.serverName+'\n':''),{mode:0o600,flag:'wx'});
    run(['x509','-req','-in',kind+'.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial','0x'+crypto.randomBytes(16).toString('hex'),'-days','7','-extfile',kind+'.ext','-out',kind+'.crt']);
   }
   for(const[kind,destination]of[['client',p.client],['server',p.server]]){const dir=path.join(stage,kind);await fsp.mkdir(dir,{mode:0o700});for(const name of['ca.crt',kind+'.crt',kind+'.key']){const data=await fsp.readFile(path.join(stage,name));const handle=await fsp.open(path.join(dir,name),'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}await fsp.rename(dir,destination);}
   const ca=new crypto.X509Certificate(await fsp.readFile(path.join(p.client,'ca.crt'))),record={version:1,scopeId:p.scope,generation:p.generation,serverName:p.serverName,caFingerprint:ca.fingerprint256};
   const handle=await fsp.open(p.record,'wx',0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}
   return await this.verify(p);
  }finally{const real=await fsp.realpath(stage);if(path.dirname(real)!==this.root||!path.basename(real).startsWith('.prepare-'))throw fail('EDITOR_TRANSPORT_CLEANUP_REFUSED');await fsp.rm(real,{recursive:true,force:true});}
 }
 async clientIdentity(scope,generation){const p=this.paths(scope,generation);await this.verify(p);return{serverName:p.serverName,ca:await readPrivate(path.join(p.client,'ca.crt')),cert:await readPrivate(path.join(p.client,'client.crt')),key:await readPrivate(path.join(p.client,'client.key'))};}
}
module.exports={EditorTransportStore,serverName};
