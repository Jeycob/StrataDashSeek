'use strict';
const {hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {jobRequest,requestStatus,enqueueProjectAction}=require('./apps-project-request.cjs');
const id='a'.repeat(16),requestId='b'.repeat(32),jobId='c'.repeat(16);
function fixture(){let enqueues=0;const manager={execution:hostExecutionBinding(),store:{jobs:[]},enqueue(projectId,action,options){enqueues++;const job={id:jobId,projectId,action,status:'queued',startedAt:10,...jobRequest(options,projectId,action)};this.store.jobs.push(job);return job;}};return{manager,count:()=>enqueues,data:{id,action:'verify',_contextProjectId:id,requestId}};}
test('lost response lookup and identical retry return one durable existing job',()=>{
 const f=fixture(),job=enqueueProjectAction(f.manager,f.data);assert.equal(f.count(),1);assert.equal(job.requestId,requestId);
 f.manager.store=JSON.parse(JSON.stringify(f.manager.store));
 assert.equal(requestStatus(f.manager,id,requestId).job.id,jobId);assert.equal(enqueueProjectAction(f.manager,f.data).id,jobId);assert.equal(f.count(),1);
 f.manager.store.jobs[0].status='passed';assert.equal(requestStatus(f.manager,id,requestId).job.passed,true);
 assert.equal(requestStatus(f.manager,id,'d'.repeat(32)).state,'unknown');
});
test('scope conflicts, non-verify request reuse and invalid request IDs never enqueue',()=>{
 const f=fixture();enqueueProjectAction(f.manager,f.data);
 for(const patch of [{id:'e'.repeat(16),_contextProjectId:'e'.repeat(16)},{action:'build'},{releaseId:'f'.repeat(16)},{requestId:'invalid'},{_contextProjectId:'e'.repeat(16)}])assert.throws(()=>enqueueProjectAction(f.manager,{...f.data,...patch}));
 assert.equal(f.count(),1);assert.throws(()=>requestStatus(f.manager,'e'.repeat(16),requestId),{code:'PROJECT_REQUEST_CONFLICT'});
 f.manager.store.jobs.push({...f.manager.store.jobs[0],id:'f'.repeat(16)});assert.throws(()=>requestStatus(f.manager,id,requestId),{code:'PROJECT_REQUEST_CONFLICT'});
});
test('receipt DTO reads full retained history and never includes job secrets',()=>{
 const f=fixture();enqueueProjectAction(f.manager,f.data);Object.assign(f.manager.store.jobs[0],{token:'PRIVATE',output:'PRIVATE',command:'PRIVATE'});
 for(let i=0;i<40;i++)f.manager.store.jobs.push({id:i.toString(16).padStart(16,'0'),projectId:'e'.repeat(16),status:'passed'});
 const response=requestStatus(f.manager,id,requestId);assert.equal(response.job.id,jobId);assert.doesNotMatch(JSON.stringify(response),/PRIVATE|command|output|token/);
 f.manager.store.jobs.shift();assert.equal(requestStatus(f.manager,id,requestId).state,'unknown');
});
test('existing workflow persists request identity in its first queued job save before background work',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'apps-request-workflow-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 class Manager{
  constructor(){this.cfg={stateDir:root,workspaceRoot:root};this.store={projects:{[id]:{id,path:'missing-fixture'}},jobs:[]};this.releases={};this.redactions=new Map();this.credentialBindings=new Map();this.saved=[];}
  requireEnabled(){}project(value){return this.store.projects[value];}acceptActivity(){}setBusy(value){this.busy=value;}save(){this.saved.push(structuredClone(this.store));}log(){}
 }
 require('./apps-workflow.cjs').install(Manager);
 const manager=new Manager(),job=enqueueProjectAction(manager,{id,action:'verify',_contextProjectId:id,requestId});
 assert.equal(job.requestId,requestId);assert.equal(manager.saved[0].jobs[0].requestId,requestId);assert.equal(manager.saved[0].jobs[0].status,'queued');
 for(let n=0;n<100&&['queued','running'].includes(job.status);n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(job.status,'failed');assert.equal(manager.busy,null);assert.equal(manager.saved.at(-1).jobs[0].status,'failed');
});
test('authenticated scoped HTTP receipt lookup survives an omitted enqueue response',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'apps-request-http-')),project=path.join(root,'project');await fs.mkdir(project);const projectId=crypto.createHash('sha256').update(await fs.realpath(project)).digest('hex').slice(0,16),f=fixture();
 Object.assign(f.manager,{cfg:{workspaceRoot:root},heartbeat(){},async tick(){},project(value){if(value!==projectId)throw Error('NO_PROJECT');return{directory:project};}});
 const {createAppsService}=require('./apps-service.cjs'),keyFile=path.join(root,'key'),service=createAppsService({keyFile},f.manager);await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{service.server.closeAllConnections();await new Promise(r=>service.server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+service.server.address().port,key=(await fs.readFile(keyFile,'utf8')).trim(),headers={'x-harness-apps-key':key,'content-type':'application/json'};
 assert.equal((await fetch(origin+'/project-request?requestId='+requestId+'&_contextProjectId='+projectId)).status,401);
 const accepted=await fetch(origin+'/project-action',{method:'POST',headers,body:JSON.stringify({...f.data,id:projectId,_contextProjectId:projectId})});assert.equal(accepted.status,202);await accepted.body.cancel();
 const result=await fetch(origin+'/project-request?requestId='+requestId+'&_contextProjectId='+projectId,{headers});assert.equal(result.status,200);assert.equal((await result.json()).job.id,jobId);
 assert.equal((await fetch(origin+'/project-request?requestId='+requestId+'&_contextProjectId='+id,{headers})).status,409);
 assert.equal(f.count(),1);
});
