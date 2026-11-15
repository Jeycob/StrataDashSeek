'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const {createSourceFixture}=require('./test-bundle.cjs');
const {changesFixture,runChangesScenarios}=require('./changes-scenarios.cjs');
// Actual pinned Native Host + browser composition; application/file data APIs are
// controlled fixtures. No model request, Docker launch, SSH or paid resource.
test('rc.2 Native Settings, CtrlAltP, Docker and EN/CZ compose on desktop and mobile',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-native-ui-'));
 const evidence=process.env.HARNESS_NATIVE_EVIDENCE||directory;fs.mkdirSync(evidence,{recursive:true});
 const tools=path.join(directory,'fixture-tools');fs.mkdirSync(tools);fs.writeFileSync(path.join(tools,'package.json'),JSON.stringify({name:'native-ui-test-tools',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));fs.writeFileSync(path.join(tools,'index.mjs'),'export function apply(){}');
 fs.writeFileSync(path.join(tools,'client.js'),"window.__ModuleLoader__.load({id:'native-ui-test-tools',factory:()=>({inject:['sessions','sidebarRight'],apply(ctx){window.NativeFixture={create:cwd=>ctx.sessions.create({cwd}),openResource:address=>ctx.sidebarRight.openResource(address),openGuide:()=>ctx.sidebarRight.openTab('guide'),closeTab:id=>ctx.sidebarRight.close(id)};}})});");
 const overlay=path.join(directory,'overlay.yml');fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'test-native-workbench',name:pathToFileURL(createSourceFixture(directory)).href},{id:'native-test-tools',name:pathToFileURL(path.join(tools,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',browser;child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(check);reject(Error('Native fixture startup timed out'));},40000),check=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(check);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',e=>{clearInterval(check);clearTimeout(timer);reject(e);});child.once('exit',code=>{clearInterval(check);clearTimeout(timer);reject(Error('Native fixture exited '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],mutations=[],fileRequests=[],deleted=new Set();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message.replace(/https?:\S+/g,'[fixture-url]')));page.on('dialog',d=>d.accept());
  const fixture={trash:{},running:[],defaults:{provider:'strata-vast',reasoningEffort:'medium',thinkingBudget:4096},workspaces:[{id:'w1',title:'Fixture project',sessionIds:[],settings:{}}],projects:{},environment:{},update:{version:1,enabled:true,phase:'ready',checkedAt:'2026-11-14T21:00:00Z',appliedCommit:'a'.repeat(40),targetCommit:'a'.repeat(40),error:null,signatureVerified:true}};
  const apps={enabled:true,available:true,busy:false,worker:{managed:true,phase:'ready'},previewSettings:{configured:true,enabled:true},holdUntil:0,projects:[],containers:[{id:'c1',name:'fixture running container',state:'running',ports:[]}],jobs:[],remoteTargets:[],vault:{configured:false}};
  const changes=changesFixture();
  async function wireRoutes(target){
  await target.route('**/api/workbench',route=>{const body=route.request().postDataJSON();if(body?.op==='changes')return changes.handle(route,body);if(body?.op==='file'){fileRequests.push(body);if(body.operation==='delete'){assert.equal(body.args.version,'v1');deleted.add(body.sessionId);}return route.fulfill({json:body.operation==='list'?{entries:deleted.has(body.sessionId)?[]:[{name:'native-fixture.txt',directory:false}]}:{path:'native-fixture.txt',text:'Native isolated project',version:'v1'}});}return route.fulfill({json:fixture});});
  await target.route('**/phone/api/apps/**',route=>{const request=route.request();if(request.method()==='POST')mutations.push({url:new URL(request.url()).pathname,body:request.postDataJSON()});return route.fulfill({json:request.url().endsWith('/state')?apps:request.url().endsWith('/scaffold')?{runtime:'node',warnings:[],files:{}}:{id:'p1'}});});
  }
  await wireRoutes(page);
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.HarnessNativeUI&&window.NativeFixture));
  const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor({timeout:4000}).catch(()=>{});if(await preview.isVisible()){await preview.click();await preview.waitFor({state:'hidden'});}
  const onboarding=page.getByRole('dialog').filter({hasText:'Get started'});await onboarding.waitFor({timeout:3000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.HarnessNativeUI.openSettings('harness-workspaces')),true);
  await page.getByRole('combobox').filter({has:page.locator('option[value="medium"]')}).waitFor();await page.locator('[data-harness-update-status]').waitFor();
  assert.match(await page.locator('[data-harness-update-status]').innerText(),/ready.*aaaaaaaaaaaa/);
  await page.locator('.wb-form [name="model"]').fill('unsaved-model-choice');
  await page.evaluate(()=>window.HarnessI18n.setLanguage('cs'));await page.getByRole('button',{name:'Výchozí nastavení projektů',exact:true}).waitFor();assert.equal(await page.locator('.wb-form [name="model"]').inputValue(),'unsaved-model-choice');
  await page.evaluate(()=>window.HarnessI18n.setLanguage('en'));await page.getByRole('button',{name:'Workspace defaults',exact:true}).waitFor();assert.equal(await page.locator('.wb-form [name="model"]').inputValue(),'unsaved-model-choice');
  await page.getByRole('button',{name:'Applications and Docker',exact:true}).click();await page.getByText('Credential vault',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Notifications',exact:true}).click();await page.getByText('Open the installed Harness app',{exact:false}).waitFor();
  await page.screenshot({path:path.join(evidence,'native-settings.png'),fullPage:true});await page.keyboard.press('Escape');
  const sid=await page.evaluate(cwd=>window.NativeFixture.create(cwd),directory);fixture.projects[sid]={root:'/data/harness/workspaces/projects/native-fixture'};fixture.workspaces[0].sessionIds=[sid];
  assert.equal(await page.evaluate(id=>window.HarnessNativeUI.openDocker(id),sid),true);await page.getByText('fixture running container',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Prepare Docker from this project',exact:true}).click();await page.getByText('Docker project prepared.',{exact:true}).waitFor();
  assert.deepEqual(mutations.map(m=>[m.url,m.body.path]),[['/phone/api/apps/scaffold','projects/native-fixture'],['/phone/api/apps/register','projects/native-fixture']]);
  fixture.projects[sid].root='/data/harness/workspaces-other/not-authorized';await page.getByRole('button',{name:'Prepare Docker from this project',exact:true}).click();await page.getByText('This project is outside the application workspace.',{exact:false}).waitFor();assert.equal(mutations.length,2);
  fixture.projects[sid].root='/data/harness/workspaces/projects/native-fixture';
  await page.getByRole('button',{name:'Prepare Docker from this project',exact:true}).click();await page.getByText('Docker project prepared.',{exact:true}).waitFor();
  await page.screenshot({path:path.join(evidence,'native-docker.png'),fullPage:true});
  fs.writeFileSync(path.join(evidence,'native-style-diagnostic.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('.harness-apps,.workspace-workbench')].map(el=>({id:el.id,font:getComputedStyle(el).fontFamily,background:getComputedStyle(el).backgroundColor,buttonFont:el.querySelector('button')&&getComputedStyle(el.querySelector('button')).fontFamily,matchingRootRules:[...document.querySelectorAll('style')].filter(s=>s.textContent.includes('#'+el.id+'{')).map(s=>({sheet:Boolean(s.sheet),rules:s.sheet?.cssRules?.length,text:s.textContent.slice(0,120)}))})))));
  fs.writeFileSync(path.join(directory,'Preview.txt'),'Native standard preview');const {fileAddressFor}=createRequire(path.resolve(process.env.HARNESS_NATIVE_CLI))('@deepseek-ai/dsh-util-workspace-path');
  await page.evaluate(address=>NativeFixture.openResource(address),fileAddressFor(sid,directory,path.join(directory,'Preview.txt')));await page.locator('[data-files-navigator-toggle]').click();await page.getByRole('button',{name:'native-fixture.txt',exact:true}).waitFor();assert.equal(fileRequests.at(-1).sessionId,sid);
  await page.keyboard.press('Control+Alt+p');await page.getByRole('button',{name:'native-fixture.txt',exact:true}).click();assert.equal(await page.locator('.wb-editor').inputValue(),'Native isolated project');assert.equal(fileRequests.every(r=>r.sessionId===sid),true);assert.ok(await page.locator('.wb-editor').evaluate(e=>e.offsetHeight>=300));
  await page.screenshot({path:path.join(evidence,'native-files.png'),fullPage:true});
  await page.getByRole('button',{name:'Rename',exact:true}).click();
  const renameDialog=page.locator('dialog[data-workbench-dialog="rename"]');await renameDialog.waitFor();
  assert.equal(await renameDialog.locator('input').evaluate(e=>e===document.activeElement),true);
  await page.screenshot({path:path.join(evidence,'native-editor-rename-dialog.png'),fullPage:true});
  await page.keyboard.press('Escape');await renameDialog.waitFor({state:'detached'});
  assert.equal(await page.locator('.wb-editor').inputValue(),'Native isolated project');
  await page.getByRole('button',{name:'Delete',exact:true}).click();await page.locator('.wb-editor').waitFor({state:'detached'});assert.equal(deleted.has(sid),true);assert.equal(fileRequests.filter(r=>r.operation==='delete').length,1);
  const other=path.join(directory,'second-source');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'Second.txt'),'Second preview');const sid2=await page.evaluate(cwd=>NativeFixture.create(cwd),other);fixture.projects[sid2]={root:'/data/harness/workspaces/projects/second-isolated'};fixture.workspaces[0].sessionIds.push(sid2);
  await page.evaluate(id=>HarnessNativeUI.openFiles(id),sid2);await page.getByRole('button',{name:'native-fixture.txt',exact:true}).waitFor();assert.equal(fileRequests.at(-1).sessionId,sid2);assert.match(await page.locator('[id$="wb-info"]:visible').innerText(),/second-isolated/);
  await page.evaluate(address=>NativeFixture.openResource(address),fileAddressFor(sid2,other,path.join(other,'Second.txt')));await page.locator('[data-files-navigator-toggle]').click();await page.getByRole('button',{name:'native-fixture.txt',exact:true}).waitFor();assert.equal(fileRequests.at(-1).sessionId,sid2);
  await runChangesScenarios(page,{sid,sid2,data:changes,evidence,wireRoutes});
  await page.evaluate(id=>window.HarnessNativeUI.openDocker(id),sid);await page.waitForTimeout(300);await page.screenshot({path:path.join(evidence,'native-docker-desktop-en.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  // Only our freshly minted fixture directory may be recursively removed.
  const resolved=path.resolve(directory),temporary=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(temporary)||!path.basename(resolved).startsWith('harness-native-ui-'))throw Error('Unsafe fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});
 }
});
