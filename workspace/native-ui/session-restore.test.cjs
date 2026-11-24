'use strict';
// Actual Native Host, SDK agent loop and browser. The local adapter never dispatches externally.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');

test('phone to desktop resumes one running Native turn, then restores its saved result without resubmission',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-session-restore-'));
 const root=path.resolve(__dirname,'../..'),project=path.join(directory,'project'),tools=path.join(directory,'fixture-tools');
 fs.mkdirSync(project);fs.mkdirSync(tools);
 const title='Synthetic mobile continuation',prompt='SYNTHETIC original phone request';
 const marker='SYNTHETIC saved conversation result',fileText='SYNTHETIC file written during the turn';
 const fileName='restored-result.txt',filePath=path.join(project,fileName),fixturePath='/api/session-restore-fixture';
 fs.writeFileSync(path.join(tools,'package.json'),JSON.stringify({name:'session-restore-fixture',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));
 fs.writeFileSync(path.join(tools,'client.js'),"window.__ModuleLoader__.load({id:'session-restore-fixture',factory:()=>({inject:['sessions','uiWorkspace'],apply(ctx){window.RestoreFixture={create:workspaceId=>ctx.sessions.create({workspaceId}),open:sessionId=>ctx.uiWorkspace.openSession(sessionId)};}})});");
 fs.writeFileSync(path.join(tools,'index.mjs'),`
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {installChatCache} from ${JSON.stringify(pathToFileURL(path.join(root,'runtime/ui-cache/native.mjs')).href)};
import {LlmAdapter} from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI),'../../dsh-llm/lib/index.js')).href)};
export const inject=['sessions','agents','connection','llm','workspaceRegistry','sessionTitle'];
export function apply(ctx){
 installChatCache(ctx);
 const project=${JSON.stringify(project)},provider='restore-fixture',gate=Promise.withResolvers();
 let own=null,streams=0,unexpectedDispatches=0,fileWritten=false;
 const admittedSessions=[];
 ctx.on('agent/inbox/inserted',({agent,message})=>{
  if(message.source.kind==='user')admittedSessions.push(agent.id);
 },{global:true});
 ctx.on('llm/stream',(options,next)=>{
  if(options.provider===provider&&options.sessionId===own&&options.purpose===undefined)return next();
  unexpectedDispatches++;throw Error('FIXTURE_REFUSES_EXTERNAL_INFERENCE');
 },{prepend:true,global:true});
 class RestoreAdapter extends LlmAdapter {
  async listModels(){return [{provider,id:'synthetic',name:'Synthetic restore fixture'}];}
  async *stream(){
   if(++streams!==1)throw Error('FIXTURE_EXPECTS_ONE_STREAM');
   await writeFile(${JSON.stringify(filePath)},${JSON.stringify(fileText)},{flag:'wx'});
   fileWritten=true;
   yield {type:'block-start',index:0,blockType:'text'};
   await gate.promise;
   yield {type:'text-delta',index:0,text:${JSON.stringify(marker)}};
   yield {type:'block-end',index:0,block:{type:'text',text:${JSON.stringify(marker)}}};
   yield {type:'finish',reason:{kind:'stop'}};
  }
 }
 ctx.llm.registerAdapter([provider],new RestoreAdapter());
 ctx.connection.fetch.register({path:${JSON.stringify(fixturePath)},methods:['POST','GET'],requestBody:'buffered',fetch:async request=>{
  if(request.method==='POST'){
   const {op,sessionId}=await request.json();
   if(op==='workspace'){
    const workspace=await ctx.workspaceRegistry.create(project);return Response.json({workspaceId:workspace.id});
   }
   const agent=ctx.agents.get(sessionId);
   if(!agent||agent.session.header.cwd!==project)throw Error('FIXTURE_OWN_SESSION_REQUIRED');
   if(op==='bind'&&own===null){
    own=sessionId;agent.model.select({provider,model:'synthetic'});
    // A named conversation has no automatic title call on its first prompt.
    ctx.sessionTitle.rename(agent.session,${JSON.stringify(title)});
   }
   else if(op==='finish'&&sessionId===own&&agent.status==='running'&&streams===1){
    gate.resolve();await agent.whenIdle();
    if(await ctx.sessions.flush(agent.session)!==true)throw Error('FIXTURE_DURABILITY_UNCONFIRMED');
   }else throw Error('FIXTURE_OPERATION_REFUSED');
  }
  const agent=own===null?null:ctx.agents.get(own);if(!agent)throw Error('FIXTURE_SESSION_REQUIRED');
  const log=agent.session.log,turnEvents=log.filter(e=>['turn/start','user/message','assistant/message','turn/end'].includes(e.type));
  return Response.json({sessionId:own,running:agent.status==='running',admittedSessions,streams,unexpectedDispatches,fileWritten,
   turns:log.filter(e=>e.type==='turn/start').length,users:log.filter(e=>e.type==='user/message'&&e.data.source?.kind==='user').length,
   replies:log.filter(e=>e.type==='assistant/message').length,reasons:log.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),
   historySha256:createHash('sha256').update(JSON.stringify(turnEvents)).digest('hex')});
 }});
}
`);
 const overlay=path.join(directory,'overlay.yml');
 fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'restore-workbench',name:pathToFileURL(createSourceFixture(directory)).href},{id:'restore-fixture',name:pathToFileURL(path.join(tools,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',browser,closed=false;
 child.once('close',()=>{closed=true;});child.stdout.on('data',b=>output=(output+b).slice(-262144));child.stderr.on('data',b=>output=(output+b).slice(-262144));
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(check);reject(Error('Native restore fixture startup timed out'));},40000),check=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(check);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',error=>{clearInterval(check);clearTimeout(timer);reject(error);});child.once('exit',code=>{clearInterval(check);clearTimeout(timer);reject(Error('Native restore fixture exited '+code));});});
  const launch={headless:true};
  if(process.env.HARNESS_BROWSER_CHANNEL)launch.channel=process.env.HARNESS_BROWSER_CHANNEL;
  else if(process.env.HARNESS_CHROMIUM_EXECUTABLE)launch.executablePath=process.env.HARNESS_CHROMIUM_EXECUTABLE;
  browser=await chromium.launch(launch);
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const desktopContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const errors=[],fileRequests=[];
  const fixture={trash:{},running:[],defaults:{},workspaces:[{id:'restore-workspace',title:'Synthetic project',sessionIds:[],settings:{}}],projects:{},environment:{},update:{}};
  let sid;
  const phone=fs.readFileSync(path.join(root,'mobile/phone.html'),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/phone/i18n.js"></script><script src="/phone/ui-copy.js"></script><script>window.harnessBackendReady=true;window.harnessPrepare=()=>Promise.resolve();</script><script src="/phone/app.js"></script></body>');
  for(const context of [mobileContext,desktopContext]){
   context.setDefaultTimeout(10000);
   context.on('page',page=>page.on('pageerror',error=>errors.push(error.message.replace(/https?:\S+/g,'[fixture-url]'))));
   await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await context.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,mode:'host-compat',available:true}}));
   await context.route('**/api/workbench/models**',route=>route.fulfill({json:{version:1,sessionId:new URL(route.request().url()).searchParams.get('sessionId'),groups:[],selection:null,source:'workspace',selectionError:null}}));
   await context.route('**/api/workbench',route=>{
    const body=route.request().postDataJSON();
    if(body?.op==='run-activity'){
     assert.equal(body.sessionId,sid);
     return route.fulfill({json:{version:1,sessionId:sid,phases:[{phase:'model.admitted',elapsedSeconds:0}]}});
    }
    if(body?.op!=='file')return route.fulfill({json:fixture});
    assert.equal(body.sessionId,sid);fileRequests.push(body);
    assert(['list','read'].includes(body.operation),'Restoring a session must not mutate a project');
    if(body.operation==='list')return route.fulfill({json:{entries:fs.readdirSync(project).map(name=>({name,directory:false}))}});
    assert.equal(body.args.path,fileName);
    return route.fulfill({json:{path:fileName,text:fs.readFileSync(filePath,'utf8'),version:'fixture-v1'}});
   });
  }
  await mobileContext.route('**/phone/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/phone/')return route.fulfill({contentType:'text/html',body:phone});
   const script={'/phone/i18n.js':'shared/i18n.cjs','/phone/ui-copy.js':'shared/ui-copy.cjs','/phone/app.js':'mobile/phone.js'}[p];
   if(script)return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,script),'utf8')});
   if(p.startsWith('/phone/api/state'))return route.fulfill({json:{registered:true,watcherOnline:true}});
   return route.fulfill({body:''});
  });
  async function ready(surface){
   try{await surface.waitForFunction(()=>Boolean(window.HarnessNativeUI&&window.RestoreFixture));}
   catch{throw Error('Local Native restore fixture did not mount: '+output.split(/\r?\n/).filter(line=>/failed|error|cannot|not found/i.test(line)).slice(-4).join(' ').replace(/https?:\S+/g,'[fixture-url]').slice(0,1200));}
   const preview=surface.getByRole('button',{name:'Continue',exact:true});
   await preview.waitFor({timeout:3000}).catch(()=>{});
   if(await preview.isVisible())await preview.click({timeout:3000}).catch(async error=>{if(await preview.isVisible())throw error;});
   const onboarding=surface.getByRole('dialog').filter({hasText:'Get started'});
   await onboarding.waitFor({timeout:2000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
   assert(await surface.evaluate(()=>Boolean(window.__HOMEAI_CHAT_CACHE_ACCESS__) &&
     window.__DSH_BOOT__.batches.some(batch=>batch.url.startsWith('_homeai/chat-ui/'))));
  }
  async function phoneSurface(page){
   await page.goto(new URL('/phone/',url).href);
   const frame=await (await page.locator('#harness').elementHandle()).contentFrame();
   assert(frame);await ready(frame);return frame;
  }
  async function proof(surface,op){
   return surface.evaluate(async({fixturePath,op,sessionId})=>{
    const options=op?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op,sessionId})}:undefined;
    const response=await fetch(fixturePath,options);if(!response.ok)throw Error('Restore proof failed: '+response.status);return response.json();
   },{fixturePath,op,sessionId:sid});
  }
  async function readFile(surface){
   await surface.evaluate(sessionId=>HarnessNativeUI.openFiles(sessionId),sid);
   await surface.locator('[data-model-session="'+sid+'"]').waitFor();
   await surface.getByRole('button',{name:fileName,exact:true}).click();
   await surface.waitForFunction(text=>document.querySelector('.wb-editor')?.value===text,fileText);
  }
  function assertOne(snapshot,running){
   assert.equal(snapshot.sessionId,sid);assert.equal(snapshot.running,running);
   assert.deepEqual(snapshot.admittedSessions,[sid]);assert.equal(snapshot.turns,1);assert.equal(snapshot.users,1);
   assert.equal(snapshot.streams,1);assert.equal(snapshot.unexpectedDispatches,0);assert.equal(snapshot.fileWritten,true);
   assert.equal(snapshot.replies,running?0:1);assert.deepEqual(snapshot.reasons,running?[]:['completed']);
  }

  const mobilePage=await mobileContext.newPage();
  await mobilePage.goto(url);
  const mobile=await phoneSurface(mobilePage);
  const {workspaceId}=await proof(mobile,'workspace');
  fixture.workspaces[0].id=workspaceId;
  sid=await mobile.evaluate(id=>RestoreFixture.create(id),workspaceId);
  fixture.workspaces[0].sessionIds=[sid];fixture.projects[sid]={root:project};
  await proof(mobile,'bind');
  await mobile.evaluate(sessionId=>RestoreFixture.open(sessionId),sid);
  try{await mobile.locator('[data-composer-input]').fill(prompt);}
  catch(error){throw Error('Native phone composer unavailable: '+(await mobile.locator('body').innerText()).slice(-3000),{cause:error});}
  await mobile.getByRole('button',{name:'Send message',exact:true}).click();
  await mobile.getByRole('button',{name:'Stop generating',exact:true}).waitFor();
  await mobile.getByText(prompt,{exact:true}).first().waitFor();
  await mobile.waitForFunction(async endpoint=>(await (await fetch(endpoint)).json()).fileWritten,fixturePath);
  await readFile(mobile);assertOne(await proof(mobile),true);
  await mobilePage.close();

  const desktop=await desktopContext.newPage();
  await desktop.goto(url);await ready(desktop);
  await desktop.getByText(title,{exact:true}).first().click();
  const stop=desktop.getByRole('button',{name:'Stop generating',exact:true});
  await stop.waitFor();
  await desktop.getByText(prompt,{exact:true}).first().waitFor();
  await readFile(desktop);assertOne(await proof(desktop),true);
  assert.equal(await desktop.getByText(marker,{exact:true}).count(),0);
  const completed=await proof(desktop,'finish');
  assertOne(completed,false);
  await desktop.getByText(marker,{exact:true}).waitFor();
  await stop.waitFor({state:'hidden'});

  async function restored(surface){
   await surface.getByText(marker,{exact:true}).waitFor();
   await readFile(surface);
   assert.deepEqual(await proof(surface),completed);
  }
  await desktop.reload();await restored(desktop);
  const reopenedPhone=await mobileContext.newPage();
  await restored(await phoneSurface(reopenedPhone));
  assert(fileRequests.filter(row=>row.operation==='read').length>=4);assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();if(!closed)child.kill();if(!closed)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('close',()=>{clearTimeout(timer);resolve();});});
  if(!closed){child.kill('SIGKILL');await new Promise(resolve=>{const timer=setTimeout(resolve,2000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
  assert(closed,'Retain the fresh fixture if its child shutdown is unconfirmed');const resolved=path.resolve(directory),temporary=path.resolve(os.tmpdir())+path.sep;assert(resolved.startsWith(temporary)&&path.basename(resolved).startsWith('harness-session-restore-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
});
