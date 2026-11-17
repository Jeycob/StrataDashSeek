'use strict';
const {hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {AppsManager}=require('./apps-manager.cjs'),{guardAppsTarget}=require('./apps-context-guard.cjs'),{projectIdFor}=require('../mobile/apps-context.cjs'),{scaffold}=require('./apps-scaffold.cjs');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'harness-app-target-race-')),root=path.join(base,'projects'),a=path.join(root,'a'),b=path.join(root,'b'),alias=path.join(root,'alias');await fs.mkdir(a,{recursive:true});await fs.mkdir(b);for(const dir of [a,b])await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{start:'node server.js'}}));await fs.symlink(a,alias,process.platform==='win32'?'junction':'dir');
 t.after(async()=>{const target=path.resolve(base);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('harness-app-target-race-'));await fs.rm(target,{recursive:true,force:true});});
 return{base,root,a,b,alias,cfg:{enabled:true,workspaceRoot:root,stateDir:path.join(base,'state')},id:projectIdFor(await fs.realpath(a)),async flip(){await fs.unlink(alias);await fs.symlink(b,alias,process.platform==='win32'?'junction':'dir');}};
}
test('actual register rejects a target swapped after the root guard and never registers the other project',async t=>{
 const f=await fixture(t);for(const dir of [f.a,f.b]){await fs.writeFile(path.join(dir,'Dockerfile'),'FROM scratch');await fs.writeFile(path.join(dir,'.harness-app.json'),JSON.stringify({version:1,name:path.basename(dir),port:8080}));}
 const manager=new AppsManager(f.cfg,{},undefined,hostExecutionBinding());await guardAppsTarget(manager,'/register',{path:'alias',_contextProjectId:f.id});await f.flip();await assert.rejects(manager.register('alias',f.id),e=>e.code==='PROJECT_CONTEXT_MISMATCH');assert.deepEqual(manager.store.projects,{});
});
test('actual workflow scaffolding receives expected identity and refuses a post-guard target swap',async t=>{
 const f=await fixture(t),manager=new AppsManager(f.cfg,{},undefined,hostExecutionBinding());await guardAppsTarget(manager,'/scaffold',{path:'alias',_contextProjectId:f.id});await f.flip();await assert.rejects(manager.scaffold('alias',false,f.id),e=>e.code==='PROJECT_CONTEXT_MISMATCH');assert.deepEqual(await fs.readdir(f.a),['package.json']);assert.deepEqual(await fs.readdir(f.b),['package.json']);assert.equal(manager.busy,null);
});
test('registration cannot replace a project reference while verification is busy or starts during path resolution',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.a,'Dockerfile'),'FROM scratch');const manifest=path.join(f.a,'.harness-app.json');await fs.writeFile(manifest,JSON.stringify({version:1,name:'Original',port:8080}));const manager=new AppsManager(f.cfg,{},undefined,hostExecutionBinding());await manager.register('alias',f.id);const saved=manager.store.projects[f.id];saved.releaseId='retained-release';await fs.writeFile(manifest,JSON.stringify({version:1,name:'Changed',port:9090}));
 manager.busy='verify';manager.lastActivity=12345;await assert.rejects(manager.register('alias',f.id),e=>e.status===409);assert.equal(manager.lastActivity,12345);assert.equal(manager.store.projects[f.id],saved);assert.equal(saved.port,8080);assert.equal(saved.releaseId,'retained-release');
 manager.busy=null;const read=fs.readFile;fs.readFile=async function(file,...args){const value=await read.call(this,file,...args);if(path.basename(String(file))==='.harness-app.json')manager.busy='verify-started-during-read';return value;};
 try{await assert.rejects(manager.register('alias',f.id),e=>e.status===409);}finally{fs.readFile=read;}
 assert.equal(manager.store.projects[f.id],saved);assert.equal(saved.port,8080);assert.equal(saved.name,'Original');assert.equal(saved.releaseId,'retained-release');
});
test('registration rechecks the canonical directory after asynchronous project manifest reads',async t=>{
 const f=await fixture(t);for(const dir of [f.a,f.b]){await fs.writeFile(path.join(dir,'compose.yaml'),'services:\n  web:\n    image: fixture:local\n');await fs.writeFile(path.join(dir,'.harness-app.json'),JSON.stringify({version:1,name:path.basename(dir),port:8080,composeFile:'compose.yaml',entryService:'web'}));}const manager=new AppsManager(f.cfg,{},undefined,hostExecutionBinding()),read=fs.readFile;let swapped=false;
 fs.readFile=async function(file,...args){const value=await read.call(this,file,...args);if(!swapped&&path.basename(String(file))==='.harness-app.json'){swapped=true;await fs.rename(f.a,path.join(f.root,'a-original'));await fs.symlink(f.b,f.a,process.platform==='win32'?'junction':'dir');}return value;};
 try{await assert.rejects(manager.register('alias',f.id),e=>e.code==='PROJECT_CONTEXT_MISMATCH');}finally{fs.readFile=read;}
 assert(swapped);assert.deepEqual(manager.store.projects,{});
});
for(const bound of [false,true])test('a target changed while planning cannot redirect scaffold writes, bound='+bound,async t=>{
 const f=await fixture(t),read=fs.readFile;let flipped=false;
 fs.readFile=async function(file,...args){const value=await read.call(this,file,...args);if(!flipped&&path.basename(String(file))==='package.json'){flipped=true;await f.flip();}return value;};
 try{await assert.rejects(scaffold('alias',f.cfg,bound?f.id:undefined),e=>e.code==='PROJECT_CONTEXT_MISMATCH');}finally{fs.readFile=read;}
 assert(flipped);assert.deepEqual(await fs.readdir(f.a),['package.json']);assert.deepEqual(await fs.readdir(f.b),['package.json']);
});
