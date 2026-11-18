// Actual pinned SDK tools/jobs/pipeline, mocked processes/connectors only.
// No real SDK subprocess, Linux proc access, TLS, Native server or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {createHostPreview} from './host-preview.mjs';
import {createPreviewRelay} from './host-preview-relay.mjs';
import brokerModule from './editor-broker.cjs';
import {createProjectCommandRunner,registerProjectTool} from './project-tool.mjs';
import {createProjectExecutionMode} from './execution-mode-service.mjs';
import {hostExecutionBinding} from './fixtures/execution-binding.mjs';
import {apply as applyEfficiency} from '../efficiency/plugin.mjs';
import {apply as applyQuality} from '../quality/plugin.mjs';
import protocol from '../development/project-custody.cjs';
let modules;
function sdk(){return modules??=(async()=>{
 const cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js'),base=path.resolve(path.dirname(cli),'../..');
 const load=name=>import(pathToFileURL(path.join(base,name,'lib/index.js')));
 const [C,P,T,J,S,pipeline,output,sandbox,workspace]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-jobs-local'),load('dsh-scope'),import(pathToFileURL(path.join(base,'dsh-tools/lib/pipeline.js'))),import(pathToFileURL(path.join(base,'dsh-subprocess-local/lib/output.js'))),load('dsh-sandbox-local'),load('dsh-workspace')]);
 return{...C,SystemPrompt:P.default,Tools:T.default,Jobs:J.default,...S,...pipeline,...output,Sandbox:sandbox.default,workspaceDomainState:workspace.workspaceDomainState};
})();}
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let n=0;n<200;n++){if(await check())return;await tick();}assert.fail('bounded fixture wait');}
const config={enabled:true,ownerOrigin:'https://same.test',endpoints:[{origin:'https://same.test:8443',listenerPort:18190},{origin:'https://same.test:8444',listenerPort:18191}]};
const args={command:'node fixture-server.mjs',description:'Start own synthetic app',run_in_background:true,timeoutMs:60000};
async function fixture(t,{enabled=true,heavy=false,operationMs=1000,transport=false,bindWait,noAckAt=-1}={}){
 const S=await sdk(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'host-preview-sdk-')),projects=path.join(directory,'projects'),state=path.join(directory,'state');
 await fs.mkdir(projects);await fs.mkdir(state);
 const ctx=new S.Context();new S.SystemPrompt(ctx,{});new S.Tools(ctx);
 ctx.provide('projectExecutionMode',createProjectExecutionMode(hostExecutionBinding()).service);
 const agents=new Map(),scopes=[],workspaces=[],routes=new Map(),events=new Map(),processes=[],calls=[],targets=[],brokers=[],relays=[];
 ctx.provide('agents',{get:id=>agents.get(id),list:()=>[...agents.values()]});
 // Use the pinned SDK's actual domain schema: the public archive view is a
 // readonly SessionId ARRAY, not a Set. Freeze it to catch consumer mutation.
 let workspaceState=S.workspaceDomainState.parse({initialized:true,workspaceIds:[],archivedSessionIds:[],pinnedSessionIds:[]});Object.freeze(workspaceState.archivedSessionIds);
 const archive=id=>{workspaceState=S.workspaceDomainState.parse({...workspaceState,archivedSessionIds:[...workspaceState.archivedSessionIds,id]});Object.freeze(workspaceState.archivedSessionIds);};
 ctx.provide('workspaceRegistry',{list:()=>workspaces,get archivedSessionIds(){return workspaceState.archivedSessionIds;}});
 ctx.provide('shellEnv',{collect:()=>({})});ctx.provide('sandboxPolicy',{resolve:({session})=>({mode:session.mode??'workspace-write'})});
 // Synthetic sole-rung selection: no real probe/process. Production uses the
 // actual unchanged selected backend and never receives internals overrides.
 const sandbox=new S.Sandbox(ctx,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:2000});sandbox.internals={platform:'linux',chain:['landlock']};
 ctx.provide('connection',{fetch:{register:route=>{routes.set(route.path,route);return()=>routes.delete(route.path);}}});
 ctx.provide('shell',{sandboxMode:'workspace-write',resolve:request=>({...request}),async execute(spec){
  calls.push(spec);const out=new S.OutputCollector(65536,'preview fake process'),control=JSON.parse(spec.stdin);let finish;
  if(processes.length!==noAckAt){out.push(protocol.frame(control,{pid:1234+processes.length,ppid:12,pgrp:12,startTicks:String(987654+processes.length),pidNamespace:'pid:[12345]'}));out.push(Buffer.from('app output\n'));}
  const process={status:'running',exitCode:null,signal:null,kills:0,hold:false,done:new Promise(resolve=>{finish=resolve;}),observed:{stdout:out,stderr:{readFrom:from=>({text:'',nextOffset:from,lossy:false})}},release(){if(process.status!=='running')return;process.status='killed';process.signal='SIGTERM';finish();},kill(){if(process.status!=='running')return false;process.kills++;if(!process.hold)process.release();return true;}};
  spec.signal.addEventListener('abort',()=>process.kill(),{once:true});processes.push(process);return process;
 }});
 new S.Jobs(ctx,{maxConcurrentJobsPerOwner:4,retainBytes:65536,settledRetainBytes:16384,pumpPollMs:2});ctx.jobs.attachController('preview source fixture');
 const manager={root:state,projectsRoot:projects,data:{sessions:{},trash:{}},ownerAgent(agent){while(agent?.session.header.origin==='subagent')agent=agents.get(agent.session.header.parentSession);return agent;},async projectFor(id){const a=agents.get(id);return{root:manager.data.sessions[id]?.root,live:a?.session,header:a?.session.header};}};
 const run=createProjectCommandRunner(ctx,manager,{captureBackgroundCustody:true},ctx.projectExecutionMode);registerProjectTool(ctx,manager,run,ctx.projectExecutionMode);
 const pipeline=new S.ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>S.executeToolBatch(input,pipeline,()=>1)});
 if(heavy)await applyEfficiency(ctx,{stateDirectory:path.join(directory,'efficiency'),engineMetrics:false});
 let rejectPeer=false;
 const trusted={supported:()=>true,uid:()=>1001,operationMs,
  connector({binding,custodyFor}){return{async connect(options){options.signal?.throwIfAborted();const target=await binding();target.assertCurrent();assert(Object.isFrozen(target));const capture=await custodyFor(target.jobId,target.owner);assert.equal(capture.identity.generation,target.generation);targets.push(target);if(rejectPeer)throw Object.assign(Error('foreign peer PRIVATE_MESSAGE_SENTINEL'),{code:'PEER_UNATTRIBUTED',peerDiagnostic:{phase:'peer-proof',dialAttempts:1,established:true,lastConnectCode:null},privateDetail:'PRIVATE_DETAIL_SENTINEL'});let finish;
   if(transport){const socket=new net.Socket();socket.pause();socket.on('error',()=>{});const done=new Promise(resolve=>socket.once('close',resolve));const close=()=>socket.destroy();options.signal?.addEventListener('abort',close,{once:true});target.signal.addEventListener('abort',close,{once:true});void capture.done.then(close);socket.once('close',()=>{options.signal?.removeEventListener('abort',close);target.signal.removeEventListener('abort',close);});await new Promise((resolve,reject)=>{socket.once('error',reject);socket.connect(target.port,'127.0.0.1',resolve);});options.signal?.throwIfAborted();target.assertCurrent();assert.equal(socket.bytesWritten,0);return{socket,done,close};}
   return{socket:{bytesWritten:0},done:new Promise(resolve=>{finish=resolve;}),close(){finish();}};}};},
  async relay(options){const relay={...options,destroyed:0,closed:false,destroyConnections(){relay.destroyed++;},async close(){relay.closed=true;relay.destroyConnections();}};relays.push(relay);return relay;},
  broker(options){const broker={options,closed:0,issued:0,server:{listening:false},close(){broker.closed++;},issue(){assert.equal(options.purpose,'preview');broker.issued++;return{url:options.origin+'/__preview/bootstrap#'+'a'.repeat(43),generation:options.generation,grantExpiresAt:Date.now()+1000};}};brokers.push(broker);return broker;},bind:async()=>{},
 };
 if(transport){trusted.relay=async options=>{const relay=await createPreviewRelay(options);relays.push(relay);return relay;};trusted.broker=options=>{const broker=brokerModule.createEditorBroker(options);brokers.push(broker);return broker;};trusted.bind=async broker=>{await new Promise((resolve,reject)=>{broker.server.once('error',reject);broker.server.listen(0,'127.0.0.1',resolve);});await bindWait?.(broker);};}
 else if(bindWait)trusted.bind=bindWait;
 const preview=createHostPreview(ctx,manager,run,enabled?config:undefined,ctx.projectExecutionMode,trusted);
 async function agent(id,{parent,mode}={}){
  const a={id,status:'idle',inbox:{nextStep:[]},model:{current:()=>({provider:'fixture',model:'fixture'})},session:{id,mode,header:{createdAt:2000,...(parent?{origin:'subagent',parentSession:parent.id}:{})},append(type,data){const list=events.get(id)??[];const event={seq:list.length,type,data};list.push(event);events.set(id,list);return event;}},inject(){},followup(){}};
  const scope=S.createScope(ctx,a);a.ctx=scope.ctx;scopes.push(scope);agents.set(id,a);
  if(!parent){const root=path.join(projects,id);await fs.mkdir(root);const n=Object.keys(manager.data.sessions).length;manager.data.sessions[id]={root,workspaceId:'workspace-'+id,ports:[21000+n*4,21001+n*4,21002+n*4,21003+n*4]};workspaces.push({id:'workspace-'+id,path:root,sessionIds:[id]});}
  preview.install(a);return a;
 }
 let sequence=0;
 async function call(a,name,value,signal=new AbortController().signal){const toolSet=await ctx.tools.resolve({agent:a,modelSelection:a.model.current(),signal});try{const report=await ctx.tools.execute({agent:a,signal,toolSet,calls:[{id:'preview-'+(++sequence),name,arguments:JSON.stringify(value)}]});return report.results[0].result;}finally{toolSet.dispose();}}
 const control=input=>preview.operation(input,{ownerControl:true});
 t.after(async()=>{for(const p of processes){p.hold=false;if(p.kills)p.release();}await preview.dispose();await run.dispose();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'host-preview-sdk-'));await fs.rm(directory,{recursive:true,force:true});});
 return{ctx,manager,run,preview,agent,call,control,processes,calls,targets,brokers,relays,routes,workspaces,state,projects,archive,set rejectPeer(value){rejectPeer=value;}};
}
async function start(f,agent){const result=await f.call(agent,'project_exec',args);assert.equal(result.isError,false,JSON.stringify(result));return result.value.jobId;}
async function open(f,agent,jobId){const result=await f.call(agent,'project_preview',{operation:'open',jobId});assert.equal(result.isError,false,JSON.stringify(result));return result.value;}

test('actual SDK browser verification queues behind its own live producer until actual done', {timeout:10000},async t=>{
 const f=await fixture(t,{heavy:true}),a=await f.agent('owner');applyQuality(f.ctx);
 let guarded=0,reviews=0;f.ctx.tools.guard(exec=>{if(exec.name==='verify_project')guarded++;});
 f.ctx.on('workspace-runtime/review',()=>{reviews++;});
 const id=await start(f,a);await until(()=>f.calls.length===1);
 const capture=await f.run.custodyFor(id,a.id),cancel=new AbortController();
 let finished=false;const queued=f.call(a,'verify_project',{kind:'browser'},cancel.signal).then(result=>{finished=true;return result;});
 await until(()=>guarded>0);await tick();await tick();
 assert.equal(finished,false);assert.equal(reviews,0);capture.assertCurrent();assert.equal(f.processes[0].status,'running');
 cancel.abort(Error('cancel queued verification'));assert.equal((await queued).isError,true);
 capture.assertCurrent();assert.equal(f.processes[0].kills,0);
 f.processes[0].hold=true;let stopped=false;
 const stopping=f.run.stopOwned(id,a.id).then(()=>{stopped=true;});await until(()=>f.processes[0].kills>0);
 assert.equal(stopped,false);assert.equal(f.processes[0].status,'running');
 let afterFinished=false;const after=f.call(a,'verify_project',{kind:'browser'}).then(value=>{afterFinished=true;return value;});
 await until(()=>guarded>1);await tick();assert.equal(afterFinished,false);assert.equal(reviews,0);
 f.processes[0].release();await stopping;await capture.done;
 const result=await after;assert.equal(reviews,1);assert.equal(result.value.code,'NO_MANAGED_PROJECT');
 assert.equal(f.calls.length,1);assert.equal(f.processes[0].status,'killed');
});

test('actual scoped SDK tool registers an own preview with Apps absent and no public authority arguments',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),id=await start(f,a),opened=await open(f,a,id);
 assert.equal(opened.state,'ready');assert.match(opened.url,/https:\/\/same.test:8443\/__preview\/bootstrap#/);assert.equal(opened.generation,(await f.run.custodyFor(id,a.id)).identity.generation);assert.equal(f.targets.length,1);assert.equal(f.targets[0].port,21000);assert.equal(f.targets[0].owner,a.id);assert.equal(f.targets[0].workspaceId,'workspace-owner');assert(!('pid'in opened));
 const closed=await f.call(a,'project_preview',{operation:'close'});assert.equal(closed.value.workSettled,true);assert.equal(f.processes[0].kills,1);assert(f.brokers[0].closed>0);
});
test('disabled configuration is unavailable without connector, broker, listener or process effects',async t=>{
 const f=await fixture(t,{enabled:false}),a=await f.agent('owner');const out=await f.call(a,'project_preview',{operation:'open',jobId:'none'});assert.equal(out.isError,false);assert.equal(out.value.state,'unavailable');assert.equal(f.targets.length+f.calls.length+f.brokers.length+f.relays.length,0);
});
test('foreign session and child SDK job ownership cannot create, observe or close another preview',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),b=await f.agent('foreign'),child=await f.agent('child',{parent:a}),id=await start(f,a);
 assert.equal((await f.call(b,'project_preview',{operation:'open',jobId:id})).isError,true);assert.equal((await f.call(child,'project_preview',{operation:'open',jobId:id})).isError,true);assert.equal(f.targets.length,0);
 await open(f,a,id);assert.equal((await f.call(child,'project_preview',{operation:'status'})).isError,true);assert.equal((await f.call(child,'project_preview',{operation:'close'})).isError,true);assert.equal(f.processes[0].kills,0);
});
test('strict model/control schemas cannot choose a host port, root, URL, PID, session or new restart command',async t=>{
 const f=await fixture(t),a=await f.agent('owner');
 for(const extra of [{port:3090},{host:'127.0.0.1'},{root:'/data'},{pid:1},{url:'http://127.0.0.1:3090'},{sessionId:'foreign'},{operation:'restart',command:'evil'}])assert.equal((await f.call(a,'project_preview',{operation:'status',...extra})).isError,true);
 for(const extra of [{port:3090},{command:'evil'},{jobId:'foreign'}])await assert.rejects(f.control({operation:'status',sessionId:a.id,...extra}),{code:'PREVIEW_REQUEST_INVALID'});assert.equal(f.targets.length,0);
});
test('canonical context, workspace membership and duplicate assigned ports fail before peer connection',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),b=await f.agent('foreign'),id=await start(f,a),record=f.manager.data.sessions[a.id];
 const ownPorts=record.ports;record.ports=f.manager.data.sessions[b.id].ports;assert.equal((await f.call(a,'project_preview',{operation:'open',jobId:id})).isError,true);record.ports=ownPorts;
 f.workspaces.push({...f.workspaces[0],id:'ambiguous'});assert.equal((await f.call(a,'project_preview',{operation:'open',jobId:id})).isError,true);f.workspaces.pop();
 f.manager.data.trash[a.id]={};assert.equal((await f.call(a,'project_preview',{operation:'open',jobId:id})).isError,true);delete f.manager.data.trash[a.id];assert.equal(f.targets.length,0);
});
test('failed peer attribution produces zero grant/broker/relay publication and leaves other work untouched',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),id=await start(f,a);f.rejectPeer=true;const result=await f.call(a,'project_preview',{operation:'open',jobId:id});assert.equal(result.isError,true);assert.equal(f.brokers.length+f.relays.length,0);assert.equal(f.processes[0].kills,0);
});
test('restart waits actual old done, uses one hidden SDK admitted spec, preserves origin/deadline and rejects replay',async t=>{
 const f=await fixture(t,{heavy:true}),a=await f.agent('owner'),id=await start(f,a),opened=await open(f,a,id);
 const ordinary=await f.ctx.tools.resolve({agent:a,modelSelection:a.model.current(),signal:new AbortController().signal});assert.equal(f.ctx.tools.get('project_preview_restart',a,ordinary),undefined);ordinary.dispose();
 f.processes[0].hold=true;let done=false;
 const input={operation:'restart',sessionId:a.id,previewId:opened.previewId,generation:opened.generation,requestId:'restart-one'},pending=f.control(input).then(v=>{done=true;return v;});
 await until(()=>f.processes[0].kills>0);assert.equal(f.calls.length,1);assert.equal(done,false);f.processes[0].release();const restarted=await pending;
 assert.equal(restarted.state,'ready');assert.equal(f.calls.length,2);assert.equal(restarted.previewId,opened.previewId);assert.equal(restarted.expiresAt,opened.expiresAt);assert.equal(restarted.url,new URL(opened.url).origin+'/');assert.notEqual(restarted.generation,opened.generation);
 assert.equal(f.calls[1].command,f.calls[0].command);assert(f.calls[1].timeoutMs<=f.calls[0].timeoutMs);assert.notEqual(f.calls[1].stdin,f.calls[0].stdin);
 await f.control(input);assert.equal(f.calls.length,2);await assert.rejects(f.control({...input,requestId:'stale-new'}),{code:'PREVIEW_RESTART_STALE'});
 const b=await f.agent('other');let foreignStarted=false;const queued=start(f,b).then(value=>{foreignStarted=true;return value;});await tick();await tick();assert.equal(foreignStarted,false);
 await f.control({operation:'close',sessionId:a.id});await queued;assert.equal(foreignStarted,true);
});
test('unknown old settlement blocks restart; no new admitted command or lease extension',async t=>{
 const f=await fixture(t,{operationMs:40}),a=await f.agent('owner'),id=await start(f,a),opened=await open(f,a,id);f.processes[0].hold=true;
 await assert.rejects(f.control({operation:'restart',sessionId:a.id,previewId:opened.previewId,generation:opened.generation,requestId:'held-stop'}));assert.equal(f.calls.length,1);assert.equal((await f.control({operation:'status',sessionId:a.id})).expiresAt,opened.expiresAt);f.processes[0].release();
});
test('scoped permission change revokes the grant and exact own job before further forwarding',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),id=await start(f,a);await open(f,a,id);a.session.mode='read-only';
 await assert.rejects(f.brokers[0].options.onActivity(),{code:'PREVIEW_READ_ONLY'});assert.equal(f.targets.length,1);
 await f.control({operation:'close',sessionId:a.id});assert.equal(f.processes[0].kills,1);
});
test('persistent origins stay with their project while closed leases and new jobs get separate grants',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),b=await f.agent('other'),first=await open(f,a,await start(f,a));
 await f.control({operation:'close',sessionId:a.id});const again=await open(f,a,await start(f,a)),other=await open(f,b,await start(f,b));
 assert.equal(new URL(first.url).origin,new URL(again.url).origin);assert.notEqual(first.previewId,again.previewId);assert.notEqual(new URL(other.url).origin,new URL(first.url).origin);assert.equal(f.brokers[0].closed>0,true);
});
test('registered owner control uses only same-origin POST and bounded explicit operation bodies',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),route=f.routes.get('/api/workbench/preview');assert.deepEqual(route.methods,['POST']);
 const request=(body,origin='https://same.test')=>new Request('http://dsh.internal/api/workbench/preview',{method:'POST',headers:{host:'same.test',origin,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await route.fetch(request({operation:'status',sessionId:a.id},'https://same.test:8443'))).status,403);
 const response=await route.fetch(request({operation:'status',sessionId:a.id}));assert.equal(response.status,200);assert.equal((await response.json()).state,'closed');
 const huge=await route.fetch(request({operation:'status',sessionId:a.id,padding:'x'.repeat(2100)}));assert.equal(huge.status,413);assert.equal(f.targets.length,0);
});

test('assembled SDK controller, real HTTP broker and private relay preserve app responses without owner credentials',async t=>{
 const seen=[],sockets=new Set(),app=http.createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=bytes;seen.push({url:req.url,method:req.method,headers:req.headers,body});res.writeHead(409,{'content-type':'application/json; charset=utf-8','set-cookie':'owner-fixation=bad','access-control-allow-origin':'*'});res.end(JSON.stringify({error:'Poznámka byla změněna',body}));});
 app.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>app.close(resolve));});
 const f=await fixture(t,{transport:true}),a=await f.agent('owner');f.manager.data.sessions[a.id].ports[0]=app.address().port;
 const id=await start(f,a),capture=await f.run.custodyFor(id,a.id);
 const before=await f.control({operation:'status',sessionId:a.id});assert.equal(before.state,'closed');assert.equal(before.workSettled,true);
 capture.assertCurrent();assert.equal(f.processes[0].status,'running'); // No preview entry is not producer settlement.
 const opened=await open(f,a,id),broker=f.brokers[0],origin=new URL(opened.url).origin;
 function request(route,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:broker.server.address().port,path:route,method,headers:{host:new URL(origin).host,'sec-fetch-site':'same-origin',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);});}
 assert.equal(seen.length,0); // The initial connector probe sent no HTTP.
 const claim=await request('/__preview/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({grant:opened.url.split('#')[1]})});assert.equal(claim.status,200);const cookie=claim.headers['set-cookie'][0].split(';')[0];
 assert.equal((await request('/',{headers:{cookie,origin:'https://same.test'}})).status,403);assert.equal(seen.length,0);
 const body=JSON.stringify({text:'Příliš žluťoučký kůň'}),response=await request('/api/notes/n1',{method:'PATCH',headers:{cookie:cookie+'; dsh-auth-owner=SECRET',origin,authorization:'Bearer SECRET','x-harness-owner':'SECRET','tailscale-user-login':'SECRET','content-type':'application/json'},body});
 assert.equal(response.status,409);assert.deepEqual(JSON.parse(response.text),{error:'Poznámka byla změněna',body});assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.headers['access-control-allow-origin'],undefined);assert.equal(seen.length,1);assert.equal(seen[0].method,'PATCH');assert.equal(seen[0].url,'/api/notes/n1');assert.equal(seen[0].body,body);assert(!/SECRET|cookie|authorization|tailscale|x-harness/.test(JSON.stringify(seen[0].headers)));
 f.rejectPeer=true;assert.equal((await request('/foreign',{headers:{cookie}})).status,502);assert.equal(seen.length,1);assert.equal(app.listening,true);
 f.processes[0].hold=true;
 const blocked=await f.control({operation:'close',sessionId:a.id});assert.equal(blocked.state,'blocked');assert.equal(blocked.workSettled,false);
 assert.equal(broker.server.listening,false);assert.equal(f.processes[0].status,'running');
 assert.equal((await f.call(a,'project_preview',{operation:'open',jobId:id})).isError,true);assert.equal(f.calls.length,1);assert.equal(f.brokers.length,1);
 f.processes[0].release();await capture.done;
 const closed=await f.control({operation:'close',sessionId:a.id});assert.equal(closed.workSettled,true);assert.equal(app.listening,true);
 assert.equal((await f.call(a,'project_preview',{operation:'open',jobId:id})).isError,true);assert.equal(f.calls.length,1);
 f.rejectPeer=false;const replacement=await open(f,a,await start(f,a));assert.equal(replacement.state,'ready');assert.notEqual(replacement.generation,opened.generation);assert.equal(f.calls.length,2);
 await f.control({operation:'close',sessionId:a.id});
});

test('a lost restart acknowledgement stops the exact newly admitted producer and never retries it',async t=>{
 const f=await fixture(t,{operationMs:80,noAckAt:1}),a=await f.agent('owner'),opened=await open(f,a,await start(f,a));
 await assert.rejects(f.control({operation:'restart',sessionId:a.id,previewId:opened.previewId,generation:opened.generation,requestId:'lost-ack'}));
 await until(()=>f.processes.length===2&&f.processes[1].kills>0);assert.equal(f.calls.length,2);assert.equal(f.processes[0].status,'killed');assert.equal(f.processes[1].status,'killed');
 const status=await f.control({operation:'status',sessionId:a.id});assert.equal(status.state,'blocked');assert.equal(status.expiresAt,opened.expiresAt);await f.control({operation:'close',sessionId:a.id});assert.equal(f.calls.length,2);
});

test('aborted open closes a late-bound broker and relay without stopping the original job',async t=>{
 let entered,release;const atBind=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const f=await fixture(t,{bindWait:async()=>{entered();await gate;}}),a=await f.agent('owner'),id=await start(f,a),controller=new AbortController();
 const pending=f.call(a,'project_preview',{operation:'open',jobId:id},controller.signal);await atBind;controller.abort();assert(f.brokers[0].closed>0);release();await pending;
 await until(()=>f.brokers[0].closed>0&&f.relays[0].closed);assert.equal(f.processes[0].kills,0);assert.equal(f.calls.length,1);
});

for(const event of ['archive','mode','dispose'])test('actual scoped '+event+' lifecycle revokes its preview and drains only its producer',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),b=await f.agent('foreign'),opened=await open(f,a,await start(f,a));await start(f,b);
 if(event==='archive'){f.archive(a.id);f.ctx.emit('workspace/session-archived',{sessionId:a.id});}
 if(event==='mode'){a.session.mode='read-only';f.ctx.emit('session/event',a.session,{type:'sandbox/mode'});}
 if(event==='dispose')f.preview.remove(a);
 assert(f.brokers[0].closed>0);await until(()=>f.processes[0].status==='killed');assert.equal(f.processes[1].kills,0);assert.equal(f.targets.length,1);assert.equal(opened.state,'ready');
});

for(const change of ['workspace','environment'])test('restart refuses changed '+change+' after old done without admitting a replacement',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),opened=await open(f,a,await start(f,a));f.processes[0].hold=true;
 const pending=f.control({operation:'restart',sessionId:a.id,previewId:opened.previewId,generation:opened.generation,requestId:'changed-'+change});const rejected=assert.rejects(pending);
 await until(()=>f.processes[0].kills>0);
 if(change==='workspace'){f.manager.data.sessions[a.id].workspaceId='new-workspace';f.workspaces[0].id='new-workspace';}
 else f.ctx.shellEnv.collect=()=>({CHANGED:'refuse replacement'});
 f.processes[0].release();await rejected;assert.equal(f.calls.length,1);assert.equal(f.targets.length,1);
});

for(const change of ['dispose','archive','workspace'])test('late custody after '+change+' cannot allocate persistent origins or publish an entry',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),id=await start(f,a),original=f.run.custodyFor;let entered,release;
 const waiting=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});f.run.custodyFor=async(...args)=>{const capture=await original(...args);entered();await gate;return capture;};
 const pending=f.preview.operation({operation:'open',jobId:id},{agent:a}),rejected=assert.rejects(pending);await waiting;
 if(change==='dispose')await f.preview.dispose();
 if(change==='archive')f.archive(a.id);
 if(change==='workspace'){f.workspaces[0].id='changed';f.manager.data.sessions[a.id].workspaceId='changed';}
 release();await rejected;assert.equal(f.targets.length+f.brokers.length+f.relays.length,0);await assert.rejects(fs.stat(path.join(f.state,'host-preview-origins.json')),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(f.state,'preview-relays')),{code:'ENOENT'});assert.equal(f.processes[0].kills,0);
});

test('actual SDK bwrap selection preserves ordinary background commands without a custody wrapper',async t=>{
 const f=await fixture(t),a=await f.agent('owner');
 const sandbox=f.ctx.sandbox[Symbol.for('cordis.original')]??f.ctx.sandbox;sandbox.internals={platform:'linux',chain:['bwrap']};
 // This inert shell accepts ordinary stdin-less calls; no real process starts.
 const execute=f.ctx.shell.execute;f.ctx.shell.execute=async spec=>{if(!spec.stdin){const wrapped={...spec,stdin:JSON.stringify({version:1,nonce:'a'.repeat(64),generation:'b'.repeat(32)})};const process=await execute(wrapped);f.calls.at(-1).command=spec.command;return process;}return execute(spec);};
 const result=await f.call(a,'project_exec',args);assert.equal(result.isError,false,JSON.stringify(result));await until(()=>f.calls.length===1);assert(!f.calls[0].command.includes('--host-custody-v1'));assert.equal((await f.call(a,'project_preview',{operation:'open',jobId:result.value.jobId})).isError,true);assert.equal(f.targets.length+f.brokers.length+f.relays.length,0);
});

test('only trusted owner status correlates original admitted SDK call and current exact preview producer across restart',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),id=await start(f,a),capture=await f.run.custodyFor(id,a.id),opened=await open(f,a,id);
 assert(Object.isFrozen(capture.call));assert.equal(capture.call.callId,'preview-1');assert.equal(capture.call.rootCallId,'preview-1');assert.equal(capture.call.toolName,'project_exec');assert.equal(f.run.producerFor(id,a.id).call,capture.call);assert.throws(()=>f.run.producerFor(id,'foreign'),{code:'PROJECT_CUSTODY_UNAVAILABLE'});
 assert.equal(opened.correlation,undefined);assert.equal((await f.call(a,'project_preview',{operation:'status'})).value.correlation,undefined);
 const ownerStatus=async()=>{const route=f.routes.get('/api/workbench/preview'),response=await route.fetch(new Request('http://dsh.internal/api/workbench/preview',{method:'POST',headers:{host:'same.test',origin:'https://same.test','content-type':'application/json'},body:JSON.stringify({operation:'status',sessionId:a.id})}));assert.equal(response.status,200);return response.json();};
 const first=await ownerStatus();assert.deepEqual(first.correlation,{version:1,sessionId:a.id,ownerAgentId:a.id,jobId:id,previewId:opened.previewId,generation:opened.generation,expiresAt:opened.expiresAt,originalCall:capture.call,producerCall:capture.call});
 const restarted=await f.control({operation:'restart',sessionId:a.id,previewId:opened.previewId,generation:opened.generation,requestId:'correlation'});assert.equal(restarted.correlation,undefined);const after=await ownerStatus();assert.deepEqual(after.correlation.originalCall,first.correlation.originalCall);assert.notEqual(after.correlation.producerCall.callId,after.correlation.originalCall.callId);assert.equal(after.correlation.producerCall.toolName,'project_preview_restart');assert.deepEqual(after.correlation.producerCall,(await f.run.custodyFor(after.jobId,a.id)).call);
 for(const key of ['jobId','previewId','generation','expiresAt'])assert.equal(after.correlation[key],after[key]);assert.equal(after.previewId,opened.previewId);assert.equal(after.expiresAt,opened.expiresAt);assert.notEqual(after.generation,opened.generation);assert.equal((await f.call(a,'project_preview',{operation:'status'})).value.correlation,undefined);
});

test('missing or oversized private SDK correlation stays unknown and never becomes caller-selected authority',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),background=await f.run.startWithCustody(args,{agent:a,callId:'x'.repeat(257),rootCallId:'bad\nid',name:'project_exec',signal:new AbortController().signal}),lease=await f.run.custodyFor(background.jobId,a.id);
 assert.equal(lease.call.callId,null);assert.equal(lease.call.rootCallId,null);assert.equal(lease.call.toolName,'project_exec');assert.deepEqual(Object.keys(background).sort(),['cwd','jobId','kind']);assert.equal((await f.call(a,'project_preview',{operation:'status',callId:'caller-value'})).isError,true);
});

test('owner status with actual SDK archive arrays serves own ready preview and refuses archived session without generic503',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),id=await start(f,a),opened=await open(f,a,id);assert(Array.isArray(f.ctx.workspaceRegistry.archivedSessionIds));assert(Object.isFrozen(f.ctx.workspaceRegistry.archivedSessionIds));assert.equal(f.ctx.workspaceRegistry.archivedSessionIds.has,undefined);
 const status=()=>f.routes.get('/api/workbench/preview').fetch(new Request('http://dsh.internal/api/workbench/preview',{method:'POST',headers:{host:'same.test',origin:'https://same.test','content-type':'application/json'},body:JSON.stringify({operation:'status',sessionId:a.id})}));
 f.archive('unrelated-session');let response=await status();assert.equal(response.status,200);const ready=await response.json();assert.equal(ready.state,'ready');assert.equal(ready.previewId,opened.previewId);assert.equal(ready.jobId,id);assert.equal(ready.correlation.ownerAgentId,a.id);assert.equal(f.targets.length,1);
 f.archive(a.id);response=await status();assert.equal(response.status,409);assert.deepEqual(await response.json(),{code:'PREVIEW_PROJECT_UNAVAILABLE'});assert.equal(f.targets.length,1);assert.equal((await f.call(a,'project_preview',{operation:'status'})).isError,true);
});

test('owner restart response and blocked status retain bounded peer-probe failure diagnostics without private raw errors',async t=>{
 const f=await fixture(t),a=await f.agent('owner'),opened=await open(f,a,await start(f,a));f.rejectPeer=true;
 const owner=body=>f.routes.get('/api/workbench/preview').fetch(new Request('http://dsh.internal/api/workbench/preview',{method:'POST',headers:{host:'same.test',origin:'https://same.test','content-type':'application/json'},body:JSON.stringify({...body,sessionId:a.id})}));
 const response=await owner({operation:'restart',previewId:opened.previewId,generation:opened.generation,requestId:'diagnostic-peer'});assert.equal(response.status,409);const error=await response.json();assert.equal(error.code,'PEER_UNATTRIBUTED');assert.equal(error.diagnostic.phase,'peer-probe');assert.equal(error.diagnostic.code,error.code);assert(Number.isSafeInteger(error.diagnostic.observedAt));assert.deepEqual(error.diagnostic.peer,{phase:'peer-proof',dialAttempts:1,established:true,lastConnectCode:null});assert(!JSON.stringify(error).includes('PRIVATE_'));
 const statusResponse=await owner({operation:'status'}),status=await statusResponse.json();assert.equal(statusResponse.status,200);assert.equal(status.state,'blocked');assert.deepEqual(status.lastRestartFailure,error.diagnostic);assert.equal(status.expiresAt,opened.expiresAt);assert.notEqual(status.jobId,opened.jobId);assert.equal(f.calls.length,2);
 const model=(await f.call(a,'project_preview',{operation:'status'})).value;assert.equal(model.lastRestartFailure,undefined);assert.equal(model.correlation,undefined);assert(!JSON.stringify(status).includes('PRIVATE_'));
});

test('unknown old stop reports its own phase and cannot masquerade as a new peer-probe failure or extend the deadline',async t=>{
 const f=await fixture(t,{operationMs:40}),a=await f.agent('owner'),opened=await open(f,a,await start(f,a));f.processes[0].hold=true;
 await assert.rejects(f.control({operation:'restart',sessionId:a.id,previewId:opened.previewId,generation:opened.generation,requestId:'diagnostic-stop'}),error=>{assert.equal(error.previewDiagnostic.phase,'stop-old');assert.equal(error.previewDiagnostic.peer,undefined);return true;});
 const status=await f.control({operation:'status',sessionId:a.id});assert.equal(status.lastRestartFailure.phase,'stop-old');assert.equal(status.expiresAt,opened.expiresAt);assert.equal(f.calls.length,1);assert.equal(f.targets.length,1);f.processes[0].release();
});
