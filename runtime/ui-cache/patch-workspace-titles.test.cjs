'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const runtime = require('../require.cjs');
const { transform, createVisibleTitleReader } = require('./patch-workspace-titles.cjs');

test('inserts visibility into the actual pinned workspace row and scopes the reader to its React tree', () => {
  const source = fs.readFileSync(runtime.resolveRuntime('@deepseek-ai/dsh-client-ui-workspace/client'), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), '77da49d837c2503c45ea197129c53d9f679e99bf36737c23eaef457c66f4ee8c');
  const patched = transform(source);
  const registrations = [];
  new vm.Script(patched).runInNewContext({ window: { __ModuleLoader__: { load(row) { registrations.push(row); } } } });
  assert.equal(registrations[0].id, '@deepseek-ai/dsh-client-ui-workspace');
  assert.match(patched, /titleReader\.watch\(rowRef\.current, node\.id\)/);
  assert.match(patched, /useSessionAccess\(node\.id, 'session\/projections'\)/);
  assert.throws(() => transform(patched), /Unsupported Native workspace title hook/);
});

test('reads two visible, eligible nonblank rows at a time and respects reconnect, unmount and tab visibility', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'blank', 'named'];
  const elements = Object.fromEntries(ids.map(id => [id, {}]));
  const snapshot = { phase: 'ready', byId: Object.fromEntries(ids.map(id => [
    id, { blank: id === 'blank', titleNeedsRefresh: id !== 'named' },
  ])) };
  const page = new EventTarget();
  let notify, listChanged;
  const pending = [], calls = [];
  const reader = createVisibleTitleReader({
    list: { getSnapshot: () => snapshot, subscribe(fn) { listChanged = fn; return () => { listChanged = undefined; }; } },
    refreshVisibleTitle(id) {
      calls.push(id);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  }, page, class {
    constructor(callback) { notify = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const off = Object.fromEntries(ids.map(id => [id, reader.watch(elements[id], id)]));
  const change = (ids, visible) => notify(ids.map(id => ({ target: elements[id], isIntersecting: visible, intersectionRatio: Number(visible) })));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  change(['a', 'b', 'c', 'd', 'blank', 'named'], true);
  await settle();
  assert.deepEqual(calls, ['a', 'b']);
  change(['c'], false);
  pending[0].reject(new Error('passive source unavailable'));
  await settle();
  assert.deepEqual(calls, ['a', 'b', 'd']);
  page.hidden = true;
  change(['e'], true);
  pending[1].resolve();
  pending[2].resolve();
  await settle();
  assert.deepEqual(calls, ['a', 'b', 'd']);
  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.deepEqual(calls, ['a', 'b', 'd', 'e']);
  pending[3].resolve();
  off.d();
  off.e();
  snapshot.phase = 'pending';
  listChanged();
  await settle();
  snapshot.phase = 'ready';
  snapshot.byId.a.titleNeedsRefresh = false;
  listChanged();
  await settle();
  assert.deepEqual(calls, ['a', 'b', 'd', 'e', 'b']);
  reader.dispose();
  assert.equal(listChanged, undefined);
  pending[4].resolve();
  await settle();
  assert.equal(calls.length, 5);
});

test('an authenticated Native workspace visibly restores a cold title from its real passive projection', { timeout: 90_000 }, async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const os = require('node:os');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { chromium } = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  const cli = process.env.HARNESS_NATIVE_CLI;
  assert.ok(cli, 'HARNESS_NATIVE_CLI must point to the pinned Native CLI');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-workspace-title-'));
  let child, closed, browser, page, log = '', listCount = 0;
  const idsRead = [];
  const errors = [], seenLists = [];
  try {
    await fs.promises.mkdir(path.join(directory, 'saved-project'));
    const content = `
      import {writeFile} from 'node:fs/promises';
      import {installChatCache} from ${JSON.stringify(pathToFileURL(path.join(__dirname, 'native.mjs')).href)};
      export const inject = ['sessions','sessionTitle','workspaceRegistry','sessionPersistence'];
      export async function apply(ctx) {
        installChatCache(ctx);
        const project = ${JSON.stringify(path.join(directory, 'saved-project'))};
        const workspace = await ctx.workspaceRegistry.create(project, 'Saved fixture workspace');
        const session = ctx.sessions.prepare('session-1a7aa9cf-8a67-4455-a128-000000000001', {meta:{cwd:project}});
        // A synthetic Session has no Agent to open its JSONL write handle.
        // session/flush only drains events routed to an existing writer.
        const handle = await ctx.sessionPersistence.create(session.header);
        const detach = ctx.sessions.enter(session);
        try {
          ctx.sessions.announce(session);
          session.append('turn/start',{turn:1});
          session.append('user/message',{id:'first',role:'user',source:{kind:'user'},content:[{type:'text',text:'First fixture prompt'}]}, {surfaceOp:'append'});
          session.append('turn/end',{turn:1,reason:{kind:'completed'}});
          ctx.sessionTitle.rename(session,'Name from exact cold projection');
          if (!await ctx.sessions.flush(session)) throw Error('Fixture session did not flush');
          await workspace.attachSession(session.id);
        } finally {
          await handle.close();
          detach();
        }
        const stored = await ctx.sessionPersistence.stat(session.id);
        if (ctx.sessions.get(session.id) || !stored?.location) throw Error('Expected a cold materialized fixture');
        await writeFile(new URL('./ready', import.meta.url), 'ready');
      }`;
    const fixture = path.join(directory, 'fixture.mjs');
    await fs.promises.writeFile(fixture, content);
    const overlay = path.join(directory, 'overlay.json');
    await fs.promises.writeFile(overlay, JSON.stringify([
      { id: 'ui-settings-models', config: { credentialOnboarding: false } }, { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'workspace-title-fixture', name: pathToFileURL(fixture).href }] },
    ]));
    child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: directory, env: { ...process.env, DSH_HOME: path.join(directory, 'home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    closed = once(child, 'close');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { log = (log + part).slice(-6000); });
    let url;
    const deadline = Date.now() + 35_000;
    while (!(url = log.match(/http:\/\/127\.0\.0\.1:\d+\S*/u)?.[0]) || !fs.existsSync(path.join(directory, 'ready'))) {
      if (child.exitCode !== null || Date.now() > deadline) throw Error('Local Native host failed to start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1160, height: 800 } });
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', item => { if (item.type() === 'error') errors.push(item.text().slice(0, 350)); });
    page.on('response', response => { if (response.status() >= 400) errors.push([new URL(response.url()).pathname.slice(0,110), response.status()]); });
    const id = 'session-1a7aa9cf-8a67-4455-a128-000000000001';
    // Reproduce a sparse list cache while keeping the Host journal, projection
    // endpoint, owner handshake, production boot graph and sidebar intact.
    await page.route('**/api/session/list', async route => {
      const response = await route.fetch();
      const rpc = await response.json();
      seenLists.push(rpc.result.value.items.map(item => item.sessionId));
      const row = rpc.result.value.items.find(item => item.sessionId === id);
      if (row) {
        if (row.projections) delete row.projections.values.title;
        listCount++;
      }
      await route.fulfill({ response, json: rpc });
    });
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/session/projections') idsRead.push(request.postData());
    });
    await page.goto(url);
    // Owner links can complete the handshake while the confirmation renders.
    await page.getByRole('button', {name:'Continue', exact:true}).click({timeout:2500}).catch(() => {});
    const row = page.locator('[data-row-key="session:' + id + '"]');
    const project = page.locator('[data-row-key^="workspace:"]').filter({hasText:'Saved fixture workspace'});
    await row.or(project).first().waitFor();
    if (!await row.isVisible() && await project.getAttribute('aria-expanded') === 'false') {
      await project.getByText('Saved fixture workspace', {exact:true}).click();
    }
    await row.getByText('Name from exact cold projection', { exact:true }).waitFor();
    assert.ok(listCount > 0);
    assert.ok(idsRead.some(data => data?.includes(id)), 'the visible row must make a scoped exact projection read');
  } catch (error) {
    const rows = await page?.locator('[data-row-key]').allTextContents().catch(() => []);
    const body = await page?.locator('body').innerText().catch(() => '');
    throw Error(JSON.stringify({ listCount, seenLists, projectionRequests: idsRead.length, rows: rows?.slice(0, 5), body:body?.slice(0,650), errors:errors.slice(-8), log: log.replace(/https?:\S+/gu, '[local URL]').slice(-3500) }), { cause:error });
  } finally {
    await browser?.close();
    child?.kill();
    if (closed) await closed;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
