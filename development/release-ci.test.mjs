import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {summary, gateOutcome, testEnvironment, combineReports, failureAnnotations, nativeFixtureAssertion} from './release-ci.mjs';
import {candidate, classify, inventory} from './ci/inventory.mjs';
const run = (stdout, extra = {}) => ({stdout, stderr: '', exitCode: 0, error: null, timedOut: false, truncated: false, aborted: false, ...extra});
const tap = '# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';

test('failed release suites produce escaped public annotations without process output or changing the gate',()=>{
  const report={passed:false,results:[{file:'vast/bad,\n%fixture.test.cjs',lane:'linux-root',outcome:'failed',exitCode:1,counts:{failed:2,skipped:0,cancelled:0},stdout:'PRIVATE_PROCESS_OUTPUT',stderr:'PRIVATE_ENV_VALUE'}]};
  const [line]=failureAnnotations(report);assert.match(line,/file=vast\/bad%2C%0A%25fixture.test.cjs/);assert.match(line,/linux-root: failed; exit=1; failed=2/);assert.equal(line.includes('\n'),false);assert.equal(line.includes('PRIVATE_'),false);assert.equal(report.passed,false);
  assert.deepEqual(failureAnnotations({...report,passed:true}),[]);assert.deepEqual(failureAnnotations({inventory:{},passed:false}),[]);
  assert.match(failureAnnotations({passed:false,outcome:'unrunnable',reason:'MISSING_LANE',results:[]})[0],/MISSING_LANE/);
});

test('combined evidence requires every suite exactly once, clean matching source and actual successful results',()=>{
  const entries=[{file:'a.test.mjs',lane:'portable',required:true,kind:'node'},{file:'b.test.cjs',lane:'linux-root',required:true,kind:'node'}],list={entries,unclassified:[]};
  const source={commit:'commit',tree:'tree',sha256:'source',metadataSha256:'metadata',nativeBundleSha256:'bundle',dirty:false};
  const reports=entries.map(row=>({lane:row.lane,source:{...source},outcome:'passed',results:[{...row,outcome:'passed'}]}));
  assert.equal(combineReports(list,reports).outcome,'passed');
  assert.equal(combineReports(list,reports.slice(0,1)).outcome,'unrunnable');
  assert.equal(combineReports(list,[...reports,reports[0]]).outcome,'unrunnable');
  assert.equal(combineReports(list,reports.map((row,index)=>index?{...row,source:{...source,sha256:'different'}}:row)).outcome,'stale');
  assert.equal(combineReports(list,reports.map(row=>({...row,source:{...source,dirty:true}}))).outcome,'unrunnable');
  assert.equal(combineReports(list,reports.map((row,index)=>index?{...row,results:[{...entries[1],outcome:'failed'}]}:row)).outcome,'failed');
  assert.equal(combineReports(list,reports.map(row=>({...row,source:{}}))).outcome,'unrunnable');
});

test('release evidence cannot pass from positive totals after nonzero exit, timeout or clipped output', () => {
  assert.equal(summary('node', run(tap)).outcome, 'passed');
  assert.equal(summary('node', run(tap, {exitCode: 1})).outcome, 'failed');
  assert.equal(summary('node', run(tap, {timedOut: true})).outcome, 'unrunnable');
  assert.equal(summary('node', run(tap, {truncated: true})).outcome, 'unrunnable');
  assert.equal(summary('node', run('')).outcome, 'unrunnable');
});
test('skipped/todo Node tests and Python expected failures remain distinct from successful execution', () => {
  assert.equal(summary('node', run(tap.replace('# pass 2', '# pass 1').replace('# skipped 0', '# skipped 1'))).outcome, 'skipped');
  assert.equal(summary('node', run(tap.replace('# pass 2', '# pass 1').replace('# todo 0', '# todo 1'))).outcome, 'skipped');
  assert.equal(summary('python', run('', {stderr: 'Ran 7 tests in 0.1s\n\nOK\n'})).outcome, 'passed');
  assert.equal(summary('python', run('', {stderr: 'Ran 7 tests in 0.1s\n\nOK (expected failures=1)\n'})).outcome, 'skipped');
  assert.equal(summary('python', run('', {stderr: 'Ran 0 tests in 0.1s\n\nOK\n'})).outcome, 'unrunnable');
});
test('workerd integration requires actual restart proof and successful process termination', () => {
  const result = JSON.stringify({passed: true, processRestartVerified: true, engine: 'actual local workerd'});
  assert.equal(summary('workerd', run(result)).outcome, 'passed');
  assert.equal(summary('workerd', run(result, {exitCode: 1})).outcome, 'failed');
  assert.equal(summary('workerd', run('{"passed":true}')).outcome, 'failed');
});
test('source changes, unknown test classification and unavailable suites cannot produce a green gate', () => {
  assert.equal(gateOutcome([{outcome: 'passed'}]), 'passed');
  assert.equal(gateOutcome([{outcome: 'passed'}], {stale: true}), 'stale');
  assert.equal(gateOutcome([{outcome: 'passed'}], {dirty: true}), 'stale');
  assert.equal(gateOutcome([{outcome: 'passed'}], {unclassified: ['new-check.cjs']}), 'unrunnable');
  assert.equal(gateOutcome([]), 'unrunnable');
});
test('discovery includes development, Python and new test directories while reporting helpers and historical fixtures explicitly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'release-ci-inventory-'));
  t.after(async () => {const real = await fs.realpath(root); assert.equal(path.dirname(real), await fs.realpath(os.tmpdir())); assert(path.basename(real).startsWith('release-ci-inventory-')); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(real, {recursive: true, force: true});});
  for (const name of ['development/new.test.mjs', 'mobile/test_notification_watcher.py', 'vast/startup-extract-tests.py', 'new-module/new.test.cjs', 'new-module/manual-check.cjs', 'workspace/native-ui/test-bundle.cjs', 'benchmarks/historical/challenge.test.cjs', 'node_modules/dependency/ignored.test.mjs']) {
    await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true}); await fs.writeFile(path.join(root, name), '');
  }
  const result = await inventory(root);
  assert.equal(result.entries.length, 7); assert.deepEqual(result.unclassified, ['new-module/manual-check.cjs']);
  assert.equal(result.entries.find(row => row.file.endsWith('test_notification_watcher.py')).kind, 'python');
  assert.equal(classify('vast/apps-context-linux-check.cjs').lane, 'linux-root');
  assert.equal(classify('workspace/runtime-admission-native.test.cjs').minTests, 2);
  for(const[file,min]of [['development/native-isolated-profile.test.mjs',12],['development/native-isolated-web.test.mjs',1]]){const row=classify(file);assert.equal(row.required,true);assert.equal(row.lane,'portable');assert.equal(row.timeoutMs,120000);assert.equal(row.minTests,min);}
  assert.equal(classify('deployments/test-worker-network.py').kind, 'helper');
  assert.equal(classify('deployments/worker-network-linux-check.cjs').lane, 'linux-root');
  const recovery=classify('vast/runtime-recovery.test.cjs');assert.equal(recovery.lane,'linux-root');assert.deepEqual(recovery.environment,{HARNESS_RUNTIME_RECOVERY_ROOT_TEST:'1'});assert.equal(recovery.minTests,12);
  for(const[file,flag,min]of [['workspace/runtime-admission.test.mjs','HARNESS_RUNTIME_ADMISSION_ROOT_TEST',9],['vast/runtime-admission-server.test.cjs','HARNESS_RUNTIME_ADMISSION_SERVER_ROOT_TEST',6],['vast/runtime-release-attestation.test.cjs','HARNESS_RUNTIME_RELEASE_ROOT_TEST',3]]){const row=classify(file);assert.equal(row.lane,'linux-root');assert.deepEqual(row.environment,{[flag]:'1'});assert.equal(row.minTests,min);}
  assert.equal(classify('workspace/native-ui/test-bundle.cjs').kind, 'helper');
  assert.equal(classify('deployments/apps-live-lifecycle-check.cjs').outcome, 'unrunnable');
  assert.equal(classify('deployments/apps-live-lifecycle-check.cjs').required, false);
  assert.equal(classify('benchmarks/historical/challenge.test.cjs').required, false);
  assert.equal(candidate('vast/startup-extract-tests.py'), true);
});
test('test subprocesses receive an isolated service root and no cloud/model/account credentials', () => {
  const env = testEnvironment({PATH: '/bin', HOMEAI_ROOT: '/data/harness', VAST_API_KEY: 'fixture', CLOUDFLARE_API_TOKEN: 'fixture', DEVICE_SIGNING_KEY: 'fixture', GITHUB_TOKEN: 'fixture', OPENAI_API_KEY: 'fixture', HARNESS_INTERNAL_KEY: 'fixture', HARNESS_NATIVE_CLI: '/pinned/cli.js',HOME:'/operator/private',USERPROFILE:'/operator/private',APPDATA:'/operator/private',LOCALAPPDATA:'/operator/private',DSH_HOME:'/operator/private',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraheader',GIT_CONFIG_VALUE_0:'Authorization: private-fixture',HARNESS_PYTHON:'/pinned/python'}, '/tmp/owned-service');
  assert.equal(env.HOMEAI_ROOT, '/tmp/owned-service'); assert.equal(env.HARNESS_NATIVE_CLI, '/pinned/cli.js');
  for (const key of ['VAST_API_KEY', 'CLOUDFLARE_API_TOKEN', 'DEVICE_SIGNING_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'HARNESS_INTERNAL_KEY']) assert.equal(key in env, false);
  for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','DSH_HOME','XDG_CONFIG_HOME'])assert.equal(path.relative('/tmp/owned-service',env[key]).startsWith('..'),false);
  assert.equal(env.GIT_CONFIG_KEY_0,'safe.directory');assert.equal(env.GIT_CONFIG_COUNT,'1');assert.notEqual(env.GIT_CONFIG_VALUE_0,'Authorization: private-fixture');assert.equal(env.GIT_CONFIG_GLOBAL,path.join(env.HOME,'.gitconfig'));assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(env.HARNESS_PYTHON,'/pinned/python');
});

test('an actual Git child cannot recover operator global headers through inherited home or config variables',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'release-ci-private-home-'));
  t.after(async()=>{const real=await fs.realpath(directory);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));assert(path.basename(real).startsWith('release-ci-private-home-'));assert.equal((await fs.lstat(directory)).isSymbolicLink(),false);await fs.rm(real,{recursive:true,force:true});});
  const operator=path.join(directory,'operator'),service=path.join(directory,'service');await fs.mkdir(operator);await fs.writeFile(path.join(operator,'.gitconfig'),'[http]\nextraheader = PRIVATE_FIXTURE_HEADER\n');
  const env=testEnvironment({...process.env,HOME:operator,USERPROFILE:operator,GIT_CONFIG_GLOBAL:path.join(operator,'.gitconfig'),GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraheader',GIT_CONFIG_VALUE_0:'PRIVATE_FIXTURE_HEADER'},service);
  await fs.mkdir(env.HOME,{recursive:true,mode:0o700});
  const run=spawnSync('git',['config','--get','http.extraheader'],{cwd:directory,env,encoding:'utf8',windowsHide:true});
  assert.equal(run.error,undefined);assert.equal(run.status,1,run.stderr);assert.equal(run.stdout,'');
});

test('Native fixture annotations accept only their explicit JSON marker and redact fixture URLs',()=>{
 const detail=nativeFixtureAssertion(run('# HARNESS_NATIVE_ASSERTION: '+JSON.stringify('Expected visible\nhttps://fixture.test/?token=PRIVATE_VALUE % detail')));
 assert.equal(detail,'Expected visible\n[fixture-url] % detail');
 assert.equal(nativeFixtureAssertion(run('arbitrary PRIVATE_PROCESS_OUTPUT')),null);
 assert.equal(nativeFixtureAssertion(run('# HARNESS_NATIVE_ASSERTION: {bad json}')),null);
 assert.equal(nativeFixtureAssertion(run('# HARNESS_NATIVE_ASSERTION: {}')),null);
 const [line]=failureAnnotations({passed:false,results:[{file:'workspace/native-ui/native.test.cjs',outcome:'failed',fixtureAssertion:detail}]});
 assert.match(line,/Expected visible%0A\[fixture-url\] %25 detail/);assert.equal(line.includes('PRIVATE_VALUE'),false);assert.equal(line.includes('\n'),false);
});
