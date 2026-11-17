// Root's nonproduction Linux fixture. No Native/model/VM/network/install.
// Landlock positive qualification and bwrap namespace refusal are distinct.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createProjectCommandRunner} from './project-tool.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import protocol from '../development/project-custody.cjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const backend=process.env.HARNESS_CUSTODY_FIXTURE_BACKEND??'landlock';
if(process.platform==='linux'&&!['landlock','bwrap'].includes(backend))throw Error('Select landlock or bwrap explicitly; no automatic backend fallback');
async function eventually(check){const deadline=Date.now()+5000;while(!await check()){assert(Date.now()<deadline,'bounded Linux fixture wait');await new Promise(resolve=>setTimeout(resolve,10));}}
for(const selected of ['landlock','bwrap'])test(selected==='landlock'
 ?'actual pinned Landlock SDK proves same-host custody and write confinement'
 :'actual pinned bwrap is refused as same-host PID custody (not positive qualification)',
 {skip:process.platform!=='linux'||backend!==selected,timeout:30000},async t=>{
 assert.notEqual(process.getuid(),0,'Root prepares the directory; run fixture as the existing nonroot service account');
 const approved=process.env.HARNESS_CUSTODY_FIXTURE_ROOT;
 assert.match(approved??'',/^\/var\/lib\/homeai-custody-fixture-[A-Za-z0-9]{8,32}$/,'Root must prepare a fresh synthetic directory');
 assert.equal(await fs.realpath(approved),approved);const info=await fs.lstat(approved);
 assert(info.isDirectory()&&!info.isSymbolicLink());assert.equal(info.uid,process.getuid());
 const sdkRoot=path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai');
 const load=async name=>import(pathToFileURL(path.join(sdkRoot,name,'lib/index.js')));
 const [C,P,T,J,S,SP,SB,B]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-jobs-local','dsh-scope','dsh-subprocess-local','dsh-sandbox-local','dsh-bash-sandbox'].map(load));
 const directory=await fs.mkdtemp(path.join(approved,'run-')),root=path.join(directory,'project'),outside=path.join(directory,'protected','sentinel');
 // Pinned Landlock grants /tmp RW. The synthetic sentinel must be elsewhere.
 assert(!outside.startsWith(root+path.sep)&&!outside.startsWith('/tmp/'));
 await fs.mkdir(path.dirname(outside),{recursive:true});await fs.mkdir(path.join(root,'.harness'),{recursive:true});await fs.writeFile(outside,'preserve');
 await fs.writeFile(path.join(root,'.harness/project.json'),JSON.stringify({ports:[21000,21001,21002,21003],databasePath:path.join(root,'.harness/data/app.sqlite')}));
 const marker=path.join(root,'startup-injection'),hook=path.join(root,'hook.sh'),preload=path.join(root,'preload.cjs');
 await fs.writeFile(hook,`printf 'spoofed startup frame\\n'; touch ${quote(marker)}\n`);
 await fs.writeFile(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'injected');`);
 const ctx=new C.Context();new P.default(ctx,{});new T.default(ctx);const agents=new Map();
 ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});ctx.provide('shellEnv',{collect:()=>({})});
 ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>({mode:'workspace-write',workspaceRoot:root,additionalWritableRoots:[]})});
 new SP.default(ctx);const sandbox=new SB.default(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000});
 // Pin a real backend via the SDK source test seam. No fake successful probe
 // or replacement executor; never automatically fall back between backends.
 const verdict=sandbox.probeRunner(selected);sandbox.internals.chain=[selected];
 const cell=value=>({get:()=>value});
 new B.SandboxBashExecutor(ctx,Object.fromEntries(Object.entries({cwd:root,timeoutMs:60000,maxTimeoutMs:600000,maxOutputBytes:65536,maxSpillBytes:1048576,graceMs:1000}).map(([k,v])=>[k,cell(v)])));
 new J.default(ctx,{maxConcurrentJobsPerOwner:2,retainBytes:65536,settledRetainBytes:16384,pumpPollMs:2});ctx.jobs.attachController('custody Linux fixture');
 let seq=0;const agent={id:'custody-linux',status:'idle',inbox:{nextStep:[]},session:{id:'custody-linux',header:{},append(type,data){return{type,data,seq:seq++};}},inject(){},followup(){}};
 const scope=S.createScope(ctx,agent);agent.ctx=scope.ctx;agents.set(agent.id,agent);
 const manager={ownerAgent:a=>a,data:{sessions:{[agent.id]:{root,workspaceId:'linux-fixture'}}}},wrapper=fileURLToPath(new URL('../development/project-run.cjs',import.meta.url));
 const run=createProjectCommandRunner(ctx,manager,{nodePath:process.execPath,wrapperPath:wrapper},hostExecutionBinding()),saved=new Map();
 t.after(async()=>{
  for(const [key,value]of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;
  await run.dispose();await scope.dispose();await ctx.fiber.dispose();
  assert(path.resolve(directory).startsWith(approved+path.sep+'run-'));assert.equal(await fs.realpath(directory),directory);await fs.rm(directory,{recursive:true,force:true});
 });
 if(selected==='bwrap'&&verdict==='unusable'){t.skip('bwrap unavailable: namespace refusal NOT EXERCISED');return;}
 assert.notEqual(verdict,'unusable','Landlock positive backend must be usable; no fallback');
 const hostile={BASH_ENV:hook,ENV:hook,NODE_OPTIONS:'--require '+preload,NODE_PATH:root,LD_PRELOAD:'/nonexistent-custody-preload.so','BASH_FUNC_exec%%':`() { printf 'spoofed function\\n'; touch ${quote(marker)}; }`};
 for(const [key,value]of Object.entries(hostile)){saved.set(key,process.env[key]);process.env[key]=value;}
 const source=`const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(outside)},'escaped');console.log('ESCAPED')}catch{console.log('DENIED')}console.log('READY');console.log('HOMEAI_CUSTODY_V1 user text');setInterval(()=>{},1000);`;
 const execution={agent,callId:'linux-custody',signal:new AbortController().signal};let result;
 try{result=await run.startWithCustody({command:quote(process.execPath)+' -e '+quote(source),description:'Linux confined custody fixture',run_in_background:true,timeoutMs:10000},execution);}catch(error){
  if(selected!=='bwrap')throw error;
  // PID1/parent0 is rejected by the wrapper protocol before child launch.
  // Require evidence of that refusal; unrelated startup failures do not pass.
  assert.equal(error.code,'PROJECT_CUSTODY_EXITED');let output='';
  await eventually(()=>{for(const job of ctx.jobs.list(agent.id))output+=JSON.stringify(ctx.jobs.read(job.id,agent.id).chunks);return output.includes('PROJECT_CUSTODY_PROTOCOL_INVALID');});
  assert(!output.includes('READY'));assert.equal(await fs.readFile(outside,'utf8'),'preserve');await assert.rejects(fs.access(marker));
  t.diagnostic('bwrap refused namespaced wrapper before acknowledgement; no host PID guessed');return;
 }
 assert.equal(sandbox.selectedRunner.runner,selected);
 const lease=await run.custodyFor(result.jobId,agent.id);lease.assertCurrent();const hostNamespace=await fs.readlink('/proc/self/ns/pid');
 if(selected==='bwrap'){
  assert.notEqual(lease.identity.pidNamespace,hostNamespace,'pinned bwrap must unshare PID namespace');
  // Refuse host qualification. Never read host /proc/<namespace-pid>.
  ctx.jobs.kill(result.jobId,agent.id,'unsupported PID namespace');await lease.done;
  assert.throws(lease.assertCurrent,{code:'PROJECT_CUSTODY_EXPIRED'});t.diagnostic('different PID namespace intentionally unsupported; NOT same-host custody qualification');return;
 }
 assert.equal(lease.identity.pidNamespace,hostNamespace,'Landlock positive proof requires same-host namespace');
 const stat=protocol.identityFromStat(await fs.readFile('/proc/'+lease.identity.pid+'/stat','utf8'),lease.identity.pid);assert.equal(stat.startTicks,lease.identity.startTicks);
 let output='';await eventually(()=>{const read=ctx.jobs.read(result.jobId,agent.id);assert.equal(read.lossy,false);output+=JSON.stringify(read.chunks);return output.includes('READY')&&output.includes('HOMEAI_CUSTODY_V1 user text');});
 assert(output.includes('DENIED'));assert(!output.includes('ESCAPED'));assert(!output.includes(lease.identity.generation));assert(!output.includes('spoofed'));assert.equal(await fs.readFile(outside,'utf8'),'preserve');
 await assert.rejects(fs.access(marker));ctx.jobs.kill(result.jobId,agent.id,'fixture finished');await lease.done;assert.throws(lease.assertCurrent,{code:'PROJECT_CUSTODY_EXPIRED'});
});
