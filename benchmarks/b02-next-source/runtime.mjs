// Root Linux implementation. Importing this file does not read/authenticate/run.
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createQualificationSeal,createRuntimeFastGuard,parseStrictWebProfile,projectDirectoryIdentity} from './runtime-guard.mjs';
import {runtimePins} from './runtime-pins.mjs';
import {b02FixtureChild} from './fixture.mjs';
import {makeRestartRequest,validateProcessRestart} from './qa-ordering.mjs';
import {frozen,validateRuntimeBindings} from './spec.mjs';
import {readActualPreviousRuns} from './prior.mjs';
export function createRuntimeSource(slot){
 const {first,sourceCommit,sourceDigest,previousSourceCommit,policySha256,previousProfileSha256,appsSha256,ownerHost,driverFolder,codeRoot,operatorCode,offlineReceipt,fixtureEvidence,frozenRoot,qaRoot,modules:pins,recordFile,operatorCommonSha256,expectedProfileSha256}=runtimePins(slot);
 const fixturePins=frozen.files.filter(x=>x.path.startsWith('fixtures/B02/'));
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validateOperatorCommon(bytes){need(Buffer.isBuffer(bytes)&&bytes.length<=131072&&createHash('sha256').update(bytes).digest('hex')===operatorCommonSha256,'ROOT_DRIVER_OPERATOR_COMMON_CHANGED');return true;}
const guard=options=>need(Number.isSafeInteger(options?.deadline)&&Date.now()<options.deadline&&!options.signal?.aborted,'ROOT_DRIVER_DEADLINE');
function validateProfileReceipt(receipt){
 need(receipt?.version===1&&receipt.fromCommit===previousSourceCommit&&receipt.targetCommit===sourceCommit&&receipt.appsConfigSha256===appsSha256&&receipt.profile?.before===previousProfileSha256&&/^[a-f0-9]{64}$/.test(receipt.profile?.after??'')&&receipt.profile.after!==receipt.profile.before&&receipt.profile.after===expectedProfileSha256,'ROOT_DRIVER_PROFILE_PIN_RECEIPT_REQUIRED');
 return receipt.profile.after; // actual protected publication receipt, never a placeholder constant
}
function validateStrictProfile(value){
 need(Array.isArray(value),'ROOT_DRIVER_PROFILE_SCHEMA');
 const rows=value.flatMap(row=>Array.isArray(row?.insert)?row.insert:[row]),stock=rows.filter(row=>row?.id==='subprocess'||row?.name==='@deepseek-ai/dsh-subprocess-local'),owned=rows.filter(row=>row?.id==='cloud-owned-range-subprocess');
 need(stock.length===1&&stock[0].disabled===true&&(!stock[0].name||stock[0].name==='@deepseek-ai/dsh-subprocess-local'),'ROOT_DRIVER_STOCK_PROVIDER_ENABLED');
 need(owned.length===1&&owned[0].disabled!==true&&owned[0].name==='file:///data/harness/releases/'+sourceCommit+'/workspace/owned-range-subprocess.mjs','ROOT_DRIVER_STRICT_PROVIDER_REQUIRED');
}

// Fixed route set. No model/browser/request input selects host, port or route.
function createOwnerReads(headers,trusted={}){
 need(headers?.Host===ownerHost&&headers.Origin==='https://'+ownerHost&&typeof headers.Cookie==='string'&&headers.Cookie.length>0&&headers.Cookie.length<=8192&&!/[^\x20-\x7e]/.test(headers.Cookie),'FIXED_OWNER_AUTH_REQUIRED');
 const request=trusted.request??http.request,now=trusted.now??Date.now;
 const routes={work:[3090,'/api/workbench'],context:[3091,'/phone/api/apps/state?sessionId='+first.sessionId],model:[3090,'/api/workbench/models?sessionId='+first.sessionId],health:[3090,'/api/workbench/health'],modelHealth:[8080,'/status'],preview:[3090,'/api/workbench/preview'],previewClose:[3090,'/api/workbench/preview'],previewRestart:[3090,'/api/workbench/preview'],archive:[3090,'/api/workspace/archiveSession'],unarchive:[3090,'/api/workspace/unarchiveSession']};
 const secrets=[headers.Cookie,...headers.Cookie.split(';').map(x=>x.slice(x.indexOf('=')+1).trim()).filter(x=>x.length>=8)];
 return async function read(kind,options){
  const route=routes[kind];need(route,'ROOT_DRIVER_ROUTE_REFUSED');
  const end=Math.min(options?.deadline??0,now()+4000),signal=options?.signal;
  need(Number.isSafeInteger(end)&&now()<end&&!signal?.aborted,'ROOT_DRIVER_DEADLINE');
  const control=['archive','unarchive'].includes(kind),method=kind==='archive'?'workspace/archiveSession':'workspace/unarchiveSession';
  const body=kind==='previewRestart'?JSON.stringify(makeRestartRequest(first,options.before,options.requestId)):['preview','previewClose'].includes(kind)?JSON.stringify({operation:kind==='preview'?'status':'close',sessionId:first.sessionId}):control?JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args:{request:{sessionId:first.sessionId,...(kind==='archive'?{stopActivity:true}:{})}}}}):'';
  return new Promise((resolve,reject)=>{
   let req,res,done=false,bytes=0;const chunks=[];
   const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){req?.destroy();res?.destroy();reject(Object.assign(Error(error),{code:error}));}else resolve(value);};
   const abort=()=>finish('ROOT_DRIVER_ABORTED'),timer=setTimeout(()=>finish('ROOT_DRIVER_HTTP_DEADLINE'),Math.max(0,end-now()));signal?.addEventListener('abort',abort,{once:true});
   try{
    need(!signal?.aborted&&now()<end,'ROOT_DRIVER_DEADLINE');
    req=request({hostname:'127.0.0.1',port:route[0],path:route[1],method:body?'POST':'GET',agent:false,headers:{...(kind==='modelHealth'?{}:headers),Accept:'application/json',...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},incoming=>{
     res=incoming;if(done){res.destroy();return;}
     if(res.statusCode!==200||res.headers?.['content-encoding']&&res.headers['content-encoding']!=='identity'){finish('ROOT_DRIVER_HTTP_REFUSED');return;}
     res.on('aborted',()=>finish('ROOT_DRIVER_HTTP_ABORTED'));res.on('error',()=>finish('ROOT_DRIVER_HTTP_FAILED'));
     res.on('data',part=>{if(done)return;bytes+=part.length;if(bytes>2*1024**2){finish('ROOT_DRIVER_RESPONSE_CAP');return;}chunks.push(Buffer.from(part));});
     res.on('end',()=>{if(done)return;try{need(!signal?.aborted&&now()<end,'ROOT_DRIVER_DEADLINE');const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));need(!secrets.some(x=>raw.includes(x)||raw.includes(JSON.stringify(x).slice(1,-1))),'ROOT_DRIVER_CREDENTIAL_ECHO');const value=JSON.parse(raw);if(control)need(value?.result?.ok===true&&Object.hasOwn(value.result,'value'),'ROOT_DRIVER_REMOTE_REFUSED');finish(null,control?value.result.value:value);}catch{finish('ROOT_DRIVER_RESPONSE_REFUSED');}});
    });req.on('error',()=>finish('ROOT_DRIVER_HTTP_FAILED'));if(done)req.destroy();else req.end(body);
   }catch{finish('ROOT_DRIVER_HTTP_FAILED');}
  });
 };
}

// Pure composition seam: tests must supply every actual effect explicitly.
function createAttester({read,metadata,target}){
 need(target?.owned===true&&['sessionId','workspaceId','projectId','projectRoot'].every(key=>typeof target[key]==='string')&&typeof read==='function'&&typeof metadata==='function','ACTUAL_ATTESTER_EFFECTS_REQUIRED');
 const first=Object.freeze(structuredClone(target)),tuple=input=>need(['sessionId','workspaceId','projectId'].every(key=>input?.[key]===first[key]),'ROOT_DRIVER_FOREIGN_TARGET');
 need(first.projectRoot==='/data/harness/workspaces/projects/'+first.sessionId,'FIXED_PROJECT_ROOT_REQUIRED');
 const sameTuple=(work,context)=>{
  need(Array.isArray(work?.workspaces)&&work.workspaces.length<=128,'ROOT_DRIVER_WORKSPACE_SCHEMA');
  const members=work.workspaces.filter(x=>Array.isArray(x.sessionIds)&&x.sessionIds.includes(first.sessionId));
  need(members.length===1&&members[0].id===first.workspaceId&&work.projects?.[first.sessionId]?.root===first.projectRoot,'ROOT_DRIVER_PROJECT_BINDING');
  need(context?.scope==='project'&&['sessionId','workspaceId','projectId'].every(k=>context[k]===first[k]),'ROOT_DRIVER_PROJECT_CONTEXT');
 };
 async function assertTarget(input){
  tuple(input);guard(input);const before=metadata(input);guard(input);
  const [work,context]=await Promise.all([read('work',input),read('context',input)]);guard(input);sameTuple(work,context?.context);
  const after=metadata(input);guard(input);need(equal(before,after),'ROOT_DRIVER_RUNTIME_CHANGED');return after;
 }
 async function attest(input){
  const before=await assertTarget(input),preview=await read('preview',input);guard(input);
  need(preview?.version===1&&preview.sessionId===first.sessionId&&['closed','opening','ready','stopping','blocked'].includes(preview.state),'ROOT_DRIVER_PROVIDER_UNCONFIRMED');
  // The actual owner route itself checks the actual provider private WeakSet.
  // Correlation is retained unchanged; frozen bindings validate exact job/call.
  const after=metadata(input);guard(input);need(equal(before,after),'ROOT_DRIVER_RUNTIME_CHANGED');
  return{version:1,sourceCommit,...Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,first[k]])),mode:'host-compat',profileSha256:after.profileSha256,ownedRangeProvider:true,preview};
 }
 return Object.freeze({assertTarget,attest,previewStatus:async input=>(await attest(input)).preview});
}

// Runs as the existing service UID only, reads just the single fixed B02 CSV and
// metadata. No project code, shell, capability, extra path or writes are used.
function inspectFixture(options){
 guard(options);const r=spawnSync('/usr/bin/setpriv',['--reuid','1001','--regid','1001','--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--',process.execPath,'--eval','('+b02FixtureChild.toString()+')();','--',first.projectRoot,JSON.stringify(fixturePins)],{timeout:Math.max(1,Math.min(3000,options.deadline-Date.now())),maxBuffer:4096,stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore','ignore'],env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
 guard(options);need(!r.error&&r.status===0&&!r.signal&&r.stdout.length<=4096,'ROOT_DRIVER_FIXTURE_READ_FAILED');return JSON.parse(r.stdout);
}
const projectIdentity=options=>projectDirectoryIdentity(first.projectRoot,options);

// One bounded service-UID profile read per qualified attempt, never per effect.
function profileChild(){
 const fs=require('node:fs'),file='/data/harness/home/.dsh/profiles/web/cordis.patch.yml',limit=262144;
 const need=value=>{if(!value)throw Error('PROFILE_READ_REFUSED');},same=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
 try{need(process.getuid()===1001&&process.getgid()===1001);let at='';const parents=[];for(const part of ['data','harness','home','.dsh','profiles','web']){at+='/'+part;const s=fs.lstatSync(at,{bigint:true});need(s.isDirectory()&&!s.isSymbolicLink()&&[0n,1001n].includes(s.uid)&&!(s.mode&0o022n)&&fs.realpathSync(at)===at);parents.push([at,s]);}
  const safe=s=>s.isFile()&&!s.isSymbolicLink()&&[0n,1001n].includes(s.uid)&&s.nlink===1n&&!(s.mode&0o022n)&&s.size>=0n&&s.size<=BigInt(limit),before=fs.lstatSync(file,{bigint:true});need(safe(before));const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const opened=fs.fstatSync(fd,{bigint:true});need(safe(opened)&&same(before,opened));const bytes=Buffer.alloc(Number(opened.size)+1);let n=0;while(n<bytes.length){const k=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!k)break;n+=k;}need(BigInt(n)===opened.size&&same(opened,fs.fstatSync(fd,{bigint:true}))&&same(opened,fs.lstatSync(file,{bigint:true})));for(const[p,s]of parents){const current=fs.lstatSync(p,{bigint:true});need(current.isDirectory()&&!current.isSymbolicLink()&&['dev','ino','uid','gid','mode'].every(key=>s[key]===current[key]));}process.stdout.write(bytes.subarray(0,n));}finally{fs.closeSync(fd);}
 }catch{process.stderr.write('PROFILE_READ_REFUSED\n');process.exitCode=1;}
}
function readQualifiedProfile(options,trusted={}){
 const now=trusted.now??Date.now,spawn=trusted.spawnSync??spawnSync;need(Number.isSafeInteger(options?.deadline)&&now()<options.deadline&&!options.signal?.aborted,'ROOT_DRIVER_DEADLINE');
 const args=['--reuid','1001','--regid','1001','--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--',process.execPath,'--eval','('+profileChild.toString()+')();'],remaining=options.deadline-now();need(remaining>0&&!options.signal?.aborted,'ROOT_DRIVER_DEADLINE');
 const result=spawn('/usr/bin/setpriv',args,{timeout:Math.min(3000,remaining),maxBuffer:266240,stdio:['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore','ignore'],env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
 need(now()<options.deadline&&!options.signal?.aborted&&!result.error&&result.status===0&&!result.signal&&Buffer.isBuffer(result.stdout)&&result.stdout.length<=262144,'BOUNDED_PROFILE_READ_FAILED');return result.stdout;
}

function createRuntimeCallbacks({o,read,attester,metadata,inspectFixture:inspect,projectIdentity:project,target},trusted={}){
 need(target?.owned===true&&['sessionId','workspaceId','projectId','projectRoot'].every(key=>typeof target[key]==='string')&&['json','projectJobs','canonical','hash'].every(key=>typeof o?.[key]==='function')&&[read,metadata,inspect,project,attester?.attest].every(value=>typeof value==='function'),'ACTUAL_RUNTIME_CALLBACKS_REQUIRED');let providerQualification,restartOperation;
 const first=Object.freeze({...structuredClone(target),modelSelection:Object.freeze({...target.modelSelection})}),tuple=input=>need(['sessionId','workspaceId','projectId'].every(key=>input?.[key]===first[key]),'ROOT_DRIVER_FOREIGN_TARGET');
 need(first.projectRoot==='/data/harness/workspaces/projects/'+first.sessionId,'FIXED_PROJECT_ROOT_REQUIRED');
 async function assertArchiveRuntime(input){
  tuple(input);guard(input);need(providerQualification,'ACTUAL_PREARCHIVE_PROVIDER_QUALIFICATION_REQUIRED');const before=metadata(input),work=await read('work',input);guard(input);
  const members=work.workspaces?.filter(w=>Array.isArray(w.sessionIds)&&w.sessionIds.includes(first.sessionId));need(members?.length===1&&members[0].id===first.workspaceId&&work.projects?.[first.sessionId]?.root===first.projectRoot,'ROOT_DRIVER_ARCHIVE_PROJECT_CHANGED');
  const currentProject=project(input),after=metadata(input);guard(input);need(equal(before,after)&&currentProject.root===first.projectRoot&&currentProject.identity===providerQualification.rootIdentity&&equal(after,providerQualification.metadata),'ROOT_DRIVER_ARCHIVE_TUPLE_CHANGED');
  const tupleSha256=o.hash(Buffer.from(o.canonical({target:first,metadata:after,rootIdentity:currentProject.identity})));
  return{...Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,first[k]])),sourceCommit,tupleSha256,mode:'host-compat',profileSha256:after.profileSha256,ownedRangeProvider:true,qualification:providerQualification.origin};
 }
 const archiveRPC=async(method,args,input)=>{tuple(input);need(args?.request?.sessionId===first.sessionId&&Object.keys(args).join(',')==='request'&&['workspace/archiveSession','workspace/unarchiveSession'].includes(method),'FIXED_ARCHIVE_RPC_REQUIRED');const archive=method==='workspace/archiveSession';need(Object.keys(args.request).sort().join(',')===(archive?'sessionId,stopActivity':'sessionId')&&(!archive||args.request.stopActivity===true),'FIXED_ARCHIVE_RPC_REQUIRED');await assertArchiveRuntime(input);guard(input);return read(archive?'archive':'unarchive',input);};
 return Object.freeze({...attester,assertArchiveRuntime,archiveRPC,
  restartPreview(input){
   tuple(input);guard(input);need(providerQualification,'ACTUAL_PROVIDER_REQUIRED');
   if(!restartOperation)restartOperation=(async()=>{await attester.assertTarget(input);const before=await read('preview',input);guard(input);const requestId=randomUUID();makeRestartRequest(first,before,requestId);const after=await read('previewRestart',{...input,before,requestId});guard(input);await attester.assertTarget(input);return validateProcessRestart({target:first,before,after,requestId});})();
   return restartOperation; // unknown stays captured; no second restart dispatch
  },previewClose:async input=>{await assertArchiveRuntime(input);guard(input);return read('previewClose',input);},
  async restoreArchiveQualification(input){
   tuple(input);guard(input);need(typeof trusted.readSavedQualification==='function'&&!providerQualification,'ACTUAL_SAVED_QUALIFICATION_READER_REQUIRED');
   const saved=await trusted.readSavedQualification(input);guard(input);const q=saved?.qualification,p=saved?.prestart,own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(key=>[key,first[key]]));
   need(q?.kind==='operator-preinference-finalizer-qualification'&&q.status==='QUALIFIED_VISIBLE'&&q.sourceCommit===sourceCommit&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(q.qualificationId??'')&&q.nativePromptsSent===0&&q.benchmarkRecordCreated===false&&q.benchmarkCheckpointUntouched===true&&Object.entries(own).every(([key,value])=>q.target?.[key]===value)&&q.fence?.status==='SETTLED_VISIBLE'&&q.fence.settled===true&&q.fence.visible===true&&q.fence.archiveState==='visible'&&q.fence.requestId===q.qualificationId&&q.fence.sourceCommit===sourceCommit&&Object.entries(own).every(([key,value])=>q.fence.target?.[key]===value),'ACTUAL_SAVED_PROVIDER_QUALIFICATION_REQUIRED');
   need(p?.status==='FRESH_FIRST_PRESTART_PASS'&&p.sourceCommit===sourceCommit&&Object.entries(own).every(([key,value])=>p[key]===value)&&p.qualificationId===q.qualificationId&&/^[a-f0-9]{64}$/.test(p.runtimeTupleSha256??'')&&p.runtimeTupleSha256===q.fence.tupleSha256,'ACTUAL_SAVED_PRESTART_TUPLE_REQUIRED');
   const before=metadata(input),currentProject=project(input),after=metadata(input);guard(input);need(equal(before,after)&&currentProject.root===first.projectRoot,'ROOT_DRIVER_RECOVERY_TUPLE_CHANGED');const tupleSha256=o.hash(Buffer.from(o.canonical({target:first,metadata:after,rootIdentity:currentProject.identity})));need(tupleSha256===p.runtimeTupleSha256,'ROOT_DRIVER_RECOVERY_TUPLE_CHANGED');
   providerQualification={metadata:after,rootIdentity:currentProject.identity,origin:'actual-protected-saved-provider-qualification-and-prestart-exact-tuple'};return{restored:true,sourceCommit,...own,tupleSha256,qualification:providerQualification.origin};
  },
  async preflight(input){
   const proof=await attester.attest({...first,...input});
   const [health,modelHealth,model]=await Promise.all([read('health',input),read('modelHealth',input),read('model',input)]);guard(input);
   need(health.sourceCommit===sourceCommit&&health.workspaceReady===true&&health.activeAgents===0&&health.admission?.enforced===true&&health.admission.activeRequests===0&&health.admission.activeTools===0&&modelHealth.busy===false&&modelHealth.queued===0,'ROOT_DRIVER_NOT_QUIET');
   need(model.version===1&&model.sessionId===first.sessionId&&model.source==='session'&&!model.selectionError&&o.canonical(model.selection)===o.canonical(first.modelSelection),'ROOT_DRIVER_MODEL_CHANGED');
   need(proof.preview.state==='closed'&&proof.preview.workSettled===true&&!o.projectJobs().some(x=>['queued','running'].includes(x.status)),'ROOT_DRIVER_PREEXISTING_WORK');
   const seed=o.json(fixtureEvidence),saved=seed.targets?.find(x=>x.sessionId===first.sessionId),actual=inspect(input);
   need(seed.phase==='TWO_FROZEN_B02_FIXTURES_PREPARED'&&saved?.workspaceId===first.workspaceId&&saved?.projectId===first.projectId&&actual.rootIdentity===saved.rootIdentity&&actual.harnessIdentity===saved.harnessIdentity&&equal(actual.files,fixturePins)&&actual.crlfCount===6&&actual.errorLine===6,'ROOT_DRIVER_FIXTURE_CHANGED');
   need(typeof trusted.readRestartQualification==='function','FRESH_RESTART_QUALIFICATION_READER_REQUIRED');
   const capability=await trusted.readRestartQualification(input);guard(input);
   need(capability?.version===1&&capability.kind==='B02_OWN_PROCESS_RESTART_CAPABILITY'&&capability.sourceCommit===sourceCommit&&capability.operatorProducerCommit===slot.qualifiedProducerCommit&&capability.sourceClosureSha256===slot.sourceClosureSha256&&capability.ownedRangeProvider===true&&capability.operation==='restart'&&capability.sdkTool==='project_preview_restart'&&['sessionId','workspaceId','projectId'].every(k=>capability.target?.[k]===first[k]),'ACTUAL_B02_RESTART_CAPABILITY_REQUIRED');
   const qualifiedMetadata=metadata(input),tupleSha256=o.hash(Buffer.from(o.canonical({target:first,metadata:qualifiedMetadata,rootIdentity:actual.rootIdentity})));
   need(capability.runtimeTupleSha256===tupleSha256&&Number.isSafeInteger(capability.qualifiedAt)&&capability.qualifiedAt<=Date.now()&&Date.now()-capability.qualifiedAt<=60000,'FRESH_RESTART_QUALIFICATION_TUPLE_REQUIRED');
   need(proof.ownedRangeProvider===true,'ACTUAL_PROVIDER_REQUIRED');providerQualification={metadata:qualifiedMetadata,rootIdentity:actual.rootIdentity,origin:'actual-prearchive-private-WeakSet-with-unchanged-source-profile-native-process-and-project'};
   return{quiet:true,mode:'host-compat',sourceCommit,runtimeCommit:sourceCommit,workspaceId:first.workspaceId,fixtureEvidence,modelSelection:first.modelSelection,modelSelectionEvidence:'fresh exact owner /api/workbench/models selection',preview:{supported:true,evidence:'fresh actual owner provider-backed closed status at startup release'},restart:{supported:true,evidence:'fresh hash-pinned Root capability qualification for exact target and actual project_preview_restart provider'}};
  },
 });
}

async function openActualRuntime({signal},trusted={}){
 validateRuntimeBindings(slot);
 need(process.platform==='linux'&&process.getuid?.()===0&&process.getgid?.()===0&&!process.env.NODE_OPTIONS&&!process.env.NODE_PATH,'ACTUAL_LINUX_ROOT_REQUIRED');
 need(fs.realpathSync(fileURLToPath(new URL('.',import.meta.url))).replace(/\/$/,'')===codeRoot+'/benchmarks/b02-next-source','ROOT_DRIVER_CODE_PLACEMENT');
 const require=createRequire(import.meta.url),commonFile=operatorCode+'/common.cjs',commonStat=fs.lstatSync(commonFile);need(commonStat.isFile()&&!commonStat.isSymbolicLink()&&commonStat.uid===0&&commonStat.gid===0&&commonStat.nlink===1&&!(commonStat.mode&0o022)&&commonStat.size<=131072&&fs.realpathSync(commonFile)===commonFile,'ROOT_DRIVER_OPERATOR_COMMON_FILE');validateOperatorCommon(fs.readFileSync(commonFile));const o=require(commonFile);o.environment();
 need(o.c.targetSourceDigest===sourceDigest&&o.pins.targetCommit===sourceCommit&&o.pins.unchanged.policySha256===policySha256&&o.pins.bootstrap12.length===12,'ROOT_DRIVER_OPERATOR_PINS');
 const options={deadline:Date.now()+10000,signal};
 const immutableFiles=[commonFile,...o.pins.bootstrap12.map(row=>'/data/harness/bootstrap/'+row.installedName),'/data/harness/root-secrets/startup-update.json','/data/harness/root-secrets/startup-update-signers.gpg','/data/harness/runtime/package-lock.json','/root/onstart.sh','/data/harness/apps-config.json',offlineReceipt,'/data/harness/root-secrets/runtime/state/runtime-admission-key.json','/data/harness/runtime-status/admission-public.pem'];
 const seal=createQualificationSeal({sourceRoot:'/data/harness/releases/'+sourceCommit,protectedFiles:immutableFiles,profileFile:'/data/harness/home/.dsh/profiles/web/cordis.patch.yml',bootstrapDirectory:'/data/harness/bootstrap'});seal.capture(options);
 const qualifiedWitness=o.witness({commit:sourceCommit});guard(options); // full signed source/bootstrap/trust ONCE, before auth
 const closureBytes=o.read(codeRoot+'/benchmarks/b02-next-source/closure.json',262144);need(o.hash(closureBytes)===slot.sourceClosureSha256,'B02_PRODUCER_CLOSURE_CHANGED');
 const closure=JSON.parse(closureBytes);need(closure.kind==='DISABLED_B02_OPERATOR_SOURCE_CLOSURE'&&closure.expectedServiceCommit===sourceCommit&&Object.keys(closure.files??{}).length<=64,'B02_PRODUCER_CLOSURE_REQUIRED');
 for(const[file,sha]of Object.entries(closure.files)){need(file.startsWith('benchmarks/')&&!file.split('/').some(p=>p==='..'||p==='.')&&/^[a-f0-9]{64}$/.test(sha)&&o.hash(o.read(codeRoot+'/'+file,2*1024**2))===sha,'B02_PRODUCER_DEPENDENCY_CHANGED');}guard(options);
 const previousRuns=readActualPreviousRuns(slot,(file,cap)=>o.read(file,cap));need(previousRuns.at(-1).settledAt<=Date.now(),'PRIOR_AFTER_CURRENT_CLOCK');guard(options); // before owner auth or any session/native RPC
 // Existing operator helper reads only its exact root-protected auth source;
 // token/cookie never enter a result, record, checkpoint or console operation.
 const headers=await o.owner();guard(options);need(headers.Host===ownerHost,'ROOT_DRIVER_OWNER_CHANGED');
 const receipt=o.json(offlineReceipt),publishedProfileSha256=validateProfileReceipt(receipt);
 const projection=o.json('/data/harness/runtime-status/project-execution.json');
 const contract=require('/data/harness/bootstrap/project-execution-mode.cjs').createExecutionModeContract();
 const binding=contract.bindForService({sourceCommit,launchId:projection.launchId});
 const yaml=createRequire('/data/harness/runtime/node_modules/@deepseek-ai/dsh/package.json')('yaml');
 const profile=readQualifiedProfile(options);need(o.hash(profile)===publishedProfileSha256&&o.hash(o.read('/data/harness/apps-config.json'))===appsSha256,'ROOT_DRIVER_PROFILE_CONFIG_CHANGED');validateStrictProfile(parseStrictWebProfile(yaml,profile));seal.assert(options);guard(options);
 const {metadata}=createRuntimeFastGuard({o,binding,seal,qualifiedWitness,target:first,sourceCommit,sourceDigest,policySha256,publishedProfileSha256});
 const read=createOwnerReads(headers),attester=createAttester({read,metadata,target:first});
 const loaded={};for(const[file,sha]of Object.entries(pins)){need(o.hash(o.read(codeRoot+'/'+file,2*1024**2))===sha,'ROOT_DRIVER_FROZEN_MODULE_CHANGED');if(file.endsWith('.mjs'))loaded[file]=await import(pathToFileURL(codeRoot+'/'+file));}
 const modules=Object.assign({},...Object.values(loaded));
 const recordBytes=o.read(codeRoot+'/'+recordFile,2*1024**2);need(o.hash(recordBytes)===slot.recordSha256,'FIXED_B02_RECORD_CHANGED');const record=JSON.parse(recordBytes);
 for(const directory of [frozenRoot,qaRoot]){need(typeof directory==='string'&&directory.startsWith('/data/harness/root-secrets/')&&fs.realpathSync(directory)===directory,'ORIGINAL_FROZEN_INPUT_LOCATION_REQUIRED');o.parents(directory+'/placeholder');}
 const inputs=modules.frozenInputs({frozenRoot,qaRoot});
 const readRestartQualification=input=>{guard(input);need(typeof slot.actualRuntimeProofFile==='string'&&/^[a-f0-9]{64}$/.test(slot.actualRuntimeProofSha256??''),'FRESH_RESTART_QUALIFICATION_PIN_REQUIRED');const bytes=o.read(slot.actualRuntimeProofFile,65536);need(o.hash(bytes)===slot.actualRuntimeProofSha256,'RESTART_QUALIFICATION_CHANGED');return JSON.parse(bytes);};
 const runtime={ownerHost,ownerCookie:headers.Cookie,WebSocket:createRequire('/data/harness/runtime/node_modules/@deepseek-ai/dsh/package.json')('ws'),...createRuntimeCallbacks({o,read,attester,metadata,inspectFixture,projectIdentity,target:first},{...trusted,readRestartQualification})};
 return{record,inputs,runtime,modules,previousRuns,protectedRead:(file,cap)=>o.read(file,cap)};
}

return Object.freeze({openActualRuntime,createOwnerReads,createAttester,createRuntimeCallbacks,validateOperatorCommon,validateProfileReceipt,validateStrictProfile,readQualifiedProfile});
}
