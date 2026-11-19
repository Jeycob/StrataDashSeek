'use strict';
// Actual pinned Native Host and browser; only synthetic log/file/phone inputs.
// No model prompt, provider request, Docker, project deployment or remote service.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');
test('desktop and phone reload restore the same Native conversation, project file and saved result without resubmission',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-session-restore-'));
 const root=path.resolve(__dirname,'../..'),project=path.join(directory,'project'),tools=path.join(directory,'fixture-tools');fs.mkdirSync(project);fs.mkdirSync(tools);
 const marker='SYNTHETIC saved conversation result',fileText='SYNTHETIC preserved project file';
 fs.writeFileSync(path.join(project,'restored-result.txt'),fileText);
 fs.writeFileSync(path.join(tools,'package.json'),JSON.stringify({name:'session-restore-fixture',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));
 fs.writeFileSync(path.join(tools,'client.js'),"window.__ModuleLoader__.load({id:'session-restore-fixture',factory:()=>({inject:['sessions'],apply(ctx){window.RestoreFixture={create:cwd=>ctx.sessions.create({cwd})};}})});");
 // The test route only sees this fresh Host's own created session. Appending a
 // synthetic completed turn exercises real persistence/rendering without inference.
 fs.writeFileSync(path.join(tools,'index.mjs'),`
import {createHash} from 'node:crypto';
import {createUserMessage,createAssistantMessage} from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(process.env.HARNESS_NATIVE_CLI),'../../dsh-llm/lib/index.js')).href)};
export const inject=['sessions','agents','connection'];
export function apply(ctx){let own=null,seedCut=0,createdSessions=0,modelRequests=0;
 ctx.on('session/created',()=>{createdSessions++;},{global:true});
 ctx.on('llm/stream',async function*(){modelRequests++;throw Error('SYNTHETIC_FIXTURE_REFUSES_INFERENCE');},{prepend:true,global:true});
 ctx.connection.fetch.register({path:'/api/session-restore-fixture',methods:['POST','GET'],requestBody:'buffered',fetch:async request=>{
 if(request.method==='POST'){if(own!==null)throw Error('FIXTURE_SEED_ONCE');const body=await request.json(),agent=ctx.agents.get(body.sessionId);if(!agent||agent.session.header.cwd!==${JSON.stringify(project)})throw Error('FIXTURE_OWN_SESSION_REQUIRED');own=body.sessionId;const s=agent.session;
 s.append('turn/start',{turn:1});s.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'SYNTHETIC original saved request'}]}),{surfaceOp:'append'});s.append('step/start',{turn:1,step:1});const block={type:'text',text:${JSON.stringify(marker)}},time=Date.now(),stream=[{type:'chunk',time,chunk:{type:'block-start',index:0,blockType:'text'}},{type:'text-chunks',time0:time,index:0,dt:[0],texts:[block.text]},{type:'chunk',time,chunk:{type:'block-end',index:0,block}},{type:'chunk',time,chunk:{type:'finish',reason:'stop'}}];s.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[block],source:{provider:'restore-fixture',model:'synthetic'}}),stream},{surfaceOp:'append'});s.append('step/end',{turn:1,step:1});s.append('turn/end',{turn:1,reason:{kind:'completed'}});if(await ctx.sessions.flush(s)!==true)throw Error('FIXTURE_DURABILITY_UNCONFIRMED');seedCut=s.log.length;
 }
 const s=own===null?null:ctx.sessions.get(own);if(!s)throw Error('FIXTURE_SESSION_REQUIRED');return Response.json({sessionId:own,prefixSha256:createHash('sha256').update(JSON.stringify(s.log.slice(0,seedCut))).digest('hex'),turns:s.log.filter(e=>e.type==='turn/start').length,assistant:s.log.filter(e=>e.type==='assistant/message').length,users:s.log.filter(e=>e.type==='user/message').length,createdSessions,modelRequests});
 }});}
`);
 const overlay=path.join(directory,'overlay.yml');fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'restore-workbench',name:pathToFileURL(createSourceFixture(directory)).href},{id:'restore-fixture',name:pathToFileURL(path.join(tools,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',browser,closed=false;child.once('close',()=>{closed=true;});child.stdout.on('data',b=>output=(output+b).slice(-262144));child.stderr.on('data',b=>output=(output+b).slice(-262144));
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(check);reject(Error('Native restore fixture startup timed out'));},40000),check=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(check);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',error=>{clearInterval(check);clearTimeout(timer);reject(error);});child.once('exit',code=>{clearInterval(check);clearTimeout(timer);reject(Error('Native restore fixture exited '+code));});});
  const launch={headless:true};if(process.env.HARNESS_BROWSER_CHANNEL)launch.channel=process.env.HARNESS_BROWSER_CHANNEL;else if(process.env.HARNESS_CHROMIUM_EXECUTABLE)launch.executablePath=process.env.HARNESS_CHROMIUM_EXECUTABLE;
  browser=await chromium.launch(launch);const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],fileRequests=[],effects={creates:0,prompts:0};page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message.replace(/https?:\S+/g,'[fixture-url]')));
  page.on('request',request=>{const p=new URL(request.url()).pathname;if(p==='/api/session/create')effects.creates++;if(p==='/api/session/prompt')effects.prompts++;});
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const fixture={trash:{},running:[],defaults:{},workspaces:[{id:'restore-workspace',title:'Synthetic project',sessionIds:[],settings:{}}],projects:{},environment:{},update:{}};
  await page.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,mode:'host-compat',available:true}}));
  await page.route('**/api/workbench/models**',route=>route.fulfill({json:{version:1,sessionId:new URL(route.request().url()).searchParams.get('sessionId'),groups:[],selection:null,source:'workspace',selectionError:null}}));
  await page.route('**/api/workbench',route=>{const body=route.request().postDataJSON();if(body?.op==='file'){assert.equal(fixture.workspaces[0].sessionIds.includes(body.sessionId),true);fileRequests.push(body);assert(['list','read'].includes(body.operation),'Reload must not mutate a project');return route.fulfill({json:body.operation==='list'?{entries:[{name:'restored-result.txt',directory:false}]}:{path:'restored-result.txt',text:fileText,version:'synthetic-v1'}});}return route.fulfill({json:fixture});});
  const phone=fs.readFileSync(path.join(root,'mobile/phone.html'),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/phone/i18n.js"></script><script src="/phone/ui-copy.js"></script><script>window.harnessBackendReady=true;window.harnessPrepare=()=>Promise.resolve();</script><script src="/phone/app.js"></script></body>');
  await page.route('**/phone/**',route=>{const p=new URL(route.request().url()).pathname;if(p==='/phone/')return route.fulfill({contentType:'text/html',body:phone});if(p==='/phone/i18n.js'||p==='/phone/ui-copy.js'||p==='/phone/app.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,p==='/phone/i18n.js'?'shared/i18n.cjs':p==='/phone/ui-copy.js'?'shared/ui-copy.cjs':'mobile/phone.js'),'utf8')});if(p.startsWith('/phone/api/state'))return route.fulfill({json:{registered:true,watcherOnline:true}});if(p==='/phone/sw.js')return route.fulfill({contentType:'text/javascript',body:''});return route.fulfill({body:''});});
  await page.goto(url);try{await page.waitForFunction(()=>Boolean(window.HarnessNativeUI&&window.RestoreFixture));}catch{throw Error('Local Native restore fixture did not mount: '+output.split(/\r?\n/).filter(line=>/failed|error|cannot|not found/i.test(line)).slice(-4).join(' ').replace(/https?:\S+/g,'[fixture-url]').slice(0,1200));}
  const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor({timeout:3000}).catch(()=>{});if(await preview.isVisible())await preview.click();
  const onboarding=page.getByRole('dialog').filter({hasText:'Get started'});await onboarding.waitFor({timeout:2000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  const sid=await page.evaluate(cwd=>RestoreFixture.create(cwd),project);fixture.workspaces[0].sessionIds=[sid];fixture.projects[sid]={root:project};
  const seed=await page.evaluate(async sessionId=>{const response=await fetch('/api/session-restore-fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId})});if(!response.ok)throw Error('Synthetic session seed failed');return response.json();},sid);
  await page.evaluate(id=>HarnessNativeUI.openFiles(id),sid);
  async function restored(surface){
   await surface.locator('[data-model-session="'+sid+'"]').waitFor();try{await surface.getByText(marker,{exact:true}).waitFor({state:'attached'});}catch{throw Error('Saved history not rendered in the restored synthetic surface: '+JSON.stringify({errors,text:await page.locator('body').innerText().then(s=>s.slice(-4500)),seed}));}
   await surface.getByRole('button',{name:'restored-result.txt',exact:true}).click();assert.equal(await surface.locator('.wb-editor').inputValue(),fileText);
   const proof=await page.evaluate(async()=>{const response=await fetch('/api/session-restore-fixture');if(!response.ok)throw Error('Synthetic history read failed');return response.json();});assert.deepEqual(proof,seed);assert.equal(proof.turns,1);assert.equal(proof.assistant,1);assert.equal(proof.users,1);assert.equal(proof.modelRequests,0);
  }
  await restored(page);const initialCreates=effects.creates;await page.reload();await restored(page);assert.equal(effects.creates,initialCreates);
  await page.setViewportSize({width:390,height:844});await page.goto(new URL('/phone/',url).href);await restored(page.frameLocator('#harness'));
  await page.reload();await restored(page.frameLocator('#harness'));
  assert.equal(effects.creates,initialCreates);assert.equal(effects.prompts,0);assert(fileRequests.length>=8);assert(fileRequests.every(row=>row.sessionId===sid));assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();if(!closed)child.kill();if(!closed)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('close',()=>{clearTimeout(timer);resolve();});});
  if(!closed){child.kill('SIGKILL');await new Promise(resolve=>{const timer=setTimeout(resolve,2000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
  assert(closed,'Retain the fresh fixture if its child shutdown is unconfirmed');const resolved=path.resolve(directory),temporary=path.resolve(os.tmpdir())+path.sep;assert(resolved.startsWith(temporary)&&path.basename(resolved).startsWith('harness-session-restore-'));fs.rmSync(resolved,{recursive:true,force:true});
 }
});
