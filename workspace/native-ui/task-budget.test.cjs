'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');

test('Native offers a task limit on demand for an idle composer and preserves its draft',{skip:!process.env.HARNESS_NATIVE_CLI,timeout:90000},async()=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'task-budget-native-'));
 // A fresh CI home has no workspace. Register this fixture's own directory
 // through the real Host API before using the ordinary New session control.
 const seed=path.join(directory,'workspace-seed.mjs');
 fs.writeFileSync(seed,`
export const inject = ['workspaceRegistry', 'connection', 'agents'];
export async function apply(ctx) {
  await ctx.workspaceRegistry.create(process.cwd(), 'Budget fixture');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  ctx.on('agent/pre-step', async () => {
    entered.resolve();
    await release.promise;
    return {kind:'reject'};
  }, {prepend:true, global:true});
  ctx.on('llm/stream', () => { throw Error('Budget fixture has no external model'); }, {prepend:true, global:true});
  ctx.effect(() => ctx.connection.fetch.register({
    path:'/api/budget-fixture-turn', methods:['POST'], requestBody:'buffered',
    async fetch(request) {
      const {sessionId, action} = await request.json();
      const agent = ctx.agents.get(sessionId);
      if (!agent || agent.session.header.cwd !== process.cwd()) return new Response(null,{status:404});
      if (action === 'start') {
        agent.model.select({provider:'budget-fixture',model:'synthetic'});
        agent.followup({id:'budget-fixture-turn',role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic turn'}]});
        await entered.promise;
      } else if (action === 'finish') {
        release.resolve();
        await agent.whenIdle();
      } else return new Response(null,{status:400});
      return Response.json({running:agent.status === 'running'});
    }
  }));
}
`);
 const overlay=path.join(directory,'overlay.json');fs.writeFileSync(overlay,JSON.stringify([{insert:[{id:'budget-workspace-fixture',name:pathToFileURL(seed).href},{id:'budget-native-fixture',name:pathToFileURL(createSourceFixture(directory)).href}]}]));
 const child=spawn(process.execPath,[path.resolve(process.env.HARNESS_NATIVE_CLI),'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',browser;child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Native fixture startup timed out'));},40000),poll=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(poll);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',error=>{clearTimeout(timer);clearInterval(poll);reject(error);});child.once('exit',code=>{clearTimeout(timer);clearInterval(poll);reject(Error('Native fixture exited '+code));});});
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.HARNESS_BROWSER_CHANNEL?{channel:process.env.HARNESS_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),values=new Map(),reads=[],mutations=[],errors=[],submissions=[];let mode='host-compat';page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/\/api\/.*(submit|followup)/i.test(request.url()))submissions.push(request.url());});
  await page.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,available:true,mode}}));
  await page.route('**/api/workbench',route=>{
   const body=route.request().postDataJSON();if(body?.op==='task-budget'){
    assert.match(body.sessionId,/^[A-Za-z0-9_-]+$/);const value=values.get(body.sessionId)||{version:1,sessionId:body.sessionId,nextTaskLimit:null,current:null};
    if(body.action==='configure'){assert.deepEqual(Object.keys(body).sort(),['action','limit','op','sessionId']);mutations.push(body);value.nextTaskLimit=body.limit;values.set(body.sessionId,value);}
    else {assert.equal(body.action,'status');reads.push(body.sessionId);}
    return route.fulfill({json:value});
   }
   return route.fulfill({json:{workspaces:[],projects:{},trash:{},running:[],defaults:{},environment:{}}});
  });
  await page.goto(url);await page.waitForFunction(()=>Boolean(window.HarnessNativeUI));
  const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor({timeout:3000}).catch(()=>{});if(await preview.isVisible())await preview.click();
  const onboarding=page.getByRole('dialog').filter({hasText:'Get started'});await onboarding.waitFor({timeout:2000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:/New session/}).first().click();
  const control=page.locator('[data-task-budget-session]');
  const commands=page.getByRole('button',{name:'Add files or run commands',exact:true});
  const draft=page.locator('[data-composer-input]:visible').first();
  async function openLimit(label){
   await commands.click();
   await page.getByRole('option').filter({hasText:label}).click();
   await control.waitFor();
   await control.locator('select:enabled').waitFor();
  }
  await draft.fill('Unsent first request');
  assert.equal(await control.count(),0);assert.deepEqual(reads,[]);
  await openLimit('Task limit');
  const sessionId=await control.getAttribute('data-task-budget-session');assert(sessionId);
  assert.ok(reads.length>0 && reads.every(id=>id===sessionId));
  await control.getByRole('combobox').selectOption('tokens');await control.getByRole('spinbutton').fill('1234');
  await control.getByRole('button',{name:'Save',exact:true}).click();await control.waitFor({state:'detached'});
  assert.deepEqual(mutations,[{op:'task-budget',action:'configure',sessionId,limit:{kind:'tokens',totalTokens:1234}}]);assert.equal(await draft.innerText(),'Unsent first request');
  values.get(sessionId).previousStop={turn:1,startedAt:1700000000000,reason:{code:'TASK_TIME_LIMIT',message:'Earlier task time limit'}};
  // Same real composer contract in Apps/VM mode, at phone width and Czech locale.
  const readsBeforeReload=reads.length;
  mode='isolated-guest';await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForFunction(()=>Boolean(window.HarnessNativeUI));
  await onboarding.waitFor({timeout:3000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'Close',exact:true}).click();
  await page.evaluate(()=>HarnessI18n.setLanguage('cs'));
  await commands.waitFor();assert.equal(await control.count(),0);assert.equal(reads.length,readsBeforeReload);
  await openLimit('Limit úlohy');assert.equal(await control.getByRole('combobox').inputValue(),'tokens');assert.equal(await control.getByRole('spinbutton').inputValue(),'1234');
  const previous=control.locator('[data-task-budget-previous-turn="1"]');await previous.filter({hasText:'Předchozí úloha'}).waitFor();assert.match(await previous.innerText(),/Předchozí úloha.*Dosažen časový limit/s);assert.equal(await control.locator('[data-task-budget-reason]').count(),0,'An earlier stop must not be presented as the current task stop');
  assert.equal(await control.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  await control.getByRole('combobox').selectOption('elapsed');await control.getByRole('spinbutton').fill('2');
  await control.getByRole('button',{name:'Zavřít',exact:true}).click();await control.waitFor({state:'detached'});
  assert.equal(mutations.length,1);
  await openLimit('Limit úlohy');assert.equal(await control.getByRole('spinbutton').inputValue(),'1234');
  await control.getByRole('combobox').selectOption('elapsed');await control.getByRole('spinbutton').fill('2');
  await control.getByRole('button',{name:'Uložit',exact:true}).click();await control.waitFor({state:'detached'});
  assert.deepEqual(mutations.at(-1),{op:'task-budget',action:'configure',sessionId,limit:{kind:'elapsed',minutes:2}});
  await draft.fill('');
  await openLimit('Limit úlohy');assert.equal(await control.getByRole('spinbutton').inputValue(),'2');
  assert.deepEqual(submissions,[]);

  async function fixtureTurn(action){
   const response=await page.request.post(new URL('/api/budget-fixture-turn',url).href,{data:{sessionId,action}});
   assert.equal(response.status(),200);return response.json();
  }
  const readsBeforeRun=reads.length;
  assert.deepEqual(await fixtureTurn('start'),{running:true});
  const stop=page.getByRole('button',{name:'Stop generating',exact:true});
  await stop.waitFor();
  await control.waitFor({state:'detached'});
  if(await commands.isVisible() && await commands.isEnabled()){
   await commands.click();await page.getByRole('option').first().waitFor();
   assert.equal(await page.getByRole('option').filter({hasText:'Limit úlohy'}).count(),0);
   await page.keyboard.press('Escape');
  }
  assert.deepEqual(await fixtureTurn('finish'),{running:false});
  await stop.waitFor({state:'hidden'});
  assert.equal(await control.count(),0);assert.equal(reads.length,readsBeforeRun);
  await openLimit('Limit úlohy');assert.equal(await control.getByRole('spinbutton').inputValue(),'2');
  assert.equal(mutations.length,2);assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('task-budget-native-'));fs.rmSync(directory,{recursive:true,force:true});
 }
});
