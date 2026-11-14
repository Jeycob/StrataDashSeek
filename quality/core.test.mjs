import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyProject, runProgram, validateContract, confined, parseTestCounts} from './core.mjs';
import {validatePlan, resolveBaseURL, verifyBrowser} from './browser.mjs';
import {executeVerification, apply} from './plugin.mjs';

const command = code => [process.execPath, '-e', code];
async function project(t, checks, requiredKinds = ['test']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  await fs.writeFile(path.join(root, 'source.txt'), 'version1');
  await fs.writeFile(path.join(root, '.harness-quality.json'), JSON.stringify({version:1,sources:['source.txt'],requiredKinds,checks}));
  return root;
}
const passing = {id:'tests',kind:'test',command:command("console.log('# pass 3\\n# fail 0')")};

test('real exit code overrides printed success; zero assertions cannot pass', async t => {
  for (const [code, diagnostic] of [["console.log('# pass 4\\n# fail 0');process.exitCode=7",'EXIT_7'],["console.log('# pass 0\\n# fail 0')",'NO_POSITIVE_CHECKS']]) {
    const workspace = await project(t,[{...passing,command:command(code)}]);
    const r = await verifyProject({workspace});
    assert.equal(r.passed,false); assert.ok(r.results[0].diagnostics.includes(diagnostic));
  }
});
test('partial stage differs from full completion', async t => {
  const workspace = await project(t,[passing,{id:'build',kind:'build',command:command('process.exit(0)')}],['test','build']);
  const partial = await verifyProject({workspace,kind:'test'});
  assert.equal(partial.passed,true); assert.equal(partial.complete,false); assert.deepEqual(partial.missingKinds,['build']);
  const all = await verifyProject({workspace}); assert.equal(all.complete,true);
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
  const ctx={waterfall:async()=>({root,sourceHash:stale && reviews++ ? 'new' : 'original',ports:[4000]}),serial:async(name,value)=>events.push({name,value}),shellEnv:{collect:()=>({DSH_APP_PORT:'4000'})},shell:{sandboxMode:'workspace-write',resolve:s=>{specs.push(s);return s;},execute:async()=>({result:async()=>({exitCode,stdout:{text:JSON.stringify(report)}})})}};
  return {ctx,root,events,specs,execution:{agent:{session:{id:'fixture'}},signal:new AbortController().signal}};
}
test('plugin uses managed root and native confinement and reports once',async()=>{
  const f=pluginContext(); const r=await executeVerification(f.ctx,{},f.execution);
  assert.equal(r.complete,true); assert.deepEqual(f.specs[0].sandboxPolicy,{mode:'workspace-write',workspaceRoot:f.root});
  assert.equal(f.specs[0].workdir,f.root); assert.deepEqual(f.specs[0].dshEnv,{DSH_APP_PORT:'4000'});
  assert.equal(f.events.length,1); assert.equal(f.events[0].value.sourceHash,'original'); assert.equal(f.events[0].value.checksTotal,4);
});
test('native tool definition uses a concurrency callback',()=>{
  let definition;apply({tools:{register:tool=>{definition=tool;}}});
  assert.equal(definition.name,'verify_project');assert.equal(definition.isConcurrencySafe({}),false);
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
