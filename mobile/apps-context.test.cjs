'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {resolveProjectContext,publicContext,scopedAppsState,authorizeAppsOperation,projectIdFor,createAppsContextGateway}=require('./apps-context.cjs');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'harness-apps-context-')),workspaceRoot=path.join(base,'projects'),a=path.join(workspaceRoot,'a'),b=path.join(workspaceRoot,'b');await fs.mkdir(a,{recursive:true});await fs.mkdir(b);
 t.after(async()=>{const target=path.resolve(base);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('harness-apps-context-'));await fs.rm(target,{recursive:true,force:true});});
 const workbench={trash:{},workspaces:[{id:'w1',sessionIds:['s1']},{id:'w2',sessionIds:['s2']}],projects:{s1:{root:a},s2:{root:b}}},options={workspaceRoot},context=await resolveProjectContext({sessionId:'s1'},workbench,options),other=projectIdFor(await fs.realpath(b));
 const state={enabled:true,busy:'foreign-job',projects:[{id:context.projectId,path:'a',name:'A'},{id:other,path:'b',name:'Private B'}],containers:[{id:'ca',projectId:context.projectId},{id:'cb',projectId:other}],jobs:[{id:'ja',projectId:context.projectId},{id:'jb',projectId:other}],vault:{configured:true,clientId:'global-client'},remoteTargets:[{id:'home',name:'Home',host:'private-address',scope:{projectId:'vault-id'}}]};
 return{base,a,b,workspaceRoot,workbench,options,context,other,state};
}
test('server resolves immutable project context from exactly one session mapping and canonical directory',async t=>{
 const f=await fixture(t);assert.equal(f.context.projectId,projectIdFor(await fs.realpath(f.a)));assert(Object.isFrozen(f.context));assert.deepEqual(publicContext(f.context),{scope:'project',workspaceId:'w1',sessionId:'s1',projectId:f.context.projectId});assert.equal(Object.hasOwn(publicContext(f.context),'directory'),false);
 for(const input of [{},{sessionId:'missing'},{sessionId:'s1',workspaceId:'w2'},{sessionId:'s1',root:f.b},{sessionId:'s1',projectId:f.other},{scope:'global',sessionId:'s1'}])await assert.rejects(resolveProjectContext(input,f.workbench,f.options));
 f.workbench.workspaces[1].sessionIds.push('s1');await assert.rejects(resolveProjectContext({sessionId:'s1'},f.workbench,f.options),e=>e.code==='PROJECT_CONTEXT_UNAVAILABLE');
});
test('project state omits other projects, containers, logs and administrative references',async t=>{
 const f=await fixture(t),state=scopedAppsState(f.state,f.context);assert.deepEqual(state.projects.map(p=>p.name),['A']);assert.deepEqual(state.containers.map(c=>c.id),['ca']);assert.deepEqual(state.jobs.map(j=>j.id),['ja']);assert.equal(state.busy,true);assert.deepEqual(state.vault,{configured:true});assert.deepEqual(state.remoteTargets,[{id:'home',name:'Home'}]);assert.doesNotMatch(JSON.stringify(state),/Private B|foreign-job|global-client|private-address|vault-id/);
 f.state.projects[0].path='b';assert.throws(()=>scopedAppsState(f.state,f.context),e=>e.code==='PROJECT_CONTEXT_MISMATCH');
});
test('deployment recovery metadata is confined to the bound project and never reveals another transaction',async t=>{
 const f=await fixture(t);f.state.deploymentRecovery={version:1,required:true,projects:[f.other],transactions:[{projectId:f.other,releaseId:'PRIVATE_OTHER_RELEASE',phase:'recovery_required'}]};const scoped=scopedAppsState(f.state,f.context);assert.equal(scoped.deploymentRecovery.required,true,'controller-wide scheduling constraint contains no foreign identity');assert.deepEqual(scoped.deploymentRecovery.transactions,[]);assert.doesNotMatch(JSON.stringify(scoped),/PRIVATE_OTHER_RELEASE/);
 f.state.deploymentRecovery.projects.push(f.context.projectId);assert.equal(scopedAppsState(f.state,f.context).deploymentRecovery.required,true);
});
test('all project, release, credential, container, export and log routes reject another project target',async t=>{
 const f=await fixture(t);for(const[route,method,good,bad]of [['/project-action','POST',f.context.projectId,f.other],['/project-settings','POST',f.context.projectId,f.other],['/releases','GET',f.context.projectId,f.other],['/release','GET',f.context.projectId,f.other],['/container-action','POST','ca','cb'],['/container-log','GET','ca','cb'],['/job-log','GET','ja','jb'],['/export-download','GET','ja','jb']]){
  await authorizeAppsOperation(route,method,{id:good},f.context,f.state);await assert.rejects(authorizeAppsOperation(route,method,{id:bad},f.context,f.state),e=>e.status===403);
 }
 await assert.rejects(authorizeAppsOperation('/project-action','GET',{id:f.context.projectId},f.context,f.state),e=>e.status===405);
 await assert.rejects(authorizeAppsOperation('/project-action','POST',{id:f.context.projectId,sessionId:'s2'},f.context,f.state),e=>e.code==='PROJECT_CONTEXT_MISMATCH');
});
test('scaffold/register use the current canonical project, including symlink and parent-path refusal',async t=>{
 const f=await fixture(t);await fs.symlink(f.b,path.join(f.a,'redirect'),process.platform==='win32'?'junction':'dir');
 for(const route of ['/scaffold','/register']){
  await authorizeAppsOperation(route,'POST',{path:'a'},f.context,f.state);await authorizeAppsOperation(route,'POST',{},f.context,f.state);
  for(const value of ['b','a/redirect','../projects/b',f.b])await assert.rejects(authorizeAppsOperation(route,'POST',{path:value},f.context,f.state));
 }
 const outside=path.join(f.base,'outside');await fs.mkdir(outside);f.workbench.projects.s1.root=outside;await assert.rejects(resolveProjectContext({sessionId:'s1'},f.workbench,f.options),e=>e.code==='PROJECT_OUTSIDE_WORKSPACE');
});
test('global administration is explicit, rejects session ambiguity, and requires mutation confirmation',async t=>{
 const f=await fixture(t),global=await resolveProjectContext({scope:'global'},null,f.options);assert.equal(scopedAppsState(f.state,global).projects.length,2);
 for(const route of ['/vault-config','/target-settings','/worker-action','/hold','/preview-settings']){
  await assert.rejects(authorizeAppsOperation(route,'POST',{},f.context,f.state),e=>e.code==='GLOBAL_SCOPE_REQUIRED');
  await assert.rejects(authorizeAppsOperation(route,'POST',{scope:'global'},global,f.state),e=>e.code==='GLOBAL_CONFIRMATION_REQUIRED');
  await authorizeAppsOperation(route,'POST',{scope:'global',confirmGlobal:true},global,f.state);
 }
 f.workbench.trash.s1={at:1};await assert.rejects(resolveProjectContext({sessionId:'s1'},f.workbench,f.options),e=>e.code==='PROJECT_ARCHIVED');
});
test('gateway forwards only server-derived binding and preserves nested vault scope',async t=>{
 const f=await fixture(t),calls=[];let nativeReads=0;
 const gateway=createAppsContextGateway({workspaceRoot:f.workspaceRoot,loadWorkbench:async()=>{nativeReads++;return f.workbench;},callApps:async(route,payload)=>{calls.push({route,payload});return route==='/state'?f.state:{saved:true};}});
 const scope={projectId:'vault-project-id',environment:'prod',secretPath:'/app'};
 const result=await gateway({route:'/project-settings',method:'POST',payload:{sessionId:'s1',id:f.context.projectId,scope,runtime:{NAME:'KEY'}}});
 assert.deepEqual(calls[1],{route:'/project-settings',payload:{id:f.context.projectId,scope,runtime:{NAME:'KEY'},_contextProjectId:f.context.projectId}});assert.deepEqual(result.value.context,publicContext(f.context));assert.equal(Object.hasOwn(result.value.context,'directory'),false);
 await assert.rejects(gateway({route:'/scaffold',method:'POST',payload:{sessionId:'s1',path:'b'}}));assert.equal(calls.filter(c=>c.route==='/scaffold').length,0);
 const download=await gateway({route:'/export-download',method:'GET',query:new URLSearchParams({sessionId:'s1',id:'ja'})});assert.equal(download.exportId,'ja');assert.equal(download.context.projectId,f.context.projectId);
 await assert.rejects(gateway({route:'/job-log',method:'GET',query:new URLSearchParams({sessionId:'s1',id:'jb'})}));assert.equal(calls.filter(c=>c.route.startsWith('/job-log')).length,0);
 const beforeGlobal=nativeReads;await gateway({route:'/worker-action',method:'POST',query:new URLSearchParams({scope:'global'}),payload:{confirmGlobal:true,action:'wake'}});assert.equal(nativeReads,beforeGlobal);assert.deepEqual(calls.at(-1),{route:'/worker-action',payload:{action:'wake'}});
});
