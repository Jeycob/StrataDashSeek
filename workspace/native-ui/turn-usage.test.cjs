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

// Feed durable events to the actual SDK. Its real turn footer projects the
// recorded usage, including a positive cache read, zero write and absent data.
async function seedTurns(ctx) {
 const session = ctx.sessions.create(undefined, {meta:{cwd:process.cwd()}});
 for (const [turn, text, usage] of [
  [1, 'First recorded result', {inputTokens:1234, cacheReadTokens:80, cacheWriteTokens:0, outputTokens:25, totalTokens:1339}],
  [2, 'Second recorded result', {inputTokens:21, outputTokens:0, totalTokens:21}],
  [3, 'Result without metering', undefined],
 ]) {
  session.append('turn/start', {turn});
  session.append('user/message', {
   id:'question-'+turn, role:'user', source:{kind:'user'}, content:[{type:'text', text:'Fixture question '+turn}],
  }, {surfaceOp:'append'});
  session.append('step/start', {turn, step:1});
  session.append('assistant/message', {
   turn, step:1, stream:[], ...(usage === undefined ? {} : {usage}),
   message:{
    id:'answer-'+turn, role:'assistant', source:{kind:'model', provider:'fixture', model:'fixture'},
    content:[{type:'text', text}],
   },
  }, {surfaceOp:'append'});
  session.append('step/end', {turn, step:1});
  if (turn === 1) await new Promise(resolve => setTimeout(resolve, 180));
  session.append('turn/end', {turn, reason:{kind:'completed'}});
 }
 return session.id;
}

test('Native completed replies show elapsed time and disjoint usage, preserving missing and zero', {timeout:90000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli, 'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-turn-usage-'));
 let child, browser, exited;
 try {
  const plugin = path.join(directory, 'seed');
  const sessionFile = path.join(directory, 'session-id');
  await fs.mkdir(plugin);
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({
   name:'turn-usage-fixture', type:'module',
   exports:{'.':'./index.mjs', './client':'./client.js', './package.json':'./package.json'},
   dsh:{client:{platform:'web'}},
  }));
  await fs.writeFile(path.join(plugin, 'index.mjs'), `
   import {writeFileSync} from 'node:fs';
   export const inject = ['sessions'];
   export async function apply(ctx) {
    writeFileSync(${JSON.stringify(sessionFile)}, await (${seedTurns.toString()})(ctx));
   }
  `);
  await fs.writeFile(path.join(plugin, 'client.js'), `window.__ModuleLoader__.load({
   id:'turn-usage-fixture',
   factory:() => ({inject:['uiWorkspace'], apply(ctx) {
    window.openTurnUsageFixture = id => ctx.uiWorkspace.openSession(id);
   }}),
  });`);
  const overlay = path.join(directory, 'overlay.json');
  await fs.writeFile(overlay, JSON.stringify([
   {id:'ui-settings-models', config:{credentialOnboarding:false}},
   {insert:[
    {id:'usage-workbench', name:pathToFileURL(createSourceFixture(directory)).href},
    {id:'turn-usage-fixture', name:pathToFileURL(path.join(plugin, 'index.mjs')).href},
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
  const sessionId = await fs.readFile(sessionFile, 'utf8');
  const {chromium} = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({
   headless:true, ...(process.env.HARNESS_CHROMIUM_CHANNEL ? {channel:process.env.HARNESS_CHROMIUM_CHANNEL} : {}),
  });
  const page = await browser.newPage({viewport:{width:1280, height:900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(url);
  const notice = page.getByRole('button', {name:'Continue', exact:true});
  await notice.click();
  await page.waitForFunction(() => window.openTurnUsageFixture && window.HarnessI18n);
  await page.evaluate(id => window.openTurnUsageFixture(id), sessionId);
  const summary = turn => page.locator('[data-turn-tail="'+turn+'"] .harness-turn-usage:visible');
  const read = async turn => Object.fromEntries(await summary(turn).locator('div').evaluateAll(rows =>
   rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent])));
  await page.getByText('First recorded result', {exact:true}).waitFor();
  await page.getByText('Result without metering', {exact:true}).waitFor();
  await summary(1).waitFor();
  const first = await read(1);
  assert.match(first['Elapsed time'], /^\d+(?:\.\d+)? sec$/);
  assert(parseFloat(first['Elapsed time']) >= 0.1);
  delete first['Elapsed time'];
  assert.deepEqual(first, {'Uncached input':'1,234', 'Cache read':'80', 'Cache write':'0', 'Output tokens':'25'});
  const second = await read(2);
  assert.equal(second['Cache read'], 'Unavailable');
  assert.equal(second['Cache write'], 'Unavailable');
  assert.equal(second['Output tokens'], '0');
  const third = await read(3);
  for (const key of ['Uncached input', 'Cache read', 'Cache write', 'Output tokens']) assert.equal(third[key], 'Unavailable');

  await page.setViewportSize({width:390, height:844});
  await page.evaluate(() => window.HarnessI18n.setLanguage('cs'));
  await summary(1).getByText('Necachovaný vstup', {exact:true}).waitFor();
  assert.equal((await read(2))['Čtení cache'], 'Nedostupné');
  assert.equal(await summary(1).evaluate(element => element.scrollWidth <= element.clientWidth), true);
  assert.deepEqual(errors, []);
 } finally {
  if (browser) await browser.close();
  if (child) {
   if (child.exitCode === null && child.signalCode === null) child.kill();
   await exited;
  }
  await fs.rm(directory, {recursive:true, force:true});
 }
});
