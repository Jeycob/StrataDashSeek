import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { confined, readJson, digest, QualityError } from './core.mjs';

const ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const loopback = u => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
export function resolveBaseURL(value, env = process.env) {
  if (typeof value !== 'string') throw new QualityError('INVALID_BROWSER_URL', 'Declare a loopback baseURL.');
  const expanded = value.replace(/\$\{(PORT|API_PORT|TEST_PORT)\}/gu, (_, name) => {
    if (!/^\d{1,5}$/u.test(env[name] ?? '') || Number(env[name]) < 1 || Number(env[name]) > 65535) throw new QualityError('PORT_UNAVAILABLE', `Assigned ${name} is missing.`);
    return env[name];
  });
  const u = new URL(expanded);
  if (!loopback(u)) throw new QualityError('INVALID_BROWSER_URL', 'Browser verification is restricted to the assigned local application.');
  const allowed = env.HARNESS_QUALITY_ALLOWED_PORTS?.split(',').map(Number);
  if (allowed?.length && !allowed.includes(Number(u.port || (u.protocol === 'https:' ? 443 : 80)))) throw new QualityError('UNASSIGNED_PORT', 'Browser URL is outside the managed project ports.');
  return u;
}

export function validatePlan(plan) {
  const known = (obj, keys) => obj && !Object.keys(obj).some(k => !keys.includes(k));
  if (!known(plan, ['version','baseURL','viewports','flows','forbiddenTexts'])) throw new QualityError('INVALID_BROWSER_PLAN', 'Unknown browser plan option.');
  if (plan.forbiddenTexts !== undefined && (!Array.isArray(plan.forbiddenTexts) || !plan.forbiddenTexts.length || plan.forbiddenTexts.length > 32 || plan.forbiddenTexts.some(s => typeof s !== 'string' || !s || s.length > 512))) throw new QualityError('INVALID_BROWSER_PLAN', 'forbiddenTexts must contain 1–32 bounded strings.');
  if (plan?.version !== 1 || !Array.isArray(plan.viewports) || !plan.viewports.length || plan.viewports.length > 4 || !Array.isArray(plan.flows) || !plan.flows.length || plan.flows.length > 16) throw new QualityError('INVALID_BROWSER_PLAN', 'Declare version 1, 1–4 viewports and 1–16 flows.');
  const names = new Set();
  for (const v of plan.viewports) {
    if (!known(v, ['name','width','height'])) throw new QualityError('INVALID_VIEWPORT', 'Unknown viewport option.');
    if (!ID.test(v.name) || names.has(v.name) || !Number.isInteger(v.width) || v.width < 320 || v.width > 2560 || !Number.isInteger(v.height) || v.height < 240 || v.height > 2160) throw new QualityError('INVALID_VIEWPORT', 'Declare unique named bounded viewports.');
    names.add(v.name);
  }
  const flows = new Set();
  for (const f of plan.flows) {
    if (!known(f, ['name','viewports','steps'])) throw new QualityError('INVALID_FLOW', 'Unknown flow option.');
    if (!ID.test(f.name) || flows.has(f.name) || !Array.isArray(f.steps) || !f.steps.length || f.steps.length > 100) throw new QualityError('INVALID_FLOW', 'Declare unique named bounded flows.');
    flows.add(f.name);
    if (f.viewports && (!Array.isArray(f.viewports) || f.viewports.some(n => !names.has(n)))) throw new QualityError('INVALID_VIEWPORT', 'Unknown flow viewport.');
    const shots = new Set();
    for (const step of f.steps) {
      const fields = { goto:['path'], click:['selector'], fill:['selector','value'], press:['selector','value'], expect:['selector','minCount','maxCount','textIncludes','textExcludes','focused'], checkpoint:['name','imageContainers'] };
      if (!known(step, ['action', ...(fields[step?.action] ?? [])])) throw new QualityError('INVALID_BROWSER_ACTION', 'Unknown action option; assertion typos cannot be ignored.');
      if (!['goto', 'click', 'fill', 'press', 'expect', 'checkpoint'].includes(step.action)) throw new QualityError('INVALID_BROWSER_ACTION', 'Unsupported browser action.');
      if (['click', 'fill', 'press', 'expect'].includes(step.action) && (typeof step.selector !== 'string' || !step.selector || step.selector.length > 512)) throw new QualityError('INVALID_SELECTOR', 'A bounded selector is required.');
      if (step.action === 'goto' && (typeof step.path !== 'string' || step.path.length > 2048)) throw new QualityError('INVALID_ROUTE', 'A bounded route is required.');
      if (['fill', 'press'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 4096)) throw new QualityError('INVALID_BROWSER_VALUE', 'A bounded value is required.');
      if (step.action === 'expect' && !['minCount', 'maxCount', 'textIncludes', 'textExcludes', 'focused'].some(k => step[k] !== undefined)) throw new QualityError('EMPTY_ASSERTION', 'An expectation must actually assert a value.');
      if (step.focused !== undefined && step.focused !== true) throw new QualityError('INVALID_ASSERTION', 'focused must be true to request a visible focus assertion.');
      for (const key of ['minCount', 'maxCount']) if (step[key] !== undefined && (!Number.isInteger(step[key]) || step[key] < 0 || step[key] > 10000)) throw new QualityError('INVALID_ASSERTION', 'Counts must be bounded nonnegative integers.');
      for (const key of ['textIncludes', 'textExcludes']) if (step[key] !== undefined && (typeof step[key] !== 'string' || !step[key] || step[key].length > 4096)) throw new QualityError('INVALID_ASSERTION', 'Expected text must be nonempty and bounded.');
      if (step.action === 'checkpoint') {
        if (!ID.test(step.name) || shots.has(step.name)) throw new QualityError('INVALID_SCREENSHOT', 'Checkpoints need unique names within each flow.');
        shots.add(step.name);
        if (step.imageContainers !== undefined && (!Array.isArray(step.imageContainers) || step.imageContainers.some(s => typeof s !== 'string' || !s || s.length > 512))) throw new QualityError('INVALID_SELECTOR', 'imageContainers must be bounded selectors.');
      }
    }
    if (!shots.size) throw new QualityError('SCREENSHOT_REQUIRED', 'Every flow must include a real screenshot checkpoint.');
  }
  return plan;
}

export async function loadChromium(workspace, env = process.env) {
  const candidates = [env.HARNESS_PLAYWRIGHT_MODULE, '/data/harness/dev/browser/node_modules/playwright'].filter(Boolean);
  for (const candidate of candidates) {
    try { const loaded = createRequire(path.join(workspace, 'package.json'))(candidate); if (loaded.chromium) return loaded.chromium; } catch (e) { if (!['MODULE_NOT_FOUND', 'ENOENT'].includes(e.code)) throw e; }
  }
  try { return createRequire(path.join(workspace, 'package.json'))('playwright').chromium; }
  catch { throw new QualityError('BROWSER_UNAVAILABLE', 'Prepared Playwright is unavailable. Report BLOCKED; do not replace browser evidence with a DOM mock or install loop.'); }
}

async function expectStep(page, step, signal) {
  const until = Date.now() + 5000; let reason = 'Expectation not met.';
  do {
    signal?.throwIfAborted();
    const locator = page.locator(step.selector), count = await locator.count();
    const text = (await locator.allTextContents()).join('\n');
    const ok = (step.minCount === undefined || count >= step.minCount) && (step.maxCount === undefined || count <= step.maxCount)
      && (step.textIncludes === undefined || text.includes(step.textIncludes)) && (step.textExcludes === undefined || !text.includes(step.textExcludes));
    let focus = true;
    if (step.focused) focus = count === 1 && await locator.evaluate(el => {
      const s = getComputedStyle(el); return document.activeElement === el && ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none');
    });
    if (ok && focus) return;
    reason = `Expected ${step.selector}: count=${count}; ${text.slice(0,160)}`;
    await page.waitForTimeout(50);
  } while (Date.now() < until);
  throw new QualityError('UI_ASSERTION_FAILED', reason);
}

export async function verifyBrowser({ workspace, planPath, outputPath, runId, env = process.env, chromium, signal } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(runId ?? '')) throw new QualityError('INVALID_RUN_ID', 'A bounded verification run id is required.');
  const root = await fs.realpath(workspace), plan = validatePlan(await readJson(root, planPath)), base = resolveBaseURL(plan.baseURL, env);
  const output = await confined(root, outputPath, { missing: true }); await fs.mkdir(path.dirname(output), { recursive: true });
  const shotsPrefix = `.harness/quality/screenshots/${digest(outputPath).slice(0,12)}/${runId}`;
  const shotsDir = await confined(root, shotsPrefix, { missing: true }); await fs.mkdir(shotsDir, { recursive: true });
  const results = [], screenshots = []; let browser;
  const record = (name, passed, code, detail = '') => results.push({ name, passed, code, detail: String(detail).slice(0,500) });
  const abort = () => { void browser?.close().catch(() => {}); };
  try {
    signal?.throwIfAborted();
    const engine = chromium ?? await loadChromium(root, env);
    browser = await engine.launch({ headless: true, ...(env.HARNESS_CHROMIUM_EXECUTABLE ? { executablePath: env.HARNESS_CHROMIUM_EXECUTABLE } : {}), args: ['--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    signal?.addEventListener('abort', abort, { once: true });
    for (const flow of plan.flows) for (const viewport of plan.viewports.filter(v => !flow.viewports || flow.viewports.includes(v.name))) {
      signal?.throwIfAborted();
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const errors = [], blocked = [];
      await context.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.origin === base.origin || ['data:', 'blob:'].includes(u.protocol)) return route.continue();
        blocked.push(u.origin); return route.abort();
      });
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0,300)); });
      page.on('pageerror', e => errors.push(e.message.slice(0,300)));
      try {
        for (const step of flow.steps) {
          signal?.throwIfAborted();
          if (step.action === 'goto') { const url = new URL(step.path, base); if (url.origin !== base.origin) throw new QualityError('EXTERNAL_NAVIGATION_REFUSED', 'Flow navigates outside its application.'); await page.goto(url.href, { waitUntil: 'domcontentloaded' }); }
          else if (step.action === 'fill') await page.locator(step.selector).fill(step.value);
          else if (step.action === 'click') await page.locator(step.selector).click();
          else if (step.action === 'press') await page.locator(step.selector).press(step.value);
          else if (step.action === 'expect') { await expectStep(page, step, signal); record(`${flow.name}/${viewport.name}/expect`, true, 'UI_ASSERTION'); }
          else {
            const snapshot = await page.evaluate(({ imageContainers, forbiddenTexts }) => {
              const text = document.body.innerText.replace(/\s+/gu, ' ');
              const invalidText = forbiddenTexts.filter(s => text.includes(s));
              const broken = [...document.images].filter(img => { const r = img.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && (!img.complete || !img.naturalWidth); }).map(img => img.getAttribute('src'));
              const missing = imageContainers.flatMap(selector => {
                const nodes = [...document.querySelectorAll(selector)];
                if (!nodes.length) return [selector + ': no containers'];
                return nodes.filter(el => !el.querySelector('svg, img') && !el.matches('svg, img')).map(() => selector + ': no product image');
              });
              return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, invalidText, broken, missing };
            }, { imageContainers: step.imageContainers ?? [], forbiddenTexts: plan.forbiddenTexts ?? ['NaN'] });
            record(`${flow.name}/${viewport.name}/${step.name}/layout`, snapshot.scrollWidth <= snapshot.width + 1, 'HORIZONTAL_OVERFLOW', `${snapshot.scrollWidth}/${snapshot.width}`);
            record(`${flow.name}/${viewport.name}/${step.name}/text`, !snapshot.invalidText.length, 'INVALID_VISIBLE_TEXT', snapshot.invalidText.join(', '));
            record(`${flow.name}/${viewport.name}/${step.name}/images`, !snapshot.broken.length && !snapshot.missing.length, 'MISSING_OR_BROKEN_IMAGES', [...snapshot.broken, ...snapshot.missing].join(', '));
            record(`${flow.name}/${viewport.name}/${step.name}/console`, !errors.length && !blocked.length, 'BROWSER_ERRORS', [...errors, ...blocked.map(s => 'external request: ' + s)].join('; '));
            const relative = `${shotsPrefix}/${flow.name}-${viewport.name}-${step.name}.png`, p = await confined(root, relative, { missing: true });
            const png = await page.screenshot({ path: p, fullPage: false });
            screenshots.push({ path: relative, width: viewport.width, height: viewport.height, sha256: digest(png) });
          }
        }
      } catch (e) { record(`${flow.name}/${viewport.name}`, false, e.code ?? 'BROWSER_FLOW_FAILED', e.message); }
      finally { await context.close(); }
    }
  } catch (e) { record('browser', false, e.code ?? 'BROWSER_UNAVAILABLE', e.message); }
  finally { signal?.removeEventListener('abort', abort); await browser?.close().catch(() => {}); }
  const report = { version: 1, runId, engine: 'chromium', passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, screenshots, results };
  await fs.writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 }); return report;
}

async function main(argv) {
  const opts = {}, keys = { '--workspace': 'workspace', '--plan': 'planPath', '--output': 'outputPath', '--run-id': 'runId' };
  for (let i = 0; i < argv.length; i += 2) { if (!keys[argv[i]] || !argv[i+1] || opts[keys[argv[i]]]) throw Error('Invalid browser arguments.'); opts[keys[argv[i]]] = argv[i+1]; }
  if (Object.keys(opts).length !== 4) throw Error('Expected workspace, plan, output and run-id.');
  const report = await verifyBrowser(opts); console.log(JSON.stringify({ passed: report.passed, failed: report.failed, screenshots: report.screenshots.length })); return report.failed || !report.passed ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
