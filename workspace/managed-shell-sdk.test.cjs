'use strict';
// Actual pinned ToolsService and native bash; the shell process seam is inert.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
let modules;
function sdk(){return modules??=(async()=>{
 const cli=process.env.HARNESS_NATIVE_CLI??path.join(process.env.HOMEAI_RUNTIME??'/data/harness/runtime','node_modules/@deepseek-ai/dsh/lib/bin.js');
 const base=path.resolve(path.dirname(cli),'../..');
 const load=(name,file='index.js')=>import(pathToFileURL(path.join(base,name,'lib',file)).href);
 const [cordis,prompt,tools,pipeline,scope,bash,adapter]=await Promise.all([load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-tools','pipeline.js'),load('dsh-scope'),load('dsh-tool-bash'),import('./managed-shell.mjs')]);
 return{...cordis,SystemPrompt:prompt.default,Tools:tools.default,...pipeline,...scope,applyNativeBash:bash.apply,createManagedShell:adapter.createManagedShell,TOOL_ABORTED:tools.TOOL_ABORTED,TOOL_ABORTED_BEFORE_DISPATCH:tools.TOOL_ABORTED_BEFORE_DISPATCH};
})();}
function outcome(overrides={}){return{cwd:'/managed/project',spec:{timeoutMs:7000},result:{exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:7000,stdout:{text:'documentation',truncated:false},stderr:{text:'',truncated:false},sandbox:{mode:'workspace-write',denied:false,enforcement:'test-shell'},...overrides}};}
async function fixture(t,run){
 const S=await sdk(),ctx=new S.Context();new S.SystemPrompt(ctx,{});new S.Tools(ctx);
 const scopes=[],calls=[],nativeCalls=[];
 ctx.provide('shell',{sandboxMode:'workspace-write',resolve:r=>({...r,workdir:r.workdir??'/legacy',timeoutMs:r.timeoutMs??7000,onExpiry:'kill',stdoutMaxBytes:4096}),execute:async spec=>{nativeCalls.push(spec);return{result:async()=>outcome().result};}});
 ctx.provide('sandboxPolicy',{resolve:()=>({mode:'workspace-write',workspaceRoot:'/managed/project'})});
 ctx.provide('shellEnv',{collect:()=>({})});ctx.provide('workingDirectory',{ensure:async()=>'/legacy'});
 S.applyNativeBash(ctx,{enableRunInBackground:false});const native=ctx.tools.get('bash');assert(native?.output?.schema);
 const manager={existing:new Set(),data:{installedAt:1000,sessions:{},trash:{}},ownerAgent:a=>a};
 const managed=S.createManagedShell(ctx,manager,async(args,exec)=>{calls.push({args,exec});return run?run(args,exec):outcome();});
 const pipeline=new S.ToolExecutionPipeline(ctx);ctx.tools.setExecutor({describe:defs=>({schemas:defs.map(({name,description,parameters})=>({name,description,parameters}))}),execute:input=>S.executeToolBatch(input,pipeline,()=>1)});
 t.after(async()=>{managed.dispose();for(const scope of scopes)await scope.dispose();await ctx.fiber.dispose();});
 function agent(id,{legacy=false,record=true,existing=false,seeded=false,createdAt=2000}={}){
  const value={id,session:{id,header:{createdAt,isSeeded:seeded}}},scope=S.createScope(ctx,value);value.ctx=scope.ctx;scopes.push(scope);
  if(record)manager.data.sessions[id]={root:'/managed/'+id,legacy};if(existing)manager.existing.add(id);return value;
 }
 async function admit(agent){return ctx.tools.resolve({agent,modelSelection:{provider:'fixture',model:'fixture'},signal:new AbortController().signal});}
 async function call(agent,args={command:'grep documentation',description:'Read project documentation'},options={}){
  const batch=await ctx.tools.execute({agent,signal:options.signal??new AbortController().signal,...(options.toolSet?{toolSet:options.toolSet}:{}),calls:[{id:'managed-shell-call',name:'bash',arguments:JSON.stringify(args)}]});return batch.results[0].result;
 }
 return{...S,ctx,native,manager,managed,calls,nativeCalls,agent,admit,call};
}

test('real Native bash schema validates a scoped managed body without mutating call arguments',async t=>{
 const f=await fixture(t,async(args,exec)=>{
  assert.equal(args,exec.arguments);assert(Object.isFrozen(args));assert.equal(exec.name,'bash');assert.equal(args.command,'grep documentation');
  assert.throws(()=>{args.command='changed';},TypeError);
  return outcome({stdout:{text:'documentation',truncated:true,spillPath:'/managed/output.log',privateDetail:'drop'},sandbox:{mode:'workspace-write',denied:false,enforcement:'test-shell',privateDetail:'drop'}});
 });
 const a=f.agent('one');f.managed.install(a);const definition=f.ctx.tools.get('bash',a);
 assert.notEqual(definition,f.native);assert.equal(definition.output.schema,f.native.output.schema);assert.equal(definition.output.presentationMeta,f.native.output.presentationMeta);
 assert.equal(definition.parameters.additionalProperties,false);assert(!Object.hasOwn(definition.parameters.properties,'run_in_background'));assert(!Object.hasOwn(definition.parameters.properties,'sandbox_permissions'));
 const toolSet=await f.admit(a);t.after(()=>toolSet.dispose());const result=await f.call(a,undefined,{toolSet});
 assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.kind,'foreground');assert.equal(result.value.stdout.text,'documentation');assert.equal(result.value.cwd,'/managed/project');assert.equal(result.meta.cwd,'/managed/project');assert(!Object.hasOwn(result.value.stdout,'privateDetail'));assert(!Object.hasOwn(result.value.sandbox,'privateDetail'));assert.match(result.content[0].text,/output truncated/);
 assert.equal(f.calls.length,1);assert.equal(f.nativeCalls.length,0);assert.equal(f.ctx.tools.get('bash'),f.native);
});

test('real SDK preserves native nonzero, timeout and sandbox facts instead of reporting a tool launch failure',async t=>{
 const f=await fixture(t,async()=>outcome({exitCode:2,signal:null,timedOut:true,stderr:{text:'denied',truncated:false},sandbox:{mode:'read-only',denied:true,enforcement:'test-shell'}}));const a=f.agent('one');f.managed.install(a);
 const result=await f.call(a);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.exitCode,2);assert.equal(result.value.timedOut,true);assert.equal(result.value.sandbox.mode,'read-only');assert.match(result.content[0].text,/file access denied under read-only/);assert.match(result.content[0].text,/timed out after 7000ms/);assert.match(result.content[0].text,/exit code: 2/);
});

test('SDK cancellation before dispatch does not enter the managed command body',async t=>{
 const f=await fixture(t),a=f.agent('one');f.managed.install(a);const controller=new AbortController();controller.abort();const result=await f.call(a,undefined,{signal:controller.signal});
 assert.equal(result.isError,true);assert.equal(result.error.info.code,f.TOOL_ABORTED_BEFORE_DISPATCH);assert.equal(f.calls.length,0);assert.equal(f.nativeCalls.length,0);
});

test('SDK cancellation after body start waits for quiescence and reports started ABORTED',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const f=await fixture(t,async(_args,exec)=>{entered();await hold;exec.signal.throwIfAborted();return outcome();}),a=f.agent('one');f.managed.install(a);
 const controller=new AbortController();let settled=false;const pending=f.call(a,undefined,{signal:controller.signal}).then(result=>{settled=true;return result;});
 await started;controller.abort(Error('fixture cancellation'));await new Promise(r=>setImmediate(r));assert.equal(settled,false);release();const result=await pending;
 assert.equal(result.isError,true);assert.equal(result.error.info.code,f.TOOL_ABORTED);assert.equal(f.calls.length,1);assert.equal(f.nativeCalls.length,0);
});

test('admission identity rejects the old tool snapshot and other guards still take precedence',async t=>{
 const f=await fixture(t),a=f.agent('one'),old=await f.admit(a);f.managed.install(a);const current=await f.admit(a);t.after(()=>{old.dispose();current.dispose();});
 assert.equal(f.managed.handles({name:'bash',agent:a,toolSet:old}),false);assert.equal(f.managed.handles({name:'bash',agent:a,toolSet:current}),true);assert.equal(f.managed.handles({name:'project_exec',agent:a,toolSet:current}),false);
 f.ctx.tools.guard(exec=>exec.name==='bash'&&!f.managed.handles(exec)?{reason:'Unadapted managed bash refused'}:undefined);
 const denied=await f.call(a,undefined,{toolSet:old});assert.equal(denied.isError,true);assert.equal(f.calls.length,0);assert.equal(f.nativeCalls.length,0);
 f.ctx.on('tools/pre-execute',async()=>({kind:'deny',reason:'Independent policy denied'}),{global:true});const policy=await f.call(a,undefined,{toolSet:current});assert.equal(policy.isError,true);assert.match(policy.error.message,/Independent policy/);assert.equal(f.calls.length,0);
});

test('legacy and old unknown sessions retain Native bash; removal and disposal release only managed shadows',async t=>{
 const f=await fixture(t),a=f.agent('one'),b=f.agent('two'),legacy=f.agent('legacy',{legacy:true}),old=f.agent('old',{record:false,existing:true});
 for(const agent of[a,b,legacy,old])f.managed.install(agent);assert.equal(f.ctx.tools.get('bash',legacy),f.native);assert.equal(f.ctx.tools.get('bash',old),f.native);
 const original=await f.call(legacy);assert.equal(original.isError,false);assert.equal(f.nativeCalls.length,1);assert.equal(f.calls.length,0);
 const prior=f.ctx.tools.get('bash',a);f.managed.install(a);assert.equal(f.ctx.tools.get('bash',a),prior);f.managed.remove(a);assert.equal(f.ctx.tools.get('bash',a),f.native);assert.notEqual(f.ctx.tools.get('bash',b),f.native);
 f.managed.install(a);assert.notEqual(f.ctx.tools.get('bash',a),prior);f.managed.dispose();f.managed.dispose();assert.equal(f.ctx.tools.get('bash',a),f.native);assert.equal(f.ctx.tools.get('bash',b),f.native);assert.equal(f.ctx.tools.get('bash'),f.native);
});

test('a future seeded session admits the managed definition before its first project is provisioned',async t=>{
 const f=await fixture(t),a=f.agent('future',{record:false,seeded:true,createdAt:new Date(2000).toISOString()});f.managed.install(a);assert.notEqual(f.ctx.tools.get('bash',a),f.native);
 const toolSet=await f.admit(a);t.after(()=>toolSet.dispose());f.manager.data.sessions[a.id]={root:'/managed/future',legacy:false};assert.equal(f.managed.handles({name:'bash',agent:a,toolSet}),true);const result=await f.call(a,undefined,{toolSet});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(f.calls.length,1);
});

test('the actual SDK final observer covers admission failures and final policy blocks without changing outcomes',async t=>{
 const f=await fixture(t),a=f.agent('one');f.managed.install(a);const seen=[];
 f.ctx.on('tools/result',(exec,result)=>{seen.push({exec,result});assert(Object.isFrozen(exec));assert(Object.isFrozen(result));},{global:true});
 f.ctx.tools.guard(exec=>exec.arguments.command==='denied'?{reason:'Independent admission refusal'}:undefined);
 const invalid=await f.call(a,{command:'denied',description:'Admission fixture'});
 assert.equal(invalid.isError,true);assert.equal(seen.length,1);assert.equal(seen[0].result,invalid);assert.equal(f.calls.length,0);
 f.ctx.on('tools/post-execute',async()=>({kind:'block',feedback:[{type:'text',text:'Independent final policy block'}]}),{global:true});
 const blocked=await f.call(a);assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/Independent final policy block/);
 assert.equal(seen.length,2);assert.equal(seen[1].result,blocked);assert.equal(f.calls.length,1);
});
