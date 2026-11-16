// Pinned offline adapter: official rc.2 JSON backend/schema, never raw SQL.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {directory,readJSON,atomic,tree,digest,stable,fail,inside} from './offline-purge.mjs';

export async function lockSessionDirectory(dir,sdkScope){if(process.platform!=='linux')fail('PURGE_LINUX_REQUIRED');await directory(dir);const file=path.join(dir,'session.lock'),before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)fail('PURGE_SESSION_LOCK_UNSAFE');
 const h=await fs.open(file,constants.O_RDWR|(constants.O_NOFOLLOW||0));try{const require=createRequire(path.join(sdkScope,'dsh/package.json'));const {tryLockExclusive}=await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/flock')).href);await tryLockExclusive(h.fd);
  const held=await h.stat(),current=await fs.lstat(file);if(current.isSymbolicLink()||held.dev!==current.dev||held.ino!==current.ino||current.ino!==before.ino)fail('PURGE_SESSION_LOCK_CHANGED');return {release:()=>h.close()};
 }catch(e){await h.close();throw e;}
}
async function permissions(file){const s=await fs.lstat(file);return {uid:s.uid,gid:s.gid,mode:s.mode&0o777};}
async function restorePermissions(file,owner){await directory(path.dirname(file));const h=await fs.open(file,constants.O_RDWR|(constants.O_NOFOLLOW||0));try{const s=await h.stat();if(!s.isFile()||s.nlink!==1)fail('PURGE_METADATA_UNSAFE');if(process.platform!=='win32')await h.chown(owner.uid,owner.gid);await h.chmod(owner.mode);await h.sync();}finally{await h.close();}}

export async function createSDKAdapter({root,engineCommit=null,historicalWorkspaceBackupHash=null,sdkScope=path.join(root,'runtime/node_modules/@deepseek-ai'),storageRoot=path.join(root,'home/.dsh/storages'),sessionRoot=path.join(root,'home/.dsh/sessions'),afterMetadataWrite=async()=>{}}){
 for(const dir of [root,sdkScope,storageRoot,sessionRoot])await directory(dir);
 const load=async name=>{const pkg=await readJSON(path.join(sdkScope,name,'package.json'));if(pkg.version!=='0.2.2-rc.2'&&name!=='cordis')fail('PURGE_SDK_VERSION_UNSUPPORTED');return import(pathToFileURL(path.join(sdkScope,name,'lib/index.js')).href);};
 const [{Context},persistence,{JsonStorageBackend},{descriptorOf},workspace,projection,schedule]=await Promise.all([load('cordis'),load('dsh-session-persistence-jsonl'),load('dsh-storage-json'),load('dsh-storage-domain'),load('dsh-workspace'),load('dsh-session-projection-cache'),load('dsh-schedule')]);
 const workspaceDescriptor=descriptorOf(workspace.workspaceDomainSpec),cacheDescriptor=descriptorOf(projection.projectionCacheDomainSpec);
 if(workspaceDescriptor.name!=='workspace'||workspaceDescriptor.version!==2||cacheDescriptor.name!=='session_projcache'||cacheDescriptor.version!==7||cacheDescriptor.layout!=='per-record')fail('PURGE_SDK_SCHEMA_UNSUPPORTED');
 const cacheDirectory=path.join(storageRoot,'session_projcache','sessions');await directory(cacheDirectory); // prevents legacy bootstrap writes on read
 const wbRoot=path.join(root,'state/workbench'),wbFile=path.join(wbRoot,'registry.json'),projectsRoot=path.join(root,'workspaces/projects');
 for(const dir of [wbRoot,projectsRoot])await directory(dir);
 const ctx=new Context();await persistence.apply(ctx,{root:sessionRoot,compression:'zstd',listConcurrency:1});
 const identity={sdk:'0.2.2-rc.2',backend:'json',root,storageRoot,sessionRoot,engineCommit,historicalWorkspaceBackupHash};
 const store=new JsonStorageBackend(storageRoot);let unit,cache;
 async function retainedDomains(){const references=[],hashes={};
  const allowed=new Set(['workspace.json','workspace.before-import.json','session_projcache','session_projcache.json','schedule.json']);for(const name of await fs.readdir(storageRoot))if(!allowed.has(name))fail('PURGE_STORAGE_DOMAIN_UNKNOWN');
  const scheduleFile=path.join(storageRoot,'schedule.json');try{const raw=await readJSON(scheduleFile),desc=descriptorOf(schedule.scheduleDomain);if(raw.unit?.name!=='schedule'||![1,desc.version].includes(raw.unit.version)||Object.keys(raw.tables||{}).join(',')!=='tasks')fail('PURGE_SCHEDULE_SCHEMA_UNSUPPORTED');
   const sessionIds=new Set(),paths=new Set();for(const value of Object.values(raw.tables.tasks)){const task=schedule.scheduleDomain.tables.tasks.valueSchema.parse(value);for(const id of [task.target.sessionId,...task.involvedSessionIds,task.lastDelivery?.targetSessionId,task.pendingDelivery?.targetSessionId,...task.deliveryHistory.records.map(r=>r.targetSessionId)])if(id)sessionIds.add(id);if(task.target.create?.cwd){if(!path.isAbsolute(task.target.create.cwd))fail('PURGE_SCHEDULE_PATH_UNKNOWN');paths.add(task.target.create.cwd);}}
   references.push({source:'schedule',sessionIds:[...sessionIds].sort(),paths:[...paths].sort()});hashes.schedule=digest(raw);
  }catch(e){if(e.code!=='ENOENT')throw e;hashes.schedule=null;}
  try{const backup=await readJSON(path.join(storageRoot,'workspace.before-import.json'));hashes.workspaceBackup=digest(backup);if(hashes.workspaceBackup===historicalWorkspaceBackupHash)return {references,hashes};
   if(backup.unit?.name!=='workspace'||backup.unit.version!==2||Object.keys(backup.tables||{}).join(',')!=='workspaces')fail('PURGE_WORKSPACE_BACKUP_SCHEMA_UNKNOWN');const global=workspace.workspaceDomainState.parse(backup.global),ids=new Set([...global.archivedSessionIds,...global.pinnedSessionIds]),paths=[];
   for(const row of Object.values(backup.tables.workspaces)){const w=workspace.workspaceRecord.parse(row);for(const id of w.sessionIds)ids.add(id);if(path.isAbsolute(w.path))paths.push(w.path);else if(!/^[A-Za-z]:[\\/]/.test(w.path))fail('PURGE_WORKSPACE_BACKUP_PATH_UNKNOWN');}
   references.push({source:'workspace-before-import-restore-status-unknown',sessionIds:[...ids].sort(),paths});
  }catch(e){if(e.code!=='ENOENT')throw e;hashes.workspaceBackup=null;}
  return {references,hashes};
 }
 const metadata=async()=>{await directory(storageRoot);const raw=await readJSON(path.join(storageRoot,'workspace.json'));if(Object.keys(raw.tables||{}).join(',')!=='workspaces')fail('PURGE_WORKSPACE_SCHEMA_UNSUPPORTED');if(unit)await unit.close();unit=await store.kv.open(workspaceDescriptor);
  const state=await unit.loadAll();if(stable(workspace.workspaceDomainState.parse(state.global))!==stable(state.global))fail('PURGE_WORKSPACE_SCHEMA_UNSUPPORTED');if(state.global.pendingMutation)fail('PURGE_WORKSPACE_MUTATION_PENDING');
  if(Object.keys(state.tables).join(',')!=='workspaces')fail('PURGE_WORKSPACE_SCHEMA_UNSUPPORTED');for(const row of Object.values(state.tables.workspaces))workspace.workspaceRecord.parse(row);
  // A malformed cache record may normally be ignored. Purge cannot treat an
  // unreadable/foreign record as proof of absence, so validate all documents.
  const cacheHashes={};for(const name of await fs.readdir(cacheDirectory)){const file=path.join(cacheDirectory,name),s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('PURGE_CACHE_ENTRY_UNSAFE');if(!/^[a-zA-Z0-9_-]+\.json$/.test(name))fail('PURGE_CACHE_RECOVERY_REQUIRED');const doc=await readJSON(file);if(![3,4,5,6,7].includes(doc.version)||!doc.record)fail('PURGE_CACHE_SCHEMA_UNSUPPORTED');cacheHashes[name.slice(0,-5)]=digest(doc);}
  let legacyHashes=null;try{const legacy=await readJSON(path.join(storageRoot,'session_projcache.json'));if(legacy.unit?.name!=='session_projcache'||![3,4,5,6,7].includes(legacy.unit.version)||Object.keys(legacy.tables||{}).join(',')!=='sessions')fail('PURGE_LEGACY_SCHEMA_UNSUPPORTED');legacyHashes=Object.fromEntries(Object.entries(legacy.tables.sessions).map(([k,v])=>[k,digest(v)]));}catch(e){if(e.code!=='ENOENT')throw e;}
  const wb=await readJSON(wbFile);if(wb.version!==1||!wb.sessions||!wb.trash||!wb.workspaces)fail('PURGE_WORKBENCH_SCHEMA_UNSUPPORTED');
  const owners={workspace:await permissions(path.join(storageRoot,'workspace.json')),workbench:await permissions(wbFile),legacy:legacyHashes===null?null:await permissions(path.join(storageRoot,'session_projcache.json'))};
  return {workspace:state,cacheHashes,legacyHashes,workbench:wb,owners,retained:await retainedDomains()};
 };
 const adapter={identity,projectsRoot,workbenchRoot:wbRoot,
  async inspect(){const before=await metadata(),snapshots=await ctx.sessionPersistence.list();
   const sessions=[];
   for(const s of snapshots){if(!s.location||s.location.kind!=='jsonl'||!inside(sessionRoot,s.location.path))fail('PURGE_SESSION_LOCATION_UNPROVEN');const artifactDir=path.dirname(s.location.path);await directory(artifactDir);
    const names=await fs.readdir(artifactDir);if(names.some(n=>n!=='session.lock'&&!/^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd$/.test(n)))fail('PURGE_UNKNOWN_SESSION_FILE');
    if(path.basename(artifactDir)!==s.header.id)fail('PURGE_SESSION_LOCATION_UNPROVEN');
    sessions.push({id:s.header.id,cwd:s.header.cwd,parentSession:s.header.parentSession||null,isSeeded:s.header.isSeeded,origin:s.header.origin,formatStatus:s.formatStatus,revision:s.revision,sizeBytes:s.sizeBytes,selectedLog:s.location.path,artifactDir,logNames:names.filter(n=>n!=='session.lock').sort()});
   }
   sessions.sort((a,b)=>a.id.localeCompare(b.id));
   const witness={workspace:await treeSnapshotFile(path.join(storageRoot,'workspace.json')),cache:await tree(path.dirname(cacheDirectory)),workbench:await treeSnapshotFile(wbFile),retained:before.retained,sessions};
   return {sessions,archived:before.workspace.global.archivedSessionIds,pinned:before.workspace.global.pinnedSessionIds,workbench:before.workbench,references:before.retained.references,identity:digest(witness),baseline:before};
  },
  lockSession:dir=>lockSessionDirectory(dir,sdkScope),
  async forget(ids,baseline,workspaceIds=[]){const targets=new Set(ids);const before=baseline.workspace,after=structuredClone(before);
   if(stable(await retainedDomains())!==stable(baseline.retained))fail('PURGE_RETAINED_METADATA_CHANGED');
   for(const row of Object.values(after.tables.workspaces))row.sessionIds=row.sessionIds.filter(id=>!targets.has(id));
   after.global.archivedSessionIds=after.global.archivedSessionIds.filter(id=>!targets.has(id));after.global.pinnedSessionIds=after.global.pinnedSessionIds.filter(id=>!targets.has(id));
   for(const id of workspaceIds){delete after.tables.workspaces[id];after.global.workspaceIds=after.global.workspaceIds.filter(key=>key!==id);}
   if(unit)await unit.close();unit=await store.kv.open(workspaceDescriptor);const actual=await unit.loadAll();
   for(const id of Object.keys(actual.tables.workspaces))if(!Object.hasOwn(before.tables.workspaces,id))fail('PURGE_METADATA_CHANGED');
   for(const [id,row]of Object.entries(before.tables.workspaces)){const current=actual.tables.workspaces[id],next=after.tables.workspaces[id];if(stable(current)!==stable(row)&&stable(current)!==stable(next))fail('PURGE_METADATA_CHANGED');if(stable(current)!==stable(next)){if(next)await unit.putRecord('workspaces',id,next);else await unit.deleteRecords('workspaces',[id]);await afterMetadataWrite('workspace-record');}}
   if(stable(actual.global)!==stable(before.global)&&stable(actual.global)!==stable(after.global))fail('PURGE_METADATA_CHANGED');if(stable(actual.global)!==stable(after.global)){await unit.setGlobal(after.global);await afterMetadataWrite('workspace-global');}
   cache??=await store.kv.open(cacheDescriptor);
   const cacheActual={};for(const name of await fs.readdir(cacheDirectory)){if(!/^[a-zA-Z0-9_-]+\.json$/.test(name))fail('PURGE_CACHE_RECOVERY_REQUIRED');cacheActual[name.slice(0,-5)]=digest(await readJSON(path.join(cacheDirectory,name)));}
   for(const id of new Set([...Object.keys(cacheActual),...Object.keys(baseline.cacheHashes)])){if(cacheActual[id]!==baseline.cacheHashes[id]&&!(targets.has(id)&&cacheActual[id]===undefined))fail('PURGE_METADATA_CHANGED');}
   await cache.deleteRecords('sessions',ids);
   await afterMetadataWrite('projection-cache');
   const wb=await readJSON(wbFile),next=structuredClone(baseline.workbench);for(const id of ids){delete next.sessions[id];delete next.trash[id];}for(const id of workspaceIds)delete next.workspaces[id];
   if(stable(wb)!==stable(baseline.workbench)&&stable(wb)!==stable(next))fail('PURGE_METADATA_CHANGED');if(stable(wb)!==stable(next))await atomic(wbFile,next);
   await afterMetadataWrite('workbench');
   // Per-record legacy bootstrap must never resurrect purged projection rows.
   // Keep sessions/ in place; mutate a present legacy unit through the same
   // official JSON backend in its original single layout, after closing cache.
   const legacy=path.join(storageRoot,'session_projcache.json');try{await readJSON(legacy);if(baseline.legacyHashes===null)fail('PURGE_METADATA_CHANGED');await cache.close();cache=null;const old=await store.kv.open({...cacheDescriptor,layout:'single'});try{const values=(await old.loadAll()).tables.sessions;for(const id of new Set([...Object.keys(values),...Object.keys(baseline.legacyHashes)]))if((values[id]===undefined?undefined:digest(values[id]))!==baseline.legacyHashes[id]&&!(targets.has(id)&&values[id]===undefined))fail('PURGE_METADATA_CHANGED');await old.deleteRecords('sessions',ids);}finally{await old.close();}}catch(e){if(e.code!=='ENOENT'||baseline.legacyHashes!==null)throw e;}
   await restorePermissions(path.join(storageRoot,'workspace.json'),baseline.owners.workspace);await restorePermissions(wbFile,baseline.owners.workbench);if(baseline.owners.legacy)await restorePermissions(legacy,baseline.owners.legacy);
  },
  async verifyForgotten(ids){const state=await metadata(),remaining=await ctx.sessionPersistence.list();for(const id of ids){if(remaining.some(s=>s.header.id===id)||state.workspace.global.archivedSessionIds.includes(id)||state.workspace.global.pinnedSessionIds.includes(id)||Object.values(state.workspace.tables.workspaces).some(w=>w.sessionIds.includes(id))||state.cacheHashes[id]!==undefined||state.legacyHashes?.[id]!==undefined||state.workbench.sessions[id]!==undefined||state.workbench.trash[id]!==undefined)fail('PURGE_POSTVERIFY_FAILED');}},
  async close(){await store.close();await ctx.fiber.dispose();}
 };
 return adapter;
}
async function treeSnapshotFile(file){const s=await fs.lstat(file);return {dev:s.dev,ino:s.ino,sha256:digest(await readJSON(file))};}
