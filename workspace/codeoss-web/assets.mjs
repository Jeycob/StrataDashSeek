import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';
import runtime from '../../runtime/require.cjs';

const local = path.dirname(fileURLToPath(import.meta.url));
const entry = '/api/workbench/codeoss';
const distributionVersion = '0.30.3';
const assets = '/_homeai/codeoss-' + distributionVersion;
const startupAssets = new Set([
  '/vscode/vs/workbench/workbench.web.main.internal.js',
  '/vscode/vs/workbench/workbench.web.main.internal.css',
  '/vscode/nls.messages.js',
  '/nls/cs/nls.messages.js',
]);
const mime = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain',
};
const csp = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob:", "connect-src 'self' blob:", "font-src 'self' data:",
  "img-src 'self' data: blob:", "worker-src 'self' blob:", "frame-src 'self' blob: data:",
  "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const shellHeaders = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

function startupEncoding(header) {
  const qualities = new Map();
  for (const field of (header ?? '').split(',')) {
    const match = /^\s*(br|gzip|identity|\*)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/iu.exec(field);
    if (match) qualities.set(match[1].toLowerCase(), Number(match[2] ?? 1));
  }
  const wildcard = qualities.get('*');
  const br = qualities.get('br') ?? wildcard ?? 0;
  const gzip = qualities.get('gzip') ?? wildcard ?? 0;
  // Implicit identity is the fallback when none of our compressed codings
  // are acceptable. An explicit identity preference can outrank them.
  const identity = qualities.get('identity');
  const compressed = Math.max(br, gzip);
  if (compressed > 0 && compressed >= (identity ?? 0)) return br >= gzip ? 'br' : 'gzip';
  return (identity ?? (wildcard === 0 ? 0 : 1)) > 0 ? 'identity' : null;
}

function encodedStream(target, compressor) {
  return Readable.toWeb(pipeline(createReadStream(target), compressor, () => {}));
}

function brotliBody(cache, asset, target) {
  const cached = cache.get(asset);
  if (cached) return cached;
  const compressor = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 3 } });
  const [response, copy] = encodedStream(target, compressor).tee();
  // The first request streams while we retain one compressed copy per pinned
  // asset. Concurrent requests share that work and a failed read can retry.
  const pending = buffer(copy);
  cache.set(asset, pending);
  void pending.catch(() => cache.delete(asset));
  return response;
}

export function installCodeOss(ctx, manager) {
  let directory;
  try {
    const name = '@github1s/vscode-web/package.json';
    if (runtime.runtimeRequire(name).version === distributionVersion) directory = path.dirname(runtime.resolveRuntime(name));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') ctx.logger?.warn('Code-OSS runtime assets are unavailable.');
  }
  const extension = new Map([
    ['/boot.js', 'boot.js'], ['/project/package.json', 'project/package.json'],
    ['/project/package.nls.json', 'project/package.nls.json'],
    ['/project/extension.js', 'project/extension.js'],
    ['/LICENSE-GitHub1s.txt', 'LICENSE-GitHub1s.txt'], ['/LICENSE-Code-OSS.txt', 'LICENSE-Code-OSS.txt'],
    ['/ThirdPartyNotices.txt', 'ThirdPartyNotices.txt'],
  ]);
  const brotli = new Map();
  ctx.inject(['webServer'], child => child.effect(() => child.webServer.register({
    kind: 'prefix', path: assets,
    // This prefix serves static distribution and plugin code only. The launch
    // page and all project requests are authenticated through the owner API.
    resource: async request => {
      const suffix = new URL(request.url).pathname.slice(assets.length);
      let relative;
      try { relative = decodeURIComponent(suffix); } catch { return new Response(null, { status: 400 }); }
      const source = extension.get(relative);
      const parts = relative.slice(1).split('/');
      if (!source && (!['vscode', 'dependencies', 'extensions', 'nls'].includes(parts[0]) ||
          parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\\:]/u.test(part)))) {
        return new Response(null, { status: 404 });
      }
      const base = source ? local : directory;
      if (!base) return new Response(null, { status: 404 });
      try {
        const target = await fs.realpath(path.join(base, source || parts.join('/')));
        const inside = path.relative(await fs.realpath(base), target);
        if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) return new Response(null, { status: 404 });
        const info = await fs.stat(target);
        if (!info.isFile()) return new Response(null, { status: 404 });
        const contentType = mime[path.extname(target)] || 'application/octet-stream';
        const headers = {
          'Content-Type': contentType,
          'Cache-Control': source ? 'no-cache' : 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        };
        if (contentType === 'text/html') headers['Content-Security-Policy'] = csp;
        let encoding = 'identity';
        if (startupAssets.has(relative)) {
          encoding = startupEncoding(request.headers.get('accept-encoding'));
          headers.Vary = 'Accept-Encoding';
          headers['Cache-Control'] += ', no-transform';
          if (!encoding) return new Response(null, { status: 406, headers: { Vary: headers.Vary } });
        }
        if (encoding === 'identity') headers['Content-Length'] = String(info.size);
        else headers['Content-Encoding'] = encoding;
        if (request.method === 'HEAD') return new Response(null, { headers });
        let body;
        if (encoding === 'br') body = await brotliBody(brotli, relative, target);
        else if (encoding === 'gzip') body = encodedStream(target, createGzip({ level: constants.Z_BEST_SPEED }));
        else body = Readable.toWeb(createReadStream(target));
        return new Response(body, { headers });
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return new Response(null, { status: 404 });
        throw error;
      }
    },
  })));
  ctx.effect(() => ctx.connection.fetch.register({ path: entry, methods: ['GET'], requestBody: 'buffered', fetch: async request => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    const language = url.searchParams.get('lang') === 'cs' ? 'cs' : 'en';
    let error = '';
    try {
      if (!directory) throw Error('missing distribution');
      if (manager.execution.snapshot.mode !== 'host-compat') throw Error('unsupported execution mode');
      await manager.projectFor(sessionId);
    } catch { error = 'unavailable'; }
    const messages = language === 'cs' ? 'nls/cs/nls.messages.js' : 'vscode/nls.messages.js';
    const workbench = error ? '' :
      '<link rel="stylesheet" href="' + assets + '/vscode/vs/workbench/workbench.web.main.internal.css">' +
      '<script src="' + assets + '/' + messages + '"></script>';
    return new Response(`<!doctype html>
<html lang="${language}" data-session="${error ? '' : sessionId}" data-state="${error}">
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code – OSS</title>
${workbench}
<body><script type="module" src="${assets}/boot.js"></script></body>
</html>`, { status: error ? 503 : 200, headers: shellHeaders });
  } }));
}
