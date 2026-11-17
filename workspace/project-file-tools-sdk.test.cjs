'use strict';
// Actual pinned ToolsService pipeline + native file/search definitions. All host
// service methods are tripwires; no real host file contents are used by tests.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
let modules;
function sdk(){return modules??=(async()=>{
 const cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js');
 const base=path.resolve(path.dirname(cli),'../..'),load=(name,file='index.js')=>import(pathToFileURL(path.join(base,name,'lib',file)).href);
 const [cordis,prompt,tools,pipeline,scope,fs,search,editor,adapter]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js'),load('dsh-scope'),load('dsh-tool-fs'),load('dsh-tool-fs-search'),load('dsh-tool-str-replace-editor'),import('./project-file-tools.mjs')]);
 return{...cordis,SystemPrompt:prompt.default,Tools:tools.default,...pipeline,...scope,fs,search,editor,...adapter,TOOL_ABORTED:tools.TOOL_ABORTED,TOOL_ABORTED_BEFORE_DISPATCH:tools.TOOL_ABORTED_BEFORE_DISPATCH};
})();}
const args={read:{file_path:'/private/host-canary'},write:{file_path:'linked/file.txt',content:'new'},edit:{file_path:'file.txt',old_string:'old',new_string:'new'},apply_patch:{patch:'*** Begin Patch\n*** End Patch'},glob:{pattern:'**/*'},grep:{pattern:'secret'},str_replace_editor:{command:'view',path:'/private/host-canary'},read_image:{file_path:'/private/host-canary.png'}};
async function fixture(t,handlers={}){
 const S=await sdk(),ctx=new S.Context();new S.SystemPrompt(ctx,{});new S.Tools(ctx);
 const hostCalls=[],scopes=[];
 const tripwire=name=>(..._args)=>{hostCalls.push(name);throw Error('HOST_TRIPWIRE');};
 ctx.provide('fs',new Proxy({},{get:(_target,key)=>key==='sandboxMode'?undefined:tripwire('fs.'+String(key))}));
 ctx.provide('workingDirectory',{ensure:tripwire('cwd.ensure')});ctx.provide('subprocess',{spawn:tripwire('subprocess.spawn')});
 S.fs.apply(ctx,{read:true,readImage:false,write:true,edit:true,applyPatch:true,readLimit:100,readMaxLineLength:1000,readMaxBytes:10000,readStreamMinSize:10000});
 await S.search.apply(ctx,{sampleOverCapGlobResults:false,globMaxResults:100,grepMaxMatches:100,grepMaxLineBytes:1000,searchMetaMaxBytes:10000,rawOutputMaxBytes:10000,graceMs:100,stderrMaxBytes:1000,timeoutMs:1000});
 // Attachment-dependent image and optional editor definitions are represented
 // by schema-valid tripwire registrations; all other six are native SDK tools.
 for(const name of ['read_image','str_replace_editor'])ctx.tools.register({name,description:name,parameters:{type:'object',properties:{file_path:{type:'string'},path:{type:'string'},command:{type:'string'}},additionalProperties:false},output:{schema:{type:'string'},render:tripwire(name+'.render')},execute:tripwire(name+'.execute')});
 const manager={existing:new Set(),data:{installedAt:1000,sessions:{}},ownerAgent:a=>a?.owner??a};
 const adapter=S.createProjectFileTools(ctx,manager,handlers);
 const pipeline=new S.ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>S.executeToolBatch(input,pipeline,()=>1)});
 function agent(id,{legacy=false,record=true,existing=false,createdAt=2000,owner}={}){
  const a={id,owner,session:{id,header:{createdAt}}},scope=S.createScope(ctx,a);a.ctx=scope.ctx;scopes.push(scope);
  if(record&&!owner)manager.data.sessions[id]={root:'/managed/'+id,legacy,independentRepository:true};if(existing)manager.existing.add(id);return a;
 }
 const admit=a=>ctx.tools.resolve({agent:a,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal});
 async function call(a,name,options={}){const batch=await ctx.tools.execute({agent:a,signal:options.signal??new AbortController().signal,...(options.toolSet?{toolSet:options.toolSet}:{}),calls:[{id:'file-call',name,arguments:JSON.stringify(options.args??args[name])}]});return batch.results[0].result;}
 t.after(async()=>{adapter.dispose();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();assert.deepEqual(hostCalls,[],'no host filesystem/subprocess/renderer execution');});
 return{...S,ctx,manager,adapter,agent,admit,call,hostCalls};
}

test('all host file tool names fail closed when isolated operations are unavailable',async t=>{
 const f=await fixture(t),a=f.agent('one');f.adapter.install(a);
 for(const name of f.projectFileToolNames){const result=await f.call(a,name);assert.equal(result.isError,true,name+':'+JSON.stringify(result));assert.match(JSON.stringify(result),/ISOLATED_FILE_OPERATION_UNAVAILABLE/,name);}
});
test('actual SDK snapshot guard denies old or missing scoped definitions',async t=>{
 const f=await fixture(t,{read:async()=>({text:'isolated',truncated:false})}),a=f.agent('one'),old=await f.admit(a);
 f.adapter.install(a);const current=await f.admit(a);t.after(()=>{old.dispose();current.dispose();});
 assert.equal(f.adapter.handles({name:'read',agent:a,toolSet:old}),false);
 const denied=await f.call(a,'read',{toolSet:old});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/Unisolated project file tool/);
 const accepted=await f.call(a,'read',{toolSet:current});assert.equal(accepted.isError,false,JSON.stringify(accepted));assert.equal(accepted.value.text,'isolated');
 f.adapter.remove(a);const removed=await f.call(a,'read',{toolSet:current});assert.equal(removed.isError,true);
 const missing=f.agent('missing');const result=await f.call(missing,'read');assert.equal(result.isError,true);assert.match(JSON.stringify(result),/Unisolated/);
});
test('trusted handler gets immutable arguments and actual child identity; output is bounded and stripped',async t=>{
 let captured;
 const f=await fixture(t,{write:async(request,exec)=>{captured={request,exec};return{text:'guest saved',truncated:false,privateSecret:'drop'};}}),owner=f.agent('owner'),child=f.agent('child',{owner,record:false});
 f.adapter.install(child);const result=await f.call(child,'write');assert.equal(result.isError,false,JSON.stringify(result));
 assert.equal(captured.exec.agent,child);assert.equal(captured.request.project.ownerId,'owner');assert.equal(captured.request.project.root,'/managed/owner');assert(Object.isFrozen(captured.request));assert(Object.isFrozen(captured.request.arguments));assert.equal(captured.request.arguments,captured.exec.arguments);
 assert.deepEqual(result.value,{text:'guest saved',truncated:false});assert(!JSON.stringify(result).includes('privateSecret'));
});
test('handler failures, oversized results and independent policy denials cannot fall back',async t=>{
 let called=0;
 const f=await fixture(t,{read:async()=>{called++;throw Error('PRIVATE_BACKEND_PATH');},write:async()=>({text:'x'.repeat(262145),truncated:false})}),a=f.agent('one');f.adapter.install(a);
 const failed=await f.call(a,'read');assert.equal(failed.isError,true);assert.match(JSON.stringify(failed),/ISOLATED_FILE_OPERATION_FAILED/);assert(!JSON.stringify(failed).includes('PRIVATE_BACKEND_PATH'));
 const oversized=await f.call(a,'write');assert.equal(oversized.isError,true);assert.match(JSON.stringify(oversized),/ISOLATED_FILE_RESULT_INVALID/);
 f.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'Independent fixture policy'}),{global:true});
 const denied=await f.call(a,'read');assert.equal(denied.isError,true);assert.equal(called,1);
});
test('abort before dispatch and after mutation start preserve SDK quiescence semantics',async t=>{
 let entered,release,count=0;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const f=await fixture(t,{write:async()=>{count++;entered();await hold;return{text:'done',truncated:false};}}),a=f.agent('one');f.adapter.install(a);
 const pre=new AbortController();pre.abort();const before=await f.call(a,'write',{signal:pre.signal});assert.equal(before.error.info.code,f.TOOL_ABORTED_BEFORE_DISPATCH);assert.equal(count,0);
 const controller=new AbortController();let settled=false;const pending=f.call(a,'write',{signal:controller.signal}).then(r=>{settled=true;return r;});
 await started;controller.abort();await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();const after=await pending;assert.equal(after.error.info.code,f.TOOL_ABORTED);assert.equal(count,1);
});
test('old, legacy and unprovisioned sessions all fail closed, including pre-install snapshots',async t=>{
 const f=await fixture(t),future=f.agent('future',{record:false}),legacy=f.agent('legacy',{legacy:true});
 const original=f.ctx.tools.get('read'),old=f.agent('old',{record:false,existing:true,createdAt:1}),continued=f.agent('continued');f.manager.data.sessions.continued.independentRepository=false;
 const snapshots=await Promise.all([legacy,old,continued].map(a=>f.admit(a)));t.after(()=>snapshots.forEach(snapshot=>snapshot.dispose()));
 for(const a of [future,legacy,old,continued])f.adapter.install(a);assert.notEqual(f.ctx.tools.get('read',legacy),original);
 for(const [index,a] of [legacy,old,continued].entries()){
  const stale=await f.call(a,'read',{toolSet:snapshots[index]});assert.equal(stale.isError,true);assert.match(JSON.stringify(stale),/Unisolated/);
  for(const name of f.projectFileToolNames){const denied=await f.call(a,name);assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/NO_MANAGED_PROJECT/,name);}
 }
 const result=await f.call(future,'read');assert.equal(result.isError,true);assert.match(JSON.stringify(result),/NO_MANAGED_PROJECT/);
 f.adapter.install(future);f.adapter.dispose();f.adapter.dispose();assert.equal(f.ctx.tools.get('read',future),original);
});
