'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
let modules;
function sdk(){return modules??=(async()=>{
 const cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js'),base=path.resolve(path.dirname(cli),'../..'),load=name=>import(pathToFileURL(path.join(base,name,'lib/index.js')));
 const [cordis,prompt,tools,pipeline,scope,jobs,jobTools,adapter]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),import(pathToFileURL(path.join(base,'dsh-tools/lib/pipeline.js'))),load('dsh-scope'),load('dsh-jobs-local'),load('dsh-tool-jobs'),import('./project-apps-tools.mjs')]);
 return{...cordis,SystemPrompt:prompt.default,Tools:tools.default,...pipeline,...scope,LocalJobs:jobs.default,applyJobTools:jobTools.apply,...adapter};
})();}
async function eventually(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('bounded wait');}
async function fixture(t,{jobs=true,passed=true,hold=false,authorityFailure=false,enqueueUncertain=false,recoverEnqueue=false,settlementFailureOnce=false,actualAdmission=false}={}){
 const S=await sdk(),ctx=new S.Context();new S.SystemPrompt(ctx,{});new S.Tools(ctx);
 const agents=new Map(),scopes=[],calls=[],epochs=[],receipts=new Map();let inEpoch=false,polls=0,retained=0,heavyBodies=0,gate,removeAdmission;
 const workspaceRoot=path.resolve('synthetic-apps-workspaces'),root=path.join(workspaceRoot,'owner'),projectId=crypto.createHash('sha256').update(root).digest('hex').slice(0,16),appsId='a'.repeat(16);
 ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});ctx.provide('sandboxPolicy',{resolve:({session})=>({mode:session.mode??'workspace-write'})});
 const manager={execution:(await import('./fixtures/execution-binding.mjs')).isolatedExecutionBinding(),data:{sessions:{},trash:{}},ownerAgent:a=>a?.owner??a,async withProjectRuntimeAuthority(input,action){epochs.push(input);if(authorityFailure)throw Error('AUTHORITY_PRIVATE_PATH');assert(!inEpoch);inEpoch=true;try{return await action('PRIVATE_TOKEN');}finally{inEpoch=false;}}};
 if(actualAdmission){const {installProjectExecutionMode}=await import('./execution-mode-service.mjs');manager.execution=installProjectExecutionMode(ctx,manager.execution);}
 if(jobs){new S.LocalJobs(ctx,{maxConcurrentJobsPerOwner:4,retainBytes:65536,settledRetainBytes:16000,pumpPollMs:2});S.applyJobTools(ctx,{completionDelivery:'quiet',waitTimeoutMs:100,maxWaitTimeoutMs:1000,inlineOutputBytes:4096});}
 const callApps=async(route,data,config)=>{
  const routePath=new URL(route,'http://local').pathname;
  assert(inEpoch||['/job-status','/project-request'].includes(routePath),'only captured exact status continuation may run outside fresh authority epoch');assert.equal(config.timeoutMs,8000);assert(config.signal);calls.push({route,data});
  assert(!JSON.stringify({route,data}).includes('PRIVATE_TOKEN'));
  if(route==='/register')return{id:projectId,name:'own',PRIVATE_SECRET:'drop'};
  if(route==='/project-action'){assert.match(data.requestId,/^[a-f0-9]{32}$/);assert(receipts.has(data.requestId),'receipt durable before POST');if(enqueueUncertain)throw Error('synthetic uncertain response');return{id:appsId,projectId,status:'queued',environment:{SECRET:'drop'}};}
  const u=new URL(route,'http://local');assert.equal(u.searchParams.get('_contextProjectId'),projectId);
  if(u.pathname==='/state')return{enabled:true,available:true,busy:hold?appsId:null,vault:{SECRET:'drop'},projects:[{id:projectId,name:'own',applicationUrl:'https://preview.example/?appPort=18080',environment:{SECRET:'drop'}},{id:'b'.repeat(16),name:'FOREIGN_PROJECT_SECRET'}],jobs:enqueueUncertain?[]:[{id:appsId,projectId,action:'verify',status:'passed'},{id:'c'.repeat(16),projectId:'b'.repeat(16),action:'verify',status:'passed',error:'FOREIGN_JOB_SECRET'}]};
  if(u.pathname==='/job-status'){assert.equal(u.searchParams.get('id'),appsId);polls++;if(settlementFailureOnce){settlementFailureOnce=false;throw Error('synthetic network interruption');}const status=hold||polls<2?'running':passed?'passed':'failed';return{version:1,job:{id:appsId,action:'verify',status,terminal:!['running'].includes(status),passed:status==='passed',workSettled:['passed','failed'].includes(status),PRIVATE_SECRET:'drop'}};}
  if(u.pathname==='/project-request')return{version:1,requestId:u.searchParams.get('requestId'),state:recoverEnqueue?'recorded':'unknown',...(recoverEnqueue?{job:{id:appsId,action:'verify',status:'running'}}:{})};
  if(u.pathname==='/job-log'){assert.equal(u.searchParams.get('id'),appsId);return{text:'synthetic build error\n'.repeat(2000)};}
  assert.fail('unexpected route '+route);
 };
 let retainHeavyToolLease=()=>{retained++;let done=false;return()=>{if(!done){done=true;retained--;}};};
 if(process.env.HOMEAI_HEAVY_LEASE_MODULE||actualAdmission){
  const lease=await import(pathToFileURL(process.env.HOMEAI_HEAVY_LEASE_MODULE??path.join(__dirname,'../efficiency/heavy-tool-lease.mjs')));retainHeavyToolLease=lease.retainHeavyToolLease;
  if(actualAdmission){
   const {FairGate,heavyTool}=await import('../efficiency/gate.mjs'),{checkWorkspaceHeavyAdmission}=await import('../efficiency/heavy-admission.mjs');gate=new FairGate();
   ctx.on('tools/execute',async(exec,next)=>{if(!heavyTool(exec))return next();await checkWorkspaceHeavyAdmission(ctx,exec);const permit=await gate.acquire({rootId:exec.agent.id,signal:exec.signal});let release;try{await checkWorkspaceHeavyAdmission(ctx,exec);retained++;release=lease.bindHeavyToolLease(exec,{release(){retained--;permit.release();}});return await next();}finally{if(release)release();else permit.release();}},{global:true});
  }else ctx.on('tools/execute',async(exec,next)=>{if(exec.name!=='project_apps'||exec.arguments.operation!=='verify_deploy')return next();retained++;const release=lease.bindHeavyToolLease(exec,{release(){retained--;}});try{return await next();}finally{release();}},{global:true});
 }
 const module=S.createProjectAppsTools(ctx,manager,{callApps,appsConfig:{enabled:true,vm:{enabled:true},projectRuntime:{enabled:true},workspaceRoot,keyFile:'PRIVATE_KEY_PATH'},receiptStore:{async list(){return[...receipts.values()].map(r=>({...r}));},async save(row){receipts.set(row.requestId,{...row});},async remove(id){receipts.delete(id);}},retainHeavyToolLease,pollMs:10,monitorMs:1000});
 if(actualAdmission){const definition={name:'project_exec',description:'Synthetic next-project heavy body',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']},output:{schema:{type:'object'},render:()=>[{type:'text',text:'synthetic complete'}]},execute(){heavyBodies++;return{exitCode:0};}};ctx.tools.register(definition);removeAdmission=manager.execution.registerWorkspace({handles:execution=>module.handles(execution)||ctx.tools.get(execution.name,execution.agent,execution.toolSet)===definition,beforeHeavy:()=>module.beforeHeavy()});}
 const pipeline=new S.ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>S.executeToolBatch(input,pipeline,()=>1)});
 function agent(id,{owner,mode}={}){const a={id,owner,status:'idle',inbox:{nextStep:[],remove(){}},session:{id,mode,header:{createdAt:2000},append(){}},inject(){},followup(){}};const scope=S.createScope(ctx,a);a.ctx=scope.ctx;a.scope=scope;scopes.push(scope);agents.set(id,a);if(!owner)manager.data.sessions[id]={root};return a;}
 async function call(agent,args={operation:'status'},name='project_apps',signal=new AbortController().signal){const toolSet=await ctx.tools.resolve({agent,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal});try{const result=await ctx.tools.execute({agent,signal,toolSet,calls:[{id:'apps-call',name,arguments:JSON.stringify(args)}]});return result.results[0].result;}finally{toolSet.dispose();}}
 t.after(async()=>{hold=false;await module.dispose();removeAdmission?.();gate?.close();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();});
 return{...S,ctx,manager,module,agent,call,calls,epochs,projectId,appsId,root,receipts,setHold:value=>{hold=value;},revoke:()=>{authorityFailure=true;},async archiveAndDispose(a){manager.data.trash[a.id]=true;agents.delete(a.id);await a.scope.dispose();},retained:()=>retained,heavyBodies:()=>heavyBodies};
}
test('actual SDK status filters global Apps state and strips credentials, unrelated metadata and raw objects',async t=>{
 const f=await fixture(t),a=f.agent('owner');const result=await f.call(a);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.projectId,f.projectId);assert.equal(result.value.project.applicationUrl,'https://preview.example/?appPort=18080');assert.equal(result.value.jobs.length,1);assert(!/SECRET|PRIVATE|environment|vault|FOREIGN/.test(JSON.stringify(result)));
});
test('model cannot select path, authority, project or arbitrary CLI; child identity is preserved and readonly refuses mutations',async t=>{
 const f=await fixture(t),owner=f.agent('owner'),child=f.agent('child',{owner});
 for(const args of [{operation:'register',path:'../other'},{operation:'verify_deploy',projectId:'b'.repeat(16)},{operation:'cli',command:'wake'},{operation:'status',token:'PRIVATE'}]){const result=await f.call(child,args);assert.equal(result.isError,true);}
 assert.equal(f.calls.length,0);
 const registered=await f.call(child,{operation:'register'});assert.equal(registered.isError,false,JSON.stringify(registered));assert.equal(f.epochs[0].sessionId,'owner');assert.equal(f.epochs[0].accessSessionId,'child');assert.match(f.epochs[0].generation,/^[a-f0-9]{32}$/);
 child.session.mode='read-only';const before=f.calls.length;const readonly=await f.call(child,{operation:'register'});assert.equal(readonly.isError,true);assert.equal(f.calls.length,before);
 owner.session.mode='read-only';child.session.mode='workspace-write';const denied=await f.call(child,{operation:'verify_deploy'});assert.equal(denied.isError,true);assert.equal(f.calls.length,before);
 const log=await f.call(child,{operation:'job_log',jobId:f.appsId});assert.equal(log.isError,false,JSON.stringify(log));assert.equal(log.value.truncated,true);assert.equal(log.value.text.length,16384);
});
test('verify_deploy uses real owned SDK job lifecycle and existing register/verify/status Apps routes',async t=>{
 const f=await fixture(t),owner=f.agent('owner'),child=f.agent('child',{owner}),other=f.agent('other');
 const result=await f.call(child,{operation:'verify_deploy'});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.monitorOnly,true);
 const id=result.value.sdkJobId;assert.equal(f.ctx.jobs.get(id,child.id).owner,child.id);assert.throws(()=>f.ctx.jobs.get(id,other.id),{code:'JOB_FOREIGN_SESSION'});
 await eventually(()=>f.ctx.jobs.get(id,child.id).status==='completed');
 assert.equal(f.retained(),0);
 assert.equal(f.receipts.size,0);
 const output=await f.call(child,{job_id:id},'job_output');assert.equal(output.isError,false,JSON.stringify(output));assert.match(JSON.stringify(output),/https:\/\/preview.example/);assert(!/PRIVATE|FOREIGN/.test(JSON.stringify(output)));
 assert.deepEqual(f.calls.slice(0,2).map(c=>c.route),['/register','/project-action']);assert.equal(f.calls[1].data.action,'verify');assert.equal(f.calls[1].data.id,f.projectId);
});
test('SDK kill retains heavy admission until exact Apps terminal evidence without deployment stop/power actions',async t=>{
 const f=await fixture(t,{hold:true}),a=f.agent('owner');const result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));
 const killed=await f.call(a,{job_id:id},'job_kill');assert.equal(killed.isError,false,JSON.stringify(killed));assert.equal(f.ctx.jobs.get(id,a.id).status,'stopping');assert.equal(f.retained(),1);
 const busy=await f.call(a,{operation:'status'});assert.equal(busy.value.busy,true);assert.equal(busy.value.jobsComplete,false);
 f.setHold(false);await eventually(()=>f.ctx.jobs.get(id,a.id).status==='killed');assert.equal(f.retained(),0);
 assert(f.calls.every(c=>!c.route.includes('stop')&&!c.route.includes('worker-action')));
 const state=await f.call(a,{operation:'status'});assert.equal(state.isError,false);assert.equal(state.value.jobs[0].id,f.appsId);
});
test('uncertain enqueue retains lease despite empty incomplete last30 job view',async t=>{
 const f=await fixture(t,{enqueueUncertain:true}),a=f.agent('owner'),result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.ctx.jobs.get(id,a.id).status==='failed');assert.equal(f.retained(),1);
 const snapshot=await f.call(a,{operation:'status'});assert.deepEqual(snapshot.value.jobs,[]);assert.equal(snapshot.value.jobsComplete,false);assert.equal(snapshot.value.admissionsRequiringReconciliation[0].leaseRetained,true);assert.equal(snapshot.value.admissionsRequiringReconciliation[0].reconciliationRequired,true);
 assert.equal(f.receipts.size,1);
});
test('lost enqueue acknowledgement recovers exact existing request without a second POST',async t=>{
 const f=await fixture(t,{enqueueUncertain:true,recoverEnqueue:true}),a=f.agent('owner'),result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.ctx.jobs.get(id,a.id).status==='completed');assert.equal(f.retained(),0);assert.equal(f.receipts.size,0);assert.equal(f.calls.filter(c=>c.route==='/project-action').length,1);assert(f.calls.some(c=>c.route.startsWith('/project-request')));
});
test('revoked authority cannot enqueue but exact original status continuation retains and settles lease',async t=>{
 const f=await fixture(t,{hold:true}),a=f.agent('owner'),result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));f.revoke();assert.equal(f.retained(),1);
 const denied=await f.call(a,{operation:'register'});assert.equal(denied.isError,true);f.setHold(false);await eventually(()=>f.ctx.jobs.get(id,a.id).status==='completed');assert.equal(f.retained(),0);assert.equal(f.receipts.size,0);assert.equal(f.calls.filter(c=>c.route==='/project-action').length,1);
});
test('missing SDK registry and pre-dispatch abort do not enqueue Apps work',async t=>{
 const f=await fixture(t,{jobs:false}),a=f.agent('owner');const unavailable=await f.call(a,{operation:'verify_deploy'});assert.equal(unavailable.isError,true);assert.equal(f.calls.length,0);
 const abort=new AbortController();abort.abort();const result=await f.call(a,{operation:'register'},'project_apps',abort.signal);assert.equal(result.isError,true);assert.equal(f.calls.length,0);
});
test('failed deployment yields failed SDK job and disposal stops only monitors',async t=>{
 const f=await fixture(t,{passed:false}),a=f.agent('owner'),result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.ctx.jobs.get(id,a.id).status==='failed');const output=await f.call(a,{job_id:id},'job_output');assert.equal(output.isError,false,JSON.stringify(output));assert.match(JSON.stringify(output),/passed\\?":false/);await f.module.dispose();assert(f.calls.every(c=>!c.route.includes('/container-action')));
});
test('authority failure reveals no private exception and never reaches Apps API',async t=>{
 const f=await fixture(t,{authorityFailure:true}),a=f.agent('owner');const result=await f.call(a,{operation:'register'});
 assert.equal(result.isError,true);assert.match(JSON.stringify(result),/PROJECT_APPS_AUTHORITY_UNAVAILABLE/);assert(!JSON.stringify(result).includes('PRIVATE_PATH'));assert.equal(f.calls.length,0);
});
test('restart guard blocks orphan running/unknown receipts and clears only exact workSettled metadata',async t=>{
 const f=await fixture(t),row={ownerId:'owner',projectId:f.projectId,requestId:'d'.repeat(32),appsJobId:f.appsId,startedAt:1};f.receipts.set(row.requestId,row);
 await assert.rejects(f.module.beforeHeavy(),/PROJECT_APPS_RECONCILIATION_REQUIRED/);assert.equal(f.receipts.size,1);
 await f.module.beforeHeavy();assert.equal(f.receipts.size,0);assert(f.calls.every(c=>c.route.startsWith('/job-status')));
 f.receipts.set(row.requestId,{...row,appsJobId:null});const report=await f.module.reconcileStored();assert.equal(report.reconciliationRequired,true);assert.equal(report.pending[0].liveOwned,false);assert.equal(f.receipts.size,1);
});
test('restart guard skips currently owned retained receipts so normal heavy queue retains authority',async t=>{
 const f=await fixture(t,{hold:true}),a=f.agent('owner'),result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));const report=await f.module.reconcileStored();assert.equal(report.reconciliationRequired,false);assert.equal(report.pending[0].liveOwned,true);assert.equal(f.retained(),1);
 f.setHold(false);await eventually(()=>f.ctx.jobs.get(id,a.id).status==='completed');assert.equal(f.retained(),0);
});
test('ordinary status reconciles a failed monitor and releases only known settled original job',async t=>{
 const f=await fixture(t,{settlementFailureOnce:true}),a=f.agent('owner'),result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.ctx.jobs.get(id,a.id).status==='failed');assert.equal(f.retained(),1);assert.equal(f.receipts.size,1);
 const status=await f.call(a,{operation:'status'});assert.equal(status.isError,false,JSON.stringify(status));assert.equal(f.retained(),0);assert.equal(f.receipts.size,0);assert.equal(status.value.admissionsRequiringReconciliation.length,0);assert.equal(f.calls.filter(c=>c.route==='/project-action').length,1);
});
test('another owner heavy admission recovers archived/disposed failed monitor lease with captured status only',async t=>{
 const f=await fixture(t,{settlementFailureOnce:true,actualAdmission:true}),old=f.agent('old-owner'),next=f.agent('next-owner');const result=await f.call(old,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.ctx.jobs.get(id,old.id).status==='failed');assert.equal(f.retained(),1);await f.archiveAndDispose(old);f.revoke();
 const before=f.calls.length,epochs=f.epochs.length;const heavy=await f.call(next,{command:'npm test'},'project_exec');assert.equal(heavy.isError,false,JSON.stringify(heavy));assert.equal(f.heavyBodies(),1);assert.equal(f.retained(),0);assert.equal(f.receipts.size,0);assert.equal(f.epochs.length,epochs);assert(f.calls.slice(before).every(c=>c.route.startsWith('/job-status')&&!c.data));assert.equal(f.calls.filter(c=>c.route==='/project-action').length,1);
});
test('another owner heavy admission refuses unknown archived failed monitor while retaining original lease',async t=>{
 const f=await fixture(t,{enqueueUncertain:true,actualAdmission:true}),old=f.agent('old-owner'),next=f.agent('next-owner');const result=await f.call(old,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.ctx.jobs.get(id,old.id).status==='failed');await f.archiveAndDispose(old);f.revoke();const before=f.calls.length;
 const denied=await f.call(next,{command:'npm test'},'project_exec');assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/PROJECT_APPS_RECONCILIATION_REQUIRED/);assert.equal(f.retained(),1);assert.equal(f.heavyBodies(),0);assert.equal(f.receipts.size,1);assert(f.calls.slice(before).every(c=>c.route.startsWith('/project-request')&&!c.data));
});
test('another owner before-heavy skips active monitor and queues on original live lease until settlement',async t=>{
 const f=await fixture(t,{hold:true,actualAdmission:true}),old=f.agent('old-owner'),next=f.agent('next-owner');const result=await f.call(old,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));const report=await f.module.reconcileStored();assert.equal(report.checked,0);assert.equal(report.pending[0].liveOwned,true);
 let finished=false;const queued=f.call(next,{command:'npm test'},'project_exec').then(r=>{finished=true;return r;});await new Promise(r=>setImmediate(r));assert.equal(finished,false);assert.equal(f.retained(),1);assert.equal(f.heavyBodies(),0);
 f.setHold(false);assert.equal((await queued).isError,false);await eventually(()=>f.ctx.jobs.get(id,old.id).status==='completed');assert.equal(f.heavyBodies(),1);assert.equal(f.retained(),0);
});
