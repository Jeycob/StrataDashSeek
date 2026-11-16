'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const T=require('./project-toolchain.cjs'),B=require('./project-toolchain-build.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-toolchain-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(name,value,mode=0o444)=>{const full=path.join(root,name);fs.mkdirSync(path.dirname(full),{recursive:true,mode:0o755});if(fs.existsSync(full))fs.chmodSync(full,0o600);fs.writeFileSync(full,value,{mode});fs.chmodSync(full,mode);};
 for(const name of T.REQUIRED)write(name,'synthetic fixture '+name);
 for(const[name,content]of Object.entries(T.NPM_WRAPPERS))write('npm/bin/'+name,content,0o555);
 const versions={playwright:T.PINS.playwright,playwrightIntegrity:T.PINS.playwrightIntegrity,dotnetVersion:T.PINS.dotnet,dotnetSHA512:T.PINS.dotnetSHA512};write('homeai/development/versions.json',JSON.stringify(versions));
 for(const[name,version]of [['code-server',T.PINS.codeServer],['npm',T.NPM_VERSION],['playwright/node_modules/playwright',T.PINS.playwright],['playwright/node_modules/playwright-core',T.PINS.playwright]])write(name+'/package.json',JSON.stringify({version}));
 const header=Buffer.alloc(64);Buffer.from('7f454c460201','hex').copy(header);header.writeUInt16LE(62,18);write('code-server/lib/node',header,0o555);write('dotnet/dotnet',header,0o555);
 const browsers=['chromium','chromium-headless-shell','ffmpeg'].map((name,i)=>({name,revision:String(i+1),sha256:String(i+1).repeat(64),executable:'playwright/browsers/'+name.replaceAll('-','_')+'-'+(i+1)+'/synthetic-elf'}));for(const b of browsers)write(b.executable,header,0o555);
 write('playwright/node_modules/playwright-core/browsers.json',JSON.stringify({browsers:browsers.map(({name,revision})=>({name,revision}))}));
 const inputs={codeServer:{version:T.PINS.codeServer,sha256:T.PINS.codeServerSHA256},dotnet:{version:T.PINS.dotnet,sha512:T.PINS.dotnetSHA512},playwright:{version:T.PINS.playwright,integrity:T.PINS.playwrightIntegrity},playwrightCore:{version:T.PINS.playwright,integrity:T.PINS.playwrightCoreIntegrity},npm:{version:T.NPM_VERSION,integrity:T.NPM_INTEGRITY},browsers};
 const sourceFiles=Object.entries(T.SOURCE_FILES).map(([source,destination])=>({source,destination,sourceSha256:sha(fs.readFileSync(path.join(root,destination))),installedSha256:sha(fs.readFileSync(path.join(root,destination)))}));
 const meta={sourceCommit:'a'.repeat(40),inputs,sourceFiles};const options={expectedUid:process.getuid()};
 function publish(){const value=T.createManifest(root,meta,options);write(T.MANIFEST,value.bytes);return value;}
 return{root,write,meta,options,publish};
}
test('canonical manifest is deterministic and validates exact immutable tree descriptor',{skip:process.platform!=='linux'},t=>{
 const f=fixture(t),a=f.publish(),b=f.publish();assert.equal(a.bytes,b.bytes);assert.equal(a.manifestSha256,b.manifestSha256);
 const result=T.verifyToolchain(f.root,{expectedDigest:a.manifestSha256,...f.options});assert.equal(result.root,f.root);assert.equal(result.uid,process.getuid());assert.equal(result.manifestSha256,a.manifestSha256);
 assert.throws(()=>T.verifyToolchain(f.root,{expectedDigest:'f'.repeat(64),...f.options}),/DIGEST/);
 fs.chmodSync(path.join(f.root,'homeai/quality/core.mjs'),0o644);fs.appendFileSync(path.join(f.root,'homeai/quality/core.mjs'),'tampered');assert.throws(()=>T.verifyToolchain(f.root,{expectedDigest:a.manifestSha256,...f.options}),/TREE_DIGEST/);
});
test('unapproved files, writable modes, outside symlinks, hardlinks and special entries fail',{skip:process.platform!=='linux'},t=>{
 for(const kind of ['extra','mode','symlink','hardlink','fifo']){
  const f=fixture(t);if(kind==='extra')f.write('homeai/secrets.json','synthetic');if(kind==='mode')fs.chmodSync(path.join(f.root,'npm/package.json'),0o666);if(kind==='symlink')fs.symlinkSync('/etc/passwd',path.join(f.root,'npm/outside'));if(kind==='hardlink')fs.linkSync(path.join(f.root,'npm/package.json'),path.join(f.root,'npm/alias'));if(kind==='fifo')assert.equal(spawnSync('mkfifo',[path.join(f.root,'npm/pipe')]).status,0);
  assert.throws(()=>f.publish(),/TOOLCHAIN_/);
 }
 const f=fixture(t);fs.symlinkSync('package.json',path.join(f.root,'npm/inside'));assert.doesNotThrow(()=>f.publish());
});
test('runtime versions, browser revisions, root ownership and scan bounds cannot be papered over',{skip:process.platform!=='linux'},t=>{
 const f=fixture(t);const wrong=structuredClone(f.meta);wrong.inputs.npm.version='0.0.0';assert.throws(()=>T.createManifest(f.root,wrong,f.options),/NPM_PIN/);
 f.write('playwright/node_modules/playwright-core/browsers.json','{"browsers":[]}');assert.throws(()=>f.publish(),/REVISION/);
 const g=fixture(t),manifest=g.publish();assert.throws(()=>T.verifyToolchain(g.root,{expectedDigest:manifest.manifestSha256,expectedUid:process.getuid()+1}),/MANIFEST_FILE/);
 assert.throws(()=>T.scan(g.root,{...g.options,limits:{...T.LIMITS,entries:1}}),/ENTRY_LIMIT/);
 assert.throws(()=>T.scan(g.root,{...g.options,limits:{...T.LIMITS,bytes:1}}),/BYTE_LIMIT/);
});
test('offline recipe requires concrete pinned inputs, whitelists sources and only transforms documented guest paths',()=>{
 const browsers=['chromium','chromium-headless-shell','ffmpeg'].map((name,i)=>({name,revision:String(i+1),sha256:String(i+1).repeat(64),file:'/offline/'+name+'.zip',executable:'playwright/browsers/'+name.replaceAll('-','_')+'-'+(i+1)+'/binary'}));
 const recipe={version:1,sourceRepo:'/trusted/repository',sourceCommit:'a'.repeat(40),artifacts:{codeServer:'/offline/code-server.tar.gz',dotnet:'/offline/dotnet.tar.gz',npm:'/offline/npm.tgz',playwright:'/offline/playwright.tgz',playwrightCore:'/offline/playwright-core.tgz',browsers}};
 const plan=B.prepare(recipe);assert.equal(plan.archives.length,8);assert.equal(plan.inputs.npm.version,'12.2.2');assert(plan.archives.every(a=>a.file.startsWith('/offline/')));
 assert.throws(()=>B.prepare({...recipe,artifacts:{...recipe.artifacts,npm:undefined}}),/ARTIFACT/);
 assert(!Object.keys(T.SOURCE_FILES).some(name=>name.includes('manager')||name.includes('apps-config')||name.startsWith('runtime/package')));
 assert.equal(B.transformSource('development/doctor.cjs',Buffer.from('/data/harness/dev/dotnet/dotnet')).toString(),'/opt/dotnet/dotnet');
 assert.equal(B.transformSource('quality/core.mjs',Buffer.from('untouched')).toString(),'untouched');
 const sources=new Map(Object.keys(T.SOURCE_FILES).map(name=>[name,{installed:Buffer.from('synthetic')}])) ;sources.get('quality/core.mjs').installed=Buffer.from("import x from '../workspace/tool-recovery.mjs';");assert.doesNotThrow(()=>B.auditSources(sources));sources.get('quality/core.mjs').installed=Buffer.from("import x from '../workspace/manager.mjs';");assert.throws(()=>B.auditSources(sources),/DEPENDENCY_UNLISTED/);
 const lock=require('./project-toolchain-lock.json');assert.deepEqual(lock.npm,{version:T.NPM_VERSION,integrity:T.NPM_INTEGRITY});assert.equal(lock.playwright.integrity,T.PINS.playwrightIntegrity);assert.equal(lock.playwrightCore.integrity,T.PINS.playwrightCoreIntegrity);assert.equal(lock.dotnet.sha512,T.PINS.dotnetSHA512);
 const versions=require('./versions.json'),ci=require('./ci/package-lock.json');assert.equal(versions.dotnetSHA512,T.PINS.dotnetSHA512);assert.equal(versions.playwrightIntegrity,T.PINS.playwrightIntegrity);assert.equal(ci.packages['node_modules/playwright'].integrity,T.PINS.playwrightIntegrity);assert.equal(ci.packages['node_modules/playwright-core'].integrity,T.PINS.playwrightCoreIntegrity);
});
