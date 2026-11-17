// Root's nonproduction Linux fixture. No Native web server, model, VM, network,
// package installation or preview endpoint. Missing confinement FAILS on Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createProjectCommandRunner} from './project-tool.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import protocol from '../development/project-custody.cjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function eventually(check){const deadline=Date.now()+5000;while(!await check()){assert(Date.now()<deadline,'bounded Linux fixture wait');await new Promise(resolve=>setTimeout(resolve,10));}}
test('actual pinned Linux confined SDK wrapper defeats startup injection and filters its first frame', {skip:process.platform!=='linux',timeout:30000},async t=>{
 const sdkRoot=path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai');
 const load=async name=>import(pathToFileURL(path.join(sdkRoot,name,'lib/index.js')));
 const [C,P,T,J,S,SP,SB,B]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-jobs-local','dsh-scope','dsh-subprocess-local','dsh-sandbox-local','dsh-bash-sandbox'].map(load));
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'custody-linux-')),root=path.join(directory,'project'),outside=path.join(directory,'outside');
 await fs.mkdir(path.join(root,'.harness'),{recursive:true});await fs.writeFile(outside,'preserve');
 await fs.writeFile(path.join(root,'.harness/project.json'),JSON.stringify({ports:[21000,21001,21002,21003],databasePath:path.join(root,'.harness/data/app.sqlite')}));
 const marker=path.join(root,'startup-injection'),hook=path.join(root,'hook.sh'),preload=path.join(root,'preload.cjs');
 await fs.writeFile(hook,`printf 'spoofed startup frame\\n'; touch ${quote(marker)}\n`);
 await fs.writeFile(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'injected');`);
 const ctx=new C.Context();new P.default(ctx,{});new T.default(ctx);const agents=new Map();
 ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});ctx.provide('shellEnv',{collect:()=>({})});
 ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>({mode:'workspace-write',workspaceRoot:root,additionalWritableRoots:[]})});
 new SP.default(ctx);new SB.default(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000});
 const cell=value=>({get:()=>value});
 new B.SandboxBashExecutor(ctx,Object.fromEntries(Object.entries({cwd:root,timeoutMs:60000,maxTimeoutMs:600000,maxOutputBytes:65536,maxSpillBytes:1048576,graceMs:1000}).map(([k,v])=>[k,cell(v)])));
 new J.default(ctx,{maxConcurrentJobsPerOwner:2,retainBytes:65536,settledRetainBytes:16384,pumpPollMs:2});ctx.jobs.attachController('custody Linux fixture');
 let seq=0;const agent={id:'custody-linux',status:'idle',inbox:{nextStep:[]},session:{id:'custody-linux',header:{},append(type,data){return{type,data,seq:seq++};}},inject(){},followup(){}};
 const scope=S.createScope(ctx,agent);agent.ctx=scope.ctx;agents.set(agent.id,agent);
 const manager={ownerAgent:a=>a,data:{sessions:{[agent.id]:{root,workspaceId:'linux-fixture'}}}},wrapper=fileURLToPath(new URL('../development/project-run.cjs',import.meta.url));
 const run=createProjectCommandRunner(ctx,manager,{nodePath:process.execPath,wrapperPath:wrapper},hostExecutionBinding());
 const saved=new Map(),hostile={BASH_ENV:hook,ENV:hook,NODE_OPTIONS:'--require '+preload,NODE_PATH:root,LD_PRELOAD:'/nonexistent-custody-preload.so','BASH_FUNC_exec%%':`() { printf 'spoofed function\\n'; touch ${quote(marker)}; }`};
 for(const [key,value]of Object.entries(hostile)){saved.set(key,process.env[key]);process.env[key]=value;}
 t.after(async()=>{
  for(const [key,value]of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;
  await run.dispose();await scope.dispose();await ctx.fiber.dispose();
  assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'custody-linux-'));await fs.rm(directory,{recursive:true,force:true});
 });
 const source=`const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(outside)},'escaped');console.log('ESCAPED')}catch{console.log('DENIED')}console.log('READY');console.log('HOMEAI_CUSTODY_V1 user text');setInterval(()=>{},1000);`;
 const execution={agent,callId:'linux-custody',signal:new AbortController().signal};
 const result=await run.startWithCustody({command:quote(process.execPath)+' -e '+quote(source),description:'Linux confined custody fixture',run_in_background:true,timeoutMs:10000},execution);
 const lease=await run.custodyFor(result.jobId,agent.id);lease.assertCurrent();
 assert.equal(lease.identity.pidNamespace,await fs.readlink('/proc/self/ns/pid'),'fixture requires the captured host PID namespace, not a guessed namespace PID');
 const stat=protocol.identityFromStat(await fs.readFile('/proc/'+lease.identity.pid+'/stat','utf8'),lease.identity.pid);assert.equal(stat.startTicks,lease.identity.startTicks);
 let output='';await eventually(()=>{const read=ctx.jobs.read(result.jobId,agent.id);assert.equal(read.lossy,false);output+=JSON.stringify(read.chunks);return output.includes('READY')&&output.includes('HOMEAI_CUSTODY_V1 user text');});
 assert(output.includes('DENIED'));assert(!output.includes(lease.identity.generation));assert(!output.includes('spoofed'));assert.equal(await fs.readFile(outside,'utf8'),'preserve');
 await assert.rejects(fs.access(marker));ctx.jobs.kill(result.jobId,agent.id,'fixture finished');await lease.done;assert.throws(lease.assertCurrent,{code:'PROJECT_CUSTODY_EXPIRED'});
});
