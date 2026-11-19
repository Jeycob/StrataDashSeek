'use strict';
// Pinned Native Host, real model directory/registry and durable selection; no inference.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');

function recordedTurns(session){
 for(const [turn,models]of [[1,[null]],[2,['alpha']],[3,['alpha','beta']],[4,['alpha','beta']]]){
  session.append('turn/start',{turn});
  session.append('user/message',{id:'q'+turn,role:'user',source:{kind:'user'},content:[{type:'text',text:'Recorded question '+turn}]},{surfaceOp:'append'});
  for(const [index,model]of models.entries()){
   const step=index+1;session.append('step/start',{turn,step});
   if(model)session.append('request/header',{header:{config:{provider:'model-fixture',model}},reason:turn===2?'initial':'change'});
   const usage=model&&!(turn===4&&step===1)?{inputTokens:1,outputTokens:1,totalTokens:2}:undefined;
   session.append('assistant/message',{turn,step,stream:[],...(usage?{usage}:{}),message:{id:'a'+turn+'-'+step,role:'assistant',source:{kind:'model',provider:model?'model-fixture':'reported-provider',model:model??'reported-model'},content:[{type:'text',text:'Recorded answer '+turn+' step '+step}]}},{surfaceOp:'append'});
   session.append('step/end',{turn,step});
  }
  session.append('turn/end',{turn,reason:{kind:'completed'}});
 }
 return session.id;
}

test('Native model warning, durable selection and per-answer routes preserve missing and multiple model facts',{timeout:90000},async t=>{
 assert(process.env.HARNESS_NATIVE_CLI,'The actual pinned Native CLI is required');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-model-availability-')),fixture=path.join(directory,'fixture'),sdk=path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI),'../..');fs.mkdirSync(fixture);
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'model-availability-fixture',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));
 fs.writeFileSync(path.join(fixture,'index.mjs'),`import {LlmAdapter} from ${JSON.stringify(pathToFileURL(path.join(sdk,'dsh-llm/lib/index.js')).href)};
export const inject=['llm','connection','sessions','agents'];
export async function apply(ctx){let mode='present',calls=0;
 class Adapter extends LlmAdapter{
  async listModels(provider){if(mode==='failure')throw Error('Synthetic catalog outage');return(mode==='absent'?['beta']:['alpha','beta']).map(id=>({provider,id,name:id}));}
  async resolveModel(provider,id){return{provider,id,name:id};}
  async *stream(){calls++;throw Error('Inference is forbidden in this fixture');}
 }
 ctx.llm.registerAdapter(['model-fixture'],new Adapter());
 const handle=await ctx.agents.create({sessionId:'model-availability-session',meta:{cwd:process.cwd()},agentOptions:{provider:'model-fixture',model:'alpha'}});const sessionId=(${recordedTurns.toString()})(handle.agent.session);await ctx.sessions.flush(handle.agent.session);
 ctx.effect(()=>()=>handle.dispose());
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/model-availability-fixture',methods:['GET','POST'],requestBody:'buffered',async fetch(request){if(request.method==='POST'){mode=(await request.json()).mode;ctx.emit('llm/models-updated','model-fixture');}return new Response(JSON.stringify({mode,calls,sessionId}),{headers:{'Content-Type':'application/json'}});}}));
}`);
 fs.writeFileSync(path.join(fixture,'client.js'),`window.__ModuleLoader__.load({id:'model-availability-fixture',factory:()=>({inject:['sessions','uiWorkspace','modelDirectories'],apply(ctx){window.ModelAvailabilityFixture={known:id=>ctx.sessions.list.getSnapshot().ids.includes(id),open:id=>ctx.uiWorkspace.openSession(id),select:async(id,model)=>{const result=await ctx.modelDirectories.directoryFor(id).select({provider:'model-fixture',model});return result.ok?result:{ok:false,error:{message:result.error.message,code:result.error.code}};},state:id=>ctx.sessions.scope(id)?ctx.modelDirectories.directoryFor(id).store.getSnapshot():null};}})});`);
 const overlay=path.join(directory,'overlay.json');fs.writeFileSync(overlay,JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},{id:'session-title-llm',disabled:true},{insert:[{id:'model-availability-workbench',name:pathToFileURL(createSourceFixture(directory)).href},{id:'model-availability-fixture',name:pathToFileURL(path.join(fixture,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[process.env.HARNESS_NATIVE_CLI,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',browser;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('homeai-model-availability-'))throw Error('Unsafe fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});});
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Native fixture did not start: '+output));},40000),poll=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(poll);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',reject);});
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url);await page.waitForFunction(()=>window.ModelAvailabilityFixture&&window.HarnessNativeUI);const proceed=page.getByRole('button',{name:'Continue',exact:true});await proceed.click();await proceed.waitFor({state:'hidden'});
 const first=(await(await page.request.get(new URL('/api/model-availability-fixture',url).href)).json()).sessionId;await page.evaluate(id=>ModelAvailabilityFixture.open(id),first);await page.waitForFunction(id=>ModelAvailabilityFixture.state(id)?.status==='ready',first);const selected=await page.evaluate(id=>ModelAvailabilityFixture.select(id,'alpha'),first);assert.equal(selected.ok,true,JSON.stringify(selected));
 const responseModel=turn=>page.locator('[data-turn-tail="'+turn+'"] .harness-response-model:visible');
 await responseModel(1).waitFor();assert.match(await responseModel(1).innerText(),/metadata is incomplete or unavailable/);
 assert.match(await responseModel(2).innerText(),/^Models used in this turn: model-fixture \/ alpha$/);
 assert.match(await responseModel(3).innerText(),/^Models used in this turn: model-fixture \/ alpha, model-fixture \/ beta$/);
 assert.match(await responseModel(4).innerText(),/metadata is incomplete or unavailable/);
 const notice=()=>page.locator('[data-model-availability-session="'+first+'"]:visible');
 const mode=async value=>{const response=await page.request.post(new URL('/api/model-availability-fixture',url).href,{data:{mode:value}});assert.equal(response.ok(),true);};
 const ready=async()=>page.waitForFunction(id=>ModelAvailabilityFixture.state(id).status==='ready',first);
 await ready();assert.equal(await notice().count(),0);
 await mode('absent');await page.waitForFunction(id=>ModelAvailabilityFixture.state(id)?.routable===false,first);try{await notice().waitFor();}catch(error){t.diagnostic(JSON.stringify({state:await page.evaluate(id=>ModelAvailabilityFixture.state(id),first),errors,text:(await page.locator('body').innerText()).slice(-1800)}));throw error;}assert.match(await notice().innerText(),/before sending.*model-fixture \/ alpha/);
 await page.evaluate(()=>HarnessI18n.setLanguage('cs'));assert.match(await notice().innerText(),/Před odesláním/);
 await mode('failure');await page.waitForFunction(id=>ModelAvailabilityFixture.state(id).failures.some(row=>row.id==='model-fixture'),first);assert.equal(await notice().count(),0,'a provider catalog failure is not proof that the selected model is missing');
 await mode('absent');await notice().waitFor();await page.reload();await page.waitForFunction(id=>window.ModelAvailabilityFixture?.known(id),first);await page.evaluate(id=>ModelAvailabilityFixture.open(id),first);await notice().waitFor();assert.equal((await page.evaluate(id=>ModelAvailabilityFixture.state(id).current,first)).model,'alpha','unavailable choice survives reload');
 await mode('present');await page.waitForFunction(id=>ModelAvailabilityFixture.state(id).routable===true,first);assert.equal(await notice().count(),0);
 assert.equal((await page.evaluate(id=>ModelAvailabilityFixture.select(id,'beta'),first)).ok,true);await page.reload();await page.waitForFunction(id=>window.ModelAvailabilityFixture?.known(id),first);await page.evaluate(id=>ModelAvailabilityFixture.open(id),first);await page.waitForFunction(id=>ModelAvailabilityFixture.state(id)?.current?.model==='beta',first);assert.equal(await notice().count(),0);await responseModel(2).waitFor();assert.match(await responseModel(2).innerText(),/model-fixture \/ alpha/,'a later selected model cannot relabel an earlier answer');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>HarnessI18n.setLanguage('cs'));await responseModel(3).getByText(/Modely použité v tomto běhu/).waitFor();assert.equal(await responseModel(3).evaluate(element=>element.scrollWidth<=element.clientWidth),true);
 const stats=await(await page.request.get(new URL('/api/model-availability-fixture',url).href)).json();assert.equal(stats.calls,0);assert.deepEqual(errors,[]);
});
