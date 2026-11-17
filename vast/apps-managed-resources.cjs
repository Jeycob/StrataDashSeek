'use strict';
// Admission based on a trusted, freshly queried daemon and immutable requested
// policy. This is not a claim of independently measured guest/kernel enforcement.
const crypto=require('node:crypto');
const {LABEL}=require('./apps-engine.cjs');
const runtimeGrants=require('./apps-project-runtime-policy.cjs');
const {assertAppsExecution,checkedAppsExecution}=require('./apps-execution-mode.cjs');
const CID=/^[a-f0-9]{64}$/,TOKEN=/^[a-f0-9]{32}$/,IMAGE=/^sha256:[a-f0-9]{64}$/;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function refused(reason,field){const recommendedAction=reason==='START_RECONCILIATION_REQUIRED'?'operator-reconciliation-no-start-replay':reason.startsWith('CAPABILITY_')?'supported-managed-worker-no-application-rebuild':'operator-reconcile-requested-policy-no-adoption';return Object.assign(Error('Managed resource admission refused: '+reason+' ('+field+'); deployment remains unverified; read resourceDiagnostic'),{code:'MANAGED_RESOURCE_'+reason,status:409,resourceDiagnostic:{version:1,reason,field,recommendedAction,deploymentVerified:false,scope:'trusted-daemon-capabilities-and-requested-policy-inspect',effectiveKernelProof:'PENDING_ACTUAL_GUEST_ACCEPTANCE'}});}
function diagnosticFor(error){const d=error?.resourceDiagnostic;if(!d||error.code!=='MANAGED_RESOURCE_'+d.reason||!['CAPABILITY_UNKNOWN','CAPABILITY_UNSUPPORTED','CAPABILITY_STALE','POLICY_INVALID','POLICY_MISSING','IDENTITY_MISMATCH','RECONCILIATION_REQUIRED','INSPECT_MISMATCH','START_RECONCILIATION_REQUIRED'].includes(d.reason)||!/^[-a-zA-Z0-9_]{1,64}$/.test(d.field||''))return;const clean=refused(d.reason,d.field).resourceDiagnostic;return clean;}
function need(ok,reason,field){if(!ok)throw refused(reason,field);}
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
async function capabilities(engine){
 const started=Date.now();let info;try{info=await engine.json('GET','/info',{timeout:3000});}catch{throw refused('CAPABILITY_UNKNOWN','daemon-info');}
 need(Date.now()-started<=3500,'CAPABILITY_STALE','response');
 need(info&&typeof info.ID==='string'&&info.ID.length>0&&info.ID.length<=128&&info.OSType==='linux','CAPABILITY_UNKNOWN','daemon-identity');
 for(const key of ['MemoryLimit','SwapLimit','PidsLimit','CpuCfsQuota','CpuCfsPeriod']){need(typeof info[key]==='boolean','CAPABILITY_UNKNOWN',key);need(info[key]===true,'CAPABILITY_UNSUPPORTED',key);}
 return{daemonId:info.ID,checkedAt:Date.now(),cgroupVersion:info.CgroupVersion,cgroupDriver:info.CgroupDriver,scope:'fresh-trusted-daemon-report',effectiveKernelProof:'PENDING_ACTUAL_GUEST_ACCEPTANCE'};
}
function requested(body,imageUser,projectRuntime){
 const h=body.HostConfig||{};
 for(const key of ['Memory','MemorySwap','NanoCpus','PidsLimit'])need(Number.isSafeInteger(h[key])&&h[key]>0,'POLICY_INVALID',key);
 need(h.MemorySwap===h.Memory,'POLICY_INVALID','no-swap');
 need(h.Privileged!==true&&['Devices','DeviceRequests','Binds'].every(k=>!h[k]||h[k].length===0),'POLICY_INVALID','privileged-access');
 need(equal(h.CapDrop,['ALL'])&&equal(h.SecurityOpt,['no-new-privileges:true']),'POLICY_INVALID','capabilities-security');
 need(h.RestartPolicy?.Name==='no'&&!(h.RestartPolicy.MaximumRetryCount>0),'POLICY_INVALID','restart-policy');
 need(h.ReadonlyRootfs===undefined||typeof h.ReadonlyRootfs==='boolean','POLICY_INVALID','readonly-root');
 const network=h.NetworkMode||'default';need(['default','bridge','none'].includes(network)||/^sdsh-[a-f0-9]{16}-[a-f0-9]{16}$/.test(network)||/^container:[a-f0-9]{64}$/.test(network)||['relay','egress'].includes(projectRuntime?.kind)&&network==='host','POLICY_INVALID','network-mode');
 const capAdd=h.CapAdd||[];need(Array.isArray(capAdd)&&(capAdd.length===0||body.Labels?.[LABEL+'.role']==='data-helper'&&body.User==='0:0'&&equal([...capAdd].sort(),['CHOWN','DAC_READ_SEARCH'])),'POLICY_INVALID','added-capabilities');
 const user=body.User||imageUser||'';need(typeof user==='string'&&user.length<=128&&/^[a-zA-Z0-9_.:-]*$/.test(user),'POLICY_INVALID','user');
 const tmpfs=h.Tmpfs||{};need(typeof tmpfs==='object'&&!Array.isArray(tmpfs)&&Object.keys(tmpfs).length<=4&&Object.entries(tmpfs).every(([k,v])=>(['/tmp','/scratch'].includes(k)||projectRuntime?.kind==='executor'&&k==='/home/coder')&&typeof v==='string'&&v.length<=256&&/^[a-zA-Z0-9_=,:.-]+$/.test(v)),'POLICY_INVALID','tmpfs');
 const mounts=h.Mounts||[];need(Array.isArray(mounts)&&mounts.length<=8,'POLICY_INVALID','mounts');
 const volumes=mounts.filter(m=>{if(m.Type==='bind'){need(projectRuntime&&projectRuntime.binds.some(b=>b.target===m.Target&&b.sourceHash===runtimeGrants.pathHash(m.Source)&&b.readOnly===m.ReadOnly&&m.BindOptions?.Propagation==='rprivate'),'POLICY_INVALID','runtime-bind');return false;}return true;}).map(m=>{need(m.Type==='volume'&&typeof m.Source==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(m.Source)&&typeof m.Target==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(m.Target)&&!m.Target.split('/').includes('..')&&typeof m.ReadOnly==='boolean','POLICY_INVALID','volume');return{type:'volume',target:m.Target,sourceHash:digest(m.Source),readOnly:m.ReadOnly};}).sort((a,b)=>a.target.localeCompare(b.target));
 return{Memory:h.Memory,MemorySwap:h.MemorySwap,NanoCpus:h.NanoCpus,PidsLimit:h.PidsLimit,ReadonlyRootfs:h.ReadonlyRootfs===true,Privileged:false,CapAdd:[...capAdd].sort(),CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],RestartPolicy:{Name:'no'},NetworkMode:network,User:user,Tmpfs:structuredClone(tmpfs),volumes,...(projectRuntime?{projectRuntime}:{} )};
}
function identity(record,body){
 const labels={};for(const key of [LABEL,LABEL+'.project',LABEL+'.job',LABEL+'.create',LABEL+'.role',LABEL+'.slot',LABEL+'.release',LABEL+'.generation','com.docker.compose.service'])if(body.Labels?.[key]!==undefined){const value=body.Labels[key];need(typeof value==='string'&&value.length<=128&&/^[a-zA-Z0-9_.:-]+$/.test(value),'POLICY_INVALID','identity-label');labels[key]=value;}
 return{token:record.token,name:'/'+record.name,imageId:body.Image,labels};
}
function policyRecord(manager,token){
 need(TOKEN.test(token||'')&&Array.isArray(manager.store?.jobs),'POLICY_MISSING','journal');
 const found=[];for(const job of manager.store.jobs){need(!job.creations||Array.isArray(job.creations),'POLICY_INVALID','journal-creations');for(const record of job.creations||[])if(record.token===token)found.push(record);}
 need(found.length===1,found.length?'POLICY_INVALID':'POLICY_MISSING','journal');return found[0];
}
function readPolicy(manager,token){const record=policyRecord(manager,token),value=record.resourcePolicy;need(value?.version===1,'POLICY_MISSING','journal-policy');need(value.identity?.token===token&&value.policy&&typeof value.daemonId==='string'&&value.policyHash===record.resourcePolicyHash&&value.policyHash===digest({identity:value.identity,policy:value.policy,daemonId:value.daemonId}),'POLICY_INVALID','journal-policy');return value;}
async function prepareManagedCreate(manager,record,body,runtimeGrant){
 assertAppsExecution(manager,{isolated:Boolean(runtimeGrant)});
 // Reject malformed constraints before consulting the daemon. Resolve inherited
 // image user from its immutable image, never from a later container's settings.
 const projectRuntime=runtimeGrant?runtimeGrants.runtimePolicy(manager,body,runtimeGrant):undefined;
 requested(body,body.User||'',projectRuntime);const caps=await checkedAppsExecution(manager,()=>capabilities(manager.engine),{isolated:Boolean(runtimeGrant)});
 let image;try{image=await checkedAppsExecution(manager,()=>manager.engine.json('GET','/images/'+encodeURIComponent(body.Image)+'/json',{timeout:3000}),{isolated:Boolean(runtimeGrant)});}catch{assertAppsExecution(manager,{isolated:Boolean(runtimeGrant)});throw refused('POLICY_INVALID','immutable-image');}
 need(IMAGE.test(body.Image||'')&&image?.Id===body.Image&&typeof image.Config?.User==='string','POLICY_INVALID','immutable-image');
 if(projectRuntime)projectRuntime.environmentHash=runtimeGrants.environmentHash(image.Config.Env||[],body.Env||[]);
 const value={version:1,identity:identity(record,body),policy:requested(body,image.Config.User,projectRuntime),daemonId:caps.daemonId,createdAt:Date.now(),capabilityObservation:caps};value.policyHash=digest({identity:value.identity,policy:value.policy,daemonId:value.daemonId});
 need(!record.resourcePolicy,'RECONCILIATION_REQUIRED','existing-policy');record.resourcePolicy=value;record.resourcePolicyHash=value.policyHash;await manager.save();assertAppsExecution(manager,{isolated:Boolean(runtimeGrant)});if(projectRuntime)runtimeGrants.registerRuntimePolicy(manager,value.policyHash,runtimeGrant);body.Labels[LABEL+'.resource-policy']=value.policyHash;return value.policyHash;
}
async function bindManagedCreate(manager,record,id){need(CID.test(id||''),'IDENTITY_MISMATCH','container-id');const value=readPolicy(manager,record.token);need(!value.containerId||value.containerId===id,'RECONCILIATION_REQUIRED','container-id');value.containerId=id;await manager.save();}
function compareInspect(value,c,caps){
 const i=value.identity,labels=c.Config?.Labels||{},h=c.HostConfig||{},r=value.policy;
 need(value.containerId===c.Id&&CID.test(c.Id||'')&&c.Image===i.imageId&&c.Name===i.name&&labels[LABEL+'.resource-policy']===value.policyHash&&Object.entries(i.labels).every(([k,v])=>labels[k]===v),'IDENTITY_MISMATCH','container');
 need(value.daemonId===caps.daemonId,'IDENTITY_MISMATCH','daemon');
 if(r.projectRuntime)need(runtimeGrants.launchHash(c.Config)===r.projectRuntime.launchHash&&runtimeGrants.environmentHash(c.Config.Env||[])===r.projectRuntime.environmentHash,'INSPECT_MISMATCH','runtime-command-environment');
 for(const key of ['Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','Privileged','NetworkMode'])need(h[key]===r[key],'INSPECT_MISMATCH',key);
 need(c.Config?.User===r.User,'INSPECT_MISMATCH','user');need(equal(h.CapDrop,r.CapDrop)&&equal(h.SecurityOpt,r.SecurityOpt),'INSPECT_MISMATCH','capabilities-security');need(h.RestartPolicy?.Name==='no'&&!(h.RestartPolicy.MaximumRetryCount>0),'INSPECT_MISMATCH','restart-policy');
 need(equal([...(h.CapAdd||[])].sort(),r.CapAdd)&&['Devices','DeviceRequests','Binds'].every(k=>!h[k]||h[k].length===0)&&!['host'].includes(h.PidMode)&&!['host'].includes(h.IpcMode)&&(!h.CgroupParent||h.CgroupParent===''),'INSPECT_MISMATCH','runtime-access');
 need(equal(h.Tmpfs||{},r.Tmpfs),'INSPECT_MISMATCH','tmpfs');need(Array.isArray(c.Mounts),'INSPECT_MISMATCH','mounts');
 const binds=c.Mounts.filter(m=>m?.Type==='bind');
 if(r.projectRuntime){need(h.CgroupnsMode==='private'&&(!h.PidMode||h.PidMode==='private')&&(!h.IpcMode||h.IpcMode==='private')&&!h.UTSMode,'INSPECT_MISMATCH','runtime-namespaces');const actual=binds.map(m=>{need(typeof m.RW==='boolean'&&typeof m.Source==='string'&&typeof m.Destination==='string','INSPECT_MISMATCH','runtime-binds');return{type:'bind',target:m.Destination,sourceHash:runtimeGrants.pathHash(m.Source),readOnly:m.RW===false,propagation:m.Propagation};});need(equal(actual.sort((a,b)=>a.target.localeCompare(b.target)),[...r.projectRuntime.binds].sort((a,b)=>a.target.localeCompare(b.target))),'INSPECT_MISMATCH','runtime-binds');}
 else need(binds.length===0,'INSPECT_MISMATCH','volume');
 const volumes=c.Mounts.filter(m=>m?.Type!=='tmpfs'&&m?.Type!=='bind').map(m=>{need(m?.Type==='volume'&&typeof m.Name==='string'&&typeof m.RW==='boolean','INSPECT_MISMATCH','volume');return{type:m.Type,target:m.Destination,sourceHash:digest(m.Name),readOnly:m.RW===false};}).sort((a,b)=>String(a.target).localeCompare(String(b.target)));need(equal(volumes,r.volumes),'INSPECT_MISMATCH','volumes');
 need(c.State&&typeof c.State.Running==='boolean'&&c.State.Paused!==true&&c.State.Restarting!==true&&c.State.Dead!==true,'INSPECT_MISMATCH','state');
}
async function validateManagedStart(manager,id){
 assertAppsExecution(manager);need(CID.test(id||''),'IDENTITY_MISMATCH','container-id');const caps=await checkedAppsExecution(manager,()=>capabilities(manager.engine));let c;try{c=await checkedAppsExecution(manager,()=>manager.engine.owned(id));}catch{assertAppsExecution(manager);throw refused('IDENTITY_MISMATCH','inspect');}need(c?.Id===id,'IDENTITY_MISMATCH','container-id');const token=c.Config?.Labels?.[LABEL+'.create'],value=readPolicy(manager,token),record=policyRecord(manager,token);need(!['pending','unknown'].includes(record.resourceStart?.state),'START_RECONCILIATION_REQUIRED','previous-start');if(value.policy.projectRuntime){assertAppsExecution(manager,{isolated:true});runtimeGrants.validateRuntimeStart(manager,value);}compareInspect(value,c,caps);return{version:1,containerId:id,token,policyHash:value.policyHash,checkedAt:Date.now(),scope:caps.scope,effectiveKernelProof:caps.effectiveKernelProof};
}
async function validateManagedStarts(manager,ids){for(const id of ids)await validateManagedStart(manager,id);}
function assertStartOutcomesKnown(manager){for(const job of manager.store.jobs)for(const record of job.creations||[])need(!['pending','unknown'].includes(record.resourceStart?.state),'START_RECONCILIATION_REQUIRED','previous-start');}
async function startManagedContainer(manager,id,options={}){
 assertStartOutcomesKnown(manager);const proof=await validateManagedStart(manager,id),record=policyRecord(manager,proof.token),isolated=Boolean(readPolicy(manager,proof.token).policy.projectRuntime);assertAppsExecution(manager,{isolated});record.resourceStart={state:'pending',at:Date.now(),containerId:id,policyHash:proof.policyHash};try{await manager.save();}catch(cause){throw Object.assign(refused('START_RECONCILIATION_REQUIRED','intent-persistence'),{cause});}
 // A closed binding before dispatch is a known rejection, not an unknown
 // in-flight start. Persist that distinction so exact owned stop can settle.
 let result,startIssued=false;try{assertAppsExecution(manager,{isolated});startIssued=true;result=await manager.engine.request('POST','/containers/'+id+'/start',options);need([204,304].includes(result?.status),'START_RECONCILIATION_REQUIRED','unexpected-start-ack');}
 catch(error){const rejected=!startIssued||[400,401,403,404,405,409].includes(error.dockerStatus);record.resourceStart.state=rejected?'rejected':'unknown';try{await manager.save();}catch(cause){record.resourceStart.state='unknown';throw Object.assign(refused('START_RECONCILIATION_REQUIRED','outcome-persistence'),{cause});}if(rejected)throw error;throw Object.assign(refused('START_RECONCILIATION_REQUIRED','start-outcome'),{cause:error});}
 record.resourceStart.state='acknowledged';try{await manager.save();}catch(cause){record.resourceStart.state='unknown';throw Object.assign(refused('START_RECONCILIATION_REQUIRED','outcome-persistence'),{cause});}return result;
}
module.exports={capabilities,prepareManagedCreate,bindManagedCreate,validateManagedStart,validateManagedStarts,startManagedContainer,assertStartOutcomesKnown,refused,diagnosticFor};
