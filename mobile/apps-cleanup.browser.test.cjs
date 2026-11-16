'use strict';
// Real browser + Settings mount, using the stable-v1 HTTP contract as a fixture.
// No production, Docker or model requests. Optional screenshots are fixture evidence.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
const cid='a'.repeat(64),protectedId='b'.repeat(64),imageId='sha256:'+'c'.repeat(64),project='d'.repeat(16);
const resource=(kind,id,extra={})=>({kind,id,projectIds:[project],sessionIds:['session-fixture'],projectNames:['Paper shop'],chatNames:['Paper shop draft'],displayName:kind==='image'?'paper-preview:latest':id===cid?'Paper preview':'Published shop',tags:kind==='image'?['paper-preview:latest']:[],eligible:true,reasonCodes:[],automaticEligible:false,automaticReasonCodes:['NOT_ARCHIVED'],afterContainerIds:[],sizeBytes:1048576,...extra});
async function until(check){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw Error('Fixture request did not arrive');await new Promise(r=>setTimeout(r,10));}}
async function fixture(t,{width=1280,language='en'}={}){
 const requests=[],errors=[],dialogs=[],pending=[],receipts=new Map();let planSerial=0;
 const state={enabled:true,available:true,busy:null,worker:{managed:true,phase:'ready'},previewSettings:{configured:false},holdUntil:0,vault:{configured:false},remoteTargets:[],features:{},deploymentRecovery:{version:1,required:false},projects:[{id:project,name:'Paper shop',path:'paper',port:3000}],containers:[{id:cid,name:'Paper preview',state:'exited',ports:[]},{id:protectedId,name:'Published shop',state:'running',ports:[]}],jobs:[]};
 const value={version:1,enabled:true,availability:'ready',reasonCode:null,observedAt:Date.now(),inventory:[resource('container',cid),resource('container',protectedId,{eligible:false,reasonCodes:['CONTAINER_RUNNING','PUBLISHED']}),resource('image',imageId,{sizeBytes:null,afterContainerIds:[cid]})],plan:null,operation:null};
 const controls={holdRead:false,holdSettings:false,failRead:false,stalePreview:false,running:false,uncertain:false,deferred:false,results:null,dropApply:false,lookupOverride:null,applyOverride:null};
 const root=path.resolve(__dirname,'..');
 const server=http.createServer(async(req,res)=>{try{
  let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):undefined,url=new URL(req.url,'http://fixture');
  const json=(v,status=200)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));}};
  if(url.pathname==='/')return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/theme.css"><style>body{margin:0}#app{width:100%;min-width:0;max-width:760px;margin:auto}</style><div id="app"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.HarnessNativeTheme={css:s=>s};</script><script src="/i18n.js"></script><script src="/apps.js"></script>');
  const files={'/theme.css':'workspace/native-ui/theme.css','/i18n.js':'shared/i18n.cjs','/apps.js':'mobile/apps.js'};
  if(files[url.pathname]){res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'application/javascript');return res.end(fs.readFileSync(path.join(root,files[url.pathname])));}
  if(url.pathname==='/phone/api/apps/state')return json({...state,context:{scope:'global',sessionId:null,projectId:null,workspaceId:null}});
  if(url.pathname==='/api/workbench/docker-cleanup'){
   const operationId=url.searchParams.get('operationId'),planId=url.searchParams.get('planId');requests.push({method:req.method,body,operationId,planId});
   if(!body){if(controls.failRead)return json({error:'unavailable'},503);const snapshot=structuredClone(value);if(operationId||planId){const receipt=planId?receipts.get(planId):[...receipts.values()].find(r=>r.id===operationId);if(!receipt||operationId&&receipt.id!==operationId)return json({code:'CLEANUP_OPERATION_NOT_FOUND'},404);snapshot.operation={...structuredClone(receipt),...controls.lookupOverride};}if(controls.holdRead){controls.holdRead=false;pending.push(()=>json(snapshot));return;}return json(snapshot);}
   if(body.op==='settings'){const complete=()=>{value.enabled=body.enabled;json(value);};if(controls.holdSettings){controls.holdSettings=false;pending.push(complete);return;}return complete();}
   if(body.op==='preview'){
    if(controls.stalePreview)return json({error:'CLEANUP_PLAN_STALE'},409);
    planSerial++;value.plan={id:String(planSerial).repeat(32),hash:String(planSerial+1).repeat(64),createdAt:Date.now(),expiresAt:Date.now()+60000,rows:structuredClone(value.inventory),selection:body.selections,availability:'ready'};return json(value);
   }
   if(body.op==='apply'){
    assert.deepEqual(body,{op:'apply',planId:value.plan.id,planHash:value.plan.hash,selections:value.plan.selection});
    let receipt=receipts.get(body.planId);
    if(!receipt){value.operation={id:String(planSerial+2).repeat(32),planId:body.planId,planHash:body.planHash,selection:body.selections,state:controls.deferred?'deferred':controls.running?'running':controls.uncertain?'reconciliation_required':'completed',results:controls.results??(controls.running||controls.deferred||controls.uncertain?[]:body.selections.map(s=>({...s,outcome:'removed',reasonCode:null}))),trigger:'manual',startedAt:Date.now(),finishedAt:null,errorCode:null};receipt=value.operation;receipts.set(body.planId,receipt);}
    else {assert.equal(receipt.planHash,body.planHash);assert.deepEqual(receipt.selection,body.selections);}
    if(controls.dropApply){res.destroy();return;}return json({...value,operation:{...receipt,...controls.applyOverride}});
   }
  }
  json({error:'missing'},404);
 }catch(e){jsonError(res,e);}});
 function jsonError(res,e){if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.HARNESS_BROWSER_CHANNEL?{channel:process.env.HARNESS_BROWSER_CHANNEL}:{})}),page=await browser.newPage({viewport:{width,height:1100}});page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.type());await d.dismiss();});
 t.after(async()=>{pending.splice(0).forEach(fn=>fn());await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(language=>{const fetch=window.fetch.bind(window);window.cleanupApplyFetches=0;window.fetch=(url,options)=>{if(options?.body&&JSON.parse(options.body).op==='apply')window.cleanupApplyFetches++;return fetch(url,options);};HarnessI18n.setLanguage(language);window.view=HarnessApps.mount(document.querySelector('#app'),{scope:'global',settings:true});},language);
 const panel=page.locator('[data-apps-cleanup]');await panel.getByLabel(/Automatically|Automaticky/).waitFor();await panel.getByRole('checkbox',{name:/Select Paper preview|Vybrat Paper preview/}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-cleanup-focus="container:'+'a'.repeat(64)+'"]').disabled);
 return{page,panel,value,state,controls,requests,errors,dialogs,release(){pending.shift()?.();},select:()=>panel.getByRole('checkbox',{name:'Select Paper preview',exact:true}),async review(){await panel.getByRole('button',{name:'Review selection',exact:true}).click();await panel.getByRole('button',{name:'Delete selected resources',exact:true}).waitFor();}};
}
test('Settings contract: protected rows, dependent image selection, preview-bound apply and real result',async t=>{
 const f=await fixture(t),p=f.panel;
 assert.equal(await p.getByRole('checkbox',{name:'Select Published shop',exact:true}).isDisabled(),true);
 await p.getByRole('checkbox',{name:'Select paper-preview:latest',exact:true}).check();assert.equal(await f.select().isChecked(),true);
 await f.select().uncheck();assert.equal(await p.getByRole('checkbox',{name:'Select paper-preview:latest',exact:true}).isChecked(),false);
 await p.getByText(/Chat: Paper shop draft/).first().waitFor();assert.equal(f.value.inventory[0].automaticEligible,false,'manual selection is independent of archive automation');
 await f.select().check();await f.review();assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,0);
 await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByRole('status',{name:'Cleanup result'}).filter({hasText:'Removed: 1'}).waitFor();
 assert.deepEqual(f.requests.find(r=>r.body?.op==='preview').body.selections,[{kind:'container',id:cid}]);assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,1);assert.deepEqual(f.dialogs,[]);assert.deepEqual(f.errors,[]);
});
test('Preference sparse saves serialize newer edits; refresh preserves choices and invalidates stale previews',async t=>{
 const f=await fixture(t),p=f.panel,auto=p.getByLabel('Automatically clean up resources of archived chats');
 f.controls.holdSettings=true;await auto.uncheck();await auto.check();await until(()=>f.requests.some(r=>r.body?.op==='settings'));f.release();await p.getByText('Preference saved.',{exact:true}).waitFor();assert.equal(f.value.enabled,true);assert.deepEqual(f.requests.filter(r=>r.body?.op==='settings').map(r=>r.body),[{op:'settings',enabled:false},{op:'settings',enabled:true}]);
 const reads=f.requests.filter(r=>r.method==='GET').length;f.controls.holdRead=true;await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await until(()=>f.requests.filter(r=>r.method==='GET').length>reads);await auto.uncheck();await p.getByText('Preference saved.',{exact:true}).waitFor();f.release();await p.getByRole('button',{name:'Refresh resources',exact:true}).waitFor();assert.equal(await auto.isChecked(),false,'late inventory cannot undo a confirmed preference');
 await f.select().check();await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByRole('button',{name:'Review selection',exact:true}).waitFor();assert.equal(await f.select().isChecked(),true);
 await f.review();f.value.inventory[0].eligible=false;f.value.inventory[0].reasonCodes=['RESUME_REFERENCE'];await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByText('Needed to resume',{exact:true}).waitFor();assert.equal(await f.select().isChecked(),false);assert.equal(await f.select().isDisabled(),true);assert.equal(await p.getByRole('button',{name:'Delete selected resources',exact:true}).count(),0);
 assert.deepEqual(f.errors,[]);
});
test('Stale/errors/deferred/uncertain never imply deletion or silently replay writes',async t=>{
 const f=await fixture(t),p=f.panel;await f.select().check();f.controls.stalePreview=true;await p.getByRole('button',{name:'Review selection',exact:true}).click();await p.getByRole('alert').filter({hasText:'Review the selection again'}).waitFor();assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,0);
 f.controls.stalePreview=false;await f.review();f.controls.deferred=true;await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByText('Cleanup is deferred while Docker is unavailable.',{exact:true}).waitFor();await p.getByRole('status',{name:'Cleanup result'}).filter({hasText:'Removed: 0'}).waitFor();
 f.controls.deferred=false;await f.review();f.controls.uncertain=true;await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByRole('alert').filter({hasText:'Result not yet confirmed'}).waitFor();assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,2);assert.equal(await p.getByRole('button',{name:'Review selection',exact:true}).isDisabled(),true);
 f.value.operation.state='completed';f.value.operation.results=[{kind:'container',id:cid,outcome:'already_absent',reasonCode:null}];await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByText('Resource is already absent.',{exact:true}).waitFor();assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,2,'reconciliation uses GET, never replays apply');
 f.controls.failRead=true;await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByRole('alert').filter({hasText:'could not be verified'}).waitFor();assert.deepEqual(f.dialogs,[]);
});
test('Sleeping, unknown and disabled inventory truthfully disable deletion without waking Docker',async t=>{
 const f=await fixture(t),p=f.panel;await f.select().check();f.value.availability='deferred';await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByText('Cleanup is deferred while Docker is unavailable.',{exact:true}).waitFor();assert.equal(await f.select().isDisabled(),true);assert.equal(await f.select().isChecked(),true);
 f.value.availability='unavailable';await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByText('Unavailable. Resource status has not been verified.',{exact:true}).waitFor();
 f.state.enabled=false;await f.page.evaluate(()=>view.refresh());await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByText('Resource management is unavailable while Applications are disabled.',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Review selection',exact:true}).isDisabled(),true);
 assert.equal(f.requests.filter(r=>r.method==='POST').length,0);assert.deepEqual(f.errors,[]);
});
test('Async progress completes through operation GET; destroyed panels ignore delayed replies',async t=>{
 const f=await fixture(t),p=f.panel;f.controls.running=true;await f.select().check();await f.review();await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByText('Cleanup in progress…',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'Refresh resources',exact:true}).isDisabled(),true);
 f.value.operation.state='completed';f.value.operation.results=[{kind:'container',id:cid,outcome:'kept',reasonCode:'OWNERSHIP_CHANGED'}];await p.getByRole('status',{name:'Cleanup result'}).filter({hasText:'Skipped: 1'}).waitFor();assert(f.requests.some(r=>r.operationId==='3'.repeat(32)));await p.getByText('Ownership changed',{exact:true}).waitFor();assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,1);
 f.controls.holdRead=true;await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await f.page.evaluate(()=>view.destroy());f.release();await f.page.waitForTimeout(50);assert.equal(await f.page.locator('[data-apps-cleanup]').count(),0);assert.deepEqual(f.errors,[]);
});
for(const status of ['deferred','uncertain'])test('Partial '+status+' receipt retains confirmed removals and separate unknown counts',async t=>{
 const f=await fixture(t),p=f.panel;f.controls[status]=true;f.controls.results=[{kind:'container',id:cid,outcome:'removed',reasonCode:null},...(status==='uncertain'?[{kind:'image',id:imageId,outcome:'uncertain',reasonCode:'DELETE_OUTCOME_UNKNOWN'}]:[])];
 await p.getByRole('checkbox',{name:'Select paper-preview:latest',exact:true}).check();await f.review();await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();const result=p.getByRole('status',{name:'Cleanup result'});await result.filter({hasText:'Removed: 1'}).waitFor();assert.match(await result.innerText(),/Skipped: 0/);assert.match(await result.innerText(),status==='uncertain'?/Unconfirmed: 1/:/Without a result: 1/);assert.doesNotMatch(await p.innerText(),/No resources were deleted|Nic se nesmazalo/);assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,1);assert.deepEqual(f.errors,[]);
});
test('Selected receipt rejects mismatched operation, plan, hash and selection without losing known partial results',async t=>{
 const f=await fixture(t),p=f.panel;f.controls.uncertain=true;f.controls.results=[{kind:'container',id:cid,outcome:'uncertain',reasonCode:'DELETE_OUTCOME_UNKNOWN'}];await f.select().check();await f.review();await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByRole('status',{name:'Cleanup result'}).filter({hasText:'Unconfirmed: 1'}).waitFor();
 for(const override of [{id:'4'.repeat(32)},{planId:'4'.repeat(32)},{planHash:'4'.repeat(64)},{selection:[{kind:'container',id:protectedId}]}]){
  f.controls.lookupOverride={...override,state:'completed',results:[{kind:'container',id:cid,outcome:'removed',reasonCode:null}]};const count=f.requests.filter(r=>r.operationId).length;await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await until(()=>f.requests.filter(r=>r.operationId).length>count);await p.getByRole('alert').filter({hasText:'Result not yet confirmed'}).waitFor();assert.match(await p.getByRole('status',{name:'Cleanup result'}).innerText(),/Unconfirmed: 1/);assert.doesNotMatch(await p.getByRole('status',{name:'Cleanup result'}).innerText(),/Removed: 1/);
 }
 assert(f.requests.filter(r=>r.operationId).every(r=>r.operationId==='3'.repeat(32)&&r.planId==='1'.repeat(32)));assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,1);assert.deepEqual(f.errors,[]);
});
for(const reload of [false,true])test('Lost apply response recovers own plan receipt '+(reload?'after page reload':'on refresh')+' without using latest',async t=>{
 const f=await fixture(t),p=f.panel;f.controls.dropApply=true;await f.select().check();await f.review();await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByRole('alert').filter({hasText:'Result not yet confirmed'}).waitFor();const postCount=f.requests.filter(r=>r.body?.op==='apply').length;assert.equal(await f.page.evaluate(()=>cleanupApplyFetches),1,'UI issues one fetch even if browser transport retries a dropped connection');
 f.value.operation={id:'4'.repeat(32),planId:'4'.repeat(32),planHash:'4'.repeat(64),selection:[],state:'completed',results:[],trigger:'archive'};
 if(reload){await f.page.reload();await f.page.evaluate(()=>{HarnessI18n.setLanguage('en');window.view=HarnessApps.mount(document.querySelector('#app'),{scope:'global',settings:true});});}else await p.getByRole('button',{name:'Refresh resources',exact:true}).click();
 await f.page.locator('[data-apps-cleanup]').getByRole('status',{name:'Cleanup result'}).filter({hasText:'Removed: 1'}).waitFor();assert(f.requests.some(r=>r.method==='GET'&&r.planId==='1'.repeat(32)&&!r.operationId));assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,postCount,'Recovery never sends another apply');assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('harness.docker-cleanup.pending.v1')),null);assert.deepEqual(f.errors,[]);
});
test('Wrong identity during initial running poll leaves exact recovery available',async t=>{
 const f=await fixture(t),p=f.panel;f.controls.running=true;f.controls.lookupOverride={id:'4'.repeat(32)};await f.select().check();await f.review();await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByRole('alert').filter({hasText:'Result not yet confirmed'}).waitFor();assert.equal(await p.getByRole('button',{name:'Refresh resources',exact:true}).isEnabled(),true);
 f.controls.lookupOverride=null;f.value.operation.state='completed';f.value.operation.results=[{kind:'container',id:cid,outcome:'removed',reasonCode:null}];await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByRole('status',{name:'Cleanup result'}).filter({hasText:'Removed: 1'}).waitFor();assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,1);assert.deepEqual(f.errors,[]);
});
test('Foreign apply receipt is rejected and recovered only through the original plan identity',async t=>{
 const f=await fixture(t),p=f.panel;f.controls.applyOverride={planId:'4'.repeat(32),planHash:'4'.repeat(64)};await f.select().check();await f.review();await p.getByRole('button',{name:'Delete selected resources',exact:true}).click();await p.getByRole('alert').filter({hasText:'Result not yet confirmed'}).waitFor();assert.equal(await p.getByRole('status',{name:'Cleanup result'}).count(),0);
 await p.getByRole('button',{name:'Refresh resources',exact:true}).click();await p.getByRole('status',{name:'Cleanup result'}).filter({hasText:'Removed: 1'}).waitFor();assert(f.requests.some(r=>r.planId==='1'.repeat(32)));assert.equal(f.requests.filter(r=>r.body?.op==='apply').length,1);
});
for(const width of [1440,390])test('Keyboard and '+width+'px Settings layout (fixture)',async t=>{
 const f=await fixture(t,{width,language:'cs'}),p=f.panel;await p.getByRole('checkbox',{name:'Vybrat Paper preview',exact:true}).focus();await f.page.keyboard.press('Space');assert.equal(await p.getByRole('checkbox',{name:'Vybrat Paper preview',exact:true}).isChecked(),true);
 await p.getByRole('button',{name:'Zkontrolovat výběr',exact:true}).click();await p.getByRole('button',{name:'Smazat vybrané zdroje',exact:true}).waitFor();
 assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(f.errors,[]);
 if(process.env.HARNESS_CLEANUP_SCREENSHOT_DIR){fs.mkdirSync(process.env.HARNESS_CLEANUP_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.HARNESS_CLEANUP_SCREENSHOT_DIR,'settings-cleanup-'+width+'.png')});}
});
