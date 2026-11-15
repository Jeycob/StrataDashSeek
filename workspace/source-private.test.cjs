'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {isPrivateSourcePath}=require('./source-private.cjs');
const privatePaths=['secrets/session-secret','nested/Secrets/key','session-secret','auth/cookie.secret.txt','.env','.env.production','.aws/credentials','credentials.json','server/private.key'];
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'source-private-')),root=path.join(directory,'project');await fs.mkdir(root);t.after(async()=>{assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'source-private-'));await fs.rm(directory,{recursive:true,force:true})});const write=async(name,value)=>{const p=path.join(root,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,value)};return{directory,root,write};}

test('credential path policy excludes conventional runtime keys while retaining code and examples',()=>{
 for(const name of privatePaths)assert.equal(isPrivateSourcePath(name),true,name);
 for(const name of ['src/secretary.js','server/session-secret.mjs','docs/secrets.md','.env.example','.env.sample','.env.template','src/__proto__'])assert.equal(isPrivateSourcePath(name),false,name);
 assert.equal(isPrivateSourcePath('src\\secrets\\session-secret'),true);
});

test('checkpoints and build snapshots never read or copy conventional credential files',async t=>{
 const f=await fixture(t),secret='FIXTURE_PRIVATE_VALUE';for(const name of privatePaths)await f.write(name,secret);
 await f.write('app.js','export const value=1;\n');await f.write('.env.example','PUBLIC_SETTING=example\n');await f.write('__proto__','ordinary filename\n');
 const {sourceManifest,saveCheckpoint}=await import('./storage.mjs'),{snapshot}=require('../vast/apps-project.cjs');
 const privateFiles=new Set(privatePaths.map(n=>path.resolve(f.root,n))),readFile=fs.readFile.bind(fs),open=fs.open.bind(fs);
 t.mock.method(fs,'readFile',async(file,...args)=>{if(privateFiles.has(path.resolve(String(file))))throw Error('Private source was read');return readFile(file,...args)});
 t.mock.method(fs,'open',async(file,...args)=>{if(privateFiles.has(path.resolve(String(file))))throw Error('Private source was opened');return open(file,...args)});
 const manifest=await sourceManifest(f.root);assert.equal(Object.getPrototypeOf(manifest.files),null);assert(Object.hasOwn(manifest.files,'__proto__'));
 for(const name of privatePaths)assert.equal(Object.hasOwn(manifest.files,name),false,name);
 const saved=await saveCheckpoint(f.root,path.join(f.directory,'checkpoint'),manifest);
 assert.equal(await readFile(path.join(saved,'files/app.js'),'utf8'),'export const value=1;\n');
 for(const name of privatePaths)await assert.rejects(fs.stat(path.join(saved,'files',name)),{code:'ENOENT'});
 await assert.rejects(saveCheckpoint(f.root,path.join(f.directory,'forged'),{files:{'secrets/session-secret':{sha256:'a'.repeat(64)}},bytes:10}),{code:'CHECKPOINT_PRIVATE_PATH'});
 const output=path.join(f.directory,'build');await snapshot({directory:f.root},output);
 assert.equal(await readFile(path.join(output,'app.js'),'utf8'),'export const value=1;\n');
 for(const name of privatePaths)await assert.rejects(fs.stat(path.join(output,name)),{code:'ENOENT'});
});

test('verification source fingerprints ignore credential rotation and still reject outside paths',async t=>{
 const f=await fixture(t);await f.write('app.js','source\n');await f.write('secrets/session-secret','FIRST_FIXTURE_VALUE');
 const {fingerprint}=await import('../quality/core.mjs'),before=await fingerprint(f.root,['.']);
 await f.write('secrets/session-secret','ROTATED_FIXTURE_VALUE');const after=await fingerprint(f.root,['.']);
 assert.deepEqual(after,before);assert.equal(after.files,1);
 await assert.rejects(fingerprint(f.root,['../secrets/session-secret']),{code:'OUTSIDE_PROJECT'});
});

test('restoring legacy source history preserves current runtime credentials and skips old private entries',async t=>{
 const f=await fixture(t),{hash}=await import('./storage.mjs'),{WorkspaceManager}=await import('./manager.mjs');
 await f.write('app.js','current source\n');await f.write('toString','extra source\n');await f.write('secrets/session-secret','CURRENT_FIXTURE_CREDENTIAL');
 const state=path.join(f.directory,'state'),checkpoint=path.join(state,'checkpoints/one/legacy');await fs.mkdir(path.join(checkpoint,'files'),{recursive:true});
 await fs.writeFile(path.join(checkpoint,'files/app.js'),'original source\n');
 const files={'app.js':{sha256:hash('original source\n'),bytes:16,binary:false},'secrets/session-secret':{sha256:hash('OLD_FIXTURE_CREDENTIAL'),bytes:22,binary:false}};
 await fs.writeFile(path.join(checkpoint,'checkpoint-manifest.json'),JSON.stringify({files}));
 const manager=Object.create(WorkspaceManager.prototype);manager.root=state;manager.data={sessions:{one:{checkpoints:{test:{path:checkpoint,sha256:hash(JSON.stringify(Object.entries(files).sort()))}}}}};
 manager.withFiles=async(_id,fn)=>fn(f.root,{});manager.save=async()=>{};
 manager.ctx={fs:{resolve:async p=>p,stat:async p=>{try{await fs.stat(p);return{version:'fixture'}}catch(e){if(e.code==='ENOENT')return null;throw e}},writeText:async(p,text)=>fs.writeFile(p,text),deleteFile:async p=>fs.unlink(p)}};
 const result=await manager.restoreCheckpoint('one','test');
 assert.equal(result.files,1);assert.equal(result.skippedPrivateFiles,1);
 assert.equal(await fs.readFile(path.join(f.root,'app.js'),'utf8'),'original source\n');
 assert.equal(await fs.readFile(path.join(f.root,'secrets/session-secret'),'utf8'),'CURRENT_FIXTURE_CREDENTIAL');
 assert.equal(await fs.readFile(path.join(f.root,'toString'),'utf8'),'extra source\n');
 assert.equal(result.legacyOverlayOnly,true);
});
