import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from './manager.mjs';
import { projectGit } from './project-repository.mjs';
import { runtimeContext } from './runtime-authority.mjs';
import { executionBindingFixture, hostExecutionBinding } from './fixtures/execution-binding.mjs';

async function fixture(t, mode, projectMode = 'fresh') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-manager-modes-')), source = path.join(directory, 'source'), projects = path.join(directory, 'projects');
  await fs.mkdir(source); await fs.mkdir(projects);
  const binding = executionBindingFixture(mode), agents = new Map(), sessions = new Map(), directories = new Map(), grants = [], writes = [], worktrees = [], warnings = [];
  const ctx = { agents:{list:()=>[...agents.values()],get:id=>agents.get(id)}, sessions:{get:id=>sessions.get(id)}, sessionPersistence:{stat:async()=>undefined},
    workspaceRegistry:{list:()=>[],archivedSessionIds:new Set()},
    workingDirectory:{get:s=>directories.get(s.id)??source,set:async(a,root)=>{writes.push({id:a.id,root});directories.set(a.id,root);}},
    sandboxPolicy:{resolve:({session})=>({mode:session.mode??'workspace-write'}),registerWritableRoot:(s,root)=>{grants.push({id:s.id,root});return()=>{};}},
    worktrees:{create:async(a,{from})=>{const root=path.join(projects,'native-'+a.id),branch='codex/fixture-'+a.id;await projectGit(source,['worktree','add','-b',branch,root,from]);worktrees.push(root);return{path:await fs.realpath(root),branch,baseCommit:from};}},logger:{warn:value=>warnings.push(value)},
    waterfall:async(_name,_input,next)=>next() };
  const manager = new WorkspaceManager(ctx, {stateRoot:path.join(directory,'state'),projectsRoot:projects,changes:{minimumFreeBytes:0}}, binding.binding);
  await manager.initialize(); manager.data.installedAt=0; manager.settings=()=>({projectMode,maxStageSteps:60}); manager.allocatePorts=async()=>[21000,21001,21002,21003];
  const agent = (id='one', fields={}) => {const a={id,status:'idle',session:{id,mode:'workspace-write',header:{cwd:source,createdAt:Date.now(),origin:'user',...fields}}};agents.set(id,a);sessions.set(id,a.session);return a;};
  const git = args => projectGit(source,args);
  t.after(async()=>{manager.changes.dispose();const actual=await fs.realpath(directory);assert.equal(path.dirname(actual),await fs.realpath(os.tmpdir()));assert(path.basename(actual).startsWith('homeai-manager-modes-'));await fs.rm(actual,{recursive:true,force:true});});
  return {directory,source,projects,binding,manager,ctx,agent,git,grants,writes,worktrees,warnings};
}

test('manager requires a separate trusted projection binding; settings strings cannot choose mode',()=>{
  assert.throws(()=>new WorkspaceManager({}, {executionMode:'isolated-guest'}),{code:'PROJECT_EXECUTION_BINDING_REQUIRED'});
  assert.throws(()=>new WorkspaceManager({}, {}, 'host-compat'),{code:'PROJECT_EXECUTION_BINDING_REQUIRED'});
  const manager=new WorkspaceManager({}, {executionMode:'isolated-guest'}, hostExecutionBinding());
  assert.equal(manager.execution.snapshot.mode,'host-compat');assert(Object.isFrozen(manager.execution));manager.changes.dispose();
  const service=Object.freeze({...hostExecutionBinding(),registerWorkspace(){return()=>{};}}),composed=new WorkspaceManager({}, {}, service);assert.equal(composed.execution.snapshot.mode,'host-compat');composed.changes.dispose();
});

test('host fresh and legacy enrollment retain6b behavior and never enter guest enrollment',async t=>{
  const f=await fixture(t,'host-compat');f.manager.ensureIsolatedProject=()=>assert.fail('Guest path called in host mode');
  const a=f.agent(),record=await f.manager.ensureProject(a);assert.equal(record.nativeWorktree,false);assert.equal(record.independentRepository,undefined);
  assert.equal(record.root,path.join(f.projects,a.id));assert.equal(f.grants.length,1);assert.equal(f.writes.length,1);
  await assert.rejects(fs.stat(path.join(record.root,'.git')),{code:'ENOENT'});assert.match(await fs.readFile(path.join(record.root,'.gitignore'),'utf8'),/\.harness\//);
  const legacy=f.agent('legacy');f.manager.existing.add(legacy.id);const old=await f.manager.ensureProject(legacy);assert.equal(old.legacy,true);assert.equal(old.root,f.source);
  assert.equal(f.manager.toolGuard({name:'exec_command',agent:legacy}),undefined);assert.equal(f.grants.length,1);
});

test('host continue keeps selected directory and host worktree uses actual Native-style shared Git metadata',async t=>{
  const continued=await fixture(t,'host-compat','continue'),a=continued.agent(),record=await continued.manager.ensureProject(a);
  assert.equal(record.root,await fs.realpath(continued.source));assert.equal(record.independentRepository,undefined);assert.equal(continued.worktrees.length,0);
  const f=await fixture(t,'host-compat','worktree');await f.git(['init','--initial-branch=main','--template=','.']);await fs.writeFile(path.join(f.source,'app.js'),'committed\n');await f.git(['add','.']);await f.git(['-c','user.name=Synthetic','-c','user.email=test@example.invalid','commit','-m','baseline']);
  await fs.writeFile(path.join(f.source,'app.js'),'dirty source\n');const p=await f.manager.ensureProject(f.agent());
  assert.equal(p.nativeWorktree,true);assert.equal(f.worktrees.length,1);assert(p.gitWritableRoots.length>=3);assert.equal(p.independentRepository,undefined);
  assert.equal(await fs.readFile(path.join(p.root,'app.js'),'utf8'),'committed\n');assert.equal(await fs.readFile(path.join(f.source,'app.js'),'utf8'),'dirty source\n');
});

test('isolated fresh baseline is retained privately before registry, grant or cwd publication',async t=>{
  const f=await fixture(t,'isolated-guest'),a=f.agent(),initialize=f.manager.changes.initialize.bind(f.manager.changes);let captured=false;
  f.ctx.worktrees.create=()=>assert.fail('Shared worktree called in guest mode');
  f.manager.changes.initialize=async(...args)=>{assert.equal(f.manager.data.sessions[a.id],undefined);assert.equal(f.grants.length,0);assert.equal(f.writes.length,0);assert.equal(JSON.parse(await fs.readFile(f.manager.file,'utf8')).sessions[a.id],undefined);const value=await initialize(...args);captured=true;return value;};
  const p=await f.manager.ensureProject(a);assert(captured);assert.equal(p.independentRepository,true);assert.equal(p.nativeWorktree,false);assert.match(p.baseCommit,/^[a-f0-9]{40}$/);
  assert.equal((await fs.lstat(path.join(p.root,'.git'))).isDirectory(),true);f.manager.changes.initialize=initialize;
  assert.equal((await f.manager.changes.list(a.id,p)).baseline.storage,'private-objects-v1');assert.equal(await f.manager.assertIndependentProject(p,a.id),p.root);
});

test('isolated existing host records and continue directories remain unchanged and commands refuse them',async t=>{
  const f=await fixture(t,'isolated-guest'),a=f.agent('old'),old={root:f.source,nativeWorktree:true,gitWritableRoots:['retained-original'],settings:{projectMode:'worktree'}};f.manager.data.sessions[a.id]=old;
  const before=JSON.stringify(old);assert.equal(await f.manager.ensureProject(a),old);assert.equal(JSON.stringify(old),before);assert.equal(f.grants.length,0);assert.equal(f.writes.length,0);assert.equal(f.manager.toolGuard({name:'project_exec',agent:a}).info.code,'PROJECT_RUNTIME_NOT_ISOLATED');
  const c=await fixture(t,'isolated-guest','continue'),continued=await c.manager.ensureProject(c.agent());assert.equal(continued.root,await fs.realpath(c.source));assert.equal(continued.independentRepository,false);await assert.rejects(fs.stat(path.join(c.source,'.harness')),{code:'ENOENT'});assert.equal(c.grants.length,0);
});

test('isolated legacy sessions are retained, and existing independent roots reject shared Git and overlap',async t=>{
  const f=await fixture(t,'isolated-guest'),legacy=f.agent('legacy');f.manager.existing.add(legacy.id);const old=await f.manager.ensureProject(legacy);assert.equal(old.legacy,true);assert.equal(f.manager.toolGuard({name:'bash',agent:legacy,managedProjectShell:true}).info.code,'PROJECT_RUNTIME_NOT_ISOLATED');
  const a=f.agent(),p=await f.manager.ensureProject(a);await fs.mkdir(path.join(p.root,'.git/objects/info'),{recursive:true});await fs.writeFile(path.join(p.root,'.git/objects/info/alternates'),f.source+'\n');
  await assert.rejects(f.manager.assertIndependentProject(p,a.id),{code:'PROJECT_RUNTIME_GIT_SHARED'});await fs.unlink(path.join(p.root,'.git/objects/info/alternates'));
  f.manager.data.sessions.other={root:p.root};await assert.rejects(f.manager.assertIndependentProject(p,a.id),{code:'PROJECT_RUNTIME_SHARED'});delete f.manager.data.sessions.other;
  await assert.rejects(f.manager.assertIndependentProject({...p,root:f.source},a.id),{code:'PROJECT_RUNTIME_NOT_ISOLATED'});
});

test('mode invalidation while queued prevents enrollment effects and invalidation after allocation prevents publication',async t=>{
  const f=await fixture(t,'isolated-guest');let release;f.manager.serial=new Promise(resolve=>release=resolve);const queued=f.manager.ensureProject(f.agent());f.binding.fail();release();await assert.rejects(queued,{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.deepEqual(await fs.readdir(f.projects),[]);assert.equal(f.grants.length,0);
  const g=await fixture(t,'isolated-guest');g.manager.allocatePorts=async()=>{g.binding.fail();return[21000,21001,21002,21003];};await assert.rejects(g.manager.ensureProject(g.agent()),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});
  assert.equal(g.manager.data.sessions.one,undefined);assert.equal(g.grants.length,0);assert.equal(g.writes.length,0);assert.equal((await fs.lstat(path.join(g.projects,'one','.git'))).isDirectory(),true); // Unpublished new files retained, never deleted.
});

test('file lease rechecks binding after await and still releases the exact lease',async t=>{
  const f=await fixture(t,'host-compat'),a=f.agent();await f.manager.ensureProject(a);f.manager.releaseIfIdle=async()=>{};let entered,release,released=0,effects=0;const ready=new Promise(resolve=>entered=resolve);
  f.manager.locks.acquire=async()=>{entered();await new Promise(resolve=>release=resolve);};f.manager.locks.release=async()=>{released++;};
  const pending=f.manager.withFiles(a.id,()=>{effects++;},true);await ready;f.binding.fail();release();await assert.rejects(pending,{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(effects,0);assert.equal(released,1);
});

test('host file dispatch preserves versioned writes and blocks a stale resolve before a second write',async t=>{
  const f=await fixture(t,'host-compat'),a=f.agent();await f.manager.ensureProject(a);const calls=[];
  f.ctx.fs={resolve:async file=>file,processPath:file=>file,writeText:async(...args)=>{calls.push(args);return{version:'next'};}};
  assert.deepEqual(await f.manager.files(a.id,'write',{path:'new.txt',text:'new',version:'previous'}),{version:'next'});assert.equal(calls.length,1);assert.deepEqual(calls[0][2],{kind:'replaceIfVersion',version:'previous'});
  f.ctx.fs.resolve=async file=>{f.binding.fail();return file;};await assert.rejects(f.manager.files(a.id,'write',{path:'new.txt',text:'blocked',version:'next'}),{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(calls.length,1);
});

test('a model step waiting on its project lease cannot continue under a changed launch',async t=>{
  const f=await fixture(t,'host-compat'),a=f.agent();await f.manager.ensureProject(a);let entered,release,released=0;const ready=new Promise(resolve=>entered=resolve);
  f.manager.locks.acquire=async()=>{entered();await new Promise(resolve=>release=resolve);};f.manager.locks.release=async()=>{released++;};
  const pending=f.manager.preStep({agent:a,signal:new AbortController().signal,turn:1,step:1,messages:[]});await ready;f.binding.fail();release();await assert.rejects(pending,{code:'PROJECT_EXECUTION_BINDING_CHANGED'});assert.equal(released,1);assert.equal(f.manager.running.has(a.id),false);
});

test('actual manager plus authority context intersects readonly child and refuses legacy/path policy changes',async t=>{
  const f=await fixture(t,'isolated-guest'),owner=f.agent(),record=await f.manager.ensureProject(owner),child=f.agent('child',{origin:'subagent',parentSession:owner.id});child.session.mode='read-only';
  const input={sessionId:owner.id,accessSessionId:child.id,op:'execute',kind:'executor',generation:'a'.repeat(32)};
  const value=await runtimeContext(f.ctx,f.manager,input);assert.equal(value.readOnly,true);assert.equal(value.projectRoot,record.root);
  child.session.mode='unknown';await assert.rejects(runtimeContext(f.ctx,f.manager,input),{code:'PROJECT_RUNTIME_POLICY_UNAVAILABLE'});child.session.mode='read-only';record.nativeWorktree=true;await assert.rejects(runtimeContext(f.ctx,f.manager,input),{code:'PROJECT_RUNTIME_NOT_ISOLATED'});
});
