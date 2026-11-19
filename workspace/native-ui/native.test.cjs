'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const {createSourceFixture}=require('./test-bundle.cjs');
const {changesFixture,runChangesScenarios}=require('./changes-scenarios.cjs');
// Actual pinned Native Host + browser composition; application/file data APIs are
// controlled fixtures. No model request, Docker launch, SSH or paid resource.
for(const legacyAbort of [false,true])test((legacyAbort?'Missing abort helpers: ':'')+'rc.2 Native Settings, CtrlAltP, Docker and EN/CZ compose on desktop and mobile',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-native-ui-'));
 const evidence=process.env.HARNESS_NATIVE_EVIDENCE||directory;fs.mkdirSync(evidence,{recursive:true});
 const tools=path.join(directory,'fixture-tools');fs.mkdirSync(tools);fs.writeFileSync(path.join(tools,'package.json'),JSON.stringify({name:'native-ui-test-tools',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));fs.writeFileSync(path.join(tools,'index.mjs'),'export function apply(){}');
 fs.writeFileSync(path.join(tools,'client.js'),"window.__ModuleLoader__.load({id:'native-ui-test-tools',factory:()=>({inject:['sessions','sidebarRight','locale','configForms'],apply(ctx){window.NativeFixture={setRunning:(id,on)=>ctx.sessions.handleSessionStatus(id,on),create:cwd=>ctx.sessions.create({cwd}),openResource:address=>ctx.sidebarRight.openResource(address),openGuide:()=>ctx.sidebarRight.openTab('guide'),closeTab:id=>ctx.sidebarRight.close(id),locale:()=>{const form=ctx.configForms.get('locale').getSnapshot();return{active:ctx.locale.getSnapshot().active,status:form.status,preference:form.value?.preference};}};}})});");
 const overlay=path.join(directory,'overlay.yml');fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'test-native-workbench',name:pathToFileURL(createSourceFixture(directory)).href},{id:'native-test-tools',name:pathToFileURL(path.join(tools,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',browser;child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(check);reject(Error('Native fixture startup timed out'));},40000),check=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(check);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',e=>{clearInterval(check);clearTimeout(timer);reject(e);});child.once('exit',code=>{clearInterval(check);clearTimeout(timer);reject(Error('Native fixture exited '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],mutations=[],fileRequests=[],deleted=new Set();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message.replace(/https?:\S+/g,'[fixture-url]')));page.on('dialog',d=>d.accept());
  if(legacyAbort)await page.addInitScript(()=>{delete AbortSignal.any;delete AbortSignal.timeout;});
  const fixture={trash:{},running:[],defaults:{provider:'strata-vast',reasoningEffort:'medium',thinkingBudget:4096},workspaces:[{id:'w1',title:'Fixture project',sessionIds:[],settings:{}}],projects:{},environment:{},update:{version:1,enabled:true,phase:'ready',checkedAt:'2026-11-14T21:00:00Z',appliedCommit:'a'.repeat(40),targetCommit:'a'.repeat(40),error:null,signatureVerified:true}};
  const apps={enabled:true,available:true,busy:false,worker:{managed:true,phase:'ready'},previewSettings:{configured:true,enabled:true},holdUntil:0,projects:[],containers:[{id:'c1',name:'fixture running container',state:'running',ports:[]}],jobs:[],remoteTargets:[],vault:{configured:false}};
  const ownDevice='11111111-2222-4333-8444-555555555555',deviceRevocations=[],devices=[{deviceId:ownDevice,name:'Fixture iPhone',createdAt:Date.now()-1000,expiresAt:Date.now()+3600000,revokedAt:null,scope:['status','wake'],credential:'MUST_NOT_RENDER_DEVICE_CREDENTIAL'},{deviceId:'99999999-2222-4333-8444-555555555555',name:'Fixture desktop',createdAt:Date.now()-1000,expiresAt:Date.now()+3600000,revokedAt:null,scope:['status','wake']}];
  const changes=changesFixture();
  async function wireRoutes(target){
  await target.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,mode:'host-compat',available:true}}));
  await target.route('**/phone/api/devices**',route=>{if(new URL(route.request().url()).pathname.endsWith('/revoke')){const data=route.request().postDataJSON();deviceRevocations.push(data.deviceId);const device=devices.find(row=>row.deviceId===data.deviceId);device.revokedAt=Date.now();return route.fulfill({json:{deviceId:device.deviceId,revokedAt:device.revokedAt}});}return route.fulfill({json:{version:2,devices,ownerUrl:'https://fixture-wake.example/?devices=1'}});});
  await target.route('**/fixture/claim-device',route=>{devices[0].revokedAt=null;return route.fulfill({json:{deviceId:ownDevice}});});
  await target.route('**/api/workbench',route=>{const body=route.request().postDataJSON();if(body?.op==='changes')return changes.handle(route,body);if(body?.op==='file'){fileRequests.push(body);if(body.operation==='delete'){assert.equal(body.args.version,'v1');deleted.add(body.sessionId);}return route.fulfill({json:body.operation==='list'?{entries:deleted.has(body.sessionId)?[]:[{name:'native-fixture.txt',directory:false}]}:{path:'native-fixture.txt',text:'Native isolated project',version:'v1'}});}return route.fulfill({json:fixture});});
  await target.route('**/phone/api/apps/**',route=>{const request=route.request(),url=new URL(request.url()),sessionId=url.searchParams.get('sessionId'),global=url.searchParams.get('scope')==='global',context=global?{scope:'global',workspaceId:null,sessionId:null,projectId:null}:{scope:'project',workspaceId:'w1',sessionId,projectId:require('node:crypto').createHash('sha256').update(sessionId||'').digest('hex').slice(0,16)};if(request.method()==='POST')mutations.push({url:url.pathname,body:request.postDataJSON()});return route.fulfill({json:{...(url.pathname.endsWith('/state')?apps:url.pathname.endsWith('/scaffold')?{runtime:'node',warnings:[],files:{}}:{id:'p1'}),context}});});
  }
  await wireRoutes(page);
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.HarnessNativeUI&&window.NativeFixture));
  const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor({timeout:4000}).catch(()=>{});if(await preview.isVisible()){await preview.click();await preview.waitFor({state:'hidden'});}
  const onboarding=page.getByRole('dialog').filter({hasText:'Get started'});await onboarding.waitFor({timeout:3000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  // Native publishes locale before its ordered Host preference write settles.
  // Finish both directions before the next switch; a translated label alone
  // can belong to an earlier render while a Host snapshot is still in flight.
  const waitForLocale=language=>page.waitForFunction(language=>{const locale=NativeFixture.locale();return locale.status==='ready'&&locale.active===language&&locale.preference===language&&HarnessI18n.language===language;},language);
  assert.equal(await page.evaluate(()=>window.HarnessNativeUI.openSettings('harness-workspaces')),true);
  await page.getByRole('combobox').filter({has:page.locator('option[value="medium"]')}).waitFor();assert.equal(await page.locator('[data-harness-settings-group="workspace"] > label > select').count(),1);
  await page.locator('.wb-form [name="model"]').fill('unsaved-model-choice');
  await page.evaluate(()=>window.HarnessI18n.setLanguage('cs'));await waitForLocale('cs');await page.getByRole('button',{name:'Výchozí nastavení projektů',exact:true}).waitFor();assert.equal(await page.locator('.wb-form [name="model"]').inputValue(),'unsaved-model-choice');
  await page.evaluate(()=>window.HarnessI18n.setLanguage('en'));await waitForLocale('en');await page.getByRole('button',{name:'Workspace defaults',exact:true}).waitFor();assert.equal(await page.locator('.wb-form [name="model"]').inputValue(),'unsaved-model-choice');
  await page.getByRole('button',{name:'General',exact:true}).click();await page.getByText('Language',{exact:true}).waitFor();assert.equal(await page.locator('#harness-interface-language').count(),0);await page.getByRole('button',{name:'English',exact:true}).click();await page.getByRole('menu').getByText('Čeština',{exact:true}).click();await page.getByText('Jazyk',{exact:true}).waitFor();await waitForLocale('cs');assert.equal(await page.evaluate(()=>HarnessI18n.language),'cs');await page.getByRole('button',{name:'Čeština',exact:true}).click();await page.getByRole('menu').getByText('English',{exact:true}).click();await waitForLocale('en');assert.equal(await page.evaluate(()=>HarnessI18n.language),'en');
  await page.getByRole('button',{name:'Advanced runtime status',exact:true}).click();await page.locator('[data-harness-update-status]').waitFor();assert.match(await page.locator('[data-harness-update-status]').innerText(),/ready[\s\S]*aaaaaaaaaaaa/);assert.equal(await page.locator('[data-harness-settings-group="advanced"] input').count(),0);
  await page.getByRole('button',{name:'Applications and Docker',exact:true}).click();await page.getByText('Credential vault',{exact:true}).waitFor();
  await page.locator('[id$="apps-vault"]').evaluate(element=>element.open=true);await page.locator('[id$="apps-vault-secret"]').fill('fixture-native-unsaved-secret');await page.getByRole('button',{name:'Manage all applications',exact:true}).click();const globalApps=page.locator('dialog.harness-apps');await globalApps.getByText('Global application administration',{exact:true}).waitFor();await globalApps.getByText('fixture running container',{exact:true}).waitFor();assert.match(await globalApps.evaluate(element=>getComputedStyle(element).fontFamily),/sans-serif|system-ui/);await globalApps.locator('[id$="apps-close"]').click();await globalApps.waitFor({state:'detached'});assert.equal(await page.locator('[id$="apps-vault-secret"]').inputValue(),'fixture-native-unsaved-secret');
  await page.evaluate(id=>{window.fixtureWakeRevoked=false;window.fixtureClaims=0;window.HarnessWakeCredentials={identity:()=>({deviceId:id,revoked:fixtureWakeRevoked}),clear(){window.fixtureWakeRevoked=true;},async claimReenrollment(){window.fixtureClaims++;const response=await fetch('/fixture/claim-device');window.fixtureWakeRevoked=false;return response.json();}};},ownDevice);
  await page.getByRole('button',{name:'Devices and notifications',exact:true}).click();await page.getByText('Open the installed Harness app',{exact:false}).waitFor();const deviceCard=page.locator('[data-device-id="'+ownDevice+'"]');await deviceCard.getByText('Fixture iPhone',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('[data-harness-settings-group="devices"]').innerText(),/MUST_NOT_RENDER/);
  await deviceCard.getByRole('button',{name:'Revoke automatic wake',exact:true}).click();await deviceCard.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(deviceRevocations.length,0);await deviceCard.getByRole('button',{name:'Revoke automatic wake',exact:true}).click();await deviceCard.getByRole('button',{name:'Confirm revocation',exact:true}).click();await deviceCard.getByText('Wake access revoked',{exact:true}).waitFor();assert.deepEqual(deviceRevocations,[ownDevice]);assert.equal(await page.evaluate(()=>fixtureClaims),0);await page.getByRole('button',{name:'Apply approved reconnection',exact:true}).click();await page.getByText('This device can wake the server again.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>fixtureClaims),1);
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
  const activityRequests = [];
  await page.route('**/api/workbench', async route => {
   const data = route.request().postDataJSON();
   if (data?.op !== 'run-activity') return route.fallback();
   activityRequests.push(data.sessionId);
   await route.fulfill({json:{version:1,sessionId:data.sessionId,phases:[{phase:'heavyTools.waiting',elapsedSeconds:42}]}});
  });
  await page.evaluate(id => NativeFixture.setRunning(id, true), sid);
  const activity = page.locator('.harness-run-activity:visible');
  await activity.getByText('Waiting for tool capacity · 42 s', {exact:true}).waitFor();
  assert.equal(await activity.getAttribute('data-run-session'), sid);
  await page.evaluate(id => NativeFixture.setRunning(id, false), sid);
  await activity.waitFor({state:'hidden'});
  assert.ok(activityRequests.length && activityRequests.every(id => id === sid));
 }catch(error){
  // Publish only this isolated fixture's assertion, never its login URL or logs.
  const safe=String(error.message||error.name||'Native fixture failed').replace(/https?:\/\/[^\s]+/g,'[fixture-url]').slice(0,2000);
  console.error('HARNESS_NATIVE_ASSERTION: '+JSON.stringify(safe));
  if(browser){const pages=browser.contexts().flatMap(context=>context.pages());if(pages[0]){await pages[0].screenshot({path:path.join(evidence,'native-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(evidence,'native-failure.json'),JSON.stringify(await pages[0].evaluate(()=>({text:document.body.innerText.slice(0,12000),language:window.HarnessI18n?.language,cards:[...document.querySelectorAll('[data-device-id]')].map(e=>e.outerHTML)})).catch(()=>({})),null,2));}}throw error;
 }finally{
  if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  // Only our freshly minted fixture directory may be recursively removed.
  const resolved=path.resolve(directory),temporary=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(temporary)||!path.basename(resolved).startsWith('harness-native-ui-'))throw Error('Unsafe fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});
 }
});
