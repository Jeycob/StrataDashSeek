// ROOT-ONLY SOURCE FIXTURE; no execution authorization. Real owned loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createProjectCommandRunner} from './project-tool.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import {createOwnPeerConnector} from './host-peer-connector.mjs';
import {pinRealLandlock} from './fixtures/host-peer-backend.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function until(check,ms=3000){const end=Date.now()+ms;while(true){const result=await check();if(result)return result;assert(Date.now()<end,'bounded fixture wait expired');await new Promise(resolve=>setTimeout(resolve,10));}}
function readReply(socket){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture response timeout')),1000);socket.once('data',data=>{clearTimeout(timer);resolve(data.toString());});socket.once('error',reject);socket.resume();socket.write('OWNED_FIXTURE_ONLY');});}
test('Root actual confined SDK peer attribution rejects foreign tuple and forwards no early bytes',{skip:process.platform!=='linux',timeout:30000},async t=>{
 assert.equal(process.getuid(),0,'Root must explicitly own the fixture');assert.equal(process.env.HOMEAI_HOST_PEER_LINUX_FIXTURE,'1','explicit inert-loopback fixture selection required');
 const runtime=process.env.HOMEAI_RUNTIME;assert(runtime&&path.isAbsolute(runtime),'explicit already-installed pinned runtime required');
 const sdkRoot=path.join(runtime,'node_modules/@deepseek-ai'),load=name=>import(pathToFileURL(path.join(sdkRoot,name,'lib/index.js')));
 const [C,P,T,J,S,SP,SB,B]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-jobs-local','dsh-scope','dsh-subprocess-local','dsh-sandbox-local','dsh-bash-sandbox'].map(load));
 const directory=await fs.mkdtemp('/var/lib/homeai-host-peer-fixture-'),root=path.join(directory,'project');let run,scope,ctx,foreign;const retained=new Set(),foreignSockets=new Set();
 t.after(async()=>{for(const peer of retained)peer.close();for(const socket of foreignSockets)socket.destroy();if(foreign)await new Promise(resolve=>foreign.close(resolve));if(run)await run.dispose();if(scope)await scope.dispose();if(ctx)await ctx.fiber.dispose();assert.equal(path.dirname(directory),'/var/lib');assert(path.basename(directory).startsWith('homeai-host-peer-fixture-'));assert.equal(await fs.realpath(directory),directory);await fs.rm(directory,{recursive:true,force:true});});
 await fs.mkdir(path.join(root,'.harness'),{recursive:true});await fs.writeFile(path.join(root,'.harness/project.json'),JSON.stringify({ports:[21000,21001,21002,21003],databasePath:path.join(root,'.harness/data/app.sqlite')}));
 ctx=new C.Context();new P.default(ctx,{});new T.default(ctx);const agents=new Map();ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});ctx.provide('shellEnv',{collect:()=>({})});ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>({mode:'workspace-write',workspaceRoot:root,additionalWritableRoots:[]})});
 new SP.default(ctx);const sandbox=new SB.default(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:5000});
 // Explicit real probe + one pinned same-host backend; no automatic bwrap fallback.
 const enforcement=pinRealLandlock(sandbox);t.diagnostic('real Landlock probe: '+enforcement);
 const cell=value=>({get:()=>value});new B.SandboxBashExecutor(ctx,Object.fromEntries(Object.entries({cwd:root,timeoutMs:60000,maxTimeoutMs:600000,maxOutputBytes:65536,maxSpillBytes:1048576,graceMs:1000}).map(([key,value])=>[key,cell(value)])));new J.default(ctx,{maxConcurrentJobsPerOwner:2,retainBytes:65536,settledRetainBytes:16384,pumpPollMs:2});ctx.jobs.attachController('Root own-peer fixture');
 let seq=0;const agent={id:'own-peer-fixture',status:'idle',inbox:{nextStep:[]},session:{id:'own-peer-fixture',header:{},append(type,data){return{type,data,seq:seq++};}},inject(){},followup(){}};scope=S.createScope(ctx,agent);agent.ctx=scope.ctx;agents.set(agent.id,agent);
 const manager={ownerAgent:value=>value,data:{sessions:{[agent.id]:{root,workspaceId:'fixture-workspace'}}}};run=createProjectCommandRunner(ctx,manager,{nodePath:process.execPath,wrapperPath:fileURLToPath(new URL('../development/project-run.cjs',import.meta.url))},hostExecutionBinding());
 const source="const net=require('node:net');const server=net.createServer(socket=>socket.on('data',bytes=>{console.log('RECEIVED:'+bytes.toString('hex'));socket.write('ACK');}));server.listen(0,'127.0.0.1',()=>console.log('FIXTURE_PORT:'+server.address().port));";
 const background=await run.startWithCustody({command:quote(process.execPath)+' -e '+quote(source),description:'Root own-peer confined fixture',run_in_background:true,timeoutMs:15000},{agent,callId:'own-peer-fixture',signal:new AbortController().signal});
 assert.equal(sandbox.selectedRunner.runner,'landlock','the executed SDK backend must be Landlock');
 const lease=await run.custodyFor(background.jobId,agent.id);lease.assertCurrent();assert.equal(lease.identity.pidNamespace,await fs.readlink('/proc/self/ns/pid'),'same-host PID namespace is required; bwrap PID isolation is unsupported, never guessed');
 let output='';const collect=()=>{const result=ctx.jobs.read(background.jobId,agent.id);assert.equal(result.lossy,false);output+=JSON.stringify(result.chunks);return output;};
 const port=await until(()=>{const match=/FIXTURE_PORT:(\d+)/.exec(collect());return match&&Number(match[1]);});assert(!output.includes('RECEIVED:'));
 const revoked=new AbortController(),target={jobId:background.jobId,owner:agent.id,generation:lease.identity.generation,projectSessionId:lease.context.projectSessionId,workspaceId:lease.context.workspaceId,projectId:'fixture-project',projectRoot:root,uid:process.getuid(),signal:revoked.signal,assertCurrent(){lease.assertCurrent();assert.equal(manager.data.sessions[agent.id].root,root);assert.equal(manager.data.sessions[agent.id].workspaceId,'fixture-workspace');assert(!revoked.signal.aborted);}};
 const connector=selectedPort=>createOwnPeerConnector({custodyFor:run.custodyFor,binding:()=>Object.freeze({...target,port:selectedPort})});
 const peer=await connector(port).connect({deadline:Date.now()+2500});retained.add(peer);assert.equal(peer.socket.bytesWritten,0);assert.equal(peer.evidence.target.projectId,'fixture-project');assert.notEqual(peer.evidence.holder.pid,process.pid);assert.equal(peer.evidence.inode.length>0,true);assert(!collect().includes('RECEIVED:'));assert.equal(await readReply(peer.socket),'ACK');await until(()=>collect().includes('RECEIVED:4f574e45445f464958545552455f4f4e4c59'));peer.close();await peer.done;
 let foreignBytes=0;foreign=net.createServer(socket=>{foreignSockets.add(socket);socket.on('data',bytes=>{foreignBytes+=bytes.length;});socket.on('close',()=>foreignSockets.delete(socket));});await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
 await assert.rejects(()=>connector(foreign.address().port).connect({deadline:Date.now()+2500}));await until(()=>foreignSockets.size===0);assert(foreign.listening,'connector must not stop another listener');assert.equal(foreignBytes,0);
 const revokedPeer=await connector(port).connect({deadline:Date.now()+2500});retained.add(revokedPeer);revoked.abort();await revokedPeer.done;assert(ctx.jobs.get(background.jobId,agent.id),'revocation closes only connection, not producer');
 // Separate fresh trusted binding permits verifying lease.done closure too.
 const activeTarget={...target,signal:new AbortController().signal,assertCurrent(){lease.assertCurrent();}};const last=await createOwnPeerConnector({custodyFor:run.custodyFor,binding:()=>Object.freeze({...activeTarget,port})}).connect({deadline:Date.now()+2500});retained.add(last);ctx.jobs.kill(background.jobId,agent.id,'Root fixture complete');await lease.done;await last.done;assert(last.socket.destroyed);
});
