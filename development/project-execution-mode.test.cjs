'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {CONTRACT,POLICY_FILE,PUBLIC_FILE,MAX_BYTES,canonical,validatePolicy,validateProjection,createExecutionModeContract}=require('../vast/project-execution-mode.cjs');
const A='a'.repeat(40),B='b'.repeat(40),E='11111111-2222-3333-4444-555555555555',L1='aaaaaaaa-2222-3333-4444-555555555555',L2='bbbbbbbb-2222-3333-4444-555555555555';
const policy=(changes={})=>({version:1,contract:CONTRACT,mode:'host-compat',policyEpoch:E,activationSourceCommit:A,...changes});
function memory(){
 const nodes=new Map(),fds=new Map();let serial=0,descriptor=10,readHook;
 const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'});
 const put=(file,content,changes={})=>{const node={type:'file',uid:0,mode:0o600,nlink:1,dev:1,ino:++serial,mtimeMs:serial,ctimeMs:serial,content:Buffer.from(content),...changes};nodes.set(file,node);return node;};
 for(const file of [POLICY_FILE,PUBLIC_FILE]){let current='/';for(const part of ['',...path.posix.dirname(file).slice(1).split('/')]){if(part)current=path.posix.join(current,part);if(!nodes.has(current))nodes.set(current,{type:'directory',uid:0,mode:0o755,nlink:1,dev:1,ino:++serial});}}
 const stat=node=>({...node,size:node.content?.length??0,isFile:()=>node.type==='file',isDirectory:()=>node.type==='directory',isSymbolicLink:()=>node.type==='link'});
 const filesystem={
  lstatSync(file){const node=nodes.get(file);if(!node)throw missing();return stat(node);},
  realpathSync(file){const node=nodes.get(file);if(!node)throw missing();return node.target??file;},
  openSync(file){const node=nodes.get(file);if(!node)throw missing();const fd=++descriptor;fds.set(fd,node);return fd;},
  fstatSync(fd){return stat(fds.get(fd));},
  readSync(fd,buffer,offset,length,position){if(readHook){const hook=readHook;readHook=undefined;hook();}return fds.get(fd).content.copy(buffer,offset,position,position+length);},
  closeSync(fd){fds.delete(fd);},
 };
 const writes=[];let currentSource=A,uid=0,launch=L1,atomicHook,verificationHook;
 const options={filesystem,platform:'linux',getuid:()=>uid,newLaunchId:()=>launch,verifySource(source){if(verificationHook)verificationHook();assert.equal(source,currentSource,'only the already verified serving source may issue a projection');},atomic(file,bytes){assert.equal(file,PUBLIC_FILE);writes.push({file,bytes});put(file,bytes,{mode:0o644});atomicHook?.();}};
 const contract=createExecutionModeContract(options);
 return{nodes,fds,writes,options,contract,put,putPolicy:value=>put(POLICY_FILE,canonical(value)),putProjection:value=>put(PUBLIC_FILE,canonical(value),{mode:0o644}),set source(value){currentSource=value;},set uid(value){uid=value;},set launch(value){launch=value;},set readHook(value){readHook=value;},set atomicHook(value){atomicHook=value;},set verificationHook(value){verificationHook=value;}};
}
function issued(changes={}){const f=memory();f.putPolicy(policy(changes));f.snapshot=f.contract.publishForSupervisor({sourceCommit:A});return f;}
const bind=f=>f.contract.bindForService({sourceCommit:f.snapshot.sourceCommit,launchId:f.snapshot.launchId});
test('production defaults ignore environment, ordinary config and per-call path overrides',()=>{
 const names=['HOMEAI_ROOT','HARNESS_ROOT','HARNESS_PROJECT_EXECUTION_ROOT'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]));try{for(const name of names)process.env[name]='/untrusted';const f=memory();f.putPolicy(policy());const contract=createExecutionModeContract({...f.options,config:{rootDirectory:'/untrusted'},root:'/untrusted'});assert.equal(contract.readPolicy({rootDirectory:'/untrusted'}).mode,'host-compat');assert.equal(f.nodes.has('/untrusted/root-secrets/runtime/state/project-execution-policy.json'),false);for(const rootDirectory of ['relative','/','/a/../b','/a/'])assert.throws(()=>createExecutionModeContract({...f.options,rootDirectory}),{code:'PROJECT_EXECUTION_ROOT_INVALID'});}finally{for(const name of names)if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}
});

test('policy is explicit and exact; no missing, unknown or coercible host default',()=>{
 const f=memory();assert.throws(()=>f.contract.readPolicy(),{code:'PROJECT_EXECUTION_POLICY_REQUIRED'});assert.equal(f.writes.length,0);
 for(const field of ['version','contract','mode','policyEpoch','activationSourceCommit']){const value=policy();delete value[field];assert.throws(()=>validatePolicy(value),{code:'PROJECT_EXECUTION_POLICY_INVALID'});}
 for(const changes of [{mode:undefined},{mode:false},{mode:'available'},{version:'1'},{policyEpoch:'boot'},{policyEpoch:[E]},{activationSourceCommit:'main'},{activationSourceCommit:[A]},{extra:true}])assert.throws(()=>validatePolicy(policy(changes)),{code:'PROJECT_EXECUTION_POLICY_INVALID'});
 assert.equal(validatePolicy(policy({mode:'isolated-guest'})).mode,'isolated-guest');
});
test('protected readers reject unsafe ownership, links, writable ancestors and oversized files',()=>{
 for(const [target,changes]of [[POLICY_FILE,{uid:1001}],[POLICY_FILE,{mode:0o622}],[POLICY_FILE,{nlink:2}],[POLICY_FILE,{type:'link'}],['/data/harness/root-secrets',{mode:0o777}],['/data',{uid:1001}],['/data/harness',{target:'/other'}]]){
  const f=memory();f.putPolicy(policy());Object.assign(f.nodes.get(target),changes);assert.throws(()=>f.contract.readPolicy(),{code:'PROJECT_EXECUTION_FILE_UNSAFE'});assert.equal(f.fds.size,0);
 }
 const large=memory();large.put(POLICY_FILE,' '.repeat(MAX_BYTES+1));assert.throws(()=>large.contract.readPolicy(),{code:'PROJECT_EXECUTION_FILE_UNSAFE'});assert.equal(large.fds.size,0);
});
test('files use bounded canonical UTF-8 JSON, including rejection of duplicate keys',()=>{
 for(const bytes of [JSON.stringify(policy())+'\n','{"mode":"host-compat","mode":"isolated-guest"}',Buffer.from([0xff]),'{']){
  const f=memory();f.put(POLICY_FILE,bytes);assert.throws(()=>f.contract.readPolicy(),{code:'PROJECT_EXECUTION_FILE_INVALID'});assert.equal(f.fds.size,0);
 }
});
test('a replaced file during reading is refused and its descriptor closes',()=>{
 const f=memory();f.putPolicy(policy());f.readHook=()=>f.putPolicy(policy({mode:'isolated-guest'}));assert.throws(()=>f.contract.readPolicy(),{code:'PROJECT_EXECUTION_FILE_CHANGED'});assert.equal(f.fds.size,0);assert.equal(f.writes.length,0);
});
test('publication binds the explicit policy to this supervisor and verified current source',()=>{
 const f=issued(),s=f.snapshot;
 assert.equal(s.mode,'host-compat');assert.equal(s.policyEpoch,E);assert.equal(s.activationSourceCommit,A);assert.equal(s.sourceCommit,A);assert.equal(s.launchId,L1);
 assert.equal(s.policySha256,crypto.createHash('sha256').update(canonical(policy())).digest('hex'));
 assert.equal(f.writes.length,1);assert.deepEqual(JSON.parse(f.writes[0].bytes),s);assert.equal(f.nodes.get(POLICY_FILE).mode,0o600);
 const binding=bind(f);assert.equal(binding.assertUnchanged(),binding.snapshot);assert(Object.isFrozen(binding));assert(Object.isFrozen(binding.snapshot));assert.throws(()=>{binding.snapshot.mode='isolated-guest';},TypeError);
});
test('service binding has no publication fallback and requires both launch and source identity',()=>{
 const empty=memory();assert.throws(()=>empty.contract.bindForService({sourceCommit:A,launchId:L1}),{code:'PROJECT_EXECUTION_PUBLICATION_REQUIRED'});
 const f=issued();for(const input of [{sourceCommit:B,launchId:L1},{sourceCommit:A,launchId:L2}])assert.throws(()=>f.contract.bindForService(input),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
 assert.throws(()=>f.contract.bindForService({sourceCommit:A,launchId:L1,mode:'host-compat'}),{code:'PROJECT_EXECUTION_BINDING_INVALID'});
 assert.throws(()=>f.contract.bindForService({sourceCommit:[A],launchId:L1}),{code:'PROJECT_EXECUTION_BINDING_INVALID'});
 for(const changes of [{launchId:[L1]},{sourceCommit:[A]},{policySha256:[f.snapshot.policySha256]}])assert.throws(()=>validateProjection({...f.snapshot,...changes}),{code:'PROJECT_EXECUTION_PROJECTION_INVALID'});
});
test('bound consumers refuse valid later mode, epoch, launch or source changes instead of adopting them',()=>{
 for(const change of [p=>p.mode='isolated-guest',p=>p.policyEpoch=L2,p=>p.launchId=L2,p=>p.sourceCommit=B]){
  const f=issued(),binding=bind(f),next={...f.snapshot};change(next);
  next.policySha256=crypto.createHash('sha256').update(canonical(policy({mode:next.mode,policyEpoch:next.policyEpoch}))).digest('hex');
  f.putProjection(next);assert.throws(()=>binding.assertUnchanged(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
 }
 const active=issued({mode:'isolated-guest'}),binding=bind(active);active.putProjection({...active.snapshot,mode:'host-compat',policySha256:crypto.createHash('sha256').update(canonical(policy())).digest('hex')});assert.throws(()=>binding.assertUnchanged(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
});
test('deleted or malformed public state blocks an existing isolated binding',()=>{
 for(const replace of [f=>f.nodes.delete(PUBLIC_FILE),f=>f.put(PUBLIC_FILE,'{}'),f=>{f.nodes.get(PUBLIC_FILE).uid=1001;}]){const f=issued({mode:'isolated-guest'}),binding=bind(f);replace(f);assert.throws(()=>binding.assertUnchanged(),/^Error: PROJECT_EXECUTION_/);}
 const f=issued();assert.throws(()=>validateProjection({...f.snapshot,mode:'isolated-guest'}),{code:'PROJECT_EXECUTION_PROJECTION_INVALID'});
});
test('ordinary supervisor restart republishes without changing or reapproving persistent policy',()=>{
 const f=issued({mode:'isolated-guest'}),old=bind(f),before=f.nodes.get(POLICY_FILE).content.toString();f.launch=L2;
 const next=f.contract.publishForSupervisor({sourceCommit:A});assert.equal(next.launchId,L2);assert.equal(next.policyEpoch,E);assert.equal(next.activationSourceCommit,A);assert.equal(f.nodes.get(POLICY_FILE).content.toString(),before);
 assert.throws(()=>old.assertUnchanged(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(f.contract.bindForService({sourceCommit:A,launchId:L2}).snapshot.mode,'isolated-guest');
});
test('signed source update preserves policy activation provenance while binding the new release',()=>{
 const f=issued({mode:'isolated-guest'}),old=bind(f);f.source=B;f.launch=L2;const next=f.contract.publishForSupervisor({sourceCommit:B});
 assert.equal(next.sourceCommit,B);assert.equal(next.activationSourceCommit,A);assert.equal(next.policyEpoch,E);assert.equal(next.mode,'isolated-guest');assert.throws(()=>old.assertUnchanged(),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
 assert.equal(f.contract.bindForService({sourceCommit:B,launchId:L2}).snapshot.policySha256,f.snapshot.policySha256);
});
test('missing persistent policy after a prior publication refuses the next supervisor',()=>{
 const f=issued();f.nodes.delete(POLICY_FILE);f.launch=L2;assert.throws(()=>f.contract.publishForSupervisor({sourceCommit:A}),{code:'PROJECT_EXECUTION_POLICY_REQUIRED'});assert.equal(f.writes.length,1);
});
test('policy mutation during publication fails without writing a replacement host policy',()=>{
 const f=memory();f.putPolicy(policy({mode:'isolated-guest'}));f.atomicHook=()=>f.putPolicy(policy({policyEpoch:L2}));assert.throws(()=>f.contract.publishForSupervisor({sourceCommit:A}),{code:'PROJECT_EXECUTION_POLICY_CHANGED'});
 assert.equal(JSON.parse(f.writes[0].bytes).mode,'isolated-guest');assert.equal(f.writes.length,1);
});
test('root and verified-source failures happen before public writes; failed output is never a fallback',()=>{
 const unprivileged=memory();unprivileged.putPolicy(policy());unprivileged.uid=1001;assert.throws(()=>unprivileged.contract.publishForSupervisor({sourceCommit:A}),{code:'PROJECT_EXECUTION_ROOT_REQUIRED'});assert.equal(unprivileged.writes.length,0);
 const wrong=memory();wrong.putPolicy(policy());wrong.verificationHook=()=>{throw Error('source not attested');};assert.throws(()=>wrong.contract.publishForSupervisor({sourceCommit:A}),/not attested/);assert.equal(wrong.writes.length,0);
 const broken=memory();broken.putPolicy(policy());const contract=createExecutionModeContract({...broken.options,atomic(){throw Error('disk unavailable');}});assert.throws(()=>contract.publishForSupervisor({sourceCommit:A}),/disk unavailable/);assert.equal(broken.nodes.has(PUBLIC_FILE),false);
});
