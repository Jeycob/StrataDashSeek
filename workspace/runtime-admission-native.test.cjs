'use strict';
// Actual pinned Native Host/ToolsService/AgentLoop dispatch with an injected
// synthetic admission client. This is not Root broker/trust-server acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('mandatory admission survives optional plugin disposal in the actual pinned Cordis runtime',{timeout:15000},async t=>{
 assert(process.env.HARNESS_NATIVE_CLI,'Pinned Native CLI is required');
 const sdk=createRequire(path.resolve(process.env.HARNESS_NATIVE_CLI)),{Context}=sdk('@deepseek-ai/cordis');
 const {installRuntimeAdmission}=await import(pathToFileURL(path.join(__dirname,'runtime-admission-hooks.mjs')).href);
 const mandatoryModule=await import(pathToFileURL(path.join(__dirname,'runtime-admission-plugin.mjs')).href);
 const root=new Context();t.after(()=>root.fiber.dispose());let calls=0,bodies=0,optionalReady=false,mandatoryReady=false;
 const client={required:true,async admit(){calls++;throw Error('SYNTHETIC_ADMISSION_CLOSED');}};
 const optional=root.plugin({name:'optional-workspace-admission-fixture',apply(ctx){installRuntimeAdmission(ctx,{},client);optionalReady=true;}});
 root.plugin({name:'mandatory-root-admission-fixture',async apply(ctx){await mandatoryModule.apply(ctx);mandatoryReady=true;}});
 const until=Date.now()+5000;while(!(optionalReady&&mandatoryReady)&&Date.now()<until)await pause(10);
 assert(optionalReady&&mandatoryReady,'Both actual plugin fibers must finish loading');
 const dispatch=()=>root.waterfall('tools/execute',{signal:AbortSignal.timeout(1000)},async()=>{bodies++;});
 await assert.rejects(dispatch,/SYNTHETIC_ADMISSION_CLOSED/);assert.equal(calls,1,'Shared admission must run exactly once');assert.equal(bodies,0);
 await optional.dispose();
 await assert.rejects(dispatch,/SYNTHETIC_ADMISSION_CLOSED/);assert.equal(calls,2,'Mandatory admission must survive optional disposal without duplication');assert.equal(bodies,0);
});
test('actual Native dispatch blocks HTTP/tool/model bodies before asynchronous admission',{timeout:90000},async t=>{
 assert(process.env.HARNESS_NATIVE_CLI,'Pinned Native CLI is required; this explicit integration must not silently skip');
 const cli=path.resolve(process.env.HARNESS_NATIVE_CLI),sdk=createRequire(cli);assert.equal(sdk('@deepseek-ai/dsh/package.json').version,'0.2.2-rc.2');
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'runtime-admission-native-')),plugin=path.join(directory,'fixture.mjs'),token=crypto.randomBytes(24).toString('hex'),hooks=path.resolve(__dirname,'runtime-admission-hooks.mjs');
 let child,closed,output='';
 t.after(async()=>{
  if(child&&child.exitCode===null&&child.signalCode===null){if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:5000});}catch{try{child.kill('SIGKILL');}catch{}}}else try{process.kill(-child.pid,'SIGKILL');}catch{}}
  if(closed){let timer;try{await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned Native fixture did not close')),5000);})]);}finally{clearTimeout(timer);}}
  const real=await fsp.realpath(directory);assert.equal(path.dirname(real),await fsp.realpath(os.tmpdir()));assert(path.basename(real).startsWith('runtime-admission-native-'));assert.equal((await fsp.lstat(directory)).isSymbolicLink(),false);await fsp.rm(real,{recursive:true,force:true});
 });
 const source=`import http from 'node:http';import crypto from 'node:crypto';
import {installRuntimeAdmission} from ${JSON.stringify(pathToFileURL(hooks).href)};
import {LlmAdapter,createUserMessage} from ${JSON.stringify(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-llm')).href)};
export const inject=['tools','agents','llm'];
export function apply(ctx){
 const state={http:true,tool:false,model:false,holdTool:false,toolWaiting:false,httpBodies:0,healthBodies:0,toolBodies:0,modelAdapterRequests:0,wireDispatches:0,attempts:[]};let releaseTool,handle;
 const api=installRuntimeAdmission(ctx,{}, {required:true,async admit(operation,{signal}={}){signal?.throwIfAborted();state.attempts.push(operation);await new Promise(r=>setTimeout(r,20));if(operation==='tool_dispatch'&&state.holdTool){state.toolWaiting=true;await new Promise(r=>releaseTool=r);state.toolWaiting=false;}signal?.throwIfAborted();if(!(operation==='start_turn'?state.http:operation==='tool_dispatch'?state.tool:state.model))throw Object.assign(Error('PRIVATE_FIXTURE_DENIAL'),{code:'FIXTURE_DENIED'});return{enforced:true,admitted:true,expiresAt:Date.now()+3000};}});
 ctx.tools.register({name:'admission_fixture',description:'Synthetic in-memory admission probe.',parameters:{type:'object',properties:{},additionalProperties:false},isConcurrencySafe:()=>true,output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(){state.toolBodies++;return{ok:true};}});
 class Synthetic extends LlmAdapter{async *stream(){state.modelAdapterRequests++;throw Error('Synthetic model must never be entered in denied test');}}
 ctx.llm.registerAdapter(['admission-fixture'],new Synthetic());
 // Defense in depth: no accidental fixture route can make a real provider call.
 ctx.on('llm/stream',()=>{state.wireDispatches++;throw Error('Fixture forbids all model streams');},{prepend:true,global:true});
 const getAgent=async()=>{if(!handle)handle=await ctx.agents.create({sessionId:'session-'+crypto.randomUUID(),meta:{cwd:${JSON.stringify(directory)}},agentOptions:{provider:'admission-fixture',model:'synthetic'}});return handle.agent;};
 ctx.on('connection/request',async(req,res,next)=>{if(req.url==='/api/workbench/health'&&req.method==='GET'){state.healthBodies++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({fixture:true,admission:api.snapshot()}));return;}if(req.url==='/api/admission-fixture'){state.httpBodies++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"fixture":true}');return;}return next();},{global:true});
 const control=http.createServer(async(req,res)=>{if(req.headers['x-fixture-key']!==${JSON.stringify(token)}){res.writeHead(403);res.end();return;}let text='';for await(const b of req){text+=b;if(text.length>4096){res.writeHead(413);res.end();return;}}const data=text?JSON.parse(text):{};let result;
  try{if(req.url==='/mode'){for(const k of ['http','tool','model','holdTool'])if(typeof data[k]==='boolean')state[k]=data[k];result={ok:true};}
   else if(req.url==='/snapshot')result={...state,admission:api.snapshot()};
   else if(req.url==='/release-tool'){releaseTool?.();result={ok:true};}
   else if(req.url==='/tool'){const agent=await getAgent(),signal=AbortSignal.timeout(5000),toolSet=await ctx.tools.resolve({agent,signal,modelSelection:{provider:'admission-fixture',model:'synthetic'}});try{const batch=await ctx.tools.execute({agent,signal,toolSet,calls:[{id:crypto.randomUUID(),name:'admission_fixture',arguments:'{}'}]});result={rejected:batch.results[0].result.isError===true,toolBodies:state.toolBodies};}finally{toolSet.dispose();}}
   else if(req.url==='/model'){const agent=await getAgent();agent.followup(createUserMessage({content:[{type:'text',text:'Synthetic admission test only.'}],source:{kind:'user'}}));await agent.whenIdle();result={modelAdapterRequests:state.modelAdapterRequests,wireDispatches:state.wireDispatches};}
   else throw Error('Unknown fixture command');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
  }catch{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({rejected:true,fixtureError:true,toolBodies:state.toolBodies}));}
 });control.listen(0,'127.0.0.1',()=>console.log('ADMISSION_FIXTURE_CONTROL='+control.address().port));ctx.on('dispose',async()=>{control.closeAllConnections();await new Promise(r=>control.close(r));await handle?.dispose();});
}
`;
 await fsp.writeFile(plugin,source);const overlay=path.join(directory,'patch.json');await fsp.writeFile(overlay,JSON.stringify([{insert:[{id:'actual-admission-fixture',name:pathToFileURL(plugin).href}]}]));
 const home=path.join(directory,'home');await fsp.mkdir(home,{mode:0o700});
 child=spawn(process.execPath,[cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,HOME:home,USERPROFILE:home,DSH_HOME:path.join(home,'.dsh'),APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});
 closed=new Promise(resolve=>child.once('close',resolve));const collect=data=>{output=(output+data.toString()).slice(-65536);};child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',()=>{});
 let nativeUrl,controlPort;const until=Date.now()+40000;while(Date.now()<until){assert.equal(child.exitCode,null,'Native fixture exited during startup');nativeUrl=output.match(/http:\/\/127\.0\.0\.1:\d+[^\s]*/)?.[0];controlPort=output.match(/ADMISSION_FIXTURE_CONTROL=(\d+)/)?.[1];if(nativeUrl&&controlPort)break;await pause(50);}
 assert(nativeUrl&&controlPort,'Native fixture readiness unavailable: '+output.replace(/https?:\/\/\S+/g,'[fixture-url]').slice(-2500));
 const control=async(route,data)=>{const r=await fetch('http://127.0.0.1:'+controlPort+route,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'X-Fixture-Key':token},body:JSON.stringify(data||{})});assert.equal(r.status,200);return r.json();};
 let cookie='',location=nativeUrl;for(let n=0;n<6;n++){const u=new URL(location);assert.equal(u.origin,new URL(nativeUrl).origin);const r=await fetch(location,{redirect:'manual',signal:AbortSignal.timeout(5000),headers:cookie?{Cookie:cookie}:{}});for(const value of r.headers.getSetCookie())cookie=value.split(';')[0];await r.text();if(!r.headers.get('location'))break;location=new URL(r.headers.get('location'),location).href;}
 const request=async(route,{method='GET'}={})=>{const r=await fetch(new URL(route,nativeUrl),{method,signal:AbortSignal.timeout(5000),headers:cookie?{Cookie:cookie}:{}});return{status:r.status,text:await r.text()};};
 await control('/mode',{http:false});
 for(const [route,method]of [['/api/admission-fixture','POST'],['/api/session/list','GET'],['/api/workbench/health?query=1','GET'],['/api/workbench/health','POST']]){const r=await request(route,{method});assert.equal(r.status,503);assert.equal(JSON.parse(r.text).code,'RUNTIME_ADMISSION_CLOSED');assert(!r.text.includes('PRIVATE_FIXTURE'));}
 const health=await request('/api/workbench/health');assert.equal(health.status,200);assert.equal(JSON.parse(health.text).fixture,true);assert.equal((await control('/snapshot')).httpBodies,0);
 const denied=await control('/tool');assert.equal(denied.rejected,true);let state=await control('/snapshot');assert.equal(state.toolBodies,0);assert(state.attempts.includes('tool_dispatch'),'Must traverse actual ToolsService dispatch');
 await control('/mode',{tool:true,holdTool:true});const pending=control('/tool');const waitUntil=Date.now()+4000;do{state=await control('/snapshot');if(state.toolWaiting)break;await pause(20);}while(Date.now()<waitUntil);assert.equal(state.toolWaiting,true);assert.equal(state.toolBodies,0);await control('/release-tool');const admitted=await pending;assert.notEqual(admitted.rejected,true);assert.equal(admitted.toolBodies,1);
 await control('/mode',{http:true,holdTool:false});assert.equal((await request('/api/admission-fixture',{method:'POST'})).status,200);
 await control('/model');state=await control('/snapshot');assert(state.attempts.includes('model_step'),'Actual AgentLoop must reach pre-step gate');assert.equal(state.modelAdapterRequests,0);assert.equal(state.wireDispatches,0);assert.equal(state.httpBodies,1);assert.equal(state.toolBodies,1);assert.equal(state.admission.activeRequests,0);assert.equal(state.admission.activeTools,0);
 const evidence={sdk:'0.2.2-rc.2',node:process.version,scope:'Actual Native Host HTTP, native ToolsService and AgentLoop dispatch; injected synthetic admission client, not the Root broker/trust server.',deniedHttpBodyCount:0,admittedHttpBodyCount:state.httpBodies,deniedToolBodyCount:0,admittedToolBodyCount:state.toolBodies,modelAdapterRequests:state.modelAdapterRequests,modelWireDispatches:state.wireDispatches,operations:[...new Set(state.attempts)],hooksSha256:crypto.createHash('sha256').update(await fsp.readFile(hooks)).digest('hex')};
 if(process.env.HARNESS_NATIVE_EVIDENCE){const dir=path.resolve(process.env.HARNESS_NATIVE_EVIDENCE);await fsp.mkdir(dir,{recursive:true});await fsp.writeFile(path.join(dir,'runtime-admission-native.json'),JSON.stringify(evidence,null,2));}t.diagnostic(JSON.stringify(evidence));
});
