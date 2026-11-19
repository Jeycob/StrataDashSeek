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

function makeSessions(ctx) {
 return ['Preview chat', 'File chat'].map((name, index) => {
  const session = ctx.sessions.create(undefined, {meta:{cwd:process.cwd()}});
  for (let turn = 1; turn <= (index === 0 ? 2 : 1); turn++) {
   session.append('turn/start', {turn});
   session.append('user/message', {id:name+'-question-'+turn, role:'user', source:{kind:'user'},
    content:[{type:'text', text:'Open the result'}]}, {surfaceOp:'append'});
   session.append('step/start', {turn, step:1});
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

test('Native chat restores its saved preview on click and keeps files scoped after reload', {timeout:90000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli, 'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-result-preview-'));
 let child, browser, exited;
 try {
  const plugin = path.join(directory, 'seed');
  const sessionFile = path.join(directory, 'sessions.json');
  const downloadLog = path.join(directory, 'downloads.jsonl');
  await fs.mkdir(plugin);
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({
   name:'result-preview-fixture', type:'module',
   exports:{'.':'./index.mjs', './client':'./client.js', './package.json':'./package.json'},
   dsh:{client:{platform:'web'}},
  }));
  await fs.writeFile(path.join(plugin, 'index.mjs'), `
   import {appendFileSync, writeFileSync} from 'node:fs';
   export const inject = ['sessions', 'connection'];
   export function apply(ctx) {
    const ids = (${makeSessions.toString()})(ctx);
    writeFileSync(${JSON.stringify(sessionFile)}, JSON.stringify(ids));
    ctx.effect(() => ctx.connection.fetch.register({
     path:'/api/workbench/download', methods:['GET'], requestBody:'buffered', fetch(request) {
      const params = new URL(request.url).searchParams;
      appendFileSync(${JSON.stringify(downloadLog)}, JSON.stringify(Object.fromEntries(params))+'\\n');
      if (params.get('sessionId') !== ids[1] || params.get('path') !== 'result.txt') return new Response(null, {status:404});
      return new Response('saved file bytes', {headers:{
       'Content-Type':'application/octet-stream', 'Content-Disposition':'attachment; filename="result.txt"',
      }});
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
  let expiresAt = 0, openGrants = 0;
  await context.route('**/api/workbench/preview', async route => {
   const body = route.request().postDataJSON();
   requests.push(body);
   const sight = {version:1, sessionId:body.sessionId};
   if (body.sessionId === fileSession) {
    // A foreign response with a plausible, reopenable saved result is ignored.
    return route.fulfill({json:{...sight, sessionId:previewSession, state:'closed', result:{id:resultId, canReopen:true}}});
   }
   if (body.operation === 'status') {
    const ready = expiresAt > Date.now();
    return route.fulfill({json:{...sight, state:ready?'ready':'closed', jobId, expiresAt, url:previewOrigin+'/',
     result:{id:openGrants ? nextId : resultId, canReopen:!ready}}});
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
   const data = route.request().postDataJSON();
   if (data?.op === 'file') {
    assert.equal(data.sessionId, fileSession);
    return route.fulfill({json:data.operation === 'list' ? {entries:[{name:'result.txt',directory:false}]} :
     {path:'result.txt', text:'saved file bytes', version:'v1'}});
   }
   return route.fulfill({json:{running:[], trash:{}, workspaces:[{id:'w1',title:'Fixture',sessionIds:[fileSession],settings:{}}],
    projects:{[fileSession]:{root:'/data/harness/workspaces/projects/fixture'}}}});
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
   {operation:'open', sessionId:previewSession, jobId},
  ]);

  await Promise.all([
   page.waitForResponse(response => response.request().url().includes('/api/workbench/preview') &&
    response.request().postDataJSON()?.sessionId === fileSession),
   page.evaluate(id => window.openResultFixture(id), fileSession),
  ]);
  await page.getByText('File chat reply 1', {exact:true}).waitFor();
  assert.equal(await card.count(), 0);
  await page.evaluate(id => window.HarnessNativeUI.openFiles(id), fileSession);
  await page.getByRole('button', {name:'result.txt',exact:true}).click();
  const [download] = await Promise.all([page.waitForEvent('download'),page.getByRole('button', {name:'Download',exact:true}).click()]);
  assert.equal(download.suggestedFilename(), 'result.txt');
  assert.equal(await fs.readFile(await download.path(), 'utf8'), 'saved file bytes');
  const downloads = (await fs.readFile(downloadLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(downloads, [{sessionId:fileSession,path:'result.txt'}]);
  assert.deepEqual(prompts, []);
  assert.deepEqual(errors, []);
 } finally {
  if (browser) await browser.close();
  if (child) {
   if (child.exitCode === null && child.signalCode === null) child.kill();
   await exited;
  }
  await fs.rm(directory, {recursive:true,force:true});
 }
});
