'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {createSourceFixture} = require('./test-bundle.cjs');

function makeSessions(ctx, roots, files) {
 return ['Preview chat', 'File chat'].map((name, index) => {
  const session = ctx.sessions.create(undefined, {meta:{cwd:roots[index]}});
  for (let turn = 1; turn <= (index === 0 ? 2 : 1); turn++) {
   session.append('turn/start', {turn});
   session.append('user/message', {id:name+'-question-'+turn, role:'user', source:{kind:'user'},
    content:[{type:'text', text:'Open the result'}]}, {surfaceOp:'append'});
   session.append('step/start', {turn, step:1});
   if (index === 1) session.append('deliverables/presented', {turn, callId:'fixture-present', files});
   session.append('assistant/message', {turn, step:1, stream:[], message:{
    id:name+'-answer-'+turn, role:'assistant', source:{kind:'model', provider:'fixture', model:'fixture'},
    content:[{type:'text', text:name+' reply '+turn}],
   }}, {surfaceOp:'append'});
   session.append('step/end', {turn, step:1});
   session.append('turn/end', {turn, reason:{kind:'completed'}});
  }
  return session.id;
 });
}

test('Native chat retries a lost reopen and downloads presented results directly before and after reload', {timeout:90000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli, 'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-result-preview-'));
 let child, browser, exited, releaseStatus;
 try {
  const plugin = path.join(directory, 'seed');
  const sessionFile = path.join(directory, 'sessions.json');
  const projectRoots = ['preview-project','file-project'].map(name => path.join(directory,name));
  for (const root of projectRoots) await fs.mkdir(root);
  const files = {'result.csv':'item,count\nexample,2\n','result.json':'{"count":2}\n'};
  const presented = [];
  for (const [name, contents] of Object.entries(files)) {
   const file = path.join(projectRoots[1],name);
   await fs.writeFile(file,contents);
   presented.push({path:file});
  }
  await fs.mkdir(plugin);
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({
   name:'result-preview-fixture', type:'module',
   exports:{'.':'./index.mjs', './client':'./client.js', './package.json':'./package.json'},
   dsh:{client:{platform:'web'}},
  }));
  await fs.writeFile(path.join(plugin, 'index.mjs'), `
   import {writeFileSync} from 'node:fs';
   import {WorkspaceManager} from ${JSON.stringify(pathToFileURL(path.resolve(__dirname,'../manager.mjs')).href)};
   import {workspaceDownload} from ${JSON.stringify(pathToFileURL(path.resolve(__dirname,'../download.mjs')).href)};
   import {hostExecutionBinding} from ${JSON.stringify(pathToFileURL(path.resolve(__dirname,'../fixtures/execution-binding.mjs')).href)};
   export const inject = ['sessions','sessionQuery','sessionPersistence','workingDirectory','fs','connection'];
   export function apply(ctx) {
    const roots = ${JSON.stringify(projectRoots)};
    const ids = (${makeSessions.toString()})(ctx, roots, ${JSON.stringify(presented)});
    const manager = new WorkspaceManager(ctx, {stateRoot:${JSON.stringify(path.join(directory,'workbench-state'))}}, hostExecutionBinding());
    manager.data = {sessions:Object.fromEntries(ids.map((id,index)=>[id,{root:roots[index]}]))};
    writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify(ids));
    ctx.effect(() => ctx.connection.fetch.register({
     path:'/api/workbench/download', methods:['GET'], requestBody:'buffered', async fetch(request) {
      try { return await workspaceDownload(ctx, manager, request); }
      catch (error) { return new Response(error.message, {status:error.status ?? 400}); }
     },
    }));
   }
  `);
  await fs.writeFile(path.join(plugin, 'client.js'), `window.__ModuleLoader__.load({
   id:'result-preview-fixture', factory:() => ({inject:['uiWorkspace'],apply(ctx) {
    window.openResultFixture = id => ctx.uiWorkspace.openSession(id);
   }}),
  });`);
  const overlay = path.join(directory, 'overlay.json');
  await fs.writeFile(overlay, JSON.stringify([
   {id:'ui-settings-models', config:{credentialOnboarding:false}},
   {insert:[
    {id:'result-workbench', name:pathToFileURL(createSourceFixture(directory)).href},
    {id:'result-preview-fixture', name:pathToFileURL(path.join(plugin, 'index.mjs')).href},
   ]},
  ]));
  child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
   cwd:directory, env:{...process.env, DSH_HOME:path.join(directory, 'home')},
   stdio:['ignore', 'pipe', 'pipe'], windowsHide:true,
  });
  exited = once(child, 'close');
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  let url;
  const deadline = Date.now() + 30000;
  while (!(url = output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0])) {
   if (child.exitCode !== null || Date.now() >= deadline) throw Error('Native fixture failed to start: '+output.slice(-3000));
   await new Promise(resolve => setTimeout(resolve, 50));
  }
  const [previewSession, fileSession] = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  const {chromium} = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({
   headless:true, ...(process.env.HARNESS_CHROMIUM_CHANNEL ? {channel:process.env.HARNESS_CHROMIUM_CHANNEL} : {}),
  });
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  const requests = [], prompts = [];
  const previewOrigin = 'https://result-preview.test';
  const resultId = 'a'.repeat(32), nextId = 'b'.repeat(32), jobId = 'own-result-job';
  let expiresAt = 0, openGrants = 0, lostReopen = false, observeStatus;
  const statusRequested = new Promise(resolve => { observeStatus = resolve; });
  const statusAllowed = new Promise(resolve => { releaseStatus = resolve; });
  await context.route('**/api/workbench/preview', async route => {
   const body = route.request().postDataJSON();
   requests.push(body);
   const sight = {version:1, sessionId:body.sessionId};
   if (body.sessionId === fileSession) {
    // A foreign response with a plausible, reopenable saved result is ignored.
    return route.fulfill({json:{...sight, sessionId:previewSession, state:'closed', result:{id:resultId, canReopen:true}}});
   }
   if (body.operation === 'status') {
    if (lostReopen && !openGrants) {
     observeStatus();
     await statusAllowed;
    }
    const ready = expiresAt > Date.now();
    return route.fulfill({json:{...sight, state:ready?'ready':'closed', jobId, expiresAt, url:previewOrigin+'/',
     result:{id:openGrants ? nextId : resultId, canReopen:!ready}}});
   }
   if (body.operation === 'reopen' && !lostReopen) {
    lostReopen = true;
    return route.abort();
   }
   if (body.operation === 'reopen') expiresAt = Date.now()+5000;
   openGrants++;
   return route.fulfill({json:{...sight, state:'ready', expiresAt, grantExpiresAt:expiresAt, jobId,
    url:previewOrigin+'/__preview/bootstrap#'+String(openGrants).repeat(43)}});
  });
  await context.route(previewOrigin+'/**', route => route.fulfill({
   contentType:'text/html', body:'<!doctype html><h1>Restored application result</h1>',
  }));
  await context.route('**/api/session/prompt', route => {
   prompts.push(route.request().method());
   return route.abort();
  });
  await context.route('**/api/workbench/execution', route => route.fulfill({json:{version:1,mode:'host-compat',available:true}}));
  await context.route('**/api/workbench', route => {
   return route.fulfill({json:{running:[], trash:{}, workspaces:[{id:'w1',title:'Fixture',sessionIds:[fileSession],settings:{}}],
    projects:{[fileSession]:{root:projectRoots[1]}}}});
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.goto(url);
  await page.getByRole('button', {name:'Continue', exact:true}).click();
  await page.waitForFunction(() => window.openResultFixture && window.HarnessNativeUI);
  await page.evaluate(id => window.openResultFixture(id), previewSession);
  const card = page.locator('[data-harness-preview-result]:visible');
  const restore = card.getByRole('button', {name:'Restore preview',exact:true});
  const open = card.getByRole('button', {name:'Open preview',exact:true});
  await restore.waitFor();
  assert.equal(await card.count(), 1);
  assert.equal(await card.evaluate(element => element.closest('[data-turn-tail]').dataset.turnTail), '2');
  await page.reload();
  await restore.waitFor();
  assert(requests.every(body => body.operation === 'status'));
  await restore.click();
  await Promise.all([statusRequested,card.getByRole('button',{name:'Refresh preview status',exact:true}).waitFor()]);
  assert.equal(await restore.count(),0);
  assert.equal(openGrants,0);
  releaseStatus();
  await restore.waitFor();
  assert.equal(requests.filter(body => body.operation === 'reopen').length,1);

  async function clickPreview(button, sequence) {
   const [popup] = await Promise.all([context.waitForEvent('page'), button.click()]);
   await popup.getByRole('heading', {name:'Restored application result'}).waitFor();
   assert.equal(new URL(popup.url()).hash, '#'+String(sequence).repeat(43));
   assert.equal(await popup.evaluate(() => window.opener), null);
   await popup.close();
  }
  await clickPreview(restore, 1);
  await clickPreview(open, 2);
  await restore.waitFor();
  assert.deepEqual(requests.filter(body => body.operation !== 'status'), [
   {operation:'reopen', sessionId:previewSession, resultId},
   {operation:'reopen', sessionId:previewSession, resultId},
   {operation:'open', sessionId:previewSession, jobId},
  ]);

  await Promise.all([
   page.waitForResponse(response => response.request().url().includes('/api/workbench/preview') &&
    response.request().postDataJSON()?.sessionId === fileSession),
   page.evaluate(id => window.openResultFixture(id), fileSession),
  ]);
  await page.getByText('File chat reply 1', {exact:true}).waitFor();
  assert.equal(await card.count(), 0);

  async function downloadResult(name, index) {
   const file = page.locator('[data-presented-file]').filter({hasText:name});
   const link = file.getByRole('link',{name:'Download file',exact:true});
   await link.waitFor();
   assert.equal(await file.evaluate(element=>element.closest('[data-turn-tail]').dataset.turnTail),'1');
   const href = new URL(await link.getAttribute('href'),url);
   assert.equal(href.pathname,'/api/workbench/download');
   assert.equal(href.searchParams.get('sessionId'),fileSession);
   assert.equal(href.searchParams.get('index'),String(index));
   assert.match(href.searchParams.get('seq'),/^\d+$/);
   const [download] = await Promise.all([page.waitForEvent('download'),link.click()]);
   assert.equal(download.suggestedFilename(),name);
   assert.equal(await fs.readFile(await download.path(),'utf8'),files[name]);
   return href;
  }
  const firstCsv = await downloadResult('result.csv',0);
  await page.reload();
  const secondCsv = await downloadResult('result.csv',0);
  const json = await downloadResult('result.json',1);
  assert.equal(firstCsv.href,secondCsv.href);
  assert.equal(firstCsv.searchParams.get('seq'),json.searchParams.get('seq'));
  json.searchParams.set('sessionId',previewSession);
  assert.equal((await context.request.get(json.href)).ok(),false);
  firstCsv.searchParams.set('path','result.json');
  assert.equal((await context.request.get(firstCsv.href)).status(),400);
  assert.deepEqual(prompts, []);
  assert.deepEqual(errors, []);
 } finally {
  releaseStatus?.();
  if (browser) await browser.close();
  if (child) {
   if (child.exitCode === null && child.signalCode === null) child.kill();
   await exited;
  }
  await fs.rm(directory, {recursive:true,force:true});
 }
});
