'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');

test('the Native ChatView shows bounded saved replies while its real follow stream waits', {timeout: 100_000}, async () => {
  const cli = process.env.HARNESS_NATIVE_CLI;
  assert.ok(cli, 'Set HARNESS_NATIVE_CLI to the pinned Native CLI');
  const {chromium} = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-chat-preview-'));
  let child, closed, browser, page;
  const errors = [];
  let log = '';
  try {
    const pkg = path.join(directory, 'fixture');
    await fs.mkdir(pkg);
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'homeai-preview-fixture', type: 'module', exports: {'.': './index.mjs', './client': './client.js', './package.json': './package.json'}, dsh: {client: {platform: 'web'}},
    }));
    await fs.writeFile(path.join(pkg, 'client.js'), `window.__ModuleLoader__.load({id:'homeai-preview-fixture',factory:()=>({
      inject:['uiWorkspace','sessions','connection'],apply(ctx){window.previewTest={open:id=>ctx.uiWorkspace.openSession(id),ids:()=>ctx.sessions.list.getSnapshot().ids,
        async previews(){const access=window.__HOMEAI_CHAT_CACHE_ACCESS__;const scope=await access?.scope(ctx.get('connection').generation.getSnapshot());return scope ? await access.read(scope,'previews')||[] : [];}
      };}
    })});`);
    await fs.writeFile(path.join(pkg, 'index.mjs'), `import {installChatCache} from ${JSON.stringify(pathToFileURL(path.join(__dirname,'native.mjs')).href)};
      export const inject=['sessions','sessionTitle','connection','workspaceRegistry','sessionPersistence'];
      export async function apply(ctx){
        installChatCache(ctx);
        const workspace=await ctx.workspaceRegistry.create(process.cwd());
        const ids=[];
        for(const label of ['First','Second']){
          const session=ctx.sessions.create(undefined,{meta:{cwd:process.cwd()}});
          session.append('turn/start',{turn:1});
          session.append('user/message',{id:label+'-prompt',role:'user',source:{kind:'user'},content:[{type:'text',text:label+' user text'}]},{surfaceOp:'append'});
          session.append('step/start',{turn:1,step:1});
          session.append('assistant/message',{turn:1,step:1,stream:[],message:{id:label+'-reply',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:label+' reply before history.\\n\\n'+ 'bounded '.repeat(500)}]}},{surfaceOp:'append'});
          session.append('step/end',{turn:1,step:1});
          session.append('turn/end',{turn:1,reason:{kind:'completed'}});
          ctx.sessionTitle.rename(session,label);
          if(!await ctx.sessions.flush(session))throw Error('Fixture session failed to save');
          await workspace.attachSession(session.id);
          ids.push(session.id);
        }
        ctx.effect(()=>ctx.connection.fetch.register({path:'/api/preview-fixture-ids',methods:['GET'],requestBody:'buffered',fetch:()=>Response.json(ids)}));
      }`);
    const overlay = path.join(directory, 'overlay.json');
    await fs.writeFile(overlay, JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},
      {id:'session-title-llm',disabled:true},{insert:[{id:'homeai-preview-fixture',name:pathToFileURL(path.join(pkg,'index.mjs')).href}]}]));
    child = spawn(process.execPath, [cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],
      {cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home')},stdio:['ignore','pipe','pipe'],windowsHide:true});
    closed = once(child, 'close');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => log = (log + chunk).slice(-3000));
    let url;
    const deadline = Date.now() + 30000;
    while (!(url = log.match(/http:\/\/127\.0\.0\.1:\d+\S*/u)?.[0])) {
      if (child.exitCode !== null || Date.now() > deadline) throw Error('Native browser fixture did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({headless:true, ...(process.env.HARNESS_BROWSER_CHANNEL ? {channel:process.env.HARNESS_BROWSER_CHANNEL} : {})});
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (['warning','error'].includes(entry.type())) errors.push(entry.text().slice(0,300)); });
    page.setDefaultTimeout(7000);
    let hold = false;
    const waiting = new Set();
    const follows = [];
    await page.routeWebSocket('**/*', socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const msg = JSON.parse(raw.toString());
        if (hold && msg.type === 'open' && /session\/follow$/u.test(msg.endpoint)) {
          follows.push(...Object.values(msg.payload.args));
          waiting.add(() => server.send(raw));
        } else server.send(raw);
      });
    });
    await page.goto(url);
    await page.getByRole('button', {name:'Continue',exact:true}).click();
    await page.waitForFunction(() => window.previewTest?.ids().length > 1);
    const [first, second] = await (await page.request.get(new URL('/api/preview-fixture-ids', url).href)).json();
    const open = id => page.evaluate(value => window.previewTest.open(value), id);
    const panel = id => page.locator('[data-conversation-content][data-conversation-session="'+id+'"]').first();
    await open(first);
    await panel(first).getByText('First reply before history.',{exact:true}).waitFor();
    await page.waitForFunction(async id => (await window.previewTest.previews()).some(([key, entry]) =>
      key === id && entry.rows.some(row => row.role === 'user') && entry.rows.some(row => row.role === 'assistant')), first);
    await open(second);
    await panel(second).getByText('Second reply before history.',{exact:true}).waitFor();
    hold = true;
    await open(first);
    const preview = panel(first).locator('[data-homeai-chat-preview]');
    await preview.waitFor();
    assert.match(await preview.innerText(), /First user text/u);
    assert.match(await preview.innerText(), /First reply before history/u);
    assert.doesNotMatch(await preview.innerText(), /Second|bounded.{260}/u);
    assert.equal(await preview.locator('a,img,button,pre').count(), 0);
    for (const snippet of await preview.locator('[data-preview-role]').allTextContents()) {
      assert.ok(snippet.length <= 240 && snippet.split('\n').length <= 3);
    }
    const sinceSnapshot = Date.now();
    while (!waiting.size && Date.now() - sinceSnapshot < 2000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(waiting.size, 'Preview painted before the real follow was released');
    const firstFollow = follows.find(request => request?.address?.sessionId === first);
    assert.ok(firstFollow?.activate && firstFollow.assistantStream);
    assert.equal(firstFollow.maxMessages, 12);
    assert.equal(Object.hasOwn(firstFollow, 'turnWindow'), false);
    hold = false;
    for (const release of waiting) release();
    waiting.clear();
    await preview.waitFor({state:'detached'});
    await panel(first).getByText('First reply before history.',{exact:true}).waitFor();
    hold = true;
    await page.reload();
    await page.waitForFunction(() => window.previewTest?.ids().length > 1);
    await open(first);
    await preview.waitFor();
    await page.route('**/api/workbench/chat-cache-scope', route => route.fulfill({status:403,body:''}));
    await page.reload();
    await page.waitForFunction(() => window.previewTest?.ids().length > 1);
    await open(first);
    await panel(first).waitFor();
    assert.equal(await preview.count(), 0);
    assert.doesNotMatch(await panel(first).innerText(), /First reply before history/u);
  } catch (error) {
    const state = await page?.evaluate(() => ({fixture:!!window.previewTest, count:window.previewTest?.ids().length,
      scope:!!window.__HOMEAI_CHAT_CACHE_SCOPE__, flow:document.querySelectorAll('[data-chat-flow]').length,
      messages:[...document.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="assistant-step"]')].slice(-4).map(e=>[e.dataset.chatFlowKind,e.querySelectorAll('[data-text-interaction-source]').length,e.querySelector('[data-message-bubble]')?.firstElementChild?.tagName])})).catch(()=>null);
    throw new Error(JSON.stringify({state, errors:errors.slice(0,12), host:log.replace(/https?:\S+/gu,'[url]').slice(-1200)}), {cause:error});
  } finally {
    await browser?.close();
    child?.kill();
    if (closed) await closed;
    await fs.rm(directory, {recursive:true,force:true});
  }
});
