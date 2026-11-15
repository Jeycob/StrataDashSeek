import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRuntimeAdmission,admissionPayload,readAdmissionTrust} from './runtime-admission.mjs';

const commit='a'.repeat(40),epoch='11111111-2222-4333-8444-555555555555';
const pair=crypto.generateKeyPairSync('ed25519'),fingerprint=key=>crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
function fixture(extra={}){
 let time=100000,calls=0,previous;const status={version:1,enabled:true,sourceCommit:commit,epoch,port:3094,publicKeyFingerprint:fingerprint(pair.publicKey),observedAt:time};
 const sign=(request,patch={},key=pair.privateKey)=>{const ack={version:1,sourceCommit:request.sourceCommit,epoch:request.epoch,challenge:request.challenge,admitted:true,issuedAt:time,expiresAt:time+3000,reasonCode:'USER_WORK_ADMITTED',...patch};return{...ack,signature:crypto.sign(null,admissionPayload(ack),key).toString('base64url')};};
 const dependencies={now:()=>time,readTrust:async()=>({key:pair.publicKey,status}),transport:async({body})=>{calls++;const request=JSON.parse(body);previous=request;return sign(request);},...extra};
 return{status,sign,dependencies,client:()=>createRuntimeAdmission({production:true,expectedCommit:commit},dependencies),calls:()=>calls,previous:()=>previous,advance:ms=>{time+=ms;}};
}
test('local development is explicit unenforced mode; production without configuration fails closed',async()=>{
 const local=createRuntimeAdmission({}, {readTrust:()=>{throw Error('must not read');}});assert.equal(local.required,false);assert.deepEqual(await local.admit('start_turn'),{admitted:true,enforced:false});const production=createRuntimeAdmission({production:true});await assert.rejects(production.admit('start_turn'),{code:'RUNTIME_ADMISSION_CONFIGURATION_REQUIRED'});
});
test('real Ed25519 ACK binds fresh challenge, physical source and root epoch; status is read-only and sanitized',async()=>{
 const f=fixture(),client=f.client();const status=await client.status();assert.equal(f.calls(),0);assert.deepEqual(Object.keys(status).sort(),['enabled','enforced','epoch','observedAt','sourceCommit','version']);const first=await client.admit('start_turn'),second=await client.admit('model_step');assert.equal(first.admitted,true);assert.equal(first.enforced,true);assert.notEqual(first.challenge,second.challenge);assert.match(first.challenge,/^[a-f0-9]{64}$/);assert.equal(first.epoch,epoch);await assert.rejects(client.admit('run_any_command'),{code:'RUNTIME_ADMISSION_OPERATION_INVALID'});assert.equal(f.calls(),2);
});
test('fake local signer, replayed challenge, changed source or epoch and altered signed fields cannot admit work',async()=>{
 const bad=crypto.generateKeyPairSync('ed25519');
 for(const kind of ['signer','challenge','source','epoch','tamper']){const f=fixture();f.dependencies.transport=async({body})=>{const request=JSON.parse(body);if(kind==='signer')return f.sign(request,{},bad.privateKey);if(kind==='challenge')return f.sign(request,{challenge:'0'.repeat(64)});if(kind==='source')return f.sign(request,{sourceCommit:'b'.repeat(40)});if(kind==='epoch')return f.sign(request,{epoch:crypto.randomUUID()});return{...f.sign(request),expiresAt:103001};};await assert.rejects(f.client().admit('start_turn'),error=>['RUNTIME_ADMISSION_ACK_INVALID','RUNTIME_ADMISSION_SIGNATURE_INVALID'].includes(error.code));}
});
test('unsigned denial and signed denial are distinguished without reflecting raw server content',async()=>{
 const f=fixture();f.dependencies.transport=async({body})=>f.sign(JSON.parse(body),{admitted:false,reasonCode:'RUNTIME_RECOVERY_ADMISSION_CLOSED'});await assert.rejects(f.client().admit('start_turn'),e=>e.code==='RUNTIME_ADMISSION_DENIED'&&e.reasonCode==='RUNTIME_RECOVERY_ADMISSION_CLOSED');f.dependencies.transport=async()=>({admitted:false,reasonCode:'SECRET_DO_NOT_REFLECT'});await assert.rejects(f.client().admit('start_turn'),e=>e.code==='RUNTIME_ADMISSION_ACK_INVALID'&&!e.message.includes('SECRET'));
});
test('stale authority, wrong fingerprint, source mismatch or expired ACK fail without fallback or retries',async()=>{
 for(const patch of [{observedAt:1},{sourceCommit:'b'.repeat(40)},{epoch:'unknown'},{publicKeyFingerprint:'0'.repeat(64)},{enabled:false},{unreviewedField:true}]){const f=fixture();Object.assign(f.status,patch);await assert.rejects(f.client().admit('start_turn'),{code:'RUNTIME_ADMISSION_STATUS_UNTRUSTED'});assert.equal(f.calls(),0);}
 const f=fixture();f.dependencies.transport=async({body})=>f.sign(JSON.parse(body),{issuedAt:95000,expiresAt:99999});await assert.rejects(f.client().admit('start_turn'),{code:'RUNTIME_ADMISSION_ACK_INVALID'});
});
test('caller cancellation rejects even when a fixture transport ignores abort and returns a valid ACK later',async()=>{
 const f=fixture(),abort=new AbortController();let response;f.dependencies.transport=({body})=>new Promise(resolve=>{response=()=>resolve(f.sign(JSON.parse(body)));});const pending=f.client().admit('start_turn',{signal:abort.signal});while(!response)await new Promise(r=>setTimeout(r,1));abort.abort();await assert.rejects(pending,{code:'RUNTIME_ADMISSION_ABORTED'});response();await new Promise(r=>setTimeout(r,10));
});
test('absolute 1.5-second deadline includes a continuously streaming local HTTP response',{timeout:5000},async t=>{
 let interval,closed=false;const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');interval=setInterval(()=>res.write(' '),10);res.on('close',()=>{closed=true;clearInterval(interval);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{clearInterval(interval);server.closeAllConnections();await new Promise(r=>server.close(r));});
 const f=fixture();f.status.port=server.address().port;const client=createRuntimeAdmission({production:true,expectedCommit:commit,port:f.status.port},{readTrust:f.dependencies.readTrust});f.status.observedAt=Date.now();const start=Date.now();await assert.rejects(client.admit('start_turn'),{code:'RUNTIME_ADMISSION_TIMEOUT'});assert(Date.now()-start<2500);for(let i=0;i<30&&!closed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(closed,true);
});
test('HTTP redirect and oversized response are rejected by the real loopback transport without retries',async t=>{
 let mode='redirect',calls=0;const server=http.createServer((req,res)=>{calls++;if(mode==='redirect'){res.writeHead(302,{Location:'http://example.invalid/'});return res.end();}res.end('x'.repeat(8193));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});const f=fixture();f.status.port=server.address().port;f.status.observedAt=Date.now();const client=createRuntimeAdmission({production:true,expectedCommit:commit,port:f.status.port},{readTrust:f.dependencies.readTrust});await assert.rejects(client.admit('start_turn'),{code:'RUNTIME_ADMISSION_HTTP_REJECTED'});mode='large';await assert.rejects(client.admit('start_turn'),{code:'RUNTIME_ADMISSION_RESPONSE_TOO_LARGE'});assert.equal(calls,2);
});

if(process.env.HARNESS_RUNTIME_ADMISSION_ROOT_TEST==='1')test('Linux public trust files are readable by UID65534 and reject writable, linked or substituted root authority',async t=>{
 assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sdsh-admission-trust-'));await fs.chmod(directory,0o755);t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('sdsh-admission-trust-'));await fs.rm(real,{recursive:true,force:true});});
 const publicKeyFile=path.join(directory,'admission-public.pem'),statusFile=path.join(directory,'runtime-admission.json');await fs.writeFile(publicKeyFile,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o644});await fs.writeFile(statusFile,JSON.stringify({...fixture().status,observedAt:Date.now()}),{mode:0o644});const options={publicKeyFile,statusFile,signal:new AbortController().signal};assert.equal((await readAdmissionTrust(options)).key.asymmetricKeyType,'ed25519');
 const code="const{readAdmissionTrust}=await import(process.argv[1]);const result=await readAdmissionTrust({publicKeyFile:process.argv[2],statusFile:process.argv[3],signal:new AbortController().signal});if(result.key.asymmetricKeyType!=='ed25519')process.exitCode=2;";const child=spawnSync('setpriv',['--reuid=65534','--regid=65534','--clear-groups','--bounding-set=-all',process.execPath,'--input-type=module','-e',code,new URL('./runtime-admission.mjs',import.meta.url).href,publicKeyFile,statusFile],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);
 await fs.chmod(publicKeyFile,0o666);await assert.rejects(readAdmissionTrust(options),{code:'RUNTIME_ADMISSION_TRUST_UNSAFE'});await fs.chmod(publicKeyFile,0o644);const link=path.join(directory,'link');await fs.link(publicKeyFile,link);await assert.rejects(readAdmissionTrust(options),{code:'RUNTIME_ADMISSION_TRUST_UNSAFE'});await fs.unlink(link);await fs.rename(publicKeyFile,link);await fs.symlink(link,publicKeyFile);await assert.rejects(readAdmissionTrust(options),{code:'RUNTIME_ADMISSION_TRUST_UNSAFE'});
});
