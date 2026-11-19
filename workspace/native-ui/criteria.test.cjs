'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {createSourceFixture} = require('./test-bundle.cjs');

test('Native Run review distinguishes current, failed, missing and stale criteria after an actual one-check rerun', {timeout:90000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli, 'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-native-criteria-'));
 let child, browser, exited;
 try {
  const project = path.join(directory, 'project');
  await fs.mkdir(path.join(project,'.harness','quality'),{recursive:true});
  const write = (file, data) => fs.writeFile(path.join(project,file),data);
  const contract = {
   version:1, sources:['source.txt'], requiredKinds:['test','build'],
   checks:[
    {id:'result',kind:'test',command:[process.execPath,'-e',"console.log('# pass 1\\n# fail 0')"]},
    {id:'input',kind:'test',command:[process.execPath,'-e',"console.log('# pass 1\\n# fail 0')"]},
    {id:'button',kind:'test',command:[process.execPath,'-e',[
     "const ok = require('node:fs').readFileSync('source.txt','utf8') === 'fixed';",
     "console.log(ok ? '# pass 1\\n# fail 0' : '# pass 0\\n# fail 1'); process.exitCode = ok ? 0 : 1;",
    ].join(' ')]},
    {id:'package',kind:'build',command:[process.execPath,'-e',"console.log('built')"]},
   ],
   criteria:[
    {id:'visible',text:'The user can see the saved result.',checkIds:['result']},
    {id:'interaction',text:'Input and action both work.',checkIds:['input','button']},
    {id:'delivery',text:'The project can be packaged.',checkIds:['package']},
   ],
  };
  await write('source.txt','broken');
  await write('.harness-quality.json',JSON.stringify(contract));
  const [{WorkspaceManager},{RepairBudget},{hostExecutionBinding},{createProjectExecutionMode},{executeVerification},{runProgram}] =
   await Promise.all([import('../manager.mjs'),import('../policy.mjs'),import('../fixtures/execution-binding.mjs'),
    import('../execution-mode-service.mjs'),import('../../quality/plugin.mjs'),import('../../quality/core.mjs')]);

  const seed = path.join(directory,'seed'), sessionFile = path.join(directory,'session.json');
  await fs.mkdir(seed);
  await fs.writeFile(path.join(seed,'package.json'),JSON.stringify({name:'criteria-fixture',type:'module',
   exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));
  await fs.writeFile(path.join(seed,'index.mjs'),[
   "import {writeFileSync} from 'node:fs';",
   "export const inject=['sessions'];",
   "export function apply(ctx){",
   " const session=ctx.sessions.create(undefined,{meta:{cwd:"+JSON.stringify(project)+"}});",
   " writeFileSync("+JSON.stringify(sessionFile)+",JSON.stringify(session.id));",
   "}",
  ].join('\n'));
  await fs.writeFile(path.join(seed,'client.js'),
   "window.__ModuleLoader__.load({id:'criteria-fixture',factory:()=>({apply(){window.criteriaFixtureReady=true;}})});");
  const overlay = path.join(directory,'overlay.json');
  await fs.writeFile(overlay,JSON.stringify([
   {id:'ui-settings-models',config:{credentialOnboarding:false}},
   {insert:[{id:'criteria-workbench',name:pathToFileURL(createSourceFixture(directory)).href},
    {id:'criteria-fixture',name:pathToFileURL(path.join(seed,'index.mjs')).href}]},
  ]));
  child = spawn(process.execPath,[cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{
   cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home')},stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  exited = once(child,'close');
  let output='', url;
  child.stdout.on('data',chunk=>output+=chunk);
  child.stderr.on('data',chunk=>output+=chunk);
  const deadline = Date.now()+30000;
  while (!(url=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0])) {
   if(child.exitCode!==null||Date.now()>=deadline)throw Error('Native criteria fixture failed to start: '+output.slice(-1500));
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const sessionId=JSON.parse(await fs.readFile(sessionFile,'utf8'));
  const agent={id:sessionId,session:{id:sessionId,header:{cwd:project}}};
  const workspaces=[{id:'criteria-ws',title:'Criteria fixture',sessionIds:[sessionId],settings:{}}];
  const binding=hostExecutionBinding();
  const manager=new WorkspaceManager({agents:{get:id=>id===sessionId?agent:undefined},
   workspaceRegistry:{list:()=>workspaces},logger:{warn(){}}},{stateRoot:path.join(project,'.harness/state')},binding);
  const record={root:project,budget:{stage:1,steps:0}};
  manager.data={sessions:{[sessionId]:record},workspaces:{},trash:{}};
  manager.budgets.set(sessionId,new RepairBudget());
  const runner=path.resolve(__dirname,'../../quality/cli.mjs');
  let sequence=0;
  async function verify(args) {
   const execution={agent,signal:AbortSignal.timeout(15000),name:'verify_project',callId:'fixture-'+(++sequence)};
   const ctx={projectExecutionMode:createProjectExecutionMode(binding).service,
    async waterfall(name){if(name==='workspace-runtime/review')return manager.review(sessionId,{includeSourceSnapshot:true});},
    serial:(name,data)=>{assert.equal(name,'workspace-runtime/verification');return manager.reportVerification(data);},
    shellEnv:{collect:()=>({})},
    shell:{sandboxMode:'workspace-write',resolve:spec=>spec,async execute(spec){
     const kind=spec.command.match(/'--kind' '([a-z]+)'/)?.[1];
     const checkId=spec.command.match(/'--check-id' '([a-z]+)'$/)?.[1];
     assert.equal(kind,args.kind??'all');
     assert.equal(checkId,args.checkId);
     const argv=[process.execPath,runner,'verify','--workspace',project,'--kind',kind,...(checkId?['--check-id',checkId]:[])];
     return {async result(){const run=await runProgram(argv,{cwd:project,signal:execution.signal});return {...run,stdout:{text:run.stdout}};}};
    }},
   };
   const value=await executeVerification(ctx,args,execution);
   manager.observeToolResult({...execution,arguments:args},{isError:false,value,content:[]});
   await manager.drainToolResults(sessionId);
   return value;
  }
  const initial=await verify({kind:'test'});
  assert.equal(initial.passed,false);
  assert.equal(initial.criteriaConfirmed,true,JSON.stringify(initial));
  assert.deepEqual((await manager.verificationCriteria(sessionId)).map(row=>row.state),['verified','failed','unknown']);

  const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1360,height:920}}), errors=[], prompts=[];
  page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/session/prompt',route=>{prompts.push(true);return route.abort();});
  await page.route('**/api/workbench/preview',route=>route.fulfill({json:{state:'closed',sessionId}}));
  await page.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,mode:'host-compat',available:true}}));
  await page.route('**/api/workbench',async route=>{
   const body=route.request().postDataJSON();
   if(!body)return route.fulfill({json:{criteriaVersion:1,running:[],trash:{},workspaces,projects:{[sessionId]:record}}});
   assert.equal(body.sessionId,sessionId);
   if(body.op==='verification-criteria')return route.fulfill({json:{version:1,criteria:await manager.verificationCriteria(sessionId)}});
   if(body.op==='automatic-reconcile')return route.fulfill({json:{automatic:null,blocked:null,continued:false}});
   if(body.op==='checkpoint-recovery')return route.fulfill({json:{pending:false}});
   if(body.op==='file'&&body.operation==='list')return route.fulfill({json:{entries:[]}});
   return route.fulfill({status:400,json:{code:'FIXTURE_UNEXPECTED_REQUEST'}});
  });
  await page.goto(url);
  const enter=page.getByRole('button',{name:'Continue',exact:true});
  await enter.waitFor({timeout:4000}).catch(()=>{});
  if(await enter.isVisible())await enter.click();
  await page.waitForFunction(()=>window.HarnessNativeUI&&window.criteriaFixtureReady);
  assert.equal(await page.evaluate(id=>window.HarnessNativeUI.openFiles(id),sessionId),true);
  const panel=page.locator('[data-harness-native-view="files"]:visible');
  const tools=panel.locator('.wb-tools summary');
  async function openReview(){
   await tools.click();
   await panel.getByRole('tab',{name:'Task progress',exact:true}).click();
  }
  async function revisitReview(){
   await tools.click();
   await panel.getByRole('tab',{name:'Workspace files',exact:true}).click();
   await openReview();
  }
  await openReview();
  const criteria=panel.locator('[data-completion-criteria]');
  async function states(expected){
   const ids=['visible','interaction','delivery'];
   for (const [i,id] of ids.entries())await criteria.locator('[data-criterion-id="'+id+'"][data-criterion-state="'+expected[i]+'"]').waitFor();
   assert.equal(await criteria.locator('[data-criterion-id]').count(),3);
  }
  const capture=async name=>{if(process.env.HARNESS_CRITERIA_EVIDENCE)await criteria.screenshot({path:path.join(process.env.HARNESS_CRITERIA_EVIDENCE,name+'.png')});};
  await states(['verified','failed','unknown']);
  await capture('criteria-mixed');

  const previous=structuredClone(record.lastVerification);
  await write('source.txt','fixed');
  const targeted=await verify({checkId:'button'});
  assert.equal(targeted.passed,true,JSON.stringify(targeted));
  assert.equal(targeted.complete,false);
  assert.deepEqual(targeted.checks.map(check=>check.id),['button']);
  assert.deepEqual(record.lastVerification,previous);
  await revisitReview();
  await states(['stale','stale','unknown']);
  await capture('criteria-stale-after-rerun');

  const ordinary=await verify({});
  assert.equal(ordinary.complete,true,JSON.stringify(ordinary));
  await revisitReview();
  await states(['verified','verified','verified']);
  await capture('criteria-ordinary-verified');
  assert.deepEqual(prompts,[]);
  assert.deepEqual(errors,[]);
 } finally {
  if (browser) await browser.close();
  if (child) {
   if (child.exitCode===null&&child.signalCode===null)child.kill();
   await exited;
  }
  await fs.rm(directory,{recursive:true,force:true});
 }
});
