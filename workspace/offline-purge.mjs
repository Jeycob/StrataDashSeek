// Root maintenance only. Never called from the live cache-cleanup timer.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COVERAGE = ['lineage','plugins','activity','savedResume','appsPublished','appsRollback','appsRecovery','appsJobs','appsDataOps','snapshots','restore'];
export const fail = code => { throw Object.assign(Error(code), {code}); };
export function stable(value) { return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v); }
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
export async function fileDigest(file){await directory(path.dirname(file));const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const before=await h.stat();if(!before.isFile()||before.nlink!==1)fail('PURGE_FILE_UNSAFE');const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);for(;;){const {bytesRead}=await h.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}const after=await h.stat();if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('PURGE_FILE_CHANGED');return hash.digest('hex');}finally{await h.close();}}
export function inside(root, target) { const rel=path.relative(root,target);return rel!=='' && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel); }
const overlap = (a,b) => a===b || inside(a,b) || inside(b,a);
function absoluteStrings(value,out=[]){if(typeof value==='string'){if(path.isAbsolute(value))out.push(value);}else if(value&&typeof value==='object')for(const v of Object.values(value))absoluteStrings(v,out);return out;}
async function referencePath(target){if(typeof target!=='string'||!path.isAbsolute(target))fail('PURGE_GRAPH_INVALID');let current=target;const tail=[];for(;;){try{return path.join(await fs.realpath(current),...tail);}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(current);if(parent===current)throw e;tail.unshift(path.basename(current));current=parent;}}}
export async function directory(target) {
 if (!path.isAbsolute(target) || path.resolve(target)!==target) fail('PURGE_NON_CANONICAL_PATH');
 let cursor=path.parse(target).root;
 for(const part of target.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);const s=await fs.lstat(cursor);if(s.isSymbolicLink()||!s.isDirectory())fail('PURGE_LINKED_PARENT');}
 if(await fs.realpath(target)!==target)fail('PURGE_LINKED_PARENT');
 return target;
}
export async function readJSON(file) {
 await directory(path.dirname(file));const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>32*1024**2)fail('PURGE_METADATA_UNSAFE');
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));try{const before=await h.stat();if(before.dev!==s.dev||before.ino!==s.ino||before.nlink!==1)fail('PURGE_METADATA_UNSAFE');const value=JSON.parse(await h.readFile('utf8')),after=await h.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('PURGE_METADATA_CHANGED');return value;}finally{await h.close();}
}
export async function atomic(file, value) {
 await directory(path.dirname(file));const tmp=file+'.'+crypto.randomUUID()+'.tmp',h=await fs.open(tmp,'wx',0o600);
 try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}
 await fs.rename(tmp,file);if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
}
export async function tree(root, {links=false}={}) {
 await directory(root);const base=await fs.lstat(root), entries=[];let count=0;
 async function visit(absolute,relative){if(++count>200000)fail('PURGE_SCAN_LIMIT');const s=await fs.lstat(absolute);if(s.dev!==base.dev)fail('PURGE_MOUNT_BOUNDARY');
  const id={dev:s.dev,ino:s.ino},entry={relative,...id};
  if(s.isSymbolicLink()){if(!links)fail('PURGE_LINK_ENTRY');entry.kind='link';entry.sha256=digest(await fs.readlink(absolute));}
  else if(s.isDirectory()){entry.kind='directory';}
  else if(s.isFile()){if(s.nlink!==1)fail('PURGE_HARDLINK_ENTRY');entry.kind='file';entry.sha256=await fileDigest(absolute);entry.bytes=s.size;}
  else fail('PURGE_SPECIAL_ENTRY');
  entry.allocatedBytes=typeof s.blocks==='number'?s.blocks*512:null;entries.push(entry);
  if(entry.kind==='directory')for(const name of (await fs.readdir(absolute)).sort())await visit(path.join(absolute,name),relative?path.join(relative,name):name);
 }
 await visit(root,'');return {root,entries,allocatedBytes:entries.every(e=>e.allocatedBytes!==null)?entries.reduce((n,e)=>n+e.allocatedBytes,0):null};
}
async function optionalTree(root, options) {try{return await tree(root,options);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function witnesses(graph) {
 if(!Array.isArray(graph.witnesses)||!graph.witnesses.length)fail('PURGE_GRAPH_WITNESSES_REQUIRED');
 const actual=[];
 for(const w of graph.witnesses){if(typeof w.path!=='string'||!['json','bytes'].includes(w.kind||'json')||!/^[a-f0-9]{64}$/.test(w.sha256||''))fail('PURGE_GRAPH_INVALID');
  const sha=w.kind==='bytes'?await fileDigest(w.path):digest(await readJSON(w.path));if(sha!==w.sha256)fail('PURGE_GRAPH_STALE');actual.push({path:w.path,sha256:sha});}
 return actual;
}
export async function plan({adapter, graph, guard}) {
 await guard();const data=await adapter.inspect();await directory(adapter.projectsRoot);const evidence=await witnesses(graph);
 if(graph.version!==1||graph.sdkVersion!=='0.2.2-rc.2'||!Array.isArray(graph.references)||!Array.isArray(graph.unknown)||Object.keys(graph).some(k=>!['version','sdkVersion','metadataIdentity','coverage','unknown','references','witnesses','protectedIds','protectedWorkspaceIds','protectedPaths','sessionMetadataDomains','capturedAt'].includes(k)))fail('PURGE_GRAPH_INVALID');
 if(graph.metadataIdentity!==data.identity)fail('PURGE_GRAPH_STALE');
 if(graph.protectedIds!==undefined&&(!Array.isArray(graph.protectedIds)||graph.protectedIds.some(v=>typeof v!=='string'))||graph.protectedPaths!==undefined&&(!Array.isArray(graph.protectedPaths)||graph.protectedPaths.some(v=>typeof v!=='string'||!path.isAbsolute(v))))fail('PURGE_GRAPH_INVALID');
 const unknown=[...graph.unknown,...COVERAGE.filter(k=>graph.coverage?.[k]!==true),...Object.keys(graph.coverage||{}).filter(k=>!COVERAGE.includes(k))];
 const protectedIds=new Set(graph.protectedIds||[]), protectedPaths=await Promise.all((graph.protectedPaths||[]).map(referencePath));
 const refs=[];for(const ref of [...graph.references,...(data.references||[])]){if(!ref||typeof ref.source!=='string'||!Array.isArray(ref.sessionIds)||!Array.isArray(ref.paths))fail('PURGE_GRAPH_INVALID');refs.push({...ref,paths:await Promise.all(ref.paths.map(referencePath))});}
 const archive=new Set(data.archived),pins=new Set(data.pinned), rows=[];
 if(new Set(data.sessions.map(s=>s.id)).size!==data.sessions.length)fail('PURGE_SESSION_ID_CONFLICT');
 for(const s of data.sessions){const row={id:s.id,eligible:false,reasons:[]};rows.push(row);
  if(!archive.has(s.id))row.reasons.push('NOT_ARCHIVED');if(pins.has(s.id))row.reasons.push('PINNED');if(protectedIds.has(s.id))row.reasons.push('PROTECTED');
  if(unknown.length)row.reasons.push('REFERENCE_GRAPH_UNKNOWN');
  const record=data.workbench.sessions[s.id];
  if(!record||record.legacy||record.nativeWorktree||record.settings?.projectMode==='continue')row.reasons.push('NOT_INDEPENDENT_MANAGED_PROJECT');
  const root=record?.root;
  const scopes=[root,s.artifactDir,...['changes','checkpoints','restores'].map(part=>path.join(adapter.workbenchRoot,part,s.id))].filter(p=>typeof p==='string'&&path.isAbsolute(p));
  if(typeof root!=='string'||!path.isAbsolute(root)||!inside(adapter.projectsRoot,root)||![root,record?.sourceRoot].includes(s.cwd)||path.basename(root)!==s.id.replace(/[^a-zA-Z0-9_-]/g,'_'))row.reasons.push('ROOT_IDENTITY_UNPROVEN');
  if(s.formatStatus!=='current'||!s.artifactDir)row.reasons.push('UNSUPPORTED_SESSION_ARTIFACT');
  // A retained parent can own a child descriptor; any lineage edge keeps both
  // endpoints in this deliberately conservative first adapter.
  if(s.parentSession||s.isSeeded||s.origin==='subagent'||data.sessions.some(other=>other.parentSession===s.id))row.reasons.push('LINEAGE_REFERENCE');
  if(root){
   if(protectedPaths.some(p=>!path.isAbsolute(p)||scopes.some(scope=>overlap(p,scope))))row.reasons.push('PROTECTED_PATH');
   for(const [id,other]of Object.entries(data.workbench.sessions))if(id!==s.id)for(const p of absoluteStrings(other)){
    const real=await referencePath(p);
    // An independent task's original source parent is provenance, not ownership
    // of every generated child below it. Actual working roots overlap in both
    // directions; other path references retain the subtree they name.
    const ownerRoot=typeof other.root==='string'?await referencePath(other.root):null;
    if(scopes.some(scope=>real===scope||inside(scope,real)||real===ownerRoot&&inside(real,scope)))row.reasons.push('SHARED_PROJECT_REFERENCE');
   }
   for(const other of data.sessions)if(other.id!==s.id&&typeof other.cwd==='string'&&path.isAbsolute(other.cwd)){const real=await referencePath(other.cwd),r=data.workbench.sessions[other.id],actual=!r||r.legacy||r.settings?.projectMode==='continue';if(scopes.some(scope=>real===scope||inside(scope,real)||actual&&inside(real,scope)))row.reasons.push('RETAINED_HEADER_CWD_REFERENCE');}
  }
  for(const ref of refs){
   if(ref.sessionIds.includes(s.id)||ref.paths.some(p=>typeof p!=='string'||!path.isAbsolute(p)||scopes.some(scope=>overlap(p,scope))))row.reasons.push('RETAINED_REFERENCE:'+ref.source);
  }
  if(row.reasons.length){row.reasons=[...new Set(row.reasons)];continue;}
  try{
   const marker=await readJSON(path.join(root,'.harness','project.json'));if(marker.sessionId!==s.id||marker.root!==root)fail('PURGE_PROJECT_MARKER_CONFLICT');
   const logs=await tree(s.artifactDir);if(!logs.entries.some(e=>e.relative==='session.lock'&&e.kind==='file'))fail('PURGE_SESSION_LOCK_REQUIRED');
   if(logs.entries.some(e=>e.kind==='directory'&&e.relative!==''))fail('PURGE_ARTIFACT_SUBDIRECTORY');
   const expectedNames=new Set(s.logNames);if(!expectedNames.size||logs.entries.some(e=>e.relative&&!expectedNames.has(e.relative)&&e.relative!=='session.lock'))fail('PURGE_UNKNOWN_ARTIFACT');
   if([...expectedNames].some(n=>!logs.entries.some(e=>e.relative===n&&e.kind==='file')))fail('PURGE_ARTIFACT_MISSING');
   const project=await tree(root,{links:true}),aux=[];
   for(const part of ['changes','checkpoints','restores']){const t=await optionalTree(path.join(adapter.workbenchRoot,part,s.id),{links:true});if(t)aux.push(t);}
   // A restore journal cannot be inferred idle from its directory name.
   if(aux.some(t=>path.basename(path.dirname(t.root))==='restores'))fail('PURGE_RESTORE_STATE_RETAINED');
   if([project,logs,...aux].some(t=>t.allocatedBytes===null))fail('PURGE_ALLOCATED_BYTES_UNKNOWN');
   Object.assign(row,{eligible:true,root,artifactDir:s.artifactDir,trees:[logs,project,...aux],allocatedBytes:[logs,project,...aux].reduce((n,t)=>n+t.allocatedBytes,0)-logs.entries.filter(e=>e.relative==='session.lock'||e.relative==='').reduce((n,e)=>n+e.allocatedBytes,0)});
  }catch(e){row.reasons.push(e.code||'PURGE_TARGET_UNSAFE');}
 }
 for(const id of archive)if(!data.sessions.some(s=>s.id===id))rows.push({id,eligible:false,reasons:['SESSION_ARTIFACT_MISSING_KEEP']});
 const ids=new Set(rows.filter(r=>r.eligible).map(r=>r.id)),workspaceRemovals=[];
 for(const [id,w]of Object.entries(data.baseline.workspace?.tables?.workspaces||{})){
  if(graph.protectedWorkspaceIds?.includes(id)||!Object.entries(data.workbench.sessions).some(([sid,r])=>ids.has(sid)&&r.workspaceId===id))continue;
  if(w.sessionIds.some(sid=>!ids.has(sid))||Object.entries(data.workbench.sessions).some(([sid,r])=>!ids.has(sid)&&r.workspaceId===id))continue;
  if(refs.some(ref=>ref.workspaceIds?.includes(id)||ref.paths.some(p=>!path.isAbsolute(p)||overlap(p,w.path))))continue;
  workspaceRemovals.push(id);
 }
 const identity={version:1,sdkVersion:'0.2.2-rc.2',adapter:adapter.identity,metadata:data.identity,metadataBaselineHash:digest(data.baseline),graphHash:digest(graph),witnesses:evidence,rows,workspaceRemovals};
 const result={...identity,planHash:digest(identity),freeBytesBefore:await free(adapter.projectsRoot),metadataBaseline:data.baseline};if(Buffer.byteLength(JSON.stringify(result))>16*1024**2)fail('PURGE_MANIFEST_TOO_LARGE');await guard();return result;
}
export async function free(root){const s=await fs.statfs(root);return Number(s.bavail)*Number(s.bsize);}
function targetIdentity(e){return {kind:e.kind,dev:e.dev,ino:e.ino,sha256:e.sha256,bytes:e.bytes};}
async function eraseTree(snapshot,{keepLock=false,guard,onStep=()=>{}}) {
 let current;try{current=await tree(snapshot.root,{links:!keepLock});}catch(e){if(e.code==='ENOENT'&&!keepLock)return;throw e;}
 const expected=new Map(snapshot.entries.map(e=>[e.relative,e]));
 for(const e of current.entries){const before=expected.get(e.relative);if(!before||stable(targetIdentity(e))!==stable(targetIdentity(before)))fail('PURGE_TARGET_CHANGED');}
 for(const e of [...current.entries].sort((a,b)=>b.relative.split(path.sep).length-a.relative.split(path.sep).length||b.relative.localeCompare(a.relative))){
  if(keepLock&&(e.relative===''||e.relative==='session.lock'))continue;
  await guard();const file=e.relative?path.join(snapshot.root,e.relative):snapshot.root;
  await directory(path.dirname(file));const s=await fs.lstat(file);if(s.dev!==e.dev||s.ino!==e.ino)fail('PURGE_TARGET_CHANGED');
  if(e.kind==='directory')await fs.rmdir(file);else {if(e.kind==='file'&&(!s.isFile()||s.nlink!==1||await fileDigest(file)!==e.sha256)||e.kind==='link'&&(!s.isSymbolicLink()||digest(await fs.readlink(file))!==e.sha256))fail('PURGE_TARGET_CHANGED');await fs.unlink(file);}
  const parent=await fs.open(path.dirname(file),'r');try{await parent.sync();}finally{await parent.close();}await onStep('unlink',file);
 }
}
async function readJournal(file){try{return await readJSON(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function validateJournal(j){if(j?.version!==1||!['logs','metadata','projects','complete'].includes(j.phase)||!j.plan)fail('PURGE_JOURNAL_UNTRUSTED');const {planHash,freeBytesBefore,metadataBaseline,...bound}=j.plan;if(digest(bound)!==planHash||digest(metadataBaseline)!==bound.metadataBaselineHash||j.phase==='complete'&&j.report?.status!=='completed')fail('PURGE_JOURNAL_UNTRUSTED');return j;}
/** An unfinished journal is a mandatory pre-Native-start barrier. No auto-undo
 * after irreversible unlink: retry forward or remain closed for reconciliation. */
export async function apply({adapter,graph,guard,journalFile,expectedPlanHash,onStep=()=>{}}){
 await guard();await directory(path.dirname(journalFile));let j=await readJournal(journalFile),locks=[];
 if(j?.phase==='complete'){validateJournal(j);return {...j.report,replayed:true};}
 try{
  if(!j){const candidate=await plan({adapter,graph,guard});if(candidate.planHash!==expectedPlanHash)fail('PURGE_STALE_PLAN');
   if(!candidate.rows.some(r=>r.eligible))return {status:'nothing-eligible',removed:[],kept:candidate.rows.map(r=>({id:r.id,reasons:r.reasons})),freeBytesBefore:candidate.freeBytesBefore,freeBytesAfter:await free(adapter.projectsRoot)};
   // Acquire every SDK-equivalent session writer lock before the final plan
   // comparison. No lock file is created, truncated, renamed or unlinked.
   for(const row of candidate.rows.filter(r=>r.eligible))locks.push(await adapter.lockSession(row.artifactDir));
   const fresh=await plan({adapter,graph,guard});if(fresh.planHash!==expectedPlanHash)fail('PURGE_STALE_PLAN');
   j={version:1,phase:'logs',plan:fresh,adapterIdentity:adapter.identity};await atomic(journalFile,j);await onStep('intent');
  }else{
   validateJournal(j);if(stable(j.adapterIdentity)!==stable(adapter.identity))fail('PURGE_JOURNAL_UNTRUSTED');
   if(j.plan.graphHash!==digest(graph))fail('PURGE_GRAPH_STALE');await witnesses(graph);
   for(const row of j.plan.rows.filter(r=>r.eligible))locks.push(await adapter.lockSession(row.artifactDir));
  }
  await guard();const rows=j.plan.rows.filter(r=>r.eligible);
  if(j.phase!=='logs')for(const row of rows){const remaining=await tree(row.artifactDir);if(remaining.entries.some(e=>e.relative!==''&&e.relative!=='session.lock'))fail('PURGE_LOG_REAPPEARED');}
  if(j.phase==='logs'){for(const row of rows)await eraseTree(row.trees[0],{keepLock:true,guard,onStep});j.phase='metadata';await atomic(journalFile,j);await onStep('logs');}
  if(j.phase==='metadata'){await adapter.forget(rows.map(r=>r.id),j.plan.metadataBaseline,j.plan.workspaceRemovals);await guard();j.phase='projects';await atomic(journalFile,j);await onStep('metadata');}
  if(j.phase==='projects'){
   // Revalidate retained metadata even when resuming after the metadata phase:
   // a schedule or unrelated record changed during downtime must not authorize
   // deletion of a now-referenced project. forget is strictly before/after CAS.
   await adapter.forget(rows.map(r=>r.id),j.plan.metadataBaseline,j.plan.workspaceRemovals);
   for(const row of rows)for(const t of row.trees.slice(1))await eraseTree(t,{guard,onStep});await adapter.verifyForgotten(rows.map(r=>r.id));await guard();
   const freeBytesAfter=await free(adapter.projectsRoot);j.report={status:'completed',removed:rows.map(r=>({id:r.id,root:r.root,allocatedBytes:r.allocatedBytes})),removedWorkspaceIds:j.plan.workspaceRemovals,kept:j.plan.rows.filter(r=>!r.eligible).map(r=>({id:r.id,reasons:r.reasons})),freeBytesBefore:j.plan.freeBytesBefore,freeBytesAfter,freeBytesDelta:freeBytesAfter-j.plan.freeBytesBefore,lockSentinelsRetained:true};j.phase='complete';await atomic(journalFile,j);await onStep('complete');}
  return j.report;
 }finally{for(const lock of locks.reverse())await lock.release();await adapter.close?.();}
}
export async function pending(journalFile){const j=await readJournal(journalFile);return j!==null&&j.phase!=='complete';}
