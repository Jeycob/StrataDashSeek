'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {CONTRACT,POLICY_FILE,canonical}=require('../vast/project-execution-mode.cjs');
const {RELEASES,DESCRIPTOR,MAX_DESCRIPTOR_BYTES,createExecutionFloor}=require('../vast/project-execution-floor.cjs');
const A='a'.repeat(40),B='b'.repeat(40),E='11111111-2222-3333-4444-555555555555',E2='aaaaaaaa-2222-3333-4444-555555555555';
const policy=(changes={})=>({version:1,contract:CONTRACT,mode:'host-compat',policyEpoch:E,activationSourceCommit:A,...changes});
const descriptor=(changes={})=>({version:1,contract:CONTRACT,sourceProtocol:1,...changes});
const descriptorFile=commit=>path.posix.join(RELEASES,commit,DESCRIPTOR);
function fixture(changes={}){
 const nodes=new Map(),fds=new Map(),reads=[];let serial=0,nextFd=10,readHook,lstatHook,uid=0;
 const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'});
 function directory(file){let current='/';for(const part of ['',...file.slice(1).split('/')]){if(part)current=path.posix.join(current,part);if(!nodes.has(current))nodes.set(current,{type:'directory',uid:0,mode:0o755,nlink:1,dev:1,ino:++serial});}}
 function put(file,content,extra={}){directory(path.posix.dirname(file));const value={type:'file',uid:0,mode:0o644,nlink:1,dev:1,ino:++serial,mtimeMs:serial,ctimeMs:serial,content:Buffer.from(content),...extra};nodes.set(file,value);return value;}
 const stat=node=>({...node,size:node.content?.length??0,isFile:()=>node.type==='file',isDirectory:()=>node.type==='directory',isSymbolicLink:()=>node.type==='link'});
 const filesystem={
  lstatSync(file){reads.push(['lstat',file]);lstatHook?.(file);const node=nodes.get(file);if(!node)throw missing();return stat(node);},
  realpathSync(file){const node=nodes.get(file);if(!node)throw missing();return node.target??file;},
  openSync(file,flags){const nofollow=require('node:fs').constants.O_NOFOLLOW;if(Number.isInteger(nofollow))assert(flags&nofollow);const node=nodes.get(file);if(!node)throw missing();const fd=++nextFd;fds.set(fd,{node,file});return fd;},
  fstatSync(fd){return stat(fds.get(fd).node);},
  readSync(fd,buffer,offset,length,position){const entry=fds.get(fd);reads.push(['read',entry.file,length]);readHook?.(entry.file);return entry.node.content.copy(buffer,offset,position,position+length);},
  closeSync(fd){fds.delete(fd);},
 };
 const options={filesystem,platform:'linux',getuid:()=>uid};
 const floor=createExecutionFloor(options);
 const putPolicy=value=>put(POLICY_FILE,canonical(value),{mode:0o600});
 const putDescriptor=(commit,value=descriptor())=>put(descriptorFile(commit),canonical(value));
 function legacy(commit){directory(path.posix.dirname(descriptorFile(commit)));}
 return{nodes,fds,reads,options,floor,put,putPolicy,putDescriptor,legacy,capture(){putPolicy(policy(changes));return floor.capturePolicy();},set uid(value){uid=value;},set readHook(value){readHook=value;},set lstatHook(value){lstatHook=value;}};
}

test('construction performs no reads and absent private policy never creates a host default',()=>{
 const f=fixture();assert.equal(f.reads.length,0);assert.throws(()=>f.floor.capturePolicy(),{code:'PROJECT_EXECUTION_POLICY_REQUIRED'});assert.equal(f.nodes.size,0);
});
test('policy authority remains the shared protected parser, including unsafe/corrupt files and root identity',()=>{
 for(const bytes of ['{}','{',JSON.stringify(policy())+'\n',Buffer.from([0xff])]){const f=fixture();f.put(POLICY_FILE,bytes);assert.throws(()=>f.floor.capturePolicy(),/^Error: PROJECT_EXECUTION_/);assert.equal(f.fds.size,0);}
 for(const patch of [{uid:1001},{nlink:2},{type:'link'},{mode:0o666}]){const f=fixture();f.putPolicy(policy());Object.assign(f.nodes.get(POLICY_FILE),patch);assert.throws(()=>f.floor.capturePolicy(),{code:'PROJECT_EXECUTION_FILE_UNSAFE'});}
 const f=fixture();f.putPolicy(policy());f.uid=1001;assert.throws(()=>f.floor.capturePolicy(),{code:'PROJECT_EXECUTION_ROOT_REQUIRED'});
});
test('explicit host mode accepts verified legacy sources and aware sources as separate immutable capabilities',()=>{
 const f=fixture(),bound=f.capture();f.legacy(A);f.putDescriptor(B);
 assert.deepEqual(bound.assertReleaseAllowed(A),{sourceCommit:A,sourceProtocol:0});
 const capability=bound.assertReleaseAllowed(B);assert.deepEqual(capability,{sourceCommit:B,sourceProtocol:1});assert(Object.isFrozen(capability));assert(Object.isFrozen(bound));assert(Object.isFrozen(bound.snapshot));
 assert.equal(bound.policySha256,crypto.createHash('sha256').update(canonical(policy())).digest('hex'));
 assert.throws(()=>{bound.snapshot.mode='isolated-guest';},TypeError);
});
test('isolated mode requires the exact protocol1 declaration, never module presence or an old attestation',()=>{
 const f=fixture({mode:'isolated-guest'}),bound=f.capture();f.legacy(A);f.put(path.posix.join(RELEASES,A,'vast/project-execution-mode.cjs'),'module exists');
 assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_PROTOCOL_REQUIRED'});
 f.putDescriptor(B);assert.equal(bound.assertReleaseAllowed(B).sourceProtocol,1);
});
test('invalid release identities cannot become filesystem paths',()=>{
 const f=fixture(),bound=f.capture();for(const id of [undefined,[],[A],'main','../'+A,A+'/..',A.toUpperCase(),A+'\0'])assert.throws(()=>bound.assertReleaseAllowed(id),{code:'PROJECT_EXECUTION_FLOOR_RELEASE_ID_INVALID'});
 assert.equal(f.reads.some(([,file])=>file.startsWith(RELEASES)),false);
});
test('malformed, duplicate, coercible or future descriptors are fatal even in host mode',()=>{
 const invalid=[{},descriptor({version:2}),descriptor({version:'1'}),descriptor({contract:'other'}),descriptor({sourceProtocol:0}),descriptor({sourceProtocol:2}),descriptor({sourceProtocol:'1'}),descriptor({extra:true})];
 for(const value of invalid){const f=fixture(),bound=f.capture();f.putDescriptor(A,value);assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_INVALID'});assert.equal(f.fds.size,0);}
 for(const bytes of ['{',canonical(descriptor())+'\n','{"contract":"project-execution-v1","sourceProtocol":0,"sourceProtocol":1,"version":1}',Buffer.from([0xff])]){const f=fixture(),bound=f.capture();f.put(descriptorFile(A),bytes);assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_INVALID'});assert.equal(f.fds.size,0);}
});
test('descriptor and all source parents must be protected regular canonical paths',()=>{
 for(const [target,patch]of [[descriptorFile(A),{uid:1001}],[descriptorFile(A),{nlink:2}],[descriptorFile(A),{mode:0o666}],[descriptorFile(A),{type:'link'}],[path.posix.join(RELEASES,A),{mode:0o777}],[path.posix.join(RELEASES,A,'vast'),{uid:1001}],[RELEASES,{target:'/elsewhere'}]]){
  const f=fixture(),bound=f.capture();f.putDescriptor(A);Object.assign(f.nodes.get(target),patch);assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNSAFE'});assert.equal(f.fds.size,0);
 }
 for(const length of [0,MAX_DESCRIPTOR_BYTES+1]){const f=fixture(),bound=f.capture();f.put(descriptorFile(A),' '.repeat(length));assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNSAFE'});assert.equal(f.fds.size,0);}
});
test('only absent descriptor is legacy; missing or changing parents and a newly appeared descriptor fail',()=>{
 const missing=fixture(),bound=missing.capture();assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNAVAILABLE'});
 const appeared=fixture(),a=appeared.capture();appeared.legacy(A);let absentChecks=0;appeared.lstatHook=file=>{if(file===descriptorFile(A)&&++absentChecks===2)appeared.putDescriptor(A);};assert.throws(()=>a.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED'});
 const changed=fixture(),b=changed.capture();changed.legacy(A);let parentChecks=0;const parent=path.posix.join(RELEASES,A,'vast');changed.lstatHook=file=>{if(file===parent&&++parentChecks===2)changed.nodes.get(parent).ino++;};assert.throws(()=>b.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED'});
 const late=fixture(),c=late.capture();late.legacy(A);let lateChecks=0;late.lstatHook=file=>{if(file===descriptorFile(A)&&++lateChecks===2)late.nodes.get(parent).ino++;};assert.throws(()=>c.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED'});
});
test('descriptor replacement or mutation while reading is rejected and its FD closes',()=>{
 for(const mutate of [f=>f.putDescriptor(A),f=>{f.nodes.get(descriptorFile(A)).content=Buffer.from(canonical(descriptor({sourceProtocol:2})));f.nodes.get(descriptorFile(A)).ctimeMs++;},f=>{f.nodes.get(path.posix.join(RELEASES,A)).ino++;}]){
  const f=fixture(),bound=f.capture();f.putDescriptor(A);let fired=false;f.readHook=file=>{if(file===descriptorFile(A)&&!fired){fired=true;mutate(f);}};assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_CHANGED'});assert.equal(f.fds.size,0);
 }
});
test('a bound launcher refuses later semantic policy changes and does not adopt after an await',async()=>{
 for(const patch of [{mode:'isolated-guest'},{policyEpoch:E2},{activationSourceCommit:B}]){const f=fixture(),bound=f.capture();f.putDescriptor(A);await Promise.resolve();f.putPolicy(policy(patch));assert.throws(()=>bound.assertPolicyUnchanged(),{code:'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});}
 const f=fixture(),bound=f.capture();f.nodes.delete(POLICY_FILE);assert.throws(()=>bound.assertPolicyUnchanged(),{code:'PROJECT_EXECUTION_POLICY_REQUIRED'});f.put(POLICY_FILE,'{}');assert.throws(()=>bound.assertPolicyUnchanged(),{code:'PROJECT_EXECUTION_POLICY_INVALID'});
});
test('policy changed while descriptor is read cannot authorize a release; shared parser catches policy inode races',()=>{
 const f=fixture(),bound=f.capture();f.putDescriptor(A);let fired=false;f.readHook=file=>{if(file===descriptorFile(A)&&!fired){fired=true;f.putPolicy(policy({policyEpoch:E2}));}};assert.throws(()=>bound.assertReleaseAllowed(A),{code:'PROJECT_EXECUTION_FLOOR_POLICY_CHANGED'});assert.equal(f.fds.size,0);
 const g=fixture(),other=g.capture();g.putDescriptor(A);let policyRead=false;g.readHook=file=>{if(file===POLICY_FILE&&!policyRead){policyRead=true;g.putPolicy(policy());}};assert.throws(()=>other.assertPolicyUnchanged(),{code:'PROJECT_EXECUTION_FILE_CHANGED'});assert.equal(g.fds.size,0);
});
test('actual recovery keeps legacy core proof bytes and policyHash while the dynamic floor gates future targets',async()=>{
 const {RuntimeRecovery}=require('../vast/runtime-recovery.cjs'),f=fixture(),bound=f.capture();f.legacy(A);f.legacy(B);
 const compatibilityId='c'.repeat(64),records=Object.fromEntries([A,B].map(commit=>[commit,{commit,digest:(commit===A?'d':'e').repeat(64),signatureVerified:true,rootProtected:true,securityEpoch:2,compatibilityId,admissionProtocol:1}]));
 const legacyBytes=JSON.stringify(records[A]);let saved=null,now=1794880000000;
 const config={policy:{enabled:true,compatibilityId,minimumSecurityEpoch:2,deniedCommits:[]},store:{read:()=>structuredClone(saved),write:value=>{saved=structuredClone(value);}},exclusive:action=>action(),now:()=>now};
 function controller(binding){return new RuntimeRecovery({...config,hooks:{verifyRelease:async({commit})=>{binding.assertReleaseAllowed(commit);return structuredClone(records[commit]);},currentCommit:async()=>A,fence:async({attemptId,commit})=>({attemptId,commit,admissionClosed:true,acceptedWork:0,activeRequests:0,activeJobs:0,fenceToken:'f'.repeat(64),observedAt:now}),switchRelease:async()=>assert.fail('no switch in this fixture'),restart:async()=>assert.fail('no restart in this fixture')}});}
 await controller(bound).adoptHealthy(A,{version:1,phase:'ready',stale:false,sourceCommit:A,sourceReady:true,runtimeReady:true,observedAt:new Date(now).toISOString()});
 const baseline=structuredClone(saved),baselineBytes=JSON.stringify(saved.lastGood);assert.equal(baselineBytes,legacyBytes);
 const status=await controller(bound).begin(B);assert.equal(status.phase,'monitoring');assert.equal(saved.policyHash,baseline.policyHash);assert.equal(JSON.stringify(saved.lastGood),legacyBytes);assert.deepEqual(saved.history[0],baseline.history[0]);assert.equal(Object.hasOwn(saved.history[1].record,'sourceProtocol'),false);
 saved=structuredClone(baseline);f.putPolicy(policy({mode:'isolated-guest',policyEpoch:E2}));const isolated=f.floor.capturePolicy();f.putDescriptor(B);
 assert.equal((await controller(isolated).status()).phase,'healthy','inert historical records retain their old format');
 await assert.rejects(controller(isolated).begin(B),{code:'PROJECT_EXECUTION_FLOOR_PROTOCOL_REQUIRED'});assert.equal(JSON.stringify(saved.lastGood),legacyBytes);assert.equal(saved.history.length,1);assert.equal(saved.policyHash,baseline.policyHash);
});
