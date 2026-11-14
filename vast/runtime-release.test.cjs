'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
const repo=path.resolve(__dirname,'..');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-release-'));t.after(()=>{if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'runtime-release-'))throw Error('Unsafe test cleanup');fs.rmSync(root,{recursive:true,force:true});});return root;}
function environment(runtime){const env={...process.env,HOMEAI_RUNTIME:runtime};for(const key of ['NODE_PATH','NODE_OPTIONS','HARNESS_WEB_PUSH_MODULE'])delete env[key];return env;}
test('Compose and push bind to the explicit installed runtime without global module paths',t=>{
 const root=fixture(t),runtime=path.join(root,'installed-runtime'),project=path.join(root,'project');
 for(const [base,wrong]of [[runtime,false],[project,true]]){
  fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,'package.json'),'{}');
  for(const name of ['yaml','web-push']){const directory=path.join(base,'node_modules',name);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'index.js'),wrong?'throw Error("Project package must not be used");':name==='yaml'?'exports.parseDocument=()=>({errors:[],toJS:()=>({bound:"runtime"})});':'module.exports={bound:"runtime"};');}
 }
 const code=`const assert=require('node:assert/strict'),path=require('node:path');const compose=require(${JSON.stringify(path.join(repo,'vast/apps-compose.cjs'))});assert.deepEqual(compose.parseCompose('fixture'),{bound:'runtime'});require(${JSON.stringify(path.join(repo,'mobile/webpush-server.cjs'))});assert(require.cache[require.resolve(${JSON.stringify(path.join(runtime,'node_modules/web-push'))})]);console.log('runtime-bound');`;
 assert.equal(cp.execFileSync(process.execPath,['-e',code],{cwd:project,env:environment(runtime),encoding:'utf8'}).trim(),'runtime-bound');
});
test('a configured missing runtime fails instead of silently using project dependencies',t=>{
 const root=fixture(t),code=`require(${JSON.stringify(path.join(repo,'runtime/require.cjs'))}).runtimeRequire('yaml');`;
 const run=cp.spawnSync(process.execPath,['-e',code],{env:environment(path.join(root,'missing')),encoding:'utf8'});assert.notEqual(run.status,0);assert.match(run.stderr,/ENOENT|manifest/);
});
test('real linked entry executes once while importing it has no main side effect',t=>{
 const root=fixture(t),release=path.join(root,'releases','version'),app=path.join(root,'app');fs.mkdirSync(release,{recursive:true});
 const helper=pathToFileURL(path.join(repo,'runtime/require.cjs')).href;fs.writeFileSync(path.join(release,'entry.mjs'),`import {isMain} from ${JSON.stringify(helper)};if(isMain(import.meta.url))console.log('entered-main');`);fs.symlinkSync(release,app,process.platform==='win32'?'junction':'dir');
 const entry=path.join(app,'entry.mjs');assert.equal(cp.execFileSync(process.execPath,[entry],{encoding:'utf8'}).trim(),'entered-main');
 assert.equal(cp.execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(entry).href)});`],{encoding:'utf8'}),'');
});
test('the actual verification CLI runs through a linked application directory',t=>{
 const root=fixture(t),app=path.join(root,'app');fs.symlinkSync(repo,app,process.platform==='win32'?'junction':'dir');
 const result=cp.spawnSync(process.execPath,[path.join(app,'quality/cli.mjs'),'invalid-operation'],{encoding:'utf8'});assert.equal(result.status,1);const report=JSON.parse(result.stdout);assert.equal(report.passed,false);assert.match(report.error,/Usage: cli/);
});
test('push defaults retain existing persistent identity outside the release tree',t=>{
 const root=fixture(t),data=path.join(root,'persistent'),secret=path.join(data,'secrets');fs.mkdirSync(secret,{recursive:true});
 const keys=JSON.stringify({publicKey:'fixture-public',privateKey:'fixture-private'});fs.writeFileSync(path.join(secret,'webpush-vapid.json'),keys);
 const code=`const assert=require('node:assert/strict'),fs=require('node:fs');const {createPushServer}=require(${JSON.stringify(path.join(repo,'mobile/webpush-server.cjs'))});let generated=0;const result=createPushServer({publicHost:'fixture.ts.net'},{generateVAPIDKeys(){generated++;throw Error('Must preserve identity')},setVapidDetails(_url,pub,priv){assert.equal(pub,'fixture-public');assert.equal(priv,'fixture-private')}});assert.equal(result.files.keys,${JSON.stringify(path.join(secret,'webpush-vapid.json'))});assert.equal(generated,0);assert.equal(fs.readFileSync(result.files.keys,'utf8'),${JSON.stringify(keys)});console.log('identity-preserved');`;
 const runtime=path.join(root,'runtime');fs.mkdirSync(path.join(runtime,'node_modules/web-push'),{recursive:true});fs.writeFileSync(path.join(runtime,'package.json'),'{}');fs.writeFileSync(path.join(runtime,'node_modules/web-push/index.js'),'module.exports={};');
 const env={...environment(runtime),HOMEAI_ROOT:data};assert.equal(cp.execFileSync(process.execPath,['-e',code],{env,encoding:'utf8'}).trim(),'identity-preserved');
});
test('service data root follows the installed runtime when no explicit root is configured',t=>{
 const root=fixture(t),runtime=path.join(root,'runtime'),env={...process.env,HOMEAI_RUNTIME:runtime};delete env.HOMEAI_ROOT;
 const code=`const assert=require('node:assert/strict');assert.equal(require(${JSON.stringify(path.join(repo,'runtime/require.cjs'))}).serviceDataRoot(),${JSON.stringify(root)});console.log('persistent-root');`;
 assert.equal(cp.execFileSync(process.execPath,['-e',code],{env,encoding:'utf8'}).trim(),'persistent-root');
});
