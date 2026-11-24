import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sessionList from './patch-session-list.cjs';
import chatPreview from './patch-chat-preview.cjs';
import workspaceTitles from './patch-workspace-titles.cjs';

const assetRoot = '/_homeai/chat-ui/';
const idPrefix = '@deepseek-ai/';
const adapters = new Map([
  [idPrefix + 'dsh-api-session-controller', ['e9af25a01168a8405730c107471cbd6befccfab3294e793b10e1467c57255852', sessionList.transform]],
  [idPrefix + 'dsh-client-ui-chat', ['eef53e82b8cd584d2f0e543a4a93395f9d90df3bba1218891bd99d07d788de5c', chatPreview.transform]],
  [idPrefix + 'dsh-client-ui-workspace', ['77da49d837c2503c45ea197129c53d9f679e99bf36737c23eaef457c66f4ee8c', workspaceTitles.transform]],
]);
const access = readFileSync(new URL('browser-access.js', import.meta.url), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Native strips each module's debug trailer before concatenating it into its
// boot batch. Match the whole pinned module, so neighboring factories and
// their order stay exactly as the Native Loader composed them.
function moduleBody(text) {
  return text.replace(/(?:\r?\n)?\/\/# sourceURL=[^\r\n]*(?:\r?\n)?$/, '')
    .replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '').trimEnd() + '\n';
}

export function releaseAssets(registry) {
  let current, previous = new Map(), available = new Map();
  const modules = new Map();

  function replacement(id) {
    if (modules.has(id)) return modules.get(id);
    const [expected, transform] = adapters.get(id);
    const bytes = readFileSync(registry.clientPath(id));
    if (hash(bytes) !== expected) throw Error('Unsupported Native UI bundle: ' + id);
    const original = bytes.toString('utf8');
    const result = { original: moduleBody(original), changed: moduleBody(transform(original)) };
    result.rev = hash(result.changed);
    modules.set(id, result);
    return result;
  }

  function forGraph(graph) {
    if (current?.source === graph) return current;
    const assets = new Map(), urls = new Map();
    function variant(row, ids) {
      const changes = ids.filter(id => adapters.has(id)).map(replacement);
      if (changes.length === 0) return row;
      const rev = hash(JSON.stringify([row.url, row.rev, ...changes.map(mod => mod.rev)]));
      const path = assetRoot + rev + '.js';
      assets.set(path, { upstream: row.url, changes });
      urls.set(row.url, path.slice(1));
      // Native compares rev with its live Loader generation and remounts
      // sessions on a mismatch. Only the HTTP cache key belongs to this overlay.
      return { ...row, url: path.slice(1) };
    }
    const entries = graph.entries.map(row => variant(row, [row.id]));
    const batches = graph.batches.map(row => variant(row, row.entries));
    previous = available;
    available = assets;
    current = { source: graph, graph: { ...graph, entries, batches }, urls };
    return current;
  }

  async function serve(request) {
    const path = new URL(request.url).pathname;
    const item = available.get(path) ?? previous.get(path);
    if (!item) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const headers = { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable' };
    if (request.method === 'HEAD') return new Response(null, { headers });
    if (!item.body) {
      item.body = (async () => {
        const upstream = await registry.fetchBundle(new Request(new URL('/' + item.upstream, request.url)));
        if (!upstream.ok) throw Error('Native boot batch unavailable');
        let body = await upstream.text();
        for (const { original, changed } of item.changes) {
          const start = body.indexOf(original);
          if (start < 0 || body.indexOf(original, start + original.length) !== -1) throw Error('Native batch does not contain one matching factory');
          body = body.slice(0, start) + changed + body.slice(start + original.length);
        }
        // The upstream map describes different generated lines after patching.
        return Buffer.from(body.replace(/\/\/# sourceMappingURL=[^\r\n]*\s*$/, ''));
      })().catch(error => { item.body = undefined; throw error; });
    }
    return new Response(await item.body, { headers });
  }
  return { forGraph, serve };
}

export function installChatCache(ctx) {
  const scope = randomBytes(16).toString('hex');
  const indexScope = hash(scope).slice(0, 32);
  ctx.inject(['clientModules', 'webServer', 'connection'], child => {
    const assets = releaseAssets(child.clientModules);
    let unsupported;
    child.effect(() => child.webServer.register({ kind: 'prefix', path: assetRoot.slice(0, -1), resource: assets.serve }));
    // Native's exact connection.fetch routes have a server-side owner check.
    child.effect(() => child.connection.fetch.register({
      path: '/api/workbench/chat-cache-scope', methods: ['GET'], requestBody: 'buffered',
      fetch: () => Response.json({ id: indexScope, scope }, { headers: { 'Cache-Control': 'private, no-store' } }),
    }));
    child.on('webserver/index-inject', (table, peer) => {
      if (peer?.principal.kind !== 'owner') return;
      const boot = table.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__');
      if (!boot || boot.value === unsupported) return;
      let result;
      try {
        result = assets.forGraph(boot.value);
      } catch (error) {
        unsupported = boot.value;
        child.logger?.warn('Native chat cache unavailable for this SDK build: ' + error.message);
        return;
      }
      // Update the browser's initial preload and individual retry targets together.
      for (const row of table) {
        if ((row.kind === 'script-preload' || row.kind === 'script-src') && result.urls.has(row.src)) row.src = result.urls.get(row.src);
      }
      boot.value = result.graph;
      table.unshift({ kind: 'global', name: '__HOMEAI_CHAT_CACHE_SCOPE__', value: indexScope },
        { kind: 'script', placement: 'head', text: access });
    });
  });
}
