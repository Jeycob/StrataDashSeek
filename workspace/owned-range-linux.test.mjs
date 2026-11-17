// ROOT-OPERATOR ONLY, prepared source, NOT run by B. Owned synthetic range only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeRequire} from '../runtime/require.cjs';
import OwnedRangeSubprocess from './owned-range-subprocess.mjs';
import {createProjectCommandRunner} from './project-tool.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import {bindHeavyToolLease} from '../efficiency/heavy-tool-lease.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function until(check,ms=5000){const end=Date.now()+ms;while(true){if(await check())return;assert(Date.now()<end,'bounded owned range fixture wait');await new Promise(resolve=>setTimeout(resolve,10));}}
test('actual confined leader exits but TERM-trapping descendant holds job and permit until exact owned range stops',{skip:process.platform!=='linux',timeout:20000},async t=>{
 assert.equal(process.env.HOMEAI_OWNED_RANGE_LINUX_FIXTURE,'1','Root explicit fixture selection required');
 const prepared=process.env.HOMEAI_OWNED_RANGE_FIXTURE_ROOT;assert.match(prepared??'',/^\/var\/lib\/homeai-owned-range-fixture-[A-Za-z0-9]{12}$/);assert.equal(await fs.realpath(prepared),prepared);
 const stat=await fs.lstat(prepared);assert(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(stat.uid,process.getuid());assert.equal(stat.gid,process.getgid());assert.equal(stat.mode&0o7777,0o700);assert.deepEqual(await fs.readdir(prepared),[],'fresh operator-prepared fixture only');
 const root=await fs.mkdtemp(path.join(prepared,'run-'));const identity=await fs.lstat(root);
 await fs.mkdir(path.join(root,'.harness'));await fs.writeFile(path.join(root,'.harness/project.json'),JSON.stringify({ports:[21000,21001,21002,21003],databasePath:path.join(root,'.harness/data/app.sqlite')}));
 const {Context}=runtimeRequire('@deepseek-ai/cordis'),{default:SystemPrompt}=runtimeRequire('@deepseek-ai/dsh-system-prompt'),{default:Tools}=runtimeRequire('@deepseek-ai/dsh-tools'),{default:Sandbox}=runtimeRequire('@deepseek-ai/dsh-sandbox-local'),{SandboxBashExecutor}=runtimeRequire('@deepseek-ai/dsh-bash-sandbox'),{default:Jobs}=runtimeRequire('@deepseek-ai/dsh-jobs-local'),{createScope}=runtimeRequire('@deepseek-ai/dsh-scope');
 const ctx=new Context();new SystemPrompt(ctx,{});new Tools(ctx);const agent={id:'own-range',status:'idle',session:{id:'own-range',header:{},append(type,data){return{seq:1,type,data};}},inbox:{nextStep:[]},inject(){},followup(){}};
 ctx.provide('agents',{get:id=>id===agent.id?agent:undefined,list:()=>[agent]});ctx.provide('shellEnv',{collect:()=>({})});ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>({mode:'workspace-write',workspaceRoot:root})});
 new OwnedRangeSubprocess(ctx);new Sandbox(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000});const cell=value=>({get:()=>value});new SandboxBashExecutor(ctx,Object.fromEntries(Object.entries({cwd:root,timeoutMs:60000,maxTimeoutMs:600000,maxOutputBytes:65536,maxSpillBytes:1048576,graceMs:500}).map(([k,v])=>[k,cell(v)])));
 new Jobs(ctx,{maxConcurrentJobsPerOwner:2,retainBytes:65536,settledRetainBytes:16000,pumpPollMs:2});ctx.jobs.attachController('Root owned-range fixture');const scope=createScope(ctx,agent);agent.ctx=scope.ctx;
 const manager={ownerAgent:a=>a,data:{sessions:{[agent.id]:{root,workspaceId:'own-range'}}}},run=createProjectCommandRunner(ctx,manager,{nodePath:process.execPath,wrapperPath:fileURLToPath(new URL('../development/project-run.cjs',import.meta.url))},hostExecutionBinding());
 t.after(async()=>{await run.dispose();await scope.dispose();await ctx.fiber.dispose();assert.equal(await fs.realpath(prepared),prepared);assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),prepared);assert.match(path.basename(root),/^run-[A-Za-z0-9]{6}$/);const after=await fs.lstat(root),outer=await fs.lstat(prepared);for(const key of ['dev','ino','uid','gid','mode']){assert.equal(after[key],identity[key]);assert.equal(outer[key],stat[key]);}await fs.rm(root,{recursive:true,force:false});});
 const onTerm='printf TERM > '+quote(path.join(root,'term-observed'))+'; sleep 0.2; exit 0',child='trap '+quote(onTerm)+' TERM; printf READY > '+quote(path.join(root,'child-ready'))+'; while :; do sleep 1; done';
 const command='bash -c '+quote(child)+' >/dev/null 2>&1 & while [ ! -f '+quote(path.join(root,'child-ready'))+' ]; do sleep 0.01; done; sleep 0.2; exit 0';
 const execution={agent,callId:'range-linux',signal:new AbortController().signal};let permitsReleased=0;const release=bindHeavyToolLease(execution,{release(){permitsReleased++;}});
 const background=await run.startWithCustody({command,description:'Own TERM descendant fixture',run_in_background:true,timeoutMs:10000},execution),lease=await run.custodyFor(background.jobId,agent.id);release();let done=false;void lease.done.then(()=>{done=true;});
 assert.equal(lease.identity.pidNamespace,await fs.readlink('/proc/self/ns/pid'),'requires actual same-host backend; no backend override/fallback');
 await until(async()=>{try{await fs.stat('/proc/'+lease.identity.pid);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}});assert.equal(await fs.readFile(path.join(root,'child-ready'),'utf8'),'READY');assert.equal(done,false);assert.equal(permitsReleased,0);
 const stop=run.stopOwned(background.jobId,agent.id);await until(async()=>fs.stat(path.join(root,'term-observed')).then(()=>true,()=>false));assert.equal(done,false);assert.equal(permitsReleased,0);
 await stop;await lease.done;assert.equal(done,true);assert.equal(permitsReleased,1);assert.equal(await fs.readFile(path.join(root,'term-observed'),'utf8'),'TERM');
});
