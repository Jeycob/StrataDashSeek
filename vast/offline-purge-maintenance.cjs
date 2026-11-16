'use strict';
// Stable bootstrap hook. Called with no Native supervisor alive, never by Apps
// maintenance or the minute cache timer. Install alongside runtime-launcher in
// the explicit operator bootstrap upgrade; an old rollback release cannot skip it.
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const runtime=require('./runtime-paths.cjs');
const fault=code=>Object.assign(Error(code),{code});
function trustedSDK(directory){
 runtime.directoryTree(directory);const real=fs.realpathSync(directory),pending=[real],seen=new Set();
 while(pending.length){const dir=pending.pop();if(seen.has(dir))continue;seen.add(dir);runtime.directoryTree(dir);
  for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),s=fs.lstatSync(file);if(s.isSymbolicLink()){const target=fs.realpathSync(file);if(target!==real&&!target.startsWith(real+path.sep))throw fault('PURGE_SDK_LINK_ESCAPE');const st=fs.statSync(target);if(st.isDirectory())pending.push(target);else runtime.trustedFile(target);}
   else if(s.isDirectory())pending.push(file);else runtime.trustedFile(file);
  }
 }
}
async function beforeNativeStart({root,uid,broker,assertNoAgentProcesses,inheritedLease,mode='boot'}){
 const control=runtime.control(root),config=runtime.readPrivate(root,'offline-purge-config.json');
 const journalFile=path.join(control.privateState,'offline-purge-journal.json');
 const journalExists=runtime.trustedFile(journalFile,{optional:true});
 if(!config&&!journalExists)return {status:'not-configured'};
 if(!config||config.version!==1||!config.engineCommit?.match(/^[a-f0-9]{40}$/)||config.sdkVersion!=='0.2.2-rc.2'||config.backend!=='json'||config.domainRoutes?.workspace!=='json'||config.domainRoutes?.session_projcache!=='json'||config.domainRoutes?.schedule!=='json'||Object.keys(config.domainRoutes).length!==3)throw fault('PURGE_CONFIGURATION_UNSUPPORTED');
 if(!Array.isArray(config.protectedIds)||!config.protectedIds.length||config.protectedIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))||!Array.isArray(config.protectedWorkspaceIds)||!Array.isArray(config.protectedPaths))throw fault('PURGE_PRIVATE_PROTECTION_POLICY_REQUIRED');
 if(config.historicalWorkspaceBackupHash!=null&&!/^[a-f0-9]{64}$/.test(config.historicalWorkspaceBackupHash))throw fault('PURGE_BACKUP_CLASSIFICATION_INVALID');
 if(mode==='boot'&&!config.applyPlanHash&&!journalExists)return {status:'no-apply-request'};
 for(const file of [config.graphFile,config.planFile]){if(typeof file!=='string'||path.dirname(file)!==control.privateState)throw fault('PURGE_PRIVATE_INPUT_REQUIRED');runtime.trustedFile(file,{optional:file===config.planFile&&(mode==='plan'||mode==='recover'||journalExists)});}
 await broker.closeAdmission();const epoch=broker.state.epoch;inheritedLease(root);assertNoAgentProcesses(uid);
 const rootLock=fs.fstatSync(9),guard=async()=>{
  if(broker.state.open!==false||broker.state.epoch!==epoch)throw fault('PURGE_ADMISSION_CHANGED');
  const held=fs.fstatSync(9);if(held.dev!==rootLock.dev||held.ino!==rootLock.ino)throw fault('PURGE_ROOT_LEASE_CHANGED');assertNoAgentProcesses(uid);
 };
 // The signed executor remains pinned across a UI rollback; recovery cannot
 // accidentally run the older release's absent or different purge code.
 const releaseRoot=path.join(root,'releases',config.engineCommit);if(fs.realpathSync(releaseRoot)!==releaseRoot)throw fault('PURGE_RELEASE_UNTRUSTED');
 require('./runtime-release.cjs').verifySync(root,path.basename(releaseRoot));
 const moduleRoot=path.join(releaseRoot,'workspace');for(const name of ['offline-purge.mjs','offline-purge-sdk.mjs'])runtime.trustedFile(path.join(moduleRoot,name));
 const core=await import(pathToFileURL(path.join(moduleRoot,'offline-purge.mjs')).href);
 if(mode==='boot'&&!config.applyPlanHash&&journalExists){const previous=await core.readJSON(journalFile);core.validateJournal(previous);if(previous.phase==='complete')return {status:'already-completed'};}
 // Loading an agent-writable npm bundle as root would defeat the barrier.
 trustedSDK(path.join(root,'runtime/node_modules'));
 const {createSDKAdapter}=await import(pathToFileURL(path.join(moduleRoot,'offline-purge-sdk.mjs')).href);
 const captured=await core.readJSON(config.graphFile),graph={...captured,protectedIds:[...new Set([...(captured.protectedIds||[]),...config.protectedIds])],protectedWorkspaceIds:[...new Set([...(captured.protectedWorkspaceIds||[]),...config.protectedWorkspaceIds])],protectedPaths:[...new Set([...(captured.protectedPaths||[]),...config.protectedPaths])]};
 if(graph.sessionMetadataDomains?.slice().sort().join(',')!=='schedule,session_projcache,workspace')throw fault('PURGE_METADATA_DOMAIN_CLOSURE_REQUIRED');
 const profiles=['runtime/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml','runtime/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml','home/.dsh/profiles/web/cordis.yml','home/.dsh/profiles/web/cordis.patch.yml'].map(p=>path.join(root,p));
 if(profiles.some(file=>!graph.witnesses?.some(w=>w.path===file&&w.kind==='bytes')))throw fault('PURGE_PROFILE_WITNESSES_REQUIRED');
 for(const w of graph.witnesses||[]){if(typeof w.path!=='string'||/secret|credential|vault|token|\.key/i.test(path.basename(w.path))||!profiles.includes(w.path)&&![path.join(root,'state/applications'),control.privateState].some(parent=>w.path.startsWith(parent+path.sep)))throw fault('PURGE_GRAPH_WITNESS_SCOPE');}
 const adapter=await createSDKAdapter({root,engineCommit:config.engineCommit,historicalWorkspaceBackupHash:config.historicalWorkspaceBackupHash||null});
 try{
  if(mode==='plan'){if(journalExists&&await core.pending(journalFile))throw fault('PURGE_RECOVERY_REQUIRED');const plan=await core.plan({adapter,graph,guard});runtime.atomic(config.planFile,plan);return {status:'planned',planHash:plan.planHash,eligible:plan.rows.filter(r=>r.eligible).length,kept:plan.rows.filter(r=>!r.eligible).map(r=>({id:r.id,reasons:r.reasons})),freeBytesBefore:plan.freeBytesBefore};}
  if(journalExists&&await core.pending(journalFile)){const result=await core.apply({adapter,graph,guard,journalFile});if(result.status==='completed')runtime.writePrivate(root,'offline-purge-config.json',{...config,applyPlanHash:null});return result;}
  if(mode==='recover')return {status:'no-pending-journal'};
  if(!config.applyPlanHash)return {status:'no-apply-request'};
  if(!/^[a-f0-9]{64}$/.test(config.applyPlanHash))throw fault('PURGE_PLAN_REQUIRED');const requested=await core.readJSON(config.planFile);if(requested.planHash!==config.applyPlanHash)throw fault('PURGE_PLAN_REQUEST_CHANGED');
  if(journalExists){const complete=await core.readJSON(journalFile);if(complete.plan?.planHash!==requested.planHash)throw fault('PURGE_PREVIOUS_JOURNAL_RETAINED');}
  const result=await core.apply({adapter,graph,guard,journalFile,expectedPlanHash:requested.planHash});
  runtime.writePrivate(root,'offline-purge-config.json',{...config,applyPlanHash:null});return result;
 }finally{await adapter.close();}
}
module.exports={beforeNativeStart,trustedSDK};
if(require.main===module){const root=process.argv[3]||'/data/harness',mode=process.argv[2];if(!['plan','apply','recover'].includes(mode)){console.error('Use plan, apply or recover under the existing offline root FD9 lease.');process.exitCode=1;}
 else Promise.resolve().then(async()=>{const {assertNoAgentProcesses,inheritedLease}=require('./runtime-launcher.cjs'),uid=runtime.identity().uid;
  const state=runtime.readPrivate(root,'runtime-admission-controller.json');if(!state||state.open!==false)throw fault('PURGE_ADMISSION_NOT_CLOSED');
  const broker={state,async closeAdmission(){const fresh=runtime.readPrivate(root,'runtime-admission-controller.json');if(fresh.open!==false||fresh.epoch!==state.epoch)throw fault('PURGE_ADMISSION_CHANGED');}};
  console.log(JSON.stringify(await beforeNativeStart({root,uid,broker,assertNoAgentProcesses,inheritedLease,mode})));}).catch(e=>{console.error(e.code||'PURGE_MAINTENANCE_REFUSED');process.exitCode=1;});
}
