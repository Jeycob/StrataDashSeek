import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {plan,apply,pending,digest,stable,COVERAGE,atomic} from './offline-purge.mjs';
const linux={skip:process.platform!=='linux'};
const held=new Set();
async function fixture(t, extra={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'offline-purge-'));
 t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('offline-purge-'));await fs.rm(root,{recursive:true,force:true});});
 const projectsRoot=path.join(root,'projects'),workbenchRoot=path.join(root,'state'),sessionRoot=path.join(root,'sessions'),control=path.join(root,'control');
 for(const dir of [projectsRoot,workbenchRoot,sessionRoot,control])await fs.mkdir(dir);
 const ids=['session-a','session-b'],sessions=[],wb={version:1,sessions:{},trash:{},workspaces:{}},ws={global:{archivedSessionIds:[ids[0]],pinnedSessionIds:[],workspaceIds:['w1']},tables:{workspaces:{w1:{path:root,sessionIds:[ids[0]]}}}};
 for(const id of ids){const p=path.join(projectsRoot,id),dir=path.join(sessionRoot,id);await fs.mkdir(path.join(p,'.harness'),{recursive:true});await fs.mkdir(dir);await fs.writeFile(path.join(p,'.harness/project.json'),JSON.stringify({sessionId:id,root:p}));await fs.writeFile(path.join(p,'app.txt'),'keep '+id);await fs.writeFile(path.join(dir,'session.lock'),'');await fs.writeFile(path.join(dir,'session.v4.jsonl.zstd'),'fixture opaque log '+id);sessions.push({id,cwd:p,parentSession:null,formatStatus:'current',artifactDir:dir,logNames:['session.v4.jsonl.zstd']});wb.sessions[id]={root:p,sourceRoot:p,workspaceId:id===ids[0]?'w1':'w2'};}
 const wbFile=path.join(workbenchRoot,'registry.json'),wsFile=path.join(control,'workspace.json');await fs.writeFile(wbFile,JSON.stringify(wb));await fs.writeFile(wsFile,JSON.stringify(ws));
 const refs=path.join(control,'reference-source.json'),value={apps:[],jobs:[]};await fs.writeFile(refs,JSON.stringify(value));
 const graph={version:1,sdkVersion:'0.2.2-rc.2',coverage:Object.fromEntries(COVERAGE.map(k=>[k,true])),unknown:[],references:[],witnesses:[{path:refs,sha256:digest(value)}]};
 let failMetadata=false;const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
 const adapter={identity:{sdk:'fixture'},projectsRoot,workbenchRoot,
  async inspect(){const workbench=await read(wbFile),workspace=await read(wsFile);return {identity:digest({workbench,workspace}),sessions,workbench,archived:workspace.global.archivedSessionIds,pinned:workspace.global.pinnedSessionIds,baseline:{workbench,workspace}};},
  async lockSession(dir){if(held.has(dir))throw Object.assign(Error('BUSY'),{code:'SESSION_LOCK_BUSY'});held.add(dir);return {release:async()=>held.delete(dir)};},
  async forget(ids,baseline,workspaceIds){const next=structuredClone(baseline.workspace);next.global.archivedSessionIds=next.global.archivedSessionIds.filter(id=>!ids.includes(id));for(const row of Object.values(next.tables.workspaces))row.sessionIds=row.sessionIds.filter(id=>!ids.includes(id));for(const id of workspaceIds){delete next.tables.workspaces[id];next.global.workspaceIds=next.global.workspaceIds.filter(k=>k!==id);}const actual=await read(wsFile);assert([stable(baseline.workspace),stable(next)].includes(stable(actual)));await atomic(wsFile,next);if(failMetadata){failMetadata=false;throw Error('crash-in-metadata');}const w=structuredClone(baseline.workbench);for(const id of ids){delete w.sessions[id];delete w.trash[id];}await atomic(wbFile,w);},
  async verifyForgotten(ids){const w=await read(wbFile),s=await read(wsFile);for(const id of ids){assert(!w.sessions[id]);assert(!s.global.archivedSessionIds.includes(id));assert.equal(await fs.stat(path.join(sessionRoot,id,'session.v4.jsonl.zstd')).then(()=>true,()=>false),false);}},
 };
 const guard=async()=>{if(extra.active)throw Error('WRITERS_ACTIVE');};
 graph.metadataIdentity=(await adapter.inspect()).identity;
 return {root,adapter,graph,guard,ids,wb,ws,wbFile,wsFile,sessions,refs,journalFile:path.join(control,'purge.json'),failMetadata:()=>failMetadata=true,async mutate(action){const w=await read(wbFile),s=await read(wsFile);await action(w,s);await fs.writeFile(wbFile,JSON.stringify(w));await fs.writeFile(wsFile,JSON.stringify(s));graph.metadataIdentity=(await adapter.inspect()).identity;}};
}
test('real filesystem plan/apply removes archived payload and metadata, retaining stable lock inode and unrelated work',linux,async t=>{
 const f=await fixture(t),before=await fs.stat(path.join(f.sessions[0].artifactDir,'session.lock')),p=await plan(f);assert.equal(p.rows[0].eligible,true);assert(p.rows[0].allocatedBytes>0);assert.equal(p.rows[1].eligible,false);assert.deepEqual(p.workspaceRemovals,['w1']);
 const r=await apply({...f,expectedPlanHash:p.planHash});assert.equal(r.status,'completed');assert.equal(await pending(f.journalFile),false);assert.equal(await fs.stat(f.wb.sessions[f.ids[0]].root).then(()=>true,()=>false),false);assert.equal(await fs.readFile(path.join(f.wb.sessions[f.ids[1]].root,'app.txt'),'utf8'),'keep '+f.ids[1]);assert.equal((await fs.stat(path.join(f.sessions[0].artifactDir,'session.lock'))).ino,before.ino);assert.equal((await apply(f)).replayed,true);
});
test('active barrier, pins, current/protected IDs, shared roots, retained children and unknown graphs cannot become eligible',linux,async t=>{
 for(const mode of ['active','pinned','protected','shared','child','apps','unknown'])await t.test(mode,async t=>{
  const f=await fixture(t,{active:mode==='active'});if(mode==='active'){await assert.rejects(plan(f),/WRITERS_ACTIVE/);return;}
  if(mode==='pinned')await f.mutate((w,s)=>s.global.pinnedSessionIds=[f.ids[0]]);
  if(mode==='protected')f.graph.protectedIds=[f.ids[0]];
  if(mode==='shared')await f.mutate(w=>w.sessions[f.ids[1]].sourceRoot=w.sessions[f.ids[0]].root);
  if(mode==='child')f.sessions[1].parentSession=f.ids[0];
  if(mode==='apps')f.graph.references.push({source:'apps-published-rollback-recovery-dataOps',sessionIds:[],paths:[f.wb.sessions[f.ids[0]].root]});
  if(mode==='unknown')f.graph.coverage.plugins=false;
  const p=await plan(f);assert.equal(p.rows[0].eligible,false);assert(p.rows[0].reasons.length);assert.equal(await fs.stat(f.wb.sessions[f.ids[0]].root).then(()=>true,()=>false),true);
 });
});
test('stale content, graph witness and metadata refuse before any unlink',linux,async t=>{
 for(const mode of ['content','graph','metadata'])await t.test(mode,async t=>{const f=await fixture(t),p=await plan(f);if(mode==='content')await fs.writeFile(path.join(f.wb.sessions[f.ids[0]].root,'app.txt'),'newer');if(mode==='graph')await fs.writeFile(f.refs,'{}');if(mode==='metadata')await f.mutate(w=>w.workspaces.new={settings:{model:'new'}});await assert.rejects(apply({...f,expectedPlanHash:p.planHash}));assert.equal(await fs.stat(path.join(f.sessions[0].artifactDir,'session.v4.jsonl.zstd')).then(()=>true,()=>false),true);});
});
test('every journal phase and a partial unlink recover forward, including partial metadata',linux,async t=>{
 for(const crash of ['intent','unlink','logs','metadata','partial-metadata'])await t.test(crash,async t=>{const f=await fixture(t),p=await plan(f);let fired=false;if(crash==='partial-metadata')f.failMetadata();await assert.rejects(apply({...f,expectedPlanHash:p.planHash,onStep:stage=>{if(stage===crash&&!fired){fired=true;throw Error('simulated-process-death');}}}));assert.equal(await pending(f.journalFile),true);const r=await apply(f);assert.equal(r.status,'completed');assert.equal(await pending(f.journalFile),false);});
});
test('two simultaneous applies cannot cross the session writer exclusion',linux,async t=>{const f=await fixture(t),p=await plan(f);let release,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);const first=apply({...f,expectedPlanHash:p.planHash,onStep:async stage=>{if(stage==='intent'){entered();await wait;}}});await ready;await assert.rejects(apply({...f,expectedPlanHash:p.planHash}),/BUSY/);release();assert.equal((await first).status,'completed');});
test('leaf symlink is unlinked without touching its external destination',linux,async t=>{const f=await fixture(t),outside=path.join(f.root,'outside');await fs.writeFile(outside,'retain');await fs.symlink(outside,path.join(f.wb.sessions[f.ids[0]].root,'link'));const p=await plan(f);assert.equal(p.rows[0].eligible,true);await apply({...f,expectedPlanHash:p.planHash});assert.equal(await fs.readFile(outside,'utf8'),'retain');});
test('hardlink source data stays; a replaced project parent invalidates a dry-run before log unlink',linux,async t=>{
 const f=await fixture(t),project=f.wb.sessions[f.ids[0]].root;await fs.link(path.join(project,'app.txt'),path.join(f.root,'external-hardlink'));let p=await plan(f);assert.equal(p.rows[0].eligible,false);assert(p.rows[0].reasons.includes('PURGE_HARDLINK_ENTRY'));await fs.unlink(path.join(f.root,'external-hardlink'));p=await plan(f);await fs.rename(project,project+'-original');await fs.symlink(project+'-original',project);await assert.rejects(apply({...f,expectedPlanHash:p.planHash}));assert.equal(await fs.stat(path.join(f.sessions[0].artifactDir,'session.v4.jsonl.zstd')).then(()=>true,()=>false),true);
});
test('changed external references and a corrupt journal fail closed on recovery',linux,async t=>{
 const f=await fixture(t),p=await plan(f);await assert.rejects(apply({...f,expectedPlanHash:p.planHash,onStep:stage=>{if(stage==='intent')throw Error('crash');}}));await fs.writeFile(f.refs,'{}');await assert.rejects(apply(f),/PURGE_GRAPH_STALE/);const j=JSON.parse(await fs.readFile(f.journalFile,'utf8'));j.plan.rows[0].root=f.root;await fs.writeFile(f.journalFile,JSON.stringify(j));await assert.rejects(apply(f),/PURGE_JOURNAL_UNTRUSTED/);
});
test('fresh independent tasks sharing a source parent are not mistaken for shared actual working roots',linux,async t=>{const f=await fixture(t);await f.mutate(w=>{for(const record of Object.values(w.sessions))record.sourceRoot=f.adapter.projectsRoot;});for(const s of f.sessions)s.cwd=f.adapter.projectsRoot;const p=await plan(f);assert.equal(p.rows[0].eligible,true);});
test('retained header without a workbench record and checkpoint alias references both keep the archived bundle',linux,async t=>{const f=await fixture(t);f.sessions.push({id:'legacy',cwd:f.wb.sessions[f.ids[0]].root,parentSession:null});let p=await plan(f);assert.equal(p.rows[0].eligible,false);f.sessions.pop();const aux=path.join(f.adapter.workbenchRoot,'checkpoints',f.ids[0]);await fs.mkdir(aux,{recursive:true});const alias=path.join(f.root,'checkpoint-alias');await fs.symlink(aux,alias);f.graph.references.push({source:'saved-restore',sessionIds:[],paths:[path.join(alias,'future-target')]});p=await plan(f);assert.equal(p.rows[0].eligible,false);assert(p.rows[0].reasons.includes('RETAINED_REFERENCE:saved-restore'));});
