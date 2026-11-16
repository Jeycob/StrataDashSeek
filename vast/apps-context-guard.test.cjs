'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {guardAppsTarget}=require('./apps-context-guard.cjs');
test('root Apps service checks actual canonical target and resource ownership before execution',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'harness-root-app-context-')),a=path.join(directory,'a'),b=path.join(directory,'b');await fs.mkdir(a);await fs.mkdir(b);const expected=crypto.createHash('sha256').update(await fs.realpath(a)).digest('hex').slice(0,16);
 t.after(async()=>{const resolved=path.resolve(directory);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('harness-root-app-context-'));await fs.rm(resolved,{recursive:true,force:true});});
 const manager={cfg:{workspaceRoot:directory},project:id=>({id,directory:a}),store:{jobs:[{id:'own-job',projectId:expected},{id:'other-job',projectId:'0'.repeat(16)}]},state:async()=>({containers:[{id:'own-container',projectId:expected},{id:'other-container',projectId:'0'.repeat(16)}]})},binding={_contextProjectId:expected};
 for(const route of ['/scaffold','/register']){await guardAppsTarget(manager,route,{...binding,path:'a'});await assert.rejects(guardAppsTarget(manager,route,{...binding,path:'b'}));await assert.rejects(guardAppsTarget(manager,route,{...binding,path:'../outside'}));}
 for(const route of ['/project-settings','/project-action','/releases','/release']){await guardAppsTarget(manager,route,{...binding,id:expected});await assert.rejects(guardAppsTarget(manager,route,{...binding,id:'0'.repeat(16)}));}
 for(const route of ['/job-status','/job-log','/export-download']){await guardAppsTarget(manager,route,{...binding,id:'own-job'});await assert.rejects(guardAppsTarget(manager,route,{...binding,id:'other-job'}));}
 for(const route of ['/container-action','/container-log']){await guardAppsTarget(manager,route,{...binding,id:'own-container'});await assert.rejects(guardAppsTarget(manager,route,{...binding,id:'other-container'}));}
 await assert.rejects(guardAppsTarget(manager,'/worker-action',binding));await assert.rejects(guardAppsTarget(manager,'/register',{_contextProjectId:'invalid',path:'a'}));
 await guardAppsTarget(manager,'/worker-action',{});
});
