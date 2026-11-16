'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),{pathToFileURL}=require('node:url');
let modules;
function sdk(){return modules??=(async()=>{
 const cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js'),base=path.resolve(path.dirname(cli),'../..'),load=name=>import(pathToFileURL(path.join(base,name,'lib/index.js')));
 const [cordis,prompt,tools,pipeline,scope,jobs,jobTools,adapter]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),import(pathToFileURL(path.join(base,'dsh-tools/lib/pipeline.js'))),load('dsh-scope'),load('dsh-jobs-local'),load('dsh-tool-jobs'),import('./project-apps-tools.mjs')]);
 return{...cordis,SystemPrompt:prompt.default,Tools:tools.default,...pipeline,...scope,LocalJobs:jobs.default,applyJobTools:jobTools.apply,...adapter};
})();}
async function eventually(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('bounded wait');}
async function fixture(t,{jobs=true,passed=true,hold=false,authorityFailure=false}={}){
 const S=await sdk(),ctx=new S.Context();new S.SystemPrompt(ctx,{});new S.Tools(ctx);
 const agents=new Map(),scopes=[],calls=[],epochs=[];let inEpoch=false,polls=0;
 const workspaceRoot=path.resolve('synthetic-apps-workspaces'),root=path.join(workspaceRoot,'owner'),projectId=crypto.createHash('sha256').update(root).digest('hex').slice(0,16),appsId='a'.repeat(16);
 ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});ctx.provide('sandboxPolicy',{resolve:({session})=>({mode:session.mode??'workspace-write'})});
 const manager={data:{sessions:{},trash:{}},ownerAgent:a=>a?.owner??a,async withProjectRuntimeAuthority(input,action){epochs.push(input);if(authorityFailure)throw Error('AUTHORITY_PRIVATE_PATH');assert(!inEpoch);inEpoch=true;try{return await action('PRIVATE_TOKEN');}finally{inEpoch=false;}}};
 if(jobs){new S.LocalJobs(ctx,{maxConcurrentJobsPerOwner:4,retainBytes:65536,settledRetainBytes:16000,pumpPollMs:2});S.applyJobTools(ctx,{completionDelivery:'quiet',waitTimeoutMs:100,maxWaitTimeoutMs:1000,inlineOutputBytes:4096});}
 const callApps=async(route,data,config)=>{
  assert(inEpoch,'every HTTP request is inside fresh authority epoch');assert.equal(config.timeoutMs,8000);assert(config.signal);calls.push({route,data});
  assert(!JSON.stringify({route,data}).includes('PRIVATE_TOKEN'));
  if(route==='/register')return{id:projectId,name:'own',PRIVATE_SECRET:'drop'};
  if(route==='/project-action')return{id:appsId,projectId,status:'queued',environment:{SECRET:'drop'}};
  const u=new URL(route,'http://local');assert.equal(u.searchParams.get('_contextProjectId'),projectId);
  if(u.pathname==='/state')return{enabled:true,available:true,busy:false,vault:{SECRET:'drop'},projects:[{id:projectId,name:'own',applicationUrl:'https://preview.example/?appPort=18080',environment:{SECRET:'drop'}},{id:'b'.repeat(16),name:'FOREIGN_PROJECT_SECRET'}],jobs:[{id:appsId,projectId,action:'verify',status:'passed'},{id:'c'.repeat(16),projectId:'b'.repeat(16),action:'verify',status:'passed',error:'FOREIGN_JOB_SECRET'}]};
  if(u.pathname==='/job-status'){assert.equal(u.searchParams.get('id'),appsId);polls++;const status=hold||polls<2?'running':passed?'passed':'failed';return{version:1,job:{id:appsId,action:'verify',status,terminal:!['running'].includes(status),passed:status==='passed',PRIVATE_SECRET:'drop'}};}
  if(u.pathname==='/job-log'){assert.equal(u.searchParams.get('id'),appsId);return{text:'synthetic build error\n'.repeat(2000)};}
  assert.fail('unexpected route '+route);
 };
 const module=S.createProjectAppsTools(ctx,manager,{callApps,appsConfig:{workspaceRoot,keyFile:'PRIVATE_KEY_PATH'},pollMs:10,monitorMs:1000});
 const pipeline=new S.ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>S.executeToolBatch(input,pipeline,()=>1)});
 function agent(id,{owner,mode}={}){const a={id,owner,status:'idle',inbox:{nextStep:[],remove(){}},session:{id,mode,header:{createdAt:2000},append(){}},inject(){},followup(){}};const scope=S.createScope(ctx,a);a.ctx=scope.ctx;scopes.push(scope);agents.set(id,a);if(!owner)manager.data.sessions[id]={root};return a;}
 async function call(agent,args={operation:'status'},name='project_apps',signal=new AbortController().signal){const toolSet=await ctx.tools.resolve({agent,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal});try{const result=await ctx.tools.execute({agent,signal,toolSet,calls:[{id:'apps-call',name,arguments:JSON.stringify(args)}]});return result.results[0].result;}finally{toolSet.dispose();}}
 t.after(async()=>{await module.dispose();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();});
 return{...S,ctx,manager,module,agent,call,calls,epochs,projectId,appsId,root};
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
 const output=await f.call(child,{job_id:id},'job_output');assert.equal(output.isError,false,JSON.stringify(output));assert.match(JSON.stringify(output),/https:\/\/preview.example/);assert(!/PRIVATE|FOREIGN/.test(JSON.stringify(output)));
 assert.deepEqual(f.calls.slice(0,2).map(c=>c.route),['/register','/project-action']);assert.equal(f.calls[1].data.action,'verify');assert.equal(f.calls[1].data.id,f.projectId);
});
test('SDK monitor kill never issues deployment stop/power actions and Apps status remains recoverable',async t=>{
 const f=await fixture(t,{hold:true}),a=f.agent('owner');const result=await f.call(a,{operation:'verify_deploy'}),id=result.value.sdkJobId;
 await eventually(()=>f.calls.some(c=>c.route.startsWith('/job-status')));
 const killed=await f.call(a,{job_id:id},'job_kill');assert.equal(killed.isError,false,JSON.stringify(killed));await eventually(()=>f.ctx.jobs.get(id,a.id).status==='killed');
 assert(f.calls.every(c=>!c.route.includes('stop')&&!c.route.includes('worker-action')));
 const state=await f.call(a,{operation:'status'});assert.equal(state.isError,false);assert.equal(state.value.jobs[0].id,f.appsId);
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
