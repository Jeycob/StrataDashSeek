'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');

test('Native first-prompt budget is reachable in both execution modes and keeps the unsent draft',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'task-budget-native-'));
 const overlay=path.join(directory,'overlay.json');fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'budget-native-fixture',name:pathToFileURL(createSourceFixture(directory)).href}]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',browser;child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Native fixture startup timed out'));},40000),poll=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(poll);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',error=>{clearTimeout(timer);clearInterval(poll);reject(error);});child.once('exit',code=>{clearTimeout(timer);clearInterval(poll);reject(Error('Native fixture exited '+code));});});
  browser=await chromium.launch({headless:true,...(process.env.HARNESS_BROWSER_CHANNEL?{channel:process.env.HARNESS_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),values=new Map(),mutations=[],errors=[],submissions=[];let mode='host-compat';page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/\/api\/.*(submit|followup)/i.test(request.url()))submissions.push(request.url());});
  await page.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,available:true,mode}}));
  await page.route('**/api/workbench',route=>{
   const body=route.request().postDataJSON();if(body?.op==='task-budget'){
    assert.match(body.sessionId,/^[A-Za-z0-9_-]+$/);const value=values.get(body.sessionId)||{version:1,sessionId:body.sessionId,nextTaskLimit:null,current:null};
    if(body.action==='configure'){assert.deepEqual(Object.keys(body).sort(),['action','limit','op','sessionId']);mutations.push(body);value.nextTaskLimit=body.limit;values.set(body.sessionId,value);}
    return route.fulfill({json:value});
   }
   return route.fulfill({json:{workspaces:[],projects:{},trash:{},running:[],defaults:{},environment:{}}});
  });
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.HarnessNativeUI));
  const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor({timeout:3000}).catch(()=>{});if(await preview.isVisible())await preview.click();
  const onboarding=page.getByRole('dialog').filter({hasText:'Get started'});await onboarding.waitFor({timeout:2000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:/New session/}).first().click();
  const control=page.locator('[data-task-budget-session]');await control.waitFor();const sessionId=await control.getAttribute('data-task-budget-session');assert(sessionId);
  const draft=page.locator('[contenteditable=true]').first();await draft.fill('Unsent first request');
  await control.locator('summary').click();await control.getByRole('combobox').waitFor();await control.getByRole('combobox').selectOption('tokens');await control.getByRole('spinbutton').fill('1234');await control.getByRole('button',{name:'Use for next request',exact:true}).click();await control.getByText('Saved for one new request.',{exact:true}).waitFor();
  assert.deepEqual(mutations,[{op:'task-budget',action:'configure',sessionId,limit:{kind:'tokens',totalTokens:1234}}]);assert.equal(await draft.innerText(),'Unsent first request');assert.match(await control.innerText(),/Tokens are not a price/);
  values.get(sessionId).previousStop={turn:1,startedAt:1700000000000,reason:{code:'TASK_TIME_LIMIT',message:'Earlier task time limit'}};
  // Same real composer contract in Apps/VM mode, at phone width and Czech locale.
  mode='isolated-guest';await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForFunction(()=>Boolean(window.HarnessNativeUI));
  await onboarding.waitFor({timeout:3000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  await page.evaluate(()=>HarnessI18n.setLanguage('cs'));
  await control.waitFor();await control.locator('summary').click();await control.getByRole('combobox').waitFor();assert.equal(await control.getByRole('combobox').inputValue(),'tokens');assert.equal(await control.getByRole('spinbutton').inputValue(),'1234');
  const previous=control.locator('[data-task-budget-previous-turn="1"]');await previous.filter({hasText:'Předchozí úloha'}).waitFor();assert.match(await previous.innerText(),/Předchozí úloha.*Dosažen časový limit/s);assert.equal(await control.locator('[data-task-budget-reason]').count(),0,'An earlier stop must not be presented as the current task stop');
  await control.getByRole('combobox').selectOption('elapsed');await control.getByRole('spinbutton').fill('2');await control.getByRole('button',{name:'Použít pro příští zadání',exact:true}).click();await control.getByText('Uloženo pro jedno nové zadání.',{exact:true}).waitFor();assert.deepEqual(mutations.at(-1),{op:'task-budget',action:'configure',sessionId,limit:{kind:'elapsed',minutes:2}});
  assert.equal(await control.evaluate(element=>element.scrollWidth<=element.clientWidth),true);assert.deepEqual(errors,[]);assert.deepEqual(submissions,[]);
 }finally{
  await browser?.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('task-budget-native-'));fs.rmSync(directory,{recursive:true,force:true});
 }
});
