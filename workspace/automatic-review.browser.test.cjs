'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),http=require('node:http'),path=require('node:path'),os=require('node:os');
const playwright=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'/data/harness/dev/browser/node_modules/playwright');
const {createSourceFixture}=require('./native-ui/test-bundle.cjs');
const root=path.resolve(__dirname,'..');

// Public B contract through actual HTTP/DOM, without inference/live sessions.
// Bundle uses current source in a temporary fixture, not release-owned client.js.
async function fixture(t,asset,language,width,section='review'){
 const budget={stage:2,steps:80,blocked:null,checks:{},automatic:{version:1,taskSteps:80,checks:1,phase:'checking',proofSerial:1,terminalAcknowledged:false}};
 const requests=[],errors=[],held=[],state={defaults:{provider:'strata-vast',model:'strata',reasoningEffort:'medium',thinkingBudget:4096,maxTokens:32768,temperature:1,topP:.95,projectMode:'auto',maxStageSteps:60,maxTaskSteps:240,maxAutomaticChecks:3,noProgressLimit:3,language:'en',environment:'web'},workspaces:[{id:'w1',title:'Workspace',sessionIds:['s1','s2'],settings:{}}],projects:{s1:{root:'/project',budget}},running:[],trash:{}};
 let failure=null,hold=false,response,continued=false;
 const temporary=asset==='bundle'?fs.mkdtempSync(path.join(os.tmpdir(),'homeai-n08-ui-')):null;
 const bundle=temporary&&path.join(path.dirname(createSourceFixture(temporary)),'client.js');
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;body=body?JSON.parse(body):null;
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="app" style="max-width:100%"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.__ModuleLoader__={load(){}};window.HarnessNativeTheme={css:v=>v};</script>'+(asset==='source'?'<script src="/i18n.js"></script>':'')+'<script src="/client.js"></script>');}
  if(req.url==='/i18n.js'||req.url==='/client.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');return res.end(fs.readFileSync(req.url==='/i18n.js'?path.join(root,'shared/i18n.cjs'):bundle||path.join(root,'workspace/client.js')));}
  if(req.url==='/api/session/list')return json({result:{ok:true,value:{items:[]}}});
  if(req.url==='/api/session/modelCatalog')return json({result:{ok:true,value:{groups:[]}}});
  if(req.url==='/api/workbench'){
   if(!body)return json(state);
   if(body.op==='checkpoint-recovery')return json({pending:false});
   requests.push(body);
   if(body.op==='automatic-reconcile'){
    if(failure){res.statusCode=409;return json(failure);}
    const current=state.projects[body.sessionId].budget;
    const captured=JSON.parse(JSON.stringify(response??{automatic:current.automatic,blocked:current.blocked,continued}));
    if(hold){held.push(()=>json(captured));return;}return json(captured);
   }
   if(body.op==='settings'){state.workspaces[0].settings=body.settings;return json({saved:true});}
   res.statusCode=400;return json({code:'UNEXPECTED_MUTATION',error:body.op});
  }
  res.writeHead(404);res.end();
 });
 let browser;
 t.after(async()=>{
  for(const complete of held.splice(0))complete();await browser?.close();await new Promise(r=>server.close(r));
  if(temporary){const resolved=path.resolve(temporary);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('homeai-n08-ui-'));fs.rmSync(resolved,{recursive:true,force:true});}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await playwright[process.env.HARNESS_AUTOMATIC_REVIEW_BROWSER||'chromium'].launch({headless:true,...(process.env.HARNESS_AUTOMATIC_REVIEW_EXECUTABLE?{executablePath:process.env.HARNESS_AUTOMATIC_REVIEW_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(({language,section})=>{HarnessI18n.setLanguage(language);window.view=HarnessWorkbench.mount(document.querySelector('#app'),{section,sessionId:'s1',workspaceId:'w1'});},{language,section});
 const settle=()=>page.waitForFunction(()=>!document.querySelector('[data-automatic-reconciliation][role="status"]'));
 await page.locator(section==='review'?'[data-automatic-review-phase]':'[name=maxStageSteps]').waitFor();await settle();
 return {page,budget,state,requests,errors,held,settle,fail:value=>failure=value,hold:value=>hold=value,response:value=>response=value,continued:value=>continued=value,complete(){held.shift()?.();},completeAll(){for(const complete of held.splice(0))complete();},async refresh({wait=true}={}){await page.evaluate(()=>window.view.refresh());if(wait)await settle();}};
}

for(const asset of ['source','bundle'])for(const language of ['en','cs'])for(const width of [1280,390])test(`N08 ${asset} ${language} ${width}: accounting, recovery and blockers without manual resume`,{timeout:20000},async t=>{
 const f=await fixture(t,asset,language,width),p=f.page,cs=language==='cs',card=p.locator('[data-automatic-review-phase]');
 await p.locator('.wb-tools > summary').click();await p.getByRole('tab',{name:cs?'Průběh úlohy':'Task progress',exact:true}).waitFor();await p.locator('.wb-tools > summary').click();
 assert.match(await card.locator('h3').innerText(),cs?/Ověřuji/:/Checking/);
 assert.deepEqual(f.requests,[{op:'automatic-reconcile',sessionId:'s1'}]);
 f.budget.automatic.phase='repairing';f.budget.automatic.taskSteps=801;f.budget.automatic.checks=12;await f.refresh();
 assert.match(await card.innerText(),cs?/Opravuji/:/Repairing/);assert.match(await card.innerText(),/801/);assert.match(await card.innerText(),/12/);
 assert.doesNotMatch(await card.innerText(),/801\s*\/|12\s*\/|new concrete request|nový konkrétní požadavek/);
 f.budget.blocked={code:'TASK_BUDGET',message:'Send a new concrete request to continue.'};f.budget.automatic.phase='stopped';await f.refresh();
 assert.doesNotMatch(await card.innerText(),/Send a new concrete request|pošli.*požadavek/);
 assert.equal(await card.locator('textarea,[data-strategy-resume]').count(),0);
 f.budget.blocked={code:'AUTOMATIC_VERIFICATION_UNCERTAIN',message:'OWN_VERIFIER_TERMINAL_NOT_ACKNOWLEDGED'};
 f.budget.automatic.recovery={state:'pending',code:'OWN_VERIFIER_TERMINAL_NOT_ACKNOWLEDGED',canContinue:false};await f.refresh();
 assert.equal(await card.getAttribute('data-automatic-review-phase'),'pending');assert.doesNotMatch(await card.innerText(),/stopped safely|bezpečně zastavila|operator must/);
 f.budget.automatic.recovery.state='reconciling';await f.refresh();assert.equal(await card.getAttribute('data-automatic-review-phase'),'reconciling');
 f.budget.automatic.recovery={state:'blocked',code:'OWN_VERIFIER_STILL_RUNNING',canContinue:false};f.budget.blocked={code:'OWN_VERIFIER_STILL_RUNNING',message:'Only the owned verifier remains active; terminal receipt is missing.'};
 f.budget.automatic.lastCheck={checks:[{id:'build',passed:false,logPath:'/project/.checks/build.log',artifactPaths:['/project/.checks/report.json']}]};await f.refresh();
 assert.equal(await card.getAttribute('data-automatic-review-phase'),'blocked');assert.match(await card.innerText(),/OWN_VERIFIER_STILL_RUNNING/);assert.match(await card.innerText(),/terminal receipt is missing/);
 assert.match(await card.locator('[data-retained-results]').innerText(),/\/project\/\.checks\/build.log/);
 assert.equal(await card.getByRole('button',{name:/resume|try a smaller|menší opravu|Pokračovat/i}).count(),0);
 if(process.env.HARNESS_AUTOMATIC_REVIEW_EVIDENCE&&asset==='source'&&((cs&&width===390)||(!cs&&width===1280))){await fsp.mkdir(process.env.HARNESS_AUTOMATIC_REVIEW_EVIDENCE,{recursive:true});await p.screenshot({path:path.join(process.env.HARNESS_AUTOMATIC_REVIEW_EVIDENCE,`${language}-${width}-blocked.png`),fullPage:true});}
 f.budget.blocked=null;f.budget.automatic.phase='working';f.budget.automatic.terminalAcknowledged=true;f.budget.automatic.reason='AUTOMATIC_VERIFICATION_UNCERTAIN';f.budget.automatic.recovery={state:'recovered',code:'MATCHING_TERMINAL_RECONCILED',canContinue:true};await f.refresh();
 assert.equal(await card.getAttribute('data-automatic-review-phase'),'recovered');assert.doesNotMatch(await card.locator('h3').innerText(),/Continuing|Pokračuji/);
 assert.equal(f.budget.automatic.taskSteps,801);assert.equal(f.budget.automatic.checks,12);
 f.continued(true);await f.refresh();assert.equal(await card.getAttribute('data-automatic-review-phase'),'queued');assert.doesNotMatch(await card.locator('h3').innerText(),/Continuing the task|Pokračuji v úloze/);
 if(process.env.HARNESS_AUTOMATIC_REVIEW_EVIDENCE&&asset==='source'&&((cs&&width===390)||(!cs&&width===1280)))await p.screenshot({path:path.join(process.env.HARNESS_AUTOMATIC_REVIEW_EVIDENCE,`${language}-${width}-accepted.png`),fullPage:true});
 f.state.running=['s1'];await f.refresh();assert.equal(await card.getAttribute('data-automatic-review-phase'),'working');
 assert(f.requests.every(r=>r.op==='automatic-reconcile'&&r.sessionId==='s1'));assert.equal(f.requests.length,9);
 await p.evaluate(language=>HarnessI18n.setLanguage(language),cs?'en':'cs');await p.waitForFunction(text=>document.querySelector('[data-automatic-review-phase] h3')?.textContent===text,cs?'Continuing the task':'Pokračuji v úloze');assert.equal(f.requests.length,9);
 assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(f.errors,[]);
});

test('N08 failed/malformed recovery retains concrete failure/files; null and optional recovery are valid',{timeout:15000},async t=>{
 const f=await fixture(t,'source','en',390),p=f.page;
 f.fail({code:'OWN_VERIFIER_FOREIGN_RECEIPT',error:'The terminal receipt belongs to different source.'});await f.refresh();
 await p.locator('[data-automatic-reconciliation][role="alert"]').waitFor();assert.match(await p.locator('[data-automatic-reconciliation]').innerText(),/OWN_VERIFIER_FOREIGN_RECEIPT/);
 assert.equal(await p.locator('textarea').count(),0);assert.equal(f.requests.length,2);assert.match(await p.locator('[data-retained-results]').innerText(),/\/project/);
 f.fail(null);f.response({automatic:{phase:'working'},blocked:null,continued:true});await f.refresh();
 assert.match(await p.locator('[data-automatic-reconciliation]').innerText(),/AUTOMATIC_RECOVERY_RESPONSE_INVALID/);assert.equal(f.requests.length,3);
 f.response({automatic:null,blocked:null,continued:false});await f.refresh();assert.equal(await p.locator('[data-automatic-reconciliation]').count(),0);
 f.response({automatic:{phase:'working',terminalAcknowledged:false,taskSteps:0,checks:0},blocked:null,continued:false});await f.refresh();assert.equal(await p.locator('[data-automatic-reconciliation]').count(),0);
 assert.deepEqual(f.errors,[]);
});

test('N08 acknowledged process end without matching outcome remains blocked, not running or passed',{timeout:15000},async t=>{
 const f=await fixture(t,'source','en',390),p=f.page;
 f.budget.steps=f.budget.automatic.taskSteps=80;f.budget.automatic.checks=2;f.budget.automatic.phase='stopped';f.budget.automatic.terminalAcknowledged=true;
 f.budget.blocked={code:'AUTOMATIC_VERIFICATION_UNCERTAIN',message:'A matching result for the ended verifier is missing.'};
 f.budget.automatic.recovery={state:'blocked',code:'MATCHING_OUTCOME_MISSING',canContinue:false};
 f.state.projects.s1.verification={kind:'build',accepted:false,exitCode:1,checksPassed:0,checksTotal:1};await f.refresh();
 const card=p.locator('[data-automatic-review-phase]');assert.equal(await card.getAttribute('data-automatic-review-phase'),'blocked');
 assert.match(await card.innerText(),/Verifier process end acknowledged/);assert.match(await card.innerText(),/matching result.*missing/);
 assert.match(await card.innerText(),/MATCHING_OUTCOME_MISSING/);
 assert.match(await card.innerText(),/recorded project check alone does not establish/);assert.doesNotMatch(await card.innerText(),/stopped safely|Continuing the task|recovery confirmed|PASS/);
 assert.equal(await card.locator('textarea').count(),0);assert(f.requests.every(r=>r.op==='automatic-reconcile'));
 f.budget.blocked.message='A verification has no acknowledged completion. Files are retained. Operator review is required before any further work.';await f.refresh();assert.doesNotMatch(await card.innerText(),/Operator review is required|has not acknowledged completion/);
 f.budget.blocked=null;f.budget.automatic.terminalAcknowledged=false;f.budget.automatic.recovery={state:'recovered',code:'INCONSISTENT_TERMINAL',canContinue:true};await f.refresh();
 assert.equal(await card.getAttribute('data-automatic-review-phase'),'blocked');assert.doesNotMatch(await card.innerText(),/recorded verification has been reconciled/);
 assert.deepEqual(f.errors,[]);
});

test('N08 negative legacy terminal receipt requires a fresh check and earns no success claim',{timeout:15000},async t=>{
 const f=await fixture(t,'source','en',390),p=f.page,card=p.locator('[data-automatic-review-phase]');
 f.budget.automatic.phase='working';f.budget.automatic.terminalAcknowledged=true;
 f.budget.automatic.recovery={state:'reconciling',code:'AUTOMATIC_LEGACY_FRESH_VERIFICATION_REQUIRED',canContinue:false};await f.refresh();
 assert.equal(await card.getAttribute('data-automatic-review-phase'),'reconciling');assert.match(await card.innerText(),/result is unknown/);assert.match(await card.innerText(),/new bounded check is required/);
 assert.doesNotMatch(await card.innerText(),/recovery confirmed|successful verification|PASS/);
 f.budget.automatic.phase='checking';f.budget.automatic.checks=3;await f.refresh();assert.equal(await card.getAttribute('data-automatic-review-phase'),'checking');assert.match(await card.innerText(),/fresh check is now running/);
 f.continued(true);f.budget.automatic.phase='working';f.budget.automatic.recovery={state:'recovered',code:'AUTOMATIC_RESULT_RECONCILED',canContinue:true};await f.refresh();assert.equal(await card.getAttribute('data-automatic-review-phase'),'queued');
 assert.equal(f.budget.automatic.taskSteps,80);assert.equal(f.budget.automatic.checks,3);assert(f.requests.every(r=>r.op==='automatic-reconcile'));assert.deepEqual(f.errors,[]);
});

test('N08 late reconcile cannot overwrite newer refresh/another session; destroy sends no new calls',{timeout:15000},async t=>{
 const f=await fixture(t,'source','en',390),p=f.page;
 f.budget.blocked={code:'AUTOMATIC_VERIFICATION_UNCERTAIN'};f.budget.automatic.recovery={state:'pending',code:'WAITING',canContinue:false};f.hold(true);await f.refresh({wait:false});
 await p.locator('[data-automatic-reconciliation][role="status"]').waitFor();
 f.hold(false);f.budget.blocked=null;f.budget.automatic.phase='working';f.budget.automatic.terminalAcknowledged=true;f.budget.automatic.recovery={state:'recovered',code:'MATCHED',canContinue:true};await f.refresh();
 f.complete();await p.waitForTimeout(30);assert.equal(await p.locator('[data-automatic-review-phase]').getAttribute('data-automatic-review-phase'),'recovered');
 f.state.projects.s2={root:'/other-project',budget:{...f.budget,automatic:{...f.budget.automatic,recovery:{state:'blocked',code:'S2_DIAGNOSTIC',canContinue:false}},blocked:{code:'S2_DIAGNOSTIC',message:'Other session retained diagnostic'}}};
 f.hold(true);await f.refresh({wait:false});await p.locator('[data-automatic-reconciliation][role="status"]').waitFor();
 f.hold(false);await p.evaluate(()=>{window.view.destroy();window.view=HarnessWorkbench.mount(document.querySelector('#app'),{section:'review',sessionId:'s2',workspaceId:'w1'});});await p.waitForFunction(()=>document.querySelector('[data-retained-results]')?.textContent.includes('/other-project'));await f.settle();f.completeAll();
 assert.match(await p.locator('[data-automatic-review-phase]').innerText(),/S2_DIAGNOSTIC/);assert.match(await p.locator('[data-retained-results]').innerText(),/\/other-project/);
 const count=f.requests.length;await p.evaluate(()=>window.view.destroy());await p.waitForTimeout(30);assert.equal(f.requests.length,count);assert.deepEqual(f.errors,[]);
});

test('N08 settings retain check interval and omit obsolete task/check stop controls',{timeout:15000},async t=>{
 const f=await fixture(t,'source','cs',390,'settings'),p=f.page;
 assert.equal(await p.locator('[name=maxTaskSteps],[name=maxAutomaticChecks]').count(),0);
 await p.locator('[name=maxStageSteps]').fill('101');await p.locator('form').evaluate(e=>e.dispatchEvent(new Event('submit',{cancelable:true})));assert.equal(f.requests.length,0);
 await p.locator('[name=maxStageSteps]').fill('80');await p.getByRole('button',{name:'Uložit',exact:true}).click();await p.locator('[id$="wb-message"]').filter({hasText:'Uloženo'}).waitFor();
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].op,'settings');assert.deepEqual(f.requests[0].settings,{maxStageSteps:80});assert.deepEqual(f.errors,[]);
});
