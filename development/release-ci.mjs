import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inventory} from './ci/inventory.mjs';
import {runProgram} from '../quality/core.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function summary(kind, run) {
  const text = run.stdout + '\n' + run.stderr;
  if (run.error || run.timedOut || run.aborted || run.truncated) return {outcome: 'unrunnable', reason: run.error ? 'PROCESS_START_FAILED' : run.timedOut ? 'TEST_TIMEOUT' : run.aborted ? 'TEST_CANCELLED' : 'OUTPUT_LIMIT', counts: null};
  if (kind === 'workerd') {
    let value; try {value = JSON.parse(run.stdout.trim().split(/\r?\n/u).at(-1));} catch {}
    return {outcome: run.exitCode === 0 && value?.passed === true && value.processRestartVerified === true && value.engine === 'actual local workerd' ? 'passed' : 'failed', counts: null, engine: value ?? null};
  }
  let counts;
  if (kind === 'python') {
    const total = Number(text.match(/Ran (\d+) tests?/u)?.[1] ?? 0), skipped = Number(text.match(/skipped=(\d+)/u)?.[1] ?? 0);
    const failureSummary=text.match(/^FAILED(?:\s+\(([^)]*)\))?/mu)?.[1]??'';
    const failed = Number(failureSummary.match(/failures=(\d+)/u)?.[1] ?? 0) + Number(failureSummary.match(/errors=(\d+)/u)?.[1] ?? 0);
    const expectedFailures = Number(text.match(/expected failures=(\d+)/u)?.[1] ?? 0);
    counts = {total, passed: Math.max(0, total - failed - skipped - expectedFailures), failed, skipped, cancelled: 0, todo: expectedFailures};
    if (total < 1) return {outcome: 'unrunnable', reason: 'NO_TEST_RESULTS', counts};
    return {outcome: run.exitCode !== 0 || failed || !/^OK(?:\s|$)/mu.test(text) ? 'failed' : skipped || expectedFailures ? 'skipped' : 'passed', counts};
  }
  const number = key => Number(text.match(new RegExp('(?:^|\\n)# ' + key + ' (\\d+)(?:\\r?\\n|$)', 'u'))?.[1] ?? 0);
  counts = {total: number('tests'), passed: number('pass'), failed: number('fail'), skipped: number('skipped'), cancelled: number('cancelled'), todo: number('todo')};
  return {outcome: run.exitCode !== 0 || counts.failed || counts.cancelled ? 'failed' : counts.total < 1 ? 'unrunnable' : counts.skipped || counts.todo ? 'skipped' : counts.passed < 1 ? 'unrunnable' : 'passed', counts, ...(counts.total < 1 ? {reason: 'NO_TEST_RESULTS'} : {})};
}
export function gateOutcome(results, {stale = false, dirty = false, unclassified = []} = {}) {
  if (stale || dirty) return 'stale';
  if (unclassified.length || results.some(row => row.outcome === 'unrunnable')) return 'unrunnable';
  if (results.some(row => row.outcome === 'failed')) return 'failed';
  if (results.some(row => row.outcome === 'skipped')) return 'skipped';
  return results.length && results.every(row => row.outcome === 'passed') ? 'passed' : 'unrunnable';
}
export function testEnvironment(source, serviceRoot) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'PLAYWRIGHT_BROWSERS_PATH', 'HARNESS_NATIVE_CLI', 'HARNESS_PLAYWRIGHT_MODULE', 'HARNESS_WEB_PUSH_MODULE', 'HARNESS_WRANGLER_CLI', 'HARNESS_BROWSER_CHANNEL', 'HARNESS_PYTHON', 'HARNESS_FIREWALL_TOOLS', 'HOMEAI_RUNTIME', 'EFFICIENCY_SDK_ROOT', 'NODE_PATH', 'PYTHONPATH'];
  const home=path.join(serviceRoot,'home');
  return {...Object.fromEntries(allowed.filter(name => source[name] !== undefined).map(name => [name, source[name]])),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),DSH_HOME:path.join(home,'.dsh'),XDG_CONFIG_HOME:path.join(home,'.config'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig'),GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:root, HOMEAI_ROOT: serviceRoot, CI: '1', PYTHONDONTWRITEBYTECODE: '1', WRANGLER_SEND_METRICS: 'false'};
}
const redact = value => value.replace(/https?:\/\/[^\s]+[?&](?:token|key|secret)=[^\s]*/giu, '[fixture authentication URL]').replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]');
async function packageVersion(directory) {try {return JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).version;} catch {return null;}}
async function dependencies(env,{requirePython=false}={}) {
  const expected = {node: '24.22.1', sdk: '0.2.2-rc.2', webPush: '3.6.7', playwright: '1.65.1', wrangler: '4.162.0',...(requirePython?{python:'3.12.12',zstandard:'0.25.0'}:{})};
  const actual = {node: process.versions.node, sdk: await packageVersion(path.join(env.HOMEAI_RUNTIME || root, 'node_modules/@deepseek-ai/dsh')),
    webPush: env.HARNESS_WEB_PUSH_MODULE ? await packageVersion(env.HARNESS_WEB_PUSH_MODULE) : null,
    playwright: env.HARNESS_PLAYWRIGHT_MODULE ? await packageVersion(env.HARNESS_PLAYWRIGHT_MODULE) : null,
    wrangler: env.HARNESS_WRANGLER_CLI ? await packageVersion(path.dirname(path.dirname(env.HARNESS_WRANGLER_CLI))) : null};
  if(requirePython){
    const code='import sys,json,importlib.metadata as m\ntry: codec=m.version("zstandard")\nexcept m.PackageNotFoundError: codec="stdlib" if sys.version_info>=(3,14) else None\nprint(json.dumps({"python":sys.version.split()[0],"zstandard":codec}))';
    const run=await runProgram([env.HARNESS_PYTHON||'python3','-c',code],{cwd:root,env,timeoutMs:10000,outputLimit:4096});
    try{Object.assign(actual,JSON.parse(run.stdout));}catch{Object.assign(actual,{python:null,zstandard:null});}
  }
  return {expected, actual, outcome: Object.entries(expected).every(([name, value]) => actual[name] === value) ? 'passed' : 'unrunnable'};
}
async function reproduceBundle(temporary, env, expectedSha256) {
  const replica = path.join(temporary, 'bundle-reproduction');
  for (const name of ['workspace/native-ui/build.cjs', 'workspace/native-ui/source.js', 'workspace/native-ui/theme.css', 'shared/i18n.cjs', 'shared/ui-copy.cjs', 'mobile/apps.js', 'workspace/client.js']) {
    const target = path.join(replica, name); await fs.mkdir(path.dirname(target), {recursive: true}); await fs.copyFile(path.join(root, name), target);
  }
  const run = await runProgram([process.execPath, 'workspace/native-ui/build.cjs'], {cwd: replica, env, timeoutMs: 15000, outputLimit: 32768});
  let actualSha256 = null;
  try {actualSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(replica, 'workspace/native-ui/client.js'))).digest('hex');} catch {}
  return {outcome: run.exitCode === 0 && !run.error && !run.timedOut && actualSha256 === expectedSha256 ? 'passed' : 'failed', expectedSha256, actualSha256, sourceChanged: false};
}
async function artifactDirectory(directory) {
  const files=[];
  async function walk(relative){for(const entry of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){const name=path.posix.join(relative,entry.name);if(entry.isSymbolicLink())throw Error('Unexpected artifact link');if(entry.isDirectory())await walk(name);else if(entry.isFile()){const data=await fs.readFile(path.join(directory,name));files.push({file:name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}if(files.length>100)throw Error('Artifact inventory exceeds limit');}}
  try{await walk('');}catch(error){if(error.code==='ENOENT')return null;throw error;}
  return files.sort((a,b)=>a.file.localeCompare(b.file));
}
async function git(args) {
  const result = await runProgram(['git', ...args], {cwd: root, timeoutMs: 15000, outputLimit: 4 * 1024 * 1024});
  if (result.exitCode !== 0 || result.error || result.timedOut || result.truncated) throw Error('Git source identity unavailable');
  return result.stdout;
}
async function identity() {
  const [commit, tree, status, names] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD^{tree}']), git(['status', '--porcelain', '--untracked-files=normal']), git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])]);
  const hash = crypto.createHash('sha256'), metadata=crypto.createHash('sha256'),unsafeSources=[],files = [...new Set(names.split('\0').filter(Boolean))].sort();
  for (const name of files) {
    const info=await fs.lstat(path.join(root,name),{bigint:true});
    metadata.update(name+'\0'+[info.dev,info.ino,info.size,info.mode,info.mtimeNs,info.ctimeNs].map(String).join(':')+'\0');
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n){unsafeSources.push(name);hash.update(name+'\0unsafe-source\0');continue;}
    const value = await fs.readFile(path.join(root, name));
    hash.update(name + '\0'); hash.update(value.includes(0) ? value : Buffer.from(value.toString('utf8').replaceAll('\r\n', '\n'))); hash.update('\0');
  }
  const bundle = unsafeSources.includes('workspace/native-ui/client.js')?null:await fs.readFile(path.join(root, 'workspace/native-ui/client.js'));
  return {commit: commit.trim(), tree: tree.trim(), dirty: !!status.trim(), files: files.length, sha256: hash.digest('hex'), metadataSha256:metadata.digest('hex'),unsafeSources,nativeBundleSha256: bundle?crypto.createHash('sha256').update(bundle).digest('hex'):null, definition: 'Sorted tracked and nonignored untracked paths; LF-normalized UTF-8 text, raw binary; exact committed tree and before/after file metadata recorded separately. Links/nonregular source are never followed.'};
}
export async function releaseCI({lane = 'all', output, inventoryOnly = false, allowDirty = false, env = process.env} = {}) {
  if (!['all', 'portable', 'linux-root', 'local-engine'].includes(lane)) throw Error('Unknown CI lane');
  if (!output || !path.isAbsolute(output)) throw Error('Use an absolute CI output directory outside the source checkout');
  const relative = path.relative(root, output);
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw Error('CI evidence must stay outside the source checkout');
  await fs.mkdir(output, {recursive: true, mode: 0o755});
  const startedAt = new Date().toISOString(), before = await identity(), sourceFiles=(await git(['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean),list = await inventory(root,{sourceFiles});
  await fs.writeFile(path.join(output, 'inventory.json'), JSON.stringify(list, null, 2));
  if (inventoryOnly) return {inventory: list, source: before};
  if (before.dirty && !allowDirty || before.unsafeSources.length) {
    const report={version:1,startedAt,finishedAt:new Date().toISOString(),lane,source:before,results:[],passed:false,outcome:before.unsafeSources.length?'unrunnable':'stale',reason:before.unsafeSources.length?'UNSAFE_SOURCE_ENTRY':'UNCOMMITTED_SOURCE',productionAcceptance:'pending'};
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));return report;
  }
  try {await fs.access('/data/harness/root-secrets/guard.json'); throw Error('CI refuses an existing production Harness host');} catch (error) {if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;}
  const serviceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'release-ci-service-')), childEnv = testEnvironment(env, serviceRoot);
  childEnv.HARNESS_NATIVE_EVIDENCE=path.join(output,'screenshots/native');childEnv.HARNESS_EDITOR_EVIDENCE=path.join(output,'screenshots/editor');
  const suites = list.entries.filter(row => row.required && row.kind !== 'unclassified' && (lane === 'all' || row.lane === lane)), results = [];
  let cursor = 0, dependencyAdmission, bundleReproduction;
  try {
    for(const directory of new Set(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','DSH_HOME','XDG_CONFIG_HOME'].map(name=>childEnv[name])))await fs.mkdir(directory,{recursive:true,mode:0o700});
    if(env.HARNESS_PYTHON)childEnv.HARNESS_PYTHON=env.HARNESS_PYTHON;
    dependencyAdmission=await dependencies(childEnv,{requirePython:suites.some(row=>row.kind==='python')});
    bundleReproduction=await reproduceBundle(serviceRoot,childEnv,before.nativeBundleSha256);
    await Promise.all(Array.from({length: 2}, async () => {
      while (cursor < suites.length) {
        const suite = suites[cursor++], log = suite.file.replaceAll('/', '__') + '.log', began = Date.now(); let result;
        if (suite.lane === 'linux-root' && (process.platform !== 'linux' || process.getuid?.() !== 0)) result = {outcome: 'unrunnable', reason: 'LINUX_ROOT_FIXTURE_REQUIRED', counts: null};
        else {
          const command = suite.kind === 'python' ? [env.HARNESS_PYTHON || 'python3', suite.file] : suite.kind === 'workerd' ? [process.execPath, suite.file] : [process.execPath, '--test', '--test-reporter=tap', '--test-timeout=120000', suite.file];
          const run = await runProgram(command, {cwd: root, env: {...childEnv,...suite.environment}, timeoutMs: suite.timeoutMs, outputLimit: 2 * 1024 * 1024});
          await fs.writeFile(path.join(output, log), redact(run.stdout + '\n[stderr]\n' + run.stderr));
          result = {...summary(suite.kind, run), exitCode: run.exitCode, timedOut: run.timedOut, truncated: run.truncated, log};
          if(suite.file==='workspace/native-ui/native.test.cjs')result.fixtureAssertion=nativeFixtureAssertion(run);
          if(result.outcome==='passed'&&suite.minTests&&!(result.counts?.total>=suite.minTests))result={...result,outcome:'unrunnable',reason:'REQUIRED_FIXTURE_NOT_EXECUTED'};
        }
        results.push({...suite, ...result, durationMs: Date.now() - began});
      }
    }));
  } finally {
    const resolved = await fs.realpath(serviceRoot), parent = await fs.realpath(os.tmpdir()), info = await fs.lstat(serviceRoot);
    if (info.isDirectory() && !info.isSymbolicLink() && path.dirname(resolved) === parent && path.basename(resolved).startsWith('release-ci-service-')) await fs.rm(resolved, {recursive: true, force: true});
  }
  results.sort((a, b) => a.file.localeCompare(b.file));
  const after = await identity(), stale = before.sha256 !== after.sha256 || before.metadataSha256!==after.metadataSha256||before.commit !== after.commit || before.nativeBundleSha256 !== after.nativeBundleSha256;
  const outcome = results.length ? gateOutcome([...results,dependencyAdmission,bundleReproduction], {stale, dirty: before.dirty || after.dirty, unclassified: list.unclassified}) : 'unrunnable';
  const report = {version: 1, startedAt, finishedAt: new Date().toISOString(), lane, platform: process.platform, arch:process.arch,kernel:os.release(),node: process.version, source: after, sourceBefore: before, stale, outcome, passed: outcome === 'passed', dependencyAdmission,bundleReproduction,workerArtifacts:await artifactDirectory(path.join(output,'worker-bundle')),productionAcceptance: 'pending separate live migration, hardware and application acceptance', results, excluded: list.entries.filter(row => !row.required), unclassified: list.unclassified,...(!results.length?{reason:'NO_SUITES_IN_SELECTED_LANE'}:{})};
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
export function combineReports(list,reports){
  const required=list.entries.filter(row=>row.required&&row.kind!=='unclassified'),expectedLanes=[...new Set(required.map(row=>row.lane))];
  const missingLanes=expectedLanes.filter(lane=>!reports.some(report=>report.lane===lane)),results=reports.flatMap(report=>report.results||[]),counts=new Map();
  for(const row of results)counts.set(row.file,(counts.get(row.file)||0)+1);
  const missingSuites=required.filter(row=>!counts.has(row.file)).map(row=>row.file),duplicateSuites=[...counts].filter(([,count])=>count!==1).map(([name])=>name);
  const source=reports.find(row=>row.source)?.source||null;
  const invalidEvidence=!source||reports.some(report=>!report.source||['commit','tree','sha256','metadataSha256','nativeBundleSha256'].some(name=>typeof report.source[name]!=='string'||!report.source[name])||report.source.dirty||report.stale)||results.some(row=>!required.some(expected=>expected.file===row.file&&expected.lane===row.lane));
  const stale=!!source&&reports.some(row=>!row.source||['commit','tree','sha256','metadataSha256','nativeBundleSha256'].some(name=>row.source[name]!==source[name]));
  const absent=missingLanes.length||missingSuites.length||duplicateSuites.length||!required.length||invalidEvidence;
  const outcome=stale?'stale':absent?'unrunnable':gateOutcome([...reports,...results],{unclassified:list.unclassified});
  return{version:1,outcome,passed:outcome==='passed',source,stale,missingLanes,missingSuites,duplicateSuites,results,lanes:reports.map(({lane,outcome,dependencyAdmission,bundleReproduction,platform,arch,kernel,node})=>({lane,outcome,dependencyAdmission,bundleReproduction,platform,arch,kernel,node})),excluded:list.entries.filter(row=>!row.required),unclassified:list.unclassified,productionAcceptance:'pending separate live migration, hardware and application acceptance'};
}
async function combineDirectory(output){
  await fs.mkdir(output,{recursive:true});
  let list;try{list=JSON.parse(await fs.readFile(path.join(output,'inventory.json'),'utf8'));}catch{
    const report={version:1,passed:false,outcome:'unrunnable',reason:'INVENTORY_UNAVAILABLE',source:null,results:[]};await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));return report;
  }
  const reports=[];
  for(const lane of [...new Set(list.entries.filter(row=>row.required&&row.kind!=='unclassified').map(row=>row.lane))])try{reports.push(JSON.parse(await fs.readFile(path.join(output,lane,'report.json'),'utf8')));}catch{}
  const report={...combineReports(list,reports),workerArtifacts:await artifactDirectory(path.join(output,'worker-bundle'))};
  if(!report.workerArtifacts?.length){report.passed=false;report.outcome='unrunnable';report.reason='WORKER_ARTIFACT_UNAVAILABLE';}
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));return report;
}
export function nativeFixtureAssertion(run) {
  const match=(run.stdout+'\n'+run.stderr).match(/(?:^|\n)(?:# )?HARNESS_NATIVE_ASSERTION: ([^\r\n]+)/u);
  if(!match)return null;
  try {const value=JSON.parse(match[1]);return typeof value==='string'?value.replace(/https?:\/\/[^\s]+/giu,'[fixture-url]').slice(0,2000):null;} catch {return null;}
}
export function failureAnnotations(report) {
  if (report.inventory || report.passed) return [];
  const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const property = value => escape(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
  const failures = (report.results || []).filter(row => row.outcome !== 'passed');
  const rows = failures.length ? failures : [{file: '.github/workflows/release-checks.yml', lane: report.lane || 'combined', outcome: report.outcome, reason: report.reason}];
  return rows.slice(0, 30).map(row => {
    const counts = row.counts ? `; failed=${row.counts.failed ?? 0}; skipped=${row.counts.skipped ?? 0}; cancelled=${row.counts.cancelled ?? 0}` : '';
    const reason = /^[A-Z0-9_]+$/.test(row.reason || '') ? `; ${row.reason}` : '';
    // Only structured metadata and an explicit isolated Native assertion are public.
    // Never copy arbitrary process logs or environment values.
    const message = `${row.lane || 'unknown'}: ${row.outcome || 'unrunnable'}${Number.isInteger(row.exitCode) ? '; exit=' + row.exitCode : ''}${counts}${reason}${row.fixtureAssertion ? '; '+row.fixtureAssertion : ''}`;
    return `::error file=${property(row.file)},line=1,title=Release check failed::${escape(message)}`;
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  (args.includes('--combine')?combineDirectory(value('--output')):releaseCI({lane: args.includes('--lane') ? value('--lane') : 'all', output: value('--output'), inventoryOnly: args.includes('--inventory'), allowDirty: args.includes('--allow-dirty')})).then(report => {
    for (const annotation of failureAnnotations(report)) console.error(annotation);
    console.log(JSON.stringify(report.inventory ? {inventoryOnly: true, files: report.inventory.entries.length, unclassified: report.inventory.unclassified, source: report.source} : {passed: report.passed, outcome: report.outcome, suites: report.results.length, source: report.source, report: path.join(value('--output'), 'report.json')}));
    if (!report.inventory) process.exitCode = report.passed ? 0 : 1;
  }).catch(error => {console.error(error.message); process.exitCode = 1;});
}
