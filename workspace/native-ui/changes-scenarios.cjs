'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function changesFixture(){
 const data={revision:'r1',diffRevision:'d1',running:true,baseline:'project-start',partial:false,warnings:[],fail:false,requests:[],files:[{path:'src/app.js',status:'modified',kind:'text',added:2,deleted:1},{path:'logo.png',status:'added',kind:'binary',added:null,deleted:null},{path:'large.txt',status:'modified',kind:'oversized',added:null,deleted:null}],lines:[' const stable = true;','-const title = "Before";','+const title = "After";','+<img src=x onerror="window.BAD_DIFF=true">']};
 data.handle=async(route,body)=>{
  data.requests.push({sessionId:body.sessionId,operation:body.operation,args:body.args,at:Date.now()});
  if(data.delay){data.pending=true;await new Promise(resolve=>{data.release=resolve;});data.pending=false;}
  if(data.fail)return route.fulfill({status:503,json:{error:'fixture unavailable'}});
  const file=data.files.find(file=>file.path===body.args?.path),diff=file&&{version:1,path:file.path,status:file.status,revision:data.diffRevision,kind:file.kind,before:file.status!=='added',after:file.status!=='deleted',beforeNewline:true,afterNewline:data.afterNewline??true,hunks:file.kind==='text'?[{oldStart:7,oldLines:2,newStart:7,newLines:3,lines:data.lines}]:[],added:file.added,deleted:file.deleted,coarse:false};
  if(body.operation==='diff')return route.fulfill({json:diff});
  const unchanged=body.args?.revision===data.revision;
  return route.fulfill({json:{version:1,sessionId:body.sessionId,root:'/data/harness/workspaces/projects/native-fixture',baseline:{kind:data.baselineKind||'snapshot',label:data.baseline,commit:data.commit,at:'2026-11-15T00:00:00Z'},revision:data.revision,running:data.running,updatedAt:Date.now(),partial:data.partial,warnings:data.warnings,total:data.files.length,...unchanged?{unchanged:true}:{files:data.files},...diff?(body.args.diffRevision===diff.revision?{diffUnchanged:true}:{diff}):{diff:null}}}).catch(error=>{if(!data.delay)throw error;});
 };
 return data;
}
async function runChangesScenarios(page,{sid,sid2,data,evidence,wireRoutes}){
 await page.setViewportSize({width:1440,height:1000});data.fail=true;await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid);
 const surface=page.locator('.harness-native-changes:visible');
 await surface.getByRole('alert').filter({hasText:'Could not refresh changes.'}).waitFor();assert.equal(await surface.getByText('No file changes yet.',{exact:true}).count(),0,'failed initial load is not reported as an empty project');data.fail=false;await surface.getByRole('button',{name:'Refresh',exact:true}).click();
 await surface.getByRole('heading',{name:'Changes',exact:true}).waitFor();await page.evaluate(()=>NativeFixture.openGuide());
 const filesCard=page.locator('[data-sidebar-right-guide-entry="files"]:visible'),dockerCard=page.locator('[data-sidebar-right-guide-entry="harness-docker"]:visible'),changesCard=page.locator('[data-sidebar-right-guide-entry="harness-changes"]:visible');
 await changesCard.waitFor();assert.equal(await dockerCard.getAttribute('class'),await filesCard.getAttribute('class'),'Docker uses the original Native guide capsule');assert.equal(await changesCard.getAttribute('class'),await filesCard.getAttribute('class'),'Changes uses the same original Native guide capsule');
 await page.screenshot({path:path.join(evidence,'native-guide-desktop-en.png'),fullPage:true});await changesCard.click();
 await surface.getByRole('button',{name:/src\/app\.js/}).waitFor();assert.equal(await surface.getByText('Changes since project start',{exact:false}).count(),1);
 await surface.getByRole('button',{name:/src\/app\.js/}).click();await surface.locator('.hc-code').filter({hasText:'const title = "After";'}).waitFor();
 assert.equal(await surface.locator('img').count(),0,'diff content is text, never markup');assert.equal(await page.evaluate(()=>Boolean(window.BAD_DIFF)),false);
 const deleted=surface.locator('tr.hc-delete');assert.deepEqual(await deleted.locator('.hc-line').allTextContents(),['8','']);
 const added=surface.locator('tr.hc-add').first();assert.deepEqual(await added.locator('.hc-line').allTextContents(),['','8']);
 await page.screenshot({path:path.join(evidence,'native-changes-desktop-en.png'),fullPage:true});
 const refresh=surface.getByRole('button',{name:'Refresh',exact:true});await refresh.focus();data.revision='r2';data.diffRevision='d2';data.lines=[' const stable = true;','-const title = "Before";','+const title = "Live update";'];
 await surface.locator('.hc-code').filter({hasText:'Live update'}).waitFor();assert.equal(await refresh.evaluate(e=>e===document.activeElement),true,'live refresh preserves keyboard focus');assert.equal(await surface.locator('[data-change-path="src/app.js"]').getAttribute('aria-pressed'),'true');
 assert.ok(data.requests.some(r=>r.operation==='list'&&r.args.revision==='r1'&&r.args.diffRevision==='d1'&&r.args.path==='src/app.js'));
 const previous=data.requests.length;await page.waitForTimeout(2200);assert.ok(data.requests.length>previous);assert.equal(await surface.locator('.hc-code').filter({hasText:'Live update'}).count(),1,'unchanged response retains selected diff');
 await surface.getByRole('button',{name:/logo\.png/}).click();await surface.getByText('Binary file — no text diff.',{exact:true}).waitFor();
 await surface.getByRole('button',{name:/large\.txt/}).click();await surface.getByText('This file is too large for a text diff.',{exact:true}).waitFor();
 data.baseline='tracking-start';data.partial=true;data.warnings=['Fixture excluded generated files.'];data.revision='r3';await refresh.click();await surface.getByText('Changes since tracking started',{exact:false}).waitFor();await surface.getByText('Some files could not be included in this comparison.',{exact:true}).waitFor();
 data.baselineKind='git-base';data.commit='abcdef1234567890';data.revision='git';await refresh.click();await surface.getByText('Changes from Git base · abcdef123456',{exact:false}).waitFor();data.baselineKind='snapshot';
 data.partial=false;data.warnings=[];data.diffRevision='d3';data.lines=Array.from({length:5010},(_,i)=>'+line '+i);await surface.getByRole('button',{name:/src\/app\.js/}).click();await surface.getByText('Only the first part of this comparison is shown.',{exact:true}).waitFor();assert.equal(await surface.locator('.hc-code').count(),5000);
 data.lines=['-before','+after'];data.afterNewline=false;data.revision='r4';data.diffRevision='d4';await refresh.click();await surface.locator('.hc-code').filter({hasText:'+after'}).waitFor();await surface.getByText('The final newline changed.',{exact:true}).waitFor();
 await page.evaluate(id=>HarnessNativeUI.openDocker(id),sid);await surface.waitFor({state:'hidden'});const hiddenCount=data.requests.length;await page.waitForTimeout(2200);assert.equal(data.requests.length,hiddenCount,'hidden Native tab makes no changes requests');
 await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid);await surface.getByRole('heading',{name:'Changes',exact:true}).waitFor();
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
 const backgroundCount=data.requests.length;await page.waitForTimeout(2200);assert.equal(data.requests.length,backgroundCount,'background document makes no changes requests');
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 data.running=false;await refresh.click();await surface.getByText('Idle',{exact:true}).waitFor();const idleCount=data.requests.length;await page.waitForTimeout(14200);assert.equal(data.requests.length,idleCount,'idle does not use active polling');for(let i=0;i<30&&data.requests.length===idleCount;i++)await page.waitForTimeout(100);assert.ok(data.requests.length>idleCount,'idle refreshes at fifteen seconds');
 data.fail=true;await refresh.click();await surface.getByRole('alert').filter({hasText:'Could not refresh changes.'}).waitFor();data.fail=false;await refresh.click();await surface.getByRole('alert').waitFor({state:'detached'});
 await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid2);await surface.locator('[data-change-path="src/app.js"]').waitFor();assert.equal(await surface.getAttribute('data-harness-changes-session'),sid2);assert.equal(data.requests.at(-1).sessionId,sid2);
 await mobileChanges(page,{sid:sid2,evidence,wireRoutes});
 await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid2);await surface.getByRole('heading',{name:'Changes',exact:true}).waitFor();
 await page.evaluate(id=>HarnessNativeUI.openFiles(id),sid2);const workbench=page.locator('.workspace-workbench:visible');await workbench.locator('.wb-tools > summary').click();await workbench.getByRole('tab',{name:'Run review',exact:true}).click();await workbench.getByText('Not checked',{exact:true}).waitFor();await workbench.locator('.wb-tools > summary').click();await workbench.getByRole('tab',{name:'Workspace files',exact:true}).click();await workbench.getByRole('button',{name:'native-fixture.txt',exact:true}).click();await workbench.locator('textarea').fill('Unsaved draft across Changes');await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid2);await surface.getByRole('heading',{name:'Changes',exact:true}).waitFor();await page.evaluate(id=>HarnessNativeUI.openFiles(id),sid2);assert.equal(await workbench.locator('textarea').inputValue(),'Unsaved draft across Changes');await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid2);
 await surface.locator('[data-change-path="src/app.js"]').click();await surface.locator('.hc-code').first().waitFor();data.files=data.files.filter(file=>file.path!=='src/app.js');data.revision='reverted';await surface.getByRole('button',{name:'Refresh',exact:true}).click();await surface.getByText('Choose a file to compare.',{exact:true}).waitFor();assert.equal(await surface.locator('.hc-code').count(),0,'reverted file clears stale selected comparison');
 data.files=[];data.revision='empty';await surface.getByRole('button',{name:'Refresh',exact:true}).click();await surface.getByText('No file changes yet.',{exact:true}).waitFor();
 await page.evaluate(()=>{const original=window.fetch;window.__changesAborted=0;window.fetch=(url,init)=>{try{if(url==='/api/workbench'&&JSON.parse(init?.body||'{}').op==='changes')init.signal?.addEventListener('abort',()=>window.__changesAborted++,{once:true});}catch{}return original(url,init);};});
 data.delay=true;await surface.getByRole('button',{name:'Refresh',exact:true}).click();for(let i=0;i<30&&!data.pending;i++)await page.waitForTimeout(50);assert.equal(data.pending,true);
 try{
  const tab=page.locator('[data-dockkit-tab]').filter({hasText:'Changes'}).filter({visible:true}).first();const id=await tab.getAttribute('data-dockkit-tab');assert.ok(id);await page.evaluate(id=>NativeFixture.closeTab(id),id);await page.waitForFunction(()=>window.__changesAborted>0);await page.locator('.harness-native-changes[data-harness-changes-session="'+sid2+'"]').waitFor({state:'detached'});
 }finally{data.release?.();}
 const disposedCount=data.requests.length;await page.waitForTimeout(2200);assert.equal(data.requests.length,disposedCount,'disposed tab has no polls');data.delay=false;
 fs.writeFileSync(path.join(evidence,'changes-requests.json'),JSON.stringify(data.requests,null,2));
}
async function mobileChanges(desktop,{sid,evidence,wireRoutes}){
 await desktop.evaluate(id=>HarnessNativeUI.openDocker(id),sid);
 const context=await desktop.context().browser().newContext({storageState:await desktop.context().storageState(),viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1'});
 try{
  const page=await context.newPage();page.setDefaultTimeout(10000);await wireRoutes(page);await page.goto(desktop.url());await page.waitForFunction(()=>Boolean(window.HarnessNativeUI&&window.NativeFixture));
  const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor({timeout:2000}).catch(()=>{});if(await preview.isVisible())await preview.click();
  const onboarding=page.getByRole('dialog').filter({hasText:'Get started'});await onboarding.waitFor({timeout:2000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  await page.evaluate(id=>HarnessNativeUI.openChanges(id),sid);await page.evaluate(()=>HarnessI18n.setLanguage('cs'));
  const surface=page.locator('.harness-native-changes:visible');await surface.getByRole('heading',{name:'Změny',exact:true}).waitFor();await surface.locator('[data-change-path="src/app.js"]').click();await surface.locator('.hc-code').first().waitFor();
  await page.waitForTimeout(400);
  const geometry=await surface.evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,viewport:innerWidth,scroll:document.documentElement.scrollWidth,font:getComputedStyle(e).fontFamily,buttonFont:getComputedStyle(e.querySelector('button')).fontFamily};});
  fs.writeFileSync(path.join(evidence,'mobile-geometry.json'),JSON.stringify(geometry,null,2));
  await page.screenshot({path:path.join(evidence,'native-changes-mobile-cs.png'),fullPage:true});
  assert.ok(geometry.left>=-1&&geometry.right<=geometry.viewport+1&&geometry.width>=geometry.viewport-20,'Native mobile panel fills the viewport without clipping');assert.ok(geometry.scroll<=geometry.viewport);
  assert.match(geometry.font,/sans-serif|system-ui/);assert.equal(geometry.buttonFont,geometry.font,'mobile controls inherit the Native font');assert.equal(await page.locator('[data-dockkit-tab]').filter({hasText:'Změny'}).count(),1,'Native tab title changes language too');
  const light=await surface.evaluate(e=>getComputedStyle(e).backgroundColor);await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));
  await page.screenshot({path:path.join(evidence,'native-changes-mobile-dark-cs.png'),fullPage:true});
  assert.notEqual(await surface.evaluate(e=>getComputedStyle(e).backgroundColor),light,'Native dark palette changes the surface');
  assert.equal(await surface.evaluate(e=>{const probe=document.createElement('span');probe.style.cssText='color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)';document.body.append(probe);const match=getComputedStyle(e).color===getComputedStyle(probe).color&&getComputedStyle(e).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return match;}),true,'surface resolves Native dark tokens');
  await page.evaluate(id=>HarnessNativeUI.openDocker(id),sid);await page.getByText('fixture running container',{exact:true}).waitFor();await page.screenshot({path:path.join(evidence,'native-docker-mobile-dark-cs.png'),fullPage:true});
  // Native locale preferences are shared through this Host. Restore English
  // and observe the other client before continuing its English assertions.
  await page.evaluate(()=>HarnessI18n.setLanguage('en'));await desktop.waitForFunction(()=>HarnessI18n.language==='en');
 }finally{await context.close();}
}
module.exports={changesFixture,runChangesScenarios};
