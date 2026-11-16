import path from 'node:path';
import crypto from 'node:crypto';
import { createAppsLifetime } from './project-apps-lifetime.mjs';
const HEX=/^[a-f0-9]{16}$/;
const statuses=new Set(['queued','running','passed','failed','interrupted','recovery_required']);
const actions=new Set(['verify','build','deploy','check','compose','rollback']);
const fail=code=>Object.assign(Error(code),{code});
const text=value=>typeof value==='string'?value.slice(0,160):null;
function url(value){try{if(typeof value!=='string'||value.length>2048)return null;const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash&&[...u.searchParams.keys()].every(k=>k==='appPort')?u.href:null;}catch{return null;}}
function projectView(p){return p?{id:p.id,name:text(p.name),applicationUrl:url(p.applicationUrl),releaseId:HEX.test(p.releaseId??'')?p.releaseId:null}:null;}
function jobView(job){
 if(!job||!HEX.test(job.id??'')||!statuses.has(job.status))throw fail('PROJECT_APPS_JOB_INVALID');
 return{id:job.id,action:actions.has(job.action)?job.action:'unknown',status:job.status,terminal:!['queued','running'].includes(job.status),passed:job.status==='passed'&&!job.recoveryRequired,recoveryRequired:job.status==='recovery_required'||job.recoveryRequired===true,workSettled:job.workSettled===true&&['passed','failed'].includes(job.status)&&!job.recoveryRequired};
}
export const projectAppsParameters={type:'object',properties:{operation:{type:'string',enum:['register','verify_deploy','status','job_status','job_log']},jobId:{type:'string',pattern:'^[a-f0-9]{16}$'}},required:['operation'],additionalProperties:false};

// Trusted Native module only. callApps retains credentials on the host; nothing
// is mounted into the guest or accepted as model-selected transport/authority.
export function createProjectAppsTools(ctx,manager,{callApps,appsConfig,retainHeavyToolLease,receiptStore,pollMs=1500,monitorMs=600000}={}){
 if(!Number.isInteger(pollMs)||pollMs<10||pollMs>5000||!Number.isInteger(monitorMs)||monitorMs<100||monitorMs>600000)throw fail('PROJECT_APPS_CONFIG_INVALID');
 let disposed=false,closing=false;const active=new Set(),pending=new Map();
 function owner(execution){const a=manager.ownerAgent(execution.agent);if(!a?.id||!execution.agent?.id)throw fail('PROJECT_APPS_OWNER_REQUIRED');return a;}
 function readonly(execution,a){
  for(const session of [a.session,execution.agent.session]){
   const mode=ctx.sandboxPolicy?.resolve({session})?.mode;
   if(!['read-only','workspace-write','danger-full-access'].includes(mode))throw fail('PROJECT_APPS_POLICY_UNAVAILABLE');
   if(mode==='read-only')throw fail('PROJECT_APPS_READ_ONLY');
  }
 }
 async function rpc(route,data,execution,signal,{write=false,binding}={}){
  signal.throwIfAborted();if(disposed||typeof callApps!=='function'||!appsConfig?.workspaceRoot||typeof manager.withProjectRuntimeAuthority!=='function')throw fail('PROJECT_APPS_UNAVAILABLE');
  const a=owner(execution);
  try{return await manager.withProjectRuntimeAuthority({sessionId:a.id,accessSessionId:execution.agent.id,op:'execute',kind:'executor',generation:crypto.randomBytes(16).toString('hex')},async()=>{
   signal.throwIfAborted();if(write)readonly(execution,a);
   const record=manager.data.sessions[a.id];
   if(!record||record.legacy||manager.data.trash?.[a.id]||typeof record.root!=='string'||!path.isAbsolute(record.root))throw fail('PROJECT_APPS_PROJECT_UNAVAILABLE');
   const relative=path.relative(appsConfig.workspaceRoot,record.root);
   if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw fail('PROJECT_APPS_PROJECT_UNAVAILABLE');
   const projectId=crypto.createHash('sha256').update(record.root).digest('hex').slice(0,16);
   if(binding&&binding!==projectId)throw fail('PROJECT_APPS_PROJECT_CHANGED');
   const body=route==='/register'?{path:relative,_contextProjectId:projectId}:route==='/project-action'?{id:projectId,action:'verify',requestId:data.requestId,_contextProjectId:projectId}:undefined;
   let endpoint=route;
   if(!body){const query=new URLSearchParams({_contextProjectId:projectId});if(data?.id)query.set('id',data.id);endpoint+='?'+query;}
   let response;try{response=await callApps(endpoint,body,{...appsConfig,signal,timeoutMs:8000});}catch{signal.throwIfAborted();throw fail('PROJECT_APPS_REQUEST_FAILED_CHECK_STATUS');}
   return{response,projectId};
  });}catch(error){signal.throwIfAborted();if(/^PROJECT_APPS_[A-Z_]+$/.test(error?.code??''))throw error;throw fail('PROJECT_APPS_AUTHORITY_UNAVAILABLE');}
 }
 async function state(execution,signal,binding){
  const {response,projectId}=await rpc('/state',null,execution,signal,{binding});
  if(!response||!Array.isArray(response.projects)||!Array.isArray(response.jobs))throw fail('PROJECT_APPS_STATE_INVALID');
  const project=response.projects.find(p=>p.id===projectId);
  const ownPending=[...pending.values()].filter(p=>p.ownerId===owner(execution).id&&p.projectId===projectId).map(p=>({requestId:p.requestId,...p.lifetime.snapshot()}));
  return{projectId,enabled:response.enabled===true,available:response.available===true,busy:response.busy===true||HEX.test(response.busy??''),project:projectView(project),jobs:response.jobs.filter(j=>j.projectId===projectId&&HEX.test(j.id??'')&&statuses.has(j.status)).slice(-30).map(jobView),jobsComplete:false,jobsScope:'Own rows from the last 30 global jobs only. Absence is not evidence that enqueue failed or that no operation is running.',admissionsRequiringReconciliation:ownPending};
 }
 async function status(id,execution,signal,binding){
  const {response,projectId}=await rpc('/job-status',{id},execution,signal,{binding});
  if(response?.version!==1||response.job?.id!==id)throw fail('PROJECT_APPS_JOB_INVALID');
  return{projectId,job:jobView(response.job)};
 }
 async function storedSettlement(record,signal){
  // Private read-only continuation of this exact admitted request. It retains
  // no authority to enqueue, read logs or choose another project after revocation.
  const id=record.appsJobId;
  const query=new URLSearchParams({_contextProjectId:record.projectId,...(id?{id}:{requestId:record.requestId})});
  let response;try{response=await callApps((id?'/job-status':'/project-request')+'?'+query,undefined,{...appsConfig,signal,timeoutMs:8000});}catch{throw fail('PROJECT_APPS_SETTLEMENT_UNCERTAIN');}
  if(response?.version!==1)throw fail('PROJECT_APPS_SETTLEMENT_INVALID');
  if(!id){if(response.requestId!==record.requestId||response.state!=='recorded')throw fail('PROJECT_APPS_SETTLEMENT_UNCERTAIN');}
  const job=jobView(response.job);
  if(id&&job.id!==id||job.action!=='verify')throw fail('PROJECT_APPS_SETTLEMENT_INVALID');
  return job;
 }
 async function settlement(admission,signal){
  const job=await storedSettlement({...admission,appsJobId:admission.lifetime.snapshot().appsJobId},signal);
  admission.lifetime.accepted(job.id);return job;
 }
 async function reconcileStored(){
  if(typeof receiptStore?.list!=='function')throw fail('PROJECT_APPS_RECEIPTS_UNAVAILABLE');
  const rows=await receiptStore.list(),controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8000);timer.unref?.();let checked=0;
  const liveIds=new Set([...pending.values()].filter(p=>p.lifetime.snapshot().leaseRetained).map(p=>p.requestId));
  try{
   for(const row of rows){
    if(liveIds.has(row.requestId))continue;
    if(checked>=32||controller.signal.aborted)break;checked++;
    try{const job=await storedSettlement(row,controller.signal);if(job.workSettled&&job.terminal&&['passed','failed'].includes(job.status)&&!job.recoveryRequired)await receiptStore.remove(row.requestId);}catch{/* Persisted unknown/error never proves quiescence. */}
   }
  }finally{clearTimeout(timer);}
  const remaining=await receiptStore.list(),currentLiveIds=new Set([...pending.values()].filter(p=>p.lifetime.snapshot().leaseRetained).map(p=>p.requestId));
  const view=remaining.map(row=>({...row,liveOwned:currentLiveIds.has(row.requestId)}));
  return{version:1,checked,pending:view,reconciliationRequired:view.some(row=>!row.liveOwned)};
 }
 function jobs(){const value=typeof ctx.get==='function'?ctx.get('jobs'):ctx.jobs;if(!value||typeof value.start!=='function')throw fail('PROJECT_APPS_SDK_JOBS_UNAVAILABLE');return value;}
 async function deploy(execution){
  // SDK admission occurs BEFORE any Apps mutation. The existing Apps controller
  // owns the deployment itself; this SDK job observes, never adopts its PID.
  if(typeof retainHeavyToolLease!=='function')throw fail('PROJECT_APPS_HEAVY_LEASE_UNAVAILABLE');
  if(typeof receiptStore?.save!=='function'||typeof receiptStore?.remove!=='function')throw fail('PROJECT_APPS_RECEIPTS_UNAVAILABLE');
  const registry=jobs(),controller=new AbortController(),lifetime=createAppsLifetime(retainHeavyToolLease(execution));let done,id,timer,stopRequested=false,admission;
  // No Apps cancellation API exists. Once enqueue can have started, SDK kill
  // waits for exact Apps settlement instead of detaching a running heavy build.
  const cancel=()=>{stopRequested=true;if(!lifetime.snapshot().enqueueAttempted)controller.abort();};
  const entry={get id(){return id;},registry,owner:execution.agent.id,cancel,get done(){return done;}};
  const abortBeforeAck=()=>cancel();execution.signal.addEventListener('abort',abortBeforeAck,{once:true});
  try{
   execution.signal.throwIfAborted();
   id=registry.start({kind:'project_apps',owner:execution.agent.id,label:'Verify and deploy current project',toolCall:{callId:execution.callId,rootCallId:execution.rootCallId??execution.callId},outputLimitBytes:16000,
    run(handle){
     done=Promise.resolve().then(async()=>{
      let appsJobId=null;
      try{
       controller.signal.throwIfAborted();
       const registered=await rpc('/register',null,execution,controller.signal,{write:true});
       if(registered.response?.id!==registered.projectId)throw fail('PROJECT_APPS_REGISTRATION_INVALID');
       admission={ownerId:owner(execution).id,projectId:registered.projectId,requestId:crypto.randomBytes(16).toString('hex'),startedAt:Date.now(),lifetime};pending.set(id,admission);
       await receiptStore.save({ownerId:admission.ownerId,projectId:admission.projectId,requestId:admission.requestId,startedAt:admission.startedAt,appsJobId:null});
       controller.signal.throwIfAborted();lifetime.attempted();
       try{
        const accepted=await rpc('/project-action',{requestId:admission.requestId},execution,controller.signal,{write:true,binding:registered.projectId});
        if(!HEX.test(accepted.response?.id??'')||accepted.response.projectId!==registered.projectId)throw fail('PROJECT_APPS_JOB_INVALID');
        appsJobId=accepted.response.id;lifetime.accepted(appsJobId);
       }catch{const recorded=await settlement(admission,controller.signal);appsJobId=recorded.id;}
       await receiptStore.save({ownerId:admission.ownerId,projectId:admission.projectId,requestId:admission.requestId,startedAt:admission.startedAt,appsJobId});
       handle.append('Apps job '+appsJobId+' accepted. SDK cancellation cannot cancel Apps; heavy admission remains held until exact settlement.\n',{channel:'stdout'});
       let prior;
       for(;;){
        controller.signal.throwIfAborted();const current={job:await settlement(admission,controller.signal)};
        if(current.job.status!==prior){handle.append('Apps job '+appsJobId+': '+current.job.status+'\n',{channel:'stdout'});prior=current.job.status;}
        if(['interrupted','recovery_required'].includes(current.job.status)||current.job.recoveryRequired)throw fail('PROJECT_APPS_RECONCILIATION_REQUIRED');
        if(current.job.terminal&&current.job.workSettled){
         lifetime.terminal(current.job);pending.delete(id);await receiptStore.remove(admission.requestId);
         let project=null;try{project=(await state(execution,controller.signal,registered.projectId)).project;}catch{/* Revocation denies preview lookup, never changes the exact job's terminal fact. */}
         const result={appsJobId,job:current.job,project};handle.append(JSON.stringify(result)+'\n',{channel:'stdout'});
         return{status:stopRequested?'killed':current.job.passed?'completed':'failed',detail:current.job.passed?'Apps verification and deployment passed':'Apps verification did not pass',result:JSON.stringify(result)};
        }
        await new Promise((resolve,reject)=>{const onAbort=()=>{clearTimeout(wait);reject(fail('PROJECT_APPS_MONITOR_STOPPED'));};const wait=setTimeout(()=>{controller.signal.removeEventListener('abort',onAbort);resolve();},pollMs);controller.signal.addEventListener('abort',onAbort,{once:true});});
       }
      }catch{lifetime.failed();if(!lifetime.snapshot().leaseRetained)pending.delete(id);return{status:controller.signal.aborted?'killed':'failed',detail:'Apps monitoring stopped. Any uncertain heavy admission remains held; use project_apps status to reconcile, never blindly repeat deployment.',result:JSON.stringify({appsJobId,...lifetime.snapshot()})};}
      finally{if(!lifetime.snapshot().enqueueAttempted){lifetime.failed();if(admission)try{await receiptStore.remove(admission.requestId);}catch{/* A stale pre-enqueue receipt blocks startup conservatively. */}}clearTimeout(timer);active.delete(entry);}
     });
     return{done,cancel};
    },
   });
  }catch{cancel();if(done)await done;lifetime.failed();throw fail('PROJECT_APPS_SDK_ADMISSION_FAILED');}
  finally{execution.signal.removeEventListener('abort',abortBeforeAck);}
  active.add(entry);timer=setTimeout(()=>{try{registry.kill(id,execution.agent.id,'Apps monitor deadline reached; waiting for exact Apps settlement');}catch{cancel();}},monitorMs);timer.unref?.();
  if(execution.signal.aborted){cancel();await done;execution.signal.throwIfAborted();}
  return{sdkJobId:id,monitorOnly:true,note:'Use job_output/job_list for progress. Apps cannot be safely canceled here: job_kill/monitor timeout waits for the exact Apps operation to settle and retains heavy admission. On uncertain enqueue, status is incomplete and absence cannot justify retrying.'};
 }
 async function execute(args,execution){
  execution.signal.throwIfAborted();owner(execution);
  if(disposed||closing||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['operation','jobId'].includes(k))||!['register','verify_deploy','status','job_status','job_log'].includes(args.operation)||(['job_status','job_log'].includes(args.operation)?!HEX.test(args.jobId??''):args.jobId!==undefined))throw fail('PROJECT_APPS_ARGUMENT_INVALID');
  if(args.operation==='status')return state(execution,execution.signal);
  if(args.operation==='job_status')return status(args.jobId,execution,execution.signal);
  if(args.operation==='job_log'){const {response,projectId}=await rpc('/job-log',{id:args.jobId},execution,execution.signal);if(typeof response?.text!=='string')throw fail('PROJECT_APPS_LOG_INVALID');return{projectId,appsJobId:args.jobId,text:response.text.slice(-16384),truncated:response.text.length>16384};}
  if(args.operation==='register'){const result=await rpc('/register',null,execution,execution.signal,{write:true});if(result.response?.id!==result.projectId)throw fail('PROJECT_APPS_REGISTRATION_INVALID');return{projectId:result.projectId,project:projectView(result.response)};}
  readonly(execution,owner(execution));return deploy(execution);
 }
 const definition={name:'project_apps',description:'Manage the current isolated project application through the authenticated Apps controller, without guest credentials or arbitrary CLI. Prepare .harness-app.json (version:1, name, port1024..65535, testCommand, healthPath and the existing Dockerfile/Compose declaration) and real health/browser checks; register reads that manifest. verify_deploy registers and starts the existing verify-and-deploy workflow as an owned SDK monitoring job. Inspect progress using job_output/job_list; status returns this project only and its real applicationUrl. job_status/job_log take an owned Apps job ID; job_log returns bounded existing controller-redacted diagnostics. Apps cannot be canceled here: SDK kill/timeout retains admission until exact Apps settlement, or requires reconciliation after uncertainty. Status contains only own rows among the last 30 global jobs; absence never proves enqueue failed. No global power, settings, delete, export, rollback or arbitrary target operations.',parameters:projectAppsParameters,isConcurrencySafe:()=>false,output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute};
 const disposeRegistration=ctx.tools.register(definition,{when:({agent})=>{const a=manager.ownerAgent(agent),p=manager.data.sessions[a?.id];return Boolean(p&&!p.legacy);}});
 return{execute,reconcileStored,async beforeHeavy(){const report=await reconcileStored();if(report.reconciliationRequired)throw fail('PROJECT_APPS_RECONCILIATION_REQUIRED');},pendingAdmissions:()=>[...pending.values()].map(p=>({ownerId:p.ownerId,projectId:p.projectId,requestId:p.requestId,...p.lifetime.snapshot()})),async reconcilePending(execution){for(const[id,p]of pending){if(p.ownerId!==owner(execution).id)continue;const current=await settlement(p,execution.signal);if(current.terminal&&current.workSettled){p.lifetime.terminal(current);pending.delete(id);await receiptStore.remove(p.requestId);}}},async dispose(){if(disposed)return;closing=true;disposeRegistration();for(const entry of active){try{entry.registry.kill(entry.id,entry.owner,'Apps monitor disposed');}catch{entry.cancel();}}await Promise.all([...active].map(entry=>entry.done));disposed=true;}};
}
