import http from 'node:http';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import privateSource from './source-private.cjs';

const require = createRequire(import.meta.url);
const renderOrigin = 'https://preview-snapshot.invalid';
const viewports = {mobile:{width:390,height:720}, desktop:{width:960,height:620}};
const maxAssetBytes = 2 * 1024 * 1024;
const maxSnapshotBytes = 1024 * 1024;
const maxScroll = 20000;
const fail = code => Object.assign(Error(code), {code,status:409});

export function previewSnapshotPosition(route = '/', scrollY = 0) {
 if (typeof route !== 'string' || route.length > 512 ||
     !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?(?![\s\S])/.test(route) ||
     route.split('/').some(segment => segment === '.' || segment === '..') ||
     /^\/(?:__preview|__editor|proxy|absproxy)(?:\/|$)/i.test(route) ||
     !Number.isSafeInteger(scrollY) || scrollY < 0 || scrollY > maxScroll) {
  throw fail('PREVIEW_SNAPSHOT_POSITION_INVALID');
 }
 return {route,scrollY};
}

function readOwnedAsset({socketPath, path, host, signal, charge}) {
 return new Promise((resolve, reject) => {
  const req = http.get({socketPath, path, agent:false, signal, headers:{host, 'accept-encoding':'identity'}}, res => {
   const chunks = [];
   let bytes = 0;
   res.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxAssetBytes || !charge(chunk.length)) res.destroy(fail('PREVIEW_SNAPSHOT_ASSET_LIMIT'));
    else chunks.push(chunk);
   });
   res.on('error', reject);
   res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks)}));
  });
  req.on('error', reject);
 });
}

export function previewAssetPath(value) {
 if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2000 ||
     /[\u0000-\u0020\u007f\\#]/u.test(value)) throw fail('PREVIEW_SNAPSHOT_ASSET_PATH');
 const url = new URL(value,renderOrigin);
 const relative = decodeURIComponent(url.pathname).slice(1);
 if (url.origin !== renderOrigin || url.pathname+url.search !== value ||
     /^(?:__preview|__editor|proxy|absproxy)(?:\/|$)/i.test(relative) ||
     /%(?:2f|5c|00|0d|0a|25)/i.test(url.pathname) || privateSource.isPrivateSourcePath(relative) ||
     relative.split('/').some(part=>part==='.git'||part==='.harness')) throw fail('PREVIEW_SNAPSHOT_ASSET_PATH');
 return value;
}

export function ownedPreviewAssets({socketPath,origin,assertCurrent,signal}) {
 const host = new URL(origin).host;
 let count = 0, total = 0;
 const charge = bytes => (total += bytes) <= 8*1024*1024;
 return async value => {
  const path = previewAssetPath(value);
  assertCurrent();
  signal.throwIfAborted();
  if (++count > 48) throw fail('PREVIEW_SNAPSHOT_ASSET_LIMIT');
  const asset = await readOwnedAsset({socketPath,path,host,signal,charge});
  assertCurrent();
  if (asset.status < 200 || asset.status >= 300 ||
      (asset.headers['content-encoding'] && asset.headers['content-encoding'] !== 'identity')) {
   throw fail('PREVIEW_SNAPSHOT_ASSET_UNAVAILABLE');
  }
  const contentType=String(asset.headers['content-type'] || 'application/octet-stream');
  const csp=asset.headers['content-security-policy'];
  if (contentType.length>8192 || (csp!==undefined&&(typeof csp!=='string'||csp.length>8192))) {
   throw fail('PREVIEW_SNAPSHOT_ASSET_UNAVAILABLE');
  }
  return {status:asset.status,body:asset.body,headers:{
   'content-type':contentType,...(csp?{'content-security-policy':csp}:{}),
  }};
 };
}

// Evaluated in a separate Chromium world. The project's JavaScript cannot
// replace the DOM primitives used to derive coordinates and selectors.
function visibleRegions() {
 const ignored = new Set(['iframe','frame','object','embed','input','textarea','select','script','style']);
 const visual = window.visualViewport;
 const left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
 const width = visual?.width ?? innerWidth, height = visual?.height ?? innerHeight;
 const scale = visual?.scale ?? 1;
 const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
 const result = [];
 function selector(element) {
  const parts = [];
  while (element && element !== document.body && parts.length < 12) {
   const tag = element.localName;
   if (!/^[a-z][a-z\d-]{0,30}$/.test(tag)) return null;
   const id = element.getAttribute('id');
   if (/^[a-zA-Z_][a-zA-Z_0-9-]{0,63}$/.test(id || '') && document.querySelectorAll('#'+id).length === 1) {
    parts.unshift('#'+id);
    return parts.join(' > ');
   }
   let index = 1;
   for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (sibling.localName === tag && ++index > 1000) return null;
   }
   parts.unshift(tag+':nth-of-type('+index+')');
   element = element.parentElement;
  }
  return element === document.body ? 'body > '+parts.join(' > ') : null;
 }
 for (let index = 0, element; index < 1400 && (element = walker.nextNode()); index++) {
  if (ignored.has(element.localName) || element.closest('[contenteditable]:not([contenteditable="false"])')) continue;
  const box = element.getBoundingClientRect();
  const x = Math.max(left,box.left), y = Math.max(top,box.top);
  const right = Math.min(left+width,box.right), bottom = Math.min(top+height,box.bottom);
  if ((right-x)*scale < 8 || (bottom-y)*scale < 8 || (right-x)*(bottom-y) > width*height*0.85) continue;
  const hit = document.elementFromPoint((x+right)/2,(y+bottom)/2);
  if (!hit || !element.contains(hit) || hit.closest('iframe,input,textarea,select,[contenteditable]:not([contenteditable="false"])')) continue;
  const identity = selector(element);
  if (!identity || identity.length > 256) continue;
  const px = Math.floor((x-left)*scale), py = Math.floor((y-top)*scale);
  const pxRight = Math.min(Math.round(width*scale),Math.ceil((right-left)*scale));
  const pxBottom = Math.min(Math.round(height*scale),Math.ceil((bottom-top)*scale));
  result.push({selector:identity,x:px,y:py,width:pxRight-px,height:pxBottom-py});
  if (result.length === 120) break;
 }
 const page = document.scrollingElement;
 return {
  regions:result,
  scrollY:Math.round(window.scrollY),
  scrollStep:Math.max(1,Math.min(1000,Math.round(height*0.75))),
  maxScrollY:Math.max(0,Math.floor(page.scrollHeight-page.clientHeight)),
 };
}

async function readViewport(context, page, scrollY) {
 const cdp = await context.newCDPSession(page);
 try {
  const {frameTree} = await cdp.send('Page.getFrameTree');
  const {executionContextId} = await cdp.send('Page.createIsolatedWorld',{
   frameId:frameTree.frame.id, worldName:'homeai-preview-selection',
  });
  const read = '('+visibleRegions.toString()+')()';
  const expression = scrollY === undefined ? read : `(async()=>{
   window.scrollTo({top:${scrollY},behavior:'instant'});
   await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
   return ${read};
  })()`;
  const {result,exceptionDetails} = await cdp.send('Runtime.evaluate',{
   expression, contextId:executionContextId, returnByValue:true, awaitPromise:true,
  });
  if (exceptionDetails || !Array.isArray(result.value?.regions)) throw fail('PREVIEW_SNAPSHOT_SELECTION_UNAVAILABLE');
  return result.value;
 } finally { await cdp.detach().catch(() => {}); }
}

export async function pinnedPreviewBrowser({guest=false}={}) {
 // Only the operator-provisioned toolchain is an executable dependency.
 const folder = guest ? '/opt/playwright/node_modules/playwright' : '/data/harness/dev/browser/node_modules/playwright';
 const distribution = {x64:'linux64',arm64:'linux-arm64'}[process.arch];
 try {
  if (process.platform !== 'linux' || !distribution) throw Error('Unsupported browser platform');
  const {playwright:version} = require('../development/versions.json');
  const manifest = require.resolve(folder+'/package.json');
  const toolkit = createRequire(manifest).resolve('playwright-core/package.json');
  if (require(manifest).version !== version || require(toolkit).version !== version) throw Error('Browser toolchain version changed');
  const {browsers} = require(path.join(path.dirname(toolkit),'browsers.json'));
  const revision = browsers.find(browser => browser.name === 'chromium-headless-shell')?.revision;
  if (!/^[0-9]{1,8}$/.test(revision ?? '')) throw Error('Browser revision unavailable');
  const root = await fs.realpath(guest ? '/opt/playwright/browsers' : '/data/harness/dev/browsers');
  const expected = path.join(root,'chromium_headless_shell-'+revision,'chrome-headless-shell-'+distribution,'chrome-headless-shell');
  const executablePath = await fs.realpath(expected);
  if (executablePath !== expected || !(await fs.stat(executablePath)).isFile()) throw Error('Browser executable changed');
  await fs.access(executablePath,constants.X_OK);
  return {engine:require(folder).chromium,executablePath};
 } catch {
  throw fail('PREVIEW_SNAPSHOT_BROWSER_UNAVAILABLE');
 }
}

let rendering = false;

export function snapshotOwnedPreview(options, browser) {
 return renderPreviewSnapshot({...options,readAsset:ownedPreviewAssets(options)},browser);
}

export async function renderPreviewSnapshot({
 layout, route, scrollY, signal, assertCurrent, readAsset,
}, {chromium, browserChannel,loadBrowser=pinnedPreviewBrowser} = {}) {
 const position = previewSnapshotPosition(route,scrollY);
 if (!Object.hasOwn(viewports, layout)) throw fail('PREVIEW_SNAPSHOT_LAYOUT_INVALID');
 assertCurrent();
 signal.throwIfAborted();
 if (rendering) throw fail('PREVIEW_SNAPSHOT_BUSY');
 rendering = true;
 let browser;
 const abort = () => { void browser?.close().catch(() => {}); };
 signal.addEventListener('abort', abort, {once:true});
 try {
  const {engine,executablePath} = chromium ? {engine:chromium} : await loadBrowser();
  signal.throwIfAborted();
  browser = await engine.launch({
   chromiumSandbox:true, headless:true, timeout:6000,
   ...(executablePath ? {executablePath} : {}),
   ...(browserChannel ? {channel:browserChannel} : {}),
   args:['--disable-dev-shm-usage','--disable-background-networking',
    '--proxy-server=http://127.0.0.1:1','--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  });
  signal.throwIfAborted();
  const viewport = viewports[layout];
  const context = await browser.newContext({
   offline:true, serviceWorkers:'block', viewport, deviceScaleFactor:1,
   ...(layout === 'mobile' ? {isMobile:true, hasTouch:true} : {}),
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  let requests=0;
  await context.route('**/*', async route => {
   try {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== 'GET' || url.origin !== renderOrigin || url.href.length > 2048 || ++requests>48) return await route.abort();
    assertCurrent();
    const asset = await readAsset(previewAssetPath(url.pathname+url.search));
    assertCurrent();
    await route.fulfill({
     status:asset.status, body:asset.body,
     headers:{
      ...asset.headers,
      'cache-control':'no-store', 'x-content-type-options':'nosniff',
     },
    });
   } catch { await route.abort().catch(() => {}); }
  });
  const page = await context.newPage();
  const address = renderOrigin+position.route;
  await page.goto(address, {waitUntil:'load', timeout:4500});
  if (page.url() !== address) throw fail('PREVIEW_SNAPSHOT_NAVIGATION_CHANGED');
  const before = await readViewport(context,page,position.scrollY);
  const png = await page.screenshot({animations:'disabled', caret:'hide', timeout:2000, scale:'css'});
  const after = await readViewport(context,page);
  assertCurrent();
  signal.throwIfAborted();
  const maxScrollY = Math.min(maxScroll,after.maxScrollY);
  if (JSON.stringify(before) !== JSON.stringify(after) || page.url() !== address ||
      after.scrollY < 0 || after.scrollY > maxScrollY) {
   throw fail('PREVIEW_SNAPSHOT_SELECTION_UNAVAILABLE');
  }
  if (png.length > maxSnapshotBytes) throw fail('PREVIEW_SNAPSHOT_IMAGE_LIMIT');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width !== viewport.width || height !== viewport.height ||
      after.regions.some(region => region.x+region.width > width || region.y+region.height > height)) {
   throw fail('PREVIEW_SNAPSHOT_LAYOUT_CHANGED');
  }
  return {width,height,png:png.toString('base64'),regions:after.regions,route:position.route,
   scrollY:after.scrollY,scrollStep:after.scrollStep,maxScrollY};
 } catch (error) {
  if (error.code?.startsWith('PREVIEW_SNAPSHOT_')) throw error;
  throw fail('PREVIEW_SNAPSHOT_UNAVAILABLE');
 } finally {
  signal.removeEventListener('abort', abort);
  try { await browser?.close(); } finally { rendering = false; }
 }
}
