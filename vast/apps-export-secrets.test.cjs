'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {recordProof,prepareExport,bindingDigest,inspect}=require('./apps-export-secrets.cjs'),{secretForms,redact}=require('./apps-command.cjs'),{Releases}=require('./apps-releases.cjs');
const marker='synthetic-only-credential-É-$-"-long-value',rotated='synthetic-only-rotated-credential-Ω-long-value';
async function fixture(t,{refs=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'apps-export-credentials-'));t.after(async()=>{assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
 const projectId='a'.repeat(16),releaseId='b'.repeat(16),credentials=refs?{scope:{projectId:'synthetic-vault-project',environment:'test',secretPath:'/fixture'},runtime:{API_TOKEN:'SYNTHETIC_RECORD'},build:{}}:undefined;
 let current=marker,reads=0;const manager={project:()=>({credentials}),redactions:new Map([[releaseId,refs?[marker]:[]]]),credentialBindings:new Map([[releaseId,{required:refs,runtime:bindingDigest(credentials,'runtime')}]]),vault:{async resolve(){reads++;return{API_TOKEN:current};}}};
 manager.releases=new Releases(path.join(root,'releases'),{onPassed:(p,id)=>recordProof(manager,p,id),requiresCredentialProof:()=>refs});const directory=manager.releases.dir(projectId,releaseId);await fs.mkdir(path.join(directory,'source'),{recursive:true});await fs.writeFile(path.join(directory,'source','app.js'),'console.log("safe");');
 const pass=()=>manager.releases.put(projectId,releaseId,{status:'passed',checks:[{passed:true}]});
 let n=0;const prepare=async()=>{const stage=path.join(root,'stage-'+n++);await fs.mkdir(stage,{mode:0o700});return{stage,...await prepareExport(manager,projectId,releaseId,stage)};};
 return{root,directory,manager,projectId,releaseId,credentials,pass,prepare,rotate(value){current=value;},reads:()=>reads};
}
test('credential-free exports need no vault; private source paths are excluded and safe large binary data is retained',async t=>{
 const f=await fixture(t,{refs:false});f.manager.vault.resolve=()=>{throw Error('must not contact vault');};
 const binary=Buffer.alloc(2*1024*1024,137);await fs.writeFile(path.join(f.directory,'source','asset.bin'),binary);await fs.writeFile(path.join(f.directory,'source','.env'),'synthetic-private-file');await f.pass();
 const result=await f.prepare();assert.deepEqual(await fs.readFile(path.join(result.stage,'source','asset.bin')),binary);await assert.rejects(fs.stat(path.join(result.stage,'source','.env')),{code:'ENOENT'});assert.equal(f.reads(),0);
});
test('release-time values and encoded forms are detected across binary read boundaries without leaking a prefix',async t=>{
 for(const form of secretForms([marker])){
  const f=await fixture(t),value=Buffer.from(form),binary=Buffer.concat([Buffer.alloc(65530,137),value,Buffer.alloc(20,255)]);await fs.writeFile(path.join(f.directory,'source','asset.bin'),binary);await f.pass();
  await assert.rejects(f.prepare(),error=>error.code==='EXPORT_SECRET_DETECTED'&&!error.message.includes(marker.slice(0,12))&&!error.message.includes(form));
  const proof=await fs.readFile(path.join(f.directory,'.export-credential-proof.json'),'utf8');assert.equal(proof.includes(marker),false);assert.equal(proof.includes(form),false);assert.equal(JSON.parse(proof).status,'blocked');
  assert.equal(redact(form,[marker]),'[REDACTED]');
 }
});
test('rotation keeps an unchanged clean release exportable and cannot hide a historical or newly introduced credential',async t=>{
 const clean=await fixture(t);await clean.pass();clean.rotate(rotated);const result=await clean.prepare();assert.equal(result.values[0],rotated);assert.equal(clean.reads(),1);
 // The private staging is the export input, not the source later modified by a writer.
 await fs.writeFile(path.join(clean.directory,'source','app.js'),marker);assert.equal((await fs.readFile(path.join(result.stage,'source','app.js'),'utf8')).includes(marker),false);
 await assert.rejects(clean.prepare(),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
 const leaked=await fixture(t);await fs.writeFile(path.join(leaked.directory,'source','debug.json'),JSON.stringify({value:marker}));await leaked.pass();leaked.rotate(rotated);await assert.rejects(leaked.prepare(),{code:'EXPORT_SECRET_DETECTED'});assert.equal(leaked.reads(),0);
 const newlySecret=await fixture(t);await fs.writeFile(path.join(newlySecret.directory,'source','example.txt'),rotated);await newlySecret.pass();newlySecret.rotate(rotated);await assert.rejects(newlySecret.prepare(),{code:'EXPORT_SECRET_DETECTED'});
});
test('legacy, changed bindings, unavailable vault and incomplete use are distinct from a detected leak',async t=>{
 const legacy=await fixture(t);await fs.writeFile(path.join(legacy.directory,'release.json'),JSON.stringify({status:'passed'}));await assert.rejects(legacy.prepare(),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
 const changed=await fixture(t);await changed.pass();changed.credentials.runtime.API_TOKEN='OTHER_REFERENCE';await assert.rejects(changed.prepare(),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
 const unavailable=await fixture(t);await unavailable.pass();unavailable.manager.vault.resolve=async()=>{throw Error(marker);};await assert.rejects(unavailable.prepare(),error=>error.code==='EXPORT_VAULT_UNAVAILABLE'&&!error.message.includes(marker));
 const incomplete=await fixture(t);incomplete.manager.credentialBindings.clear();await incomplete.pass();await assert.rejects(incomplete.prepare(),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
});

test('an unclassified historical release cannot become credential-free after references were removed',async t=>{
 const f=await fixture(t,{refs:false});f.manager.vault.resolve=()=>{throw Error('No vault access is needed to reject missing historical evidence');};
 await fs.writeFile(path.join(f.directory,'release.json'),JSON.stringify({status:'passed'}));
 await fs.writeFile(path.join(f.directory,'source','old.txt'),marker);
 await assert.rejects(f.prepare(),error=>error.code==='EXPORT_SECRET_CHECK_UNAVAILABLE'&&error.message.includes('Verify a new release'));
 // A normal new verification explicitly classifies no-reference releases.
 await fs.writeFile(path.join(f.directory,'source','old.txt'),'corrected safe source');await f.pass();
 assert.equal((await f.manager.releases.get(f.projectId,f.releaseId)).requiresCredentialProof,false);await f.prepare();assert.equal(f.reads(),0);
});

test('rotation cannot expose a historical value through generated credential-name metadata',async t=>{
 const f=await fixture(t),alias='SYNTHETIC_HISTORICAL_KEY_ALIAS';f.credentials.runtime={[alias]:'SYNTHETIC_RECORD'};
 f.manager.credentialBindings.set(f.releaseId,{runtime:bindingDigest(f.credentials,'runtime')});f.manager.redactions.set(f.releaseId,[alias]);
 await f.pass();f.rotate(rotated);await assert.rejects(f.prepare(),error=>error.code==='EXPORT_SECRET_DETECTED'&&!error.message.includes(alias));
 const proof=await fs.readFile(path.join(f.directory,'.export-credential-proof.json'),'utf8');assert.equal(proof.includes(alias),false);
});
test('links and changed snapshots cannot be exported as a clean credential witness',async t=>{
 const f=await fixture(t);await f.pass();await fs.link(path.join(f.directory,'source','app.js'),path.join(f.directory,'source','alias.js'));
 await assert.rejects(f.prepare(),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
 const g=await fixture(t);await g.pass();await fs.writeFile(path.join(g.directory,'source','new.txt'),'safe but not the witnessed release');await assert.rejects(g.prepare(),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
 await assert.rejects(inspect(g.directory,{deadline:0}),{code:'EXPORT_SECRET_CHECK_UNAVAILABLE'});
});
