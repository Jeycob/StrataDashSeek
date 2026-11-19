'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');

test('phone creates a second SID in the same workspace and the SDK assembles its saved decision without inference',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async t=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
 const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'harness-project-memory-phone-')));
 const root=path.resolve(__dirname,'../..'),project=path.join(directory,'owned-project');fs.mkdirSync(project);
 const title='Synthetic owned project',firstTitle='Synthetic first chat',decision='Synthetic decision: use one named output.';
 const endpoint='/api/project-memory-native-fixture',memory='/api/workbench/project-memory';
 const sdk=path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI),'../..');
 const sdkModule=name=>JSON.stringify(pathToFileURL(path.join(sdk,name,'lib/index.js')).href);
 const host=path.join(directory,'memory-fixture.mjs');
 fs.writeFileSync(host,`
import {installProjectMemory} from ${JSON.stringify(pathToFileURL(path.join(root,'workspace/project-memory.mjs')).href)};
import {assembleContextFor} from ${sdkModule('dsh-agent')};
import {createUserMessage} from ${sdkModule('dsh-llm')};
import {renderPrompt} from ${sdkModule('dsh-system-prompt')};
export const inject=['workspaceRegistry','sessions','agents','sessionTitle','systemPrompt','connection'];
export function apply(ctx){
 const project=${JSON.stringify(project)},title=${JSON.stringify(title)},decision=${JSON.stringify(decision)};
 let workspace=null,first=null;const counters={externalStreams:0,prompts:0};
 ctx.on('llm/stream',()=>{counters.externalStreams++;throw Error('FIXTURE_REFUSES_ALL_INFERENCE');},{prepend:true,global:true});
 ctx.on('agent/inbox/inserted',({message})=>{if(message.source.kind==='user')counters.prompts++;},{global:true});
 installProjectMemory(ctx,{root:${JSON.stringify(directory)},execution:{assertUnchanged(){}}});
 function agentsInProject(){
  return (workspace?.sessionIds??[]).map(id=>{
   const agent=ctx.agents.get(id);if(!agent||agent.session.header.cwd!==project)throw Error('FIXTURE_OWN_PROJECT_REQUIRED');
   return agent;
  });
 }
 ctx.connection.fetch.register({path:${JSON.stringify(endpoint)},methods:['POST'],requestBody:'buffered',fetch:async request=>{
  const {op,sessionId}=await request.json();
  if(op==='setup'){
   if(workspace)throw Error('FIXTURE_ONLY_ONE_WORKSPACE');
   workspace=await ctx.workspaceRegistry.create(project,title);
  }
  if(!workspace)throw Error('FIXTURE_NEEDS_WORKSPACE');
  const own=agentsInProject(),ids=own.map(agent=>agent.id);
  if(op==='history'){
   if(first||ids.length!==1||sessionId!==ids[0])throw Error('FIXTURE_ONLY_ONE_PRIOR_CHAT');
   first=own[0].session;
   ctx.sessionTitle.rename(first,${JSON.stringify(firstTitle)});
   first.append('turn/start',{turn:1});
   first.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Synthetic earlier message'}]}),{surfaceOp:'append'});
   first.append('turn/end',{turn:1,reason:{kind:'completed'}});
   if(await ctx.sessions.flush(first)!==true)throw Error('FIXTURE_FLUSH_REQUIRED');
  }
  const checks=[];
  if(op==='assemble'){
   if(ids.length!==2||!ids.includes(first?.id)||!ids.includes(sessionId)||first.id===sessionId)throw Error('FIXTURE_NEEDS_TWO_DISTINCT_CHATS');
   for(const id of [first.id,sessionId]){
    const agent=own.find(value=>value.id===id);
    const assembly=await ctx.systemPrompt.assemble(assembleContextFor(agent,AbortSignal.timeout(4000)));
    checks.push({id:agent.id,decisionSeen:renderPrompt(assembly).includes(JSON.stringify(decision)),
     inHistory:agent.session.log.some(event=>JSON.stringify(event).includes(decision)),
     turnStarts:agent.session.log.filter(event=>event.type==='turn/start').length});
   }
  }
  return Response.json({workspaceId:workspace.id,ids,checks,counters});
 }});
}
`);
 const overlay=path.join(directory,'overlay.yml');
 fs.writeFileSync(overlay,JSON.stringify([{insert:[
  {id:'memory-workbench',name:pathToFileURL(createSourceFixture(directory)).href},
  {id:'memory-fixture',name:pathToFileURL(host).href}
 ]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{
  cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},
  stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 let output='',browser,closed=false;
 child.once('close',()=>{closed=true;});child.stdout.on('data',data=>output=(output+data).slice(-262144));child.stderr.on('data',data=>output=(output+data).slice(-262144));
 try{
  const url=await new Promise((resolve,reject)=>{
   const stop=setTimeout(()=>{clearInterval(check);reject(Error('Native project memory startup timed out'));},40000);
   const check=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(check);clearTimeout(stop);resolve(match[0]);}},50);
   child.once('error',error=>{clearInterval(check);clearTimeout(stop);reject(error);});
   child.once('exit',code=>{clearInterval(check);clearTimeout(stop);reject(Error('Native fixture exited '+code));});
  });
  const launch={headless:true};if(process.env.HARNESS_BROWSER_CHANNEL)launch.channel=process.env.HARNESS_BROWSER_CHANNEL;
  else if(process.env.HARNESS_CHROMIUM_EXECUTABLE)launch.executablePath=process.env.HARNESS_CHROMIUM_EXECUTABLE;
  browser=await chromium.launch(launch);
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();page.setDefaultTimeout(10000);
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const phone=fs.readFileSync(path.join(root,'mobile/phone.html'),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/phone/i18n.js"></script><script src="/phone/ui-copy.js"></script><script>window.harnessBackendReady=true;window.harnessPrepare=()=>Promise.resolve();</script><script src="/phone/app.js"></script></body>');
  await context.route('**/phone/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/phone/')return route.fulfill({contentType:'text/html',body:phone});
   const script={'/phone/i18n.js':'shared/i18n.cjs','/phone/ui-copy.js':'shared/ui-copy.cjs','/phone/app.js':'mobile/phone.js'}[p];
   if(script)return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,script),'utf8')});
   if(p.startsWith('/phone/api/state'))return route.fulfill({json:{registered:true,watcherOnline:true}});
   return route.fulfill({body:''});
  });
  await page.goto(url);
  const request=(target,body)=>page.evaluate(async({target,body})=>{
   const response=await fetch(target,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!response.ok)throw Error('Fixture '+body.op+' failed: '+response.status+' '+(await response.text()).slice(0,400));
   return response.json();
  },{target,body});
  const proof=(op,sessionId)=>request(endpoint,{op,sessionId});
  const {workspaceId}=await proof('setup');
  await page.goto(new URL('/phone/',url).href);
  const phoneFrame=await (await page.locator('#harness').elementHandle()).contentFrame();assert(phoneFrame);
  await phoneFrame.waitForFunction(()=>Boolean(window.HarnessNativeUI),null,{timeout:15000});
  const preview=phoneFrame.getByRole('button',{name:'Continue',exact:true});
  await preview.waitFor({timeout:3000}).catch(()=>{});if(await preview.isVisible())await preview.tap();
  const onboarding=phoneFrame.getByRole('dialog').filter({hasText:'Get started'});
  await onboarding.waitFor({timeout:2000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).tap();
  const navigation=phoneFrame.getByRole('dialog',{name:'Navigation',exact:true}).and(phoneFrame.locator('[aria-modal=true]'));
  async function openNavigation(){
   if(!await navigation.isVisible())await phoneFrame.locator('[data-sidebar-opener]').tap();
   await navigation.waitFor();
  }
  async function newSession(){
   await openNavigation();
   const row=navigation.locator('[data-row-key^="workspace:"]').filter({hasText:title});
   const create=row.getByRole('button',{name:'New session in '+title,exact:true});
   await row.waitFor();if(!await create.isVisible())await row.getByText(title,{exact:true}).tap();
   await create.tap();
   await navigation.waitFor({state:'hidden'});
   await phoneFrame.locator('[data-composer-input]').waitFor();
  }
  async function waitForCount(expected){
   await page.waitForFunction(async({endpoint,expected})=>{
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'state'})});
    return response.ok&&(await response.json()).ids.length===expected;
   },{endpoint,expected});
   return proof('state');
  }
  await newSession();
  const first=(await waitForCount(1)).ids[0];
  await proof('history',first);
  const saved=await request(memory,{operation:'add',workspaceId,revision:null,text:decision});
  assert.equal(saved.workspaceId,workspaceId);assert.equal(saved.entries[0].text,decision);
  await newSession();
  const {ids}=await waitForCount(2),second=ids.find(id=>id!==first);
  assert(ids.includes(first));assert(second);
  const result=await proof('assemble',second);
  assert.equal(result.workspaceId,workspaceId);
  assert.deepEqual(result.checks,[
   {id:first,decisionSeen:true,inHistory:false,turnStarts:1},
   {id:second,decisionSeen:true,inHistory:false,turnStarts:0}
  ]);
  assert.deepEqual(result.counters,{externalStreams:0,prompts:0});
  t.diagnostic(JSON.stringify({workspaceId,first,second,checks:result.checks,counters:result.counters}));
 }finally{
  if(browser)await browser.close();if(!closed)child.kill();
  if(!closed)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('close',()=>{clearTimeout(timer);resolve();});});
  if(!closed){child.kill('SIGKILL');await new Promise(resolve=>{const timer=setTimeout(resolve,2000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
  assert(closed,'Retain fixture if the Native host did not settle');
  assert(path.basename(directory).startsWith('harness-project-memory-phone-'));fs.rmSync(directory,{recursive:true,force:true});
 }
});
