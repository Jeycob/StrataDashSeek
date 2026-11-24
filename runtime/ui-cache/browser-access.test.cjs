'use strict';
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, 'browser-access.js'), 'utf8');
const id = '1'.repeat(32), scope = '2'.repeat(32);
const generation = {};

function tab(storage, answer = async () => Response.json({ id, scope })) {
  let pagehide;
  const ctx = vm.createContext({
    __HOMEAI_CHAT_CACHE_SCOPE__: id, fetch: answer, crypto: webcrypto, TextEncoder, TextDecoder,
    AbortSignal, atob, btoa, addEventListener: (_, listener) => { pagehide = listener; },
    sessionStorage: {getItem: k => storage.get(k), setItem: (k, v) => storage.set(k,v), removeItem: k => storage.delete(k)},
  });
  vm.runInContext(source, ctx);
  return {api: ctx.__HOMEAI_CHAT_CACHE_ACCESS__, hide: () => pagehide()};
}

test('only the current verified owner can restore tab data after reload', async () => {
  const storage = new Map();
  const first = tab(storage);
  assert.equal(await first.api.scope(generation), scope);
  await first.api.write(scope, 'previews', ['fixture text']);
  assert.equal(storage.size, 1);
  assert(![...storage.values()][0].includes('fixture'));
  const reload = tab(storage);
  assert.equal(await reload.api.read(scope, 'previews'), null);
  await reload.api.scope({});
  assert.equal((await reload.api.read(scope, 'previews'))[0], 'fixture text');
  const anotherHost = tab(storage, () => Response.json({id, scope:'3'.repeat(32)}));
  const other = await anotherHost.api.scope({});
  assert.equal(await anotherHost.api.read(other, 'previews'), null);
  reload.hide();
  assert.equal(await reload.api.read(scope, 'previews'), null);
});

test('components share a single fresh request per generation and ignore late authorization', async () => {
  let calls = 0, complete;
  const tabState = tab(new Map(), () => ++calls === 1
    ? new Promise(resolve => {complete = resolve;}) : new Response(null, {status: 403}));
  const one = tabState.api.scope(generation), two = tabState.api.scope(generation);
  assert.equal(calls, 1);
  assert.equal(await tabState.api.scope({}), null);
  complete(Response.json({id,scope}));
  assert.equal(await one, null);
  assert.equal(await two, null);
  assert.equal(calls, 2);
});
