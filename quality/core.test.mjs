import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyProject, runProgram, validateContract, confined, parseTestCounts, compactReport} from './core.mjs';
import {validatePlan, resolveBaseURL, verifyBrowser} from './browser.mjs';
import {executeVerification, apply} from './plugin.mjs';
import {createHash} from 'node:crypto';
import {createProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
import {inspectBrowserServer} from './browser-server-inspect.mjs';
function hostMode(){const policy={version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)},policySha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'),snapshot={...policy,policySha256,sourceCommit:'a'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'};return createProjectExecutionMode({snapshot,assertUnchanged:()=>snapshot}).service;}

const command = code => [process.execPath, '-e', code];
async function project(t, checks, requiredKinds = ['test']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.writeFile(path.join(root, 'source.txt'), 'version1');
  await fs.writeFile(path.join(root, '.harness-quality.json'), JSON.stringify({version:1,sources:['source.txt'],requiredKinds,checks}));
  return root;
}
const passing = {id:'tests',kind:'test',command:command("console.log('# pass 3\\n# fail 0')")};

test('browser failure detail survives missing screenshot evidence without passing verification', async t => {
  const root = await project(t, [{id:'ui',kind:'browser',plan:'plan.json'}], ['browser']);
  await fs.writeFile(path.join(root,'plan.json'), '{}');
  const report = await verifyProject({workspace:root,run:async (_command,{env})=>{
    await fs.writeFile(path.join(root,'.harness/quality/ui-browser.json'),JSON.stringify({
      runId:env.HARNESS_QUALITY_RUN_ID,engine:'chromium',passed:0,failed:1,screenshots:[],
      results:[{passed:false,code:'BROWSER_FLOW_FAILED',detail:'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:21000/'}],
    }));
    return {exitCode:1,stdout:'',stderr:''};
  }});
  assert.equal(report.passed,false);assert.equal(report.complete,false);
  assert.equal(report.results[0].checksPassed,0);
  assert(report.results[0].diagnostics.some(x=>x.includes('ERR_CONNECTION_REFUSED')),JSON.stringify(report));
  assert(report.results[0].diagnostics.includes('BROWSER_EVIDENCE_MISSING'));
  assert.equal(report.results[0].artifactPaths.filter(x=>x.endsWith('.png')).length,0);
});

test('explicit browser server fails closed outside managed SDK control and validates exact assigned endpoint',async t=>{
  const root=await project(t,[{id:'ui',kind:'browser',plan:'plan.json',server:{command:['node','server.mjs']}}],['browser']);
  const plan={version:1,baseURL:'http://127.0.0.1:${PORT}',viewports:[{name:'desktop',width:800,height:600}],flows:[{name:'start',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',textIncludes:'ready'},{action:'checkpoint',name:'ready'}]}]};
  await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan));let runs=0;
  const report=await verifyProject({workspace:root,run:async()=>{runs++;throw Error('No unmanaged browser');}});
  assert.equal(runs,0);assert.equal(report.complete,false);assert(report.results[0].diagnostics.includes('BROWSER_SERVER_CHANNEL_UNAVAILABLE'));
  const env={PORT:'21000',HARNESS_QUALITY_ALLOWED_PORTS:'21000,21001,21002,21003'};
  const inspected=await inspectBrowserServer({workspace:root,contractPath:'.harness-quality.json',checkId:'ui',env});assert.equal(inspected.port,21000);assert.deepEqual(inspected.server.command,['node','server.mjs']);
  await assert.rejects(inspectBrowserServer({workspace:root,contractPath:'.harness-quality.json',checkId:'ui',env:{PORT:'22000',HARNESS_QUALITY_ALLOWED_PORTS:'21000'}}),{code:'UNASSIGNED_PORT'});
  plan.baseURL='http://localhost:${PORT}';await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan));
  await assert.rejects(inspectBrowserServer({workspace:root,contractPath:'.harness-quality.json',checkId:'ui',env}),{code:'BROWSER_SERVER_IPV4_REQUIRED'});
  assert.throws(()=>validateContract({version:1,sources:['source.txt'],requiredKinds:['test'],checks:[{...passing,server:{command:['node','server.mjs']}}]}),{code:'INVALID_BROWSER_SERVER'});
});

test('quality uses the same bounded Node directory compatibility and retains setup versus test-body failures', async t => {
  const workspace = await project(t, [{ id: 'api', kind: 'test', command: [process.execPath, '--test', 'test/'] }]);
  await fs.mkdir(path.join(workspace, 'test'));
  const target = path.join(workspace, 'test/bootstrap.test.mjs');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  await fs.writeFile(target, "throw new TypeError('root path required');\n");
  const bootstrap = await verifyProject({ workspace, env }); assert.equal(bootstrap.passed, false); assert.equal(bootstrap.results[0].category, 'setup', await fs.readFile(path.join(workspace, '.harness/quality/api.log'), 'utf8'));
  assert.equal(compactReport(bootstrap).checks[0].diagnosticCode, 'TEST_BOOTSTRAP_FAILURE');
  await fs.writeFile(target, "import test from 'node:test';test('actual behavior',()=>{throw new TypeError('root path required')});\n");
  const actual = await verifyProject({ workspace, env }); assert.equal(actual.passed, false); assert.equal(actual.results[0].category, 'verification');
});

test('real exit code overrides printed success; zero assertions cannot pass', async t => {
  for (const [code, diagnostic] of [["console.log('# pass 4\\n# fail 0');process.exitCode=7",'EXIT_7'],["console.log('# pass 0\\n# fail 0')",'NO_POSITIVE_CHECKS']]) {
    const workspace = await project(t,[{...passing,command:command(code)}]);
    const r = await verifyProject({workspace});
    assert.equal(r.passed,false); assert.ok(r.results[0].diagnostics.includes(diagnostic));
  }
});

test('real Node output without numeric totals is marked unmeasured; canonical all-fail totals remain measurable',async t=>{
 const workspace=await project(t,[{id:'core',kind:'test',command:[process.execPath,'--test','--test-reporter=./compact.mjs','core.test.mjs']}]);
 await fs.writeFile(path.join(workspace,'core.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';for(let n=0;n<2;n++)test('real failure '+n,()=>assert.equal(n,-1));");
 await fs.writeFile(path.join(workspace,'compact.mjs'),"export default async function*(events){for await(const event of events)if(event.type==='test:pass'||event.type==='test:fail')yield (event.type==='test:pass'?'✔':'✖')+' case\\n';}");
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const missing=await verifyProject({workspace,env});assert.equal(missing.passed,false);assert.equal(missing.results[0].exitCode,1);assert.equal(missing.results[0].countsMeasured,false);assert.equal(compactReport(missing).checks[0].countsMeasured,false);
 assert.equal(missing.results[0].checksTotal,1,'legacy placeholder remains a failure, never measured progress');
 const contract=JSON.parse(await fs.readFile(path.join(workspace,'.harness-quality.json'),'utf8'));contract.checks[0].command=[process.execPath,'--test','--test-reporter=tap','core.test.mjs'];await fs.writeFile(path.join(workspace,'.harness-quality.json'),JSON.stringify(contract));
 const measured=await verifyProject({workspace,env});assert.equal(measured.passed,false);assert.equal(measured.results[0].exitCode,1);assert.equal(measured.results[0].checksTotal,2);assert.equal(measured.results[0].checksPassed,0);assert.equal(compactReport(measured).checks[0].countsMeasured,true);
});
test('partial stage differs from full completion', async t => {
  const workspace = await project(t,[passing,{id:'build',kind:'build',command:command('process.exit(0)')}],['test','build']);
  const partial = await verifyProject({workspace,kind:'test'});
  assert.equal(partial.passed,true); assert.equal(partial.complete,false); assert.deepEqual(partial.missingKinds,['build']);
  const all = await verifyProject({workspace}); assert.equal(all.complete,true);
});

test('a partial test stage does not require a future browser plan but cannot complete the project', async t => {
  const workspace = await project(t,[passing,{id:'browser',kind:'browser',plan:'plans/browser.json'}],['test','browser']);
  const partial = await verifyProject({workspace,kind:'test'});
  assert.equal(partial.passed,true); assert.equal(partial.complete,false);
  assert.deepEqual(partial.verifiedKinds,['test']); assert.deepEqual(partial.missingKinds,['browser']);
  let launched = 0; const run = async () => { launched++; throw Error('Missing plans must fail before execution'); };
  for (const kind of ['browser','all']) await assert.rejects(verifyProject({workspace,kind,run}),e=>e.code==='ENOENT');
  assert.equal(launched,0);
  // Failed preflights release the lock and never replace the successful partial report.
  const latest = JSON.parse(await fs.readFile(path.join(workspace,'.harness/quality/latest.json'),'utf8'));
  assert.equal(latest.runId,partial.runId); assert.equal(latest.complete,false);
  assert.equal((await verifyProject({workspace,kind:'test'})).passed,true);
});

test('unselected browser plans retain traversal and symlink protection without requiring their files', async t => {
  const workspace = await project(t,[passing,{id:'browser',kind:'browser',plan:'../outside.json'}],['test','browser']);
  let launched = 0; const run = async () => { launched++; throw Error('Unsafe paths must fail before execution'); };
  await assert.rejects(verifyProject({workspace,kind:'test',run}),e=>e.code==='OUTSIDE_PROJECT');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(),'quality-outside-'));
  t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await fs.symlink(outside,path.join(workspace,'linked'),process.platform==='win32'?'junction':'dir');
  const file = path.join(workspace,'.harness-quality.json'),contract=JSON.parse(await fs.readFile(file,'utf8'));
  contract.checks[1].plan='linked/missing.json';await fs.writeFile(file,JSON.stringify(contract));
  await assert.rejects(verifyProject({workspace,kind:'test',run}),e=>e.code==='SYMLINK_REFUSED');
  assert.equal(launched,0);
});
test('source mutation makes a passing test stale', async t => {
  const workspace = await project(t,[{...passing,command:command("require('fs').writeFileSync('source.txt','changed');console.log('# pass 1\\n# fail 0')")}]);
  const r = await verifyProject({workspace}); assert.equal(r.stale,true); assert.equal(r.passed,false);
});
test('old structured evidence is rejected even after successful command', async t => {
  const workspace = await project(t,[{...passing,resultFile:'evidence.json'}]);
  await fs.writeFile(path.join(workspace,'evidence.json'),JSON.stringify({runId:'old',passed:5,failed:0}));
  const r = await verifyProject({workspace}); assert.equal(r.passed,false); assert.ok(r.results[0].diagnostics.includes('STALE_EVIDENCE'));
});
test('timeout terminates a real process and preserves failure', async t => {
  const workspace = await project(t,[{...passing,timeoutMs:150,command:command('setInterval(()=>{},1000)')}]);
  const r = await verifyProject({workspace}); assert.equal(r.passed,false); assert.ok(r.results[0].diagnostics.includes('CHECK_TIMEOUT'));
});
test('cancellation releases project lock', async t => {
  const workspace = await project(t,[passing]); const controller = new AbortController();
  await assert.rejects(verifyProject({workspace,signal:controller.signal,run:async()=>{controller.abort(Error('stop'));return {aborted:true};}}),/stop/);
  assert.equal((await verifyProject({workspace})).passed,true);
});
test('concurrent verifications cannot overwrite evidence', async t => {
  const workspace = await project(t,[passing]); let release, entered;
  const started = new Promise(r=>entered=r), wait = new Promise(r=>release=r);
  const first = verifyProject({workspace,run:async()=>{entered();await wait;return {exitCode:0,stdout:'# pass 1\n# fail 0',stderr:''};}});
  await started;
  await assert.rejects(verifyProject({workspace}),e=>e.code==='VERIFICATION_BUSY');
  release(); assert.equal((await first).passed,true);
});
test('bounded noisy output retains final counts without a false failure', async t => {
  const workspace = await project(t,[{...passing,command:command("console.log('x'.repeat(100000));console.log('# pass 2\\n# fail 0')")}]);
  const r = await verifyProject({workspace}); assert.equal(r.passed,true); assert.equal(r.results[0].outputTruncated,true);
  assert.ok((await fs.stat(path.join(workspace,'.harness/quality/tests.log'))).size < 140000);
});
test('path escape, shell masking and missing required checks are refused', async t => {
  const workspace = await project(t,[passing]);
  await assert.rejects(confined(workspace,'../outside'),e=>e.code==='OUTSIDE_PROJECT');
  assert.throws(()=>validateContract({version:1,sources:['.'],requiredKinds:['test'],checks:[{...passing,command:['sh','-c','false | cat']}]}),e=>e.code==='SHELL_REFUSED');
  assert.throws(()=>validateContract({version:1,sources:['.'],requiredKinds:['browser'],checks:[passing]}),e=>e.code==='MISSING_REQUIRED_CHECK');
});
test('test summary parsers cover prepared runtimes',()=>{
  assert.deepEqual(parseTestCounts('# pass 12\n# fail 0'),{passed:12,failed:0});
  assert.deepEqual(parseTestCounts('Passed: 8, Failed: 1'),{passed:8,failed:1});
  assert.deepEqual(parseTestCounts('3 passed in 0.2s'),{passed:3,failed:0});
  assert.equal(parseTestCounts('all fine'),null);
});
test('browser plan cannot silently ignore misspelled expectations or use foreign ports',()=>{
  const plan={version:1,baseURL:'http://127.0.0.1:4000',viewports:[{name:'mobile',width:390,height:844}],flows:[{name:'shop',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',minCount:1},{action:'checkpoint',name:'catalog'}]}]};
  assert.equal(validatePlan(plan),plan);
  assert.throws(()=>validatePlan({...plan,flows:[{name:'shop',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',minCount:1,textInclude:'Hello'},{action:'checkpoint',name:'x'}]}]}),e=>e.code==='INVALID_BROWSER_ACTION');
  assert.throws(()=>resolveBaseURL(plan.baseURL,{HARNESS_QUALITY_ALLOWED_PORTS:'5000'}),e=>e.code==='UNASSIGNED_PORT');
  assert.throws(()=>resolveBaseURL('https://example.com',{}),e=>e.code==='INVALID_BROWSER_URL');
  assert.throws(()=>validatePlan({...plan,flows:[{name:'empty',steps:[{action:'checkpoint',name:'empty'}]}]}),e=>e.code==='EMPTY_BROWSER_FLOW');
});

function pluginContext({stale=false,exitCode=0}={}) {
  const root=path.resolve('managed-project'), events=[], specs=[]; let reviews=0;
  const report={passed:true,complete:true,stale:false,checks:[{passed:true,checksPassed:4,checksTotal:4,artifactPaths:[]}]};
  const ctx={projectExecutionMode:hostMode(),waterfall:async()=>({root,sourceHash:stale && reviews++ ? 'new' : 'original',ports:[4000]}),serial:async(name,value)=>events.push({name,value}),shellEnv:{collect:()=>({DSH_APP_PORT:'4000'})},shell:{sandboxMode:'workspace-write',resolve:s=>{specs.push(s);return s;},execute:async()=>({result:async()=>({exitCode,stdout:{text:JSON.stringify(report)}})})}};
  return {ctx,root,events,specs,execution:{agent:{session:{id:'fixture'}},signal:new AbortController().signal}};
}
test('plugin uses managed root and native confinement and reports once',async()=>{
  const f=pluginContext(); const r=await executeVerification(f.ctx,{},f.execution);
  assert.equal(r.complete,true); assert.deepEqual(f.specs[0].sandboxPolicy,{mode:'workspace-write',workspaceRoot:f.root});
  assert.equal(f.specs[0].workdir,f.root); assert.deepEqual(f.specs[0].dshEnv,{DSH_APP_PORT:'4000'});
  assert.equal(f.events.length,1); assert.equal(f.events[0].value.sourceHash,'original'); assert.equal(f.events[0].value.checksTotal,4);
});

test('unavailable optional server control preserves existing verification checks',async()=>{
  const f=pluginContext(),waterfall=f.ctx.waterfall;
  f.ctx.waterfall=async(name,...args)=>{if(name==='workspace-runtime/browser-server-channel')throw Object.assign(Error('No private transport'),{code:'BROWSER_SERVER_CHANNEL_UNAVAILABLE'});return waterfall(name,...args);};
  const report=await executeVerification(f.ctx,{},f.execution);assert.equal(report.complete,true);assert.equal(f.events.length,1);assert.equal(f.specs[0].stdin,undefined);
});
test('native tool definition uses a concurrency callback',()=>{
  let definition;apply({projectExecutionMode:hostMode(),tools:{register:tool=>{definition=tool;}}});
  assert.equal(definition.name,'verify_project');assert.equal(definition.isConcurrencySafe({}),false);
});

test('automatic verifier retains only its actual handle before awaiting foreground completion',async()=>{
 const f=pluginContext();f.execution.callId='automatic-review-11111111-1111-4111-8111-111111111111';let release,registered=false,finished=false;
 const done=new Promise(resolve=>release=resolve),handle={done,kill(){release();return true;},async result(){await done;finished=true;return{exitCode:0,stdout:{text:JSON.stringify({passed:true,complete:true,stale:false,checks:[{id:'unit',kind:'test',passed:true,checksPassed:1,checksTotal:1}]})}};}};
 f.ctx.shell.execute=async()=>handle;
 f.ctx.serial=async(name,value)=>{if(name==='workspace-runtime/verification-process'){assert.equal(value.process,handle);assert.equal(value.projectRoot,f.root);assert.equal(value.sourceHash,'original');assert.equal(value.execution,f.execution);assert.equal(finished,false);registered=true;release();}else f.events.push({name,value});};
 const result=await executeVerification(f.ctx,{},f.execution);assert.equal(registered,true);assert.equal(finished,true);assert.equal(result.passed,true);assert.equal(f.events.length,1);
});
test('failed handle registration kills and drains only that verifier and cannot report a pass',async()=>{
 const f=pluginContext();f.execution.callId='automatic-review-11111111-1111-4111-1111-111111111111';let release,killed=0,drained=false;
 const done=new Promise(resolve=>release=resolve),handle={done,kill(){killed++;drained=true;release();return true;},async result(){await done;return{exitCode:1,stdout:{text:'{}'}};}};
 f.ctx.shell.execute=async()=>handle;f.ctx.serial=async(name,value)=>{if(name==='workspace-runtime/verification-process')throw Error('Synthetic registration failure');f.events.push({name,value});};
 const result=await executeVerification(f.ctx,{},f.execution);assert.equal(killed,1);assert.equal(drained,true);assert.equal(result.passed,false);assert.equal(result.code,'QUALITY_RUNNER_FAILED');
});
test('plugin invalidates changed source and nonzero native exits',async()=>{
  for(const options of [{stale:true},{exitCode:7}]) {const f=pluginContext(options);const r=await executeVerification(f.ctx,{},f.execution);assert.equal(r.passed,false);assert.equal(r.complete,false);assert.equal(f.events[0].value.exitCode,1);}
});
test('plugin refuses unmanaged projects without executing commands',async()=>{
  const f=pluginContext();f.ctx.waterfall=async()=>undefined;
  assert.equal((await executeVerification(f.ctx,{},f.execution)).code,'NO_MANAGED_PROJECT');assert.equal(f.specs.length,0);
});
test('plugin refuses legacy shared projects without executing commands',async()=>{
  const f=pluginContext();const original=f.ctx.waterfall;f.ctx.waterfall=async(...args)=>({...await original(...args),legacy:true});
  assert.equal((await executeVerification(f.ctx,{},f.execution)).code,'NO_MANAGED_PROJECT');assert.equal(f.specs.length,0);
});
test('manager rejection is returned as failed evidence, never a pass',async()=>{
  const f=pluginContext();f.ctx.serial=async()=>{throw Object.assign(Error('Source changed before acceptance'),{code:'STALE_VERIFICATION'});};
  const r=await executeVerification(f.ctx,{},f.execution);assert.equal(r.complete,false);assert.equal(r.passed,false);assert.equal(r.code,'STALE_VERIFICATION');
});
test('malformed native runner output cannot earn a manager pass',async()=>{
  const f=pluginContext();f.ctx.shell.execute=async()=>({result:async()=>({exitCode:0,stdout:{text:'not JSON'}})});
  const r=await executeVerification(f.ctx,{},f.execution);assert.equal(r.passed,false);assert.equal(f.events[0].value.exitCode,1);
});
test('unavailable Chromium produces failure with no invented screenshots',async t=>{
  const workspace=await project(t,[passing]);
  await fs.writeFile(path.join(workspace,'plan.json'),JSON.stringify({version:1,baseURL:'http://127.0.0.1:4000',viewports:[{name:'mobile',width:390,height:844}],flows:[{name:'shop',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',minCount:1},{action:'checkpoint',name:'catalog'}]}]}));
  const r=await verifyBrowser({workspace,planPath:'plan.json',outputPath:'.harness/quality/browser.json',runId:'missing',env:{},chromium:{launch:async()=>{throw Error('Chromium absent');}}});
  assert.equal(r.passed,0);assert.equal(r.failed,1);assert.deepEqual(r.screenshots,[]);
});
