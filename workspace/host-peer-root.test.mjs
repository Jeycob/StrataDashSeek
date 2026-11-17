import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreparedPeerRun} from './fixtures/host-peer-root.mjs';
const approved='/var/lib/homeai-host-peer-fixture-AbCd1234wXyZ',directory=approved+'/run-aB12Cd',identity={uid:1001,gid:1001};
function fixture(){const effects=[],nodes=new Map([[approved,{dev:1,ino:1,uid:1001,gid:1001,mode:0o40700,kind:'dir'}]]);let names=[],alias=false;const files={async realpath(file){return alias?'/foreign':file;},async lstat(file){const info=nodes.get(file);assert(info,'synthetic missing');return{...info,isDirectory:()=>info.kind==='dir',isSymbolicLink:()=>info.kind==='link'};},async readdir(file){assert.equal(file,approved);return names;},async mkdtemp(prefix){assert.equal(prefix,approved+'/run-');effects.push('mkdtemp:'+prefix);nodes.set(directory,{dev:1,ino:2,uid:1001,gid:1001,mode:0o40700,kind:'dir'});return directory;},async rm(file,options){effects.push('rm:'+file);assert.equal(file,directory);assert.deepEqual(options,{recursive:true,force:false});nodes.delete(file);}};return{files,nodes,effects,setNames(value){names=value;},alias(){alias=true;}};}
test('nonroot fixture creates only fresh own run child and leaves prepared outer untouched',async()=>{
 const f=fixture(),run=await createPreparedPeerRun(approved,identity,f.files);assert.equal(run.directory,directory);assert(Object.isFrozen(run));await run.cleanup();assert.deepEqual(f.effects,['mkdtemp:'+approved+'/run-','rm:'+directory]);assert(f.nodes.has(approved));
});
test('Root UID, arbitrary paths and invalid exact suffix refuse before any filesystem effect',async()=>{
 for(const root of['/tmp/homeai-host-peer-fixture-AbCd1234wXyZ','/var/lib/homeai-host-peer-fixture-short',approved+'/child','/var/lib/homeai-host-peer-fixture-AbCd1234wXyZ/../else']){const f=fixture();await assert.rejects(()=>createPreparedPeerRun(root,identity,f.files),{code:'PEER_FIXTURE_PREPARED_ROOT_REQUIRED'});assert.deepEqual(f.effects,[]);}
 const f=fixture();await assert.rejects(()=>createPreparedPeerRun(approved,{uid:0,gid:0},f.files),{code:'PEER_FIXTURE_NONROOT_REQUIRED'});assert.deepEqual(f.effects,[]);
});
test('alias, wrong UID/GID/mode, symlink and populated outer refuse before mkdtemp',async()=>{
 for(const change of[f=>f.alias(),f=>f.nodes.get(approved).uid=1000,f=>f.nodes.get(approved).gid=1000,f=>f.nodes.get(approved).mode=0o40755,f=>f.nodes.get(approved).mode=0o42700,f=>f.nodes.get(approved).kind='link',f=>f.setNames(['previous-run'])]){const f=fixture();change(f);await assert.rejects(()=>createPreparedPeerRun(approved,identity,f.files));assert.deepEqual(f.effects,[]);}
});
test('cleanup refuses replaced child/outer or changed ownership without deleting anything',async()=>{
 for(const change of[f=>f.nodes.get(directory).ino++,f=>f.nodes.get(approved).ino++,f=>f.nodes.get(directory).uid=1000,f=>f.nodes.get(directory).kind='link']){const f=fixture(),run=await createPreparedPeerRun(approved,identity,f.files);change(f);await assert.rejects(()=>run.cleanup());assert(!f.effects.some(value=>value.startsWith('rm:')));}
});
