'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {transform} = require('./patch-session-list.cjs');

const sdk = process.env.HARNESS_NATIVE_CLI
  ? path.join(path.dirname(process.env.HARNESS_NATIVE_CLI), '../..')
  : path.resolve(__dirname, '../node_modules/@deepseek-ai');
const pkg = path.join(sdk, 'dsh-api-session-controller');
const bundle = fs.readFileSync(path.join(pkg, 'lib/client.js'), 'utf8');
const owner = 'a'.repeat(32);
const flush = () => new Promise(resolve => setImmediate(resolve));
function row(id, title, blank = false) {
  return {sessionId:id, agentAvailable:true, updatedAt:1, running:false, blank,
    ...(title === undefined ? {} : {projections:{kind:'cached', values:{title}}})};
}

// Exercise the browser module factory and its published Sessions service. Only
// Cordis transport/events and the encrypted tab storage boundary are fixtures.
function browser(saved, initialScope = owner) {
  let plugin, sessions, generation, connected, scope = initialScope;
  const events = {}, pending = [], reads = [];
  const history = [];
  const event = seq => ({type:'event', event:{type:'turn/start', time:seq, seq, data:{turn:1}}});
  const access = {
    scope: async () => scope,
    read: async key => saved.get(key),
    write: async (key, name, record) => { assert.equal(name, 'titles'); saved.set(key, structuredClone(record)); },
    clear: async key => { saved.delete(key); },
  };
  const gateway = {
    RemoteJournalStream: class {
      constructor(_remote, options) { this.options = options; }
      async open(request) {
        for await (const frame of this.follow(request, new AbortController().signal)) {
          this.cursor = frame.cursor;
          this.options.publish({type:'replace',page:frame.page,entries:frame.page.records,hasMore:frame.page.hasMore});
        }
      }
      async prepend(request) {
        const page = await this.readPage(request, this.cursor, new AbortController().signal);
        this.options.publish({type:'prepend',page,entries:page.records,hasMore:page.hasMore});
      }
    }, RemoteSnapshotStream: class { start() {} restart() {} },
    isRemoteFailure: e => e.isDSHRemoteError === true,
  };
  const store = {
    notifySubscribers: listeners => { for (const fn of listeners) fn(); },
    createSnapshotStore(snapshot) {
      const listeners = new Set();
      return {getSnapshot: () => snapshot, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
        set(value) {snapshot = value; store.notifySubscribers(listeners);}};
    },
  };
  const load = ({factory}) => { plugin = factory(id => id.endsWith('client-store') ? store : id.endsWith('gateway/client') ? gateway : {Context:{filter:Symbol()}}); };
  vm.runInNewContext(transform(bundle), {window:{__ModuleLoader__:{load}}, __HOMEAI_CHAT_CACHE_ACCESS__:access,
    AbortController, queueMicrotask, console}, {filename:'dsh-api-session-controller/lib/client.js'});
  plugin.apply({
    get: () => ({generation:{getSnapshot:() => generation, subscribe:fn => {connected = fn;}}}),
    plugin: () => ({ctx:{extend:properties => ({...properties,effect() {}})}}),
    effect: run => run(), typert:{contexts:{registerClient() {}}}, reflect:{provide:(_key, value) => {sessions = value;}},
    remote:{$on:(key, fn) => {events[key] = fn;}, $stream() {}, session:{
      list: () => new Promise(resolve => pending.push(items => resolve({ok:true, value:{items}}))),
      projections: async ({sessionId}) => { reads.push(sessionId); return {ok:true, value:{kind:'sequenced', asOfSeq:4, values:{title:sessionId === 'cold' ? 'Exact title' : null}}}; },
      async *follow(request) {
        history.push(structuredClone(request));
        yield {type:'snapshot',cursor:5,hasMore:true,records:[event(5)],assistantStream:{revision:0}};
      },
      async page(request) {
        history.push(structuredClone(request));
        return {ok:true,value:{cursor:5,hasMore:request.beforeSeq===5,records:[event(request.beforeSeq-1)]}};
      },
    }},
  });
  return {
    sessions, reads, events, history, get: id => sessions.list.getSnapshot().byId[id], setScope: value => {scope = value;},
    connect() { generation = {id:(generation?.id ?? 0) + 1, host:{home:'/home/test'}}; connected(); },
    async reply(items) { assert.ok(pending.length); pending.shift()(items); await flush(); },
  };
}

test('real rc.2 browser list retains verified titles during reconnect and accepts new generation ordering', async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version, '0.2.2-rc.2');
  const saved = new Map(), app = browser(saved);
  app.connect();
  await app.reply([row('same', 'Original'), row('gone', 'Forget me'), row('blank', 'Blank title', true)]);
  app.sessions.handleControlFrame({type:'projection', sessionId:'same', seq:90, changes:[{key:'title', val:'Renamed'}]});
  await flush();
  assert.equal(app.get('same').title, 'Renamed');
  assert.equal(saved.get(owner).rows.some(([id]) => id === 'blank'), false);

  const seen = [];
  app.sessions.list.subscribe(() => seen.push(app.get('same')?.title));
  app.connect();
  await flush(); // Reconnected SDK cleared projection watermarks, session.list is still pending.
  assert.equal(app.get('same').title, 'Renamed');
  await app.reply([row('same'), row('blank', undefined, true)]);
  assert.ok(seen.length && seen.every(name => name === 'Renamed'));
  assert.equal(app.get('gone'), undefined);
  assert.ok(!saved.get(owner).rows.some(([id]) => id === 'gone'));
  app.sessions.handleControlFrame({type:'projection', sessionId:'same', seq:2, changes:[{key:'title', val:'After restart'}]});
  await flush();
  assert.equal(app.get('same').title, 'After restart');
});

test('cold reload uses only current authorized listed rows, and passive reads stay scoped', async () => {
  const saved = new Map([[owner, {savedAt:Date.now(), rows:[['same','Cached'], ['invisible','Other']]}]]);
  const app = browser(saved);
  app.connect();
  assert.equal(app.get('same'), undefined);
  await app.reply([row('same'), row('cold'), row('blank', undefined, true)]);
  assert.equal(app.get('same').title, 'Cached');
  assert.equal(app.get('same').titleNeedsRefresh, true);
  assert.equal(app.get('cold').titleNeedsRefresh, true);
  assert.equal(app.get('invisible'), undefined);
  await Promise.all(['cold','cold','invisible','blank','same'].map(id => app.sessions.refreshVisibleTitle(id)));
  await flush();
  assert.deepEqual(app.reads, ['cold','same']);
  assert.equal(app.get('cold').title, 'Exact title');
  assert.equal(app.get('same').title, undefined); // authoritative empty baseline
  app.connect();
  await app.reply([row('cold'), row('same')]);
  assert.deepEqual(app.reads, ['cold','same'], 'previous visibility cannot enqueue reconnect fan-out');
  app.setScope('b'.repeat(32));
  app.connect();
  await flush();
  assert.equal(app.get('cold').title, undefined, 'scope switch while the new list is still pending');
  await app.reply([row('cold')]);
  assert.equal(app.get('cold').title, undefined);
  const denied = browser(saved, null);
  denied.connect();
  await denied.reply([row('cold')]);
  assert.equal(denied.get('cold').title, undefined);
  assert.equal(denied.get('cold').titleNeedsRefresh, false);
});

test('a removed and re-added identity never recovers an earlier in-flight list title', async () => {
  const app = browser(new Map());
  app.connect();
  await app.reply([row('same', 'Original')]);
  app.sessions.refresh();
  app.events['api-session/removed']('same');
  app.events['api-session/added'](row('same'));
  await app.reply([row('same', 'Stale')]);
  assert.equal(app.get('same').title, undefined);
  assert.equal(app.get('same').titleNeedsRefresh, true);
});

test('slow optional authorization never delays the host list or overwrites a fresh title', async () => {
  const saved = new Map([[owner, {savedAt:Date.now(), rows:[['same','Older'], ['cold','Remembered']]}]]);
  const gate = Promise.withResolvers();
  const app = browser(saved, gate.promise);
  app.connect();
  await app.reply([row('same', 'From host'), row('cold')]);
  assert.equal(app.get('same').title, 'From host');
  assert.equal(app.get('cold').title, undefined);
  app.sessions.handleControlFrame({type:'projection',sessionId:'same',seq:8,changes:[{key:'title',val:'Live rename'}]});
  await flush();
  gate.resolve(owner);
  await flush();
  assert.equal(app.get('same').title, 'Live rename');
  assert.equal(app.get('cold').title, 'Remembered');

  const recheck = Promise.withResolvers();
  app.setScope(recheck.promise);
  app.connect();
  await app.reply([row('cold'), row('new', 'Immediately available')]);
  assert.equal(app.get('cold').title, 'Remembered');
  assert.equal(app.get('new').title, 'Immediately available');
  assert.equal(app.get('same'), undefined);
  recheck.resolve(null);
  await flush();
  assert.equal(app.get('cold').title, undefined);
  assert.equal(app.get('new').title, 'Immediately available');
});

test('the 128 stored titles favor recent activity regardless of list order', async () => {
  const saved = new Map(), app = browser(saved);
  app.connect();
  await app.reply(Array.from({length:130}, (_, i) => ({...row('id-'+i, 'Row '+i), updatedAt:i})));
  const ids = saved.get(owner).rows.map(([id]) => id);
  assert.equal(ids.length, 128);
  assert.ok(ids.includes('id-129') && !ids.includes('id-0'));
  app.events['api-session/activity']('id-0', 200);
  await flush();
  assert.ok(saved.get(owner).rows.some(([id]) => id === 'id-0'));
});

test('opening a real SDK Session requests a 12-message live follow and preserves older and jump page windows', async () => {
  const app = browser(new Map());
  app.connect();
  await app.reply([row('long', 'Recent work')]);
  const ref = app.sessions.retain('long', {source:'fixture'});
  await ref.ready;
  const session = ref.binding.session;
  const address = {kind:'session',sessionId:'long'};
  assert.deepEqual(app.history[0], {address,activate:true,assistantStream:true,maxMessages:12});
  await session.loadOlder({deferConsumption:true});
  assert.deepEqual(app.history[1], {address,throughSeq:5,beforeSeq:5,maxMessages:500,turnWindow:{minMessages:50,minTurns:2}});
  assert.equal(session.consumeOlder(), true);
  await session.loadThrough(2);
  assert.deepEqual(app.history[2], {address,throughSeq:5,beforeSeq:4,maxMessages:500,turnWindow:{minMessages:200,minTurns:2}});
});
