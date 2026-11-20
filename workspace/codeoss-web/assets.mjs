import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import runtime from '../../runtime/require.cjs';

const local = path.dirname(fileURLToPath(import.meta.url));
const entry = '/api/workbench/codeoss';
const distributionVersion = '0.30.3';
const assets = '/_homeai/codeoss-' + distributionVersion;
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
          'Content-Type': contentType, 'Content-Length': String(info.size),
          'Cache-Control': source ? 'no-cache' : 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        };
        if (contentType === 'text/html') headers['Content-Security-Policy'] = csp;
        return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(target)), { headers });
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
