'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),{chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
async function fixture(t,asset,{holdReconcile=false}={}){
 const requests=[],errors=[],dialogs=[];let protect=false,conflict=false,pending=false,hold=false,release,reconcileRelease;
 const state={trash:{},running:[],defaults:{},environment:{},workspaces:[{id:'w1',title:'Workspace',sessionIds:['s1','s2'],settings:{}}],projects:Object.fromEntries(['s1','s2'].map(id=>[id,{root:'/projects/'+id,budget:{stage:1,steps:2},checkpoints:{best:{files:1,at:1}}}]))};
 const preview=()=>({version:2,canRestore:!protect,sourceHash:'a'.repeat(64),writes:['index.js'],deletes:['old.js'],preservedPaths:['keep.txt'],preservedExclusions:[{path:'.env',reason:'private'}],protectedFiles:protect?[{path:'large.bin',reason:'unbacked-current-file'}]:[],legacyOverlayOnly:false,inventoryComplete:true,requiredStagingBytes:100});
 const server=http.createServer(async(req,res)=>{let body='';for await(const bytes of req)body+=bytes;const data=body?JSON.parse(body):null;
  const json=(value,status=200)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}};
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="app"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.__ModuleLoader__={load(){}};</script>'+(asset==='source'?'<script src="/i18n.js"></script>':'')+'<script src="/client.js"></script>');}
  if(req.url==='/i18n.js'||req.url==='/client.js'){res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(root,req.url==='/i18n.js'?'shared/i18n.cjs':asset==='source'?'workspace/client.js':'workspace/native-ui/client.js')));}
  if(req.url==='/api/session/list')return json({result:{ok:true,value:{items:[{sessionId:'s1',title:'One'},{sessionId:'s2',title:'Two'}]}}});
  if(req.url==='/api/session/modelCatalog')return json({result:{ok:true,value:{groups:[]}}});
  if(req.url!=='/api/workbench')return json({},404);if(!data)return json(state);requests.push(data);
  if(data.op==='automatic-reconcile'){const complete=()=>json({automatic:null,blocked:null,continued:false});if(holdReconcile){reconcileRelease=complete;return;}return complete();}
  if(data.op==='checkpoint-recovery')return json({status:pending?'recovery-required':'none',pending,beforeRestore:{version:2,sha256:'b'.repeat(64)},conflicts:pending?['conflict.js']:[]});
  if(data.op==='checkpoint-preview'){if(hold){release=()=>json(preview());return;}return json(preview());}
  if(data.op==='checkpoint-restore'){assert.equal(data.expectedSourceHash,'a'.repeat(64));return conflict?json({code:'SOURCE_CHANGED',error:'Source changed after preview'},409):json({restored:true,recovery:{pending:false,status:'committed'}});}
  if(data.op==='checkpoint-recover'){pending=false;return json({pending:false,status:'rolled-back'});}
  return json({},400);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.type());await d.dismiss();});
 t.after(async()=>{release?.();reconcileRelease?.();await browser.close();await new Promise(r=>server.close(r));});await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>{HarnessI18n.setLanguage('en');window.view=HarnessWorkbench.mount(document.querySelector('#app'),{sessionId:'s1',section:'review'});});await page.getByRole('button',{name:'Restore checkpoint',exact:true}).waitFor();
 return{page,requests,errors,dialogs,protect:value=>protect=value,conflict:value=>conflict=value,pending:value=>pending=value,hold:()=>hold=true,release:()=>release?.(),releaseReconcile(){assert.equal(typeof reconcileRelease,'function');holdReconcile=false;reconcileRelease();reconcileRelease=undefined;}};
}
for(const asset of ['source','bundle']){
 test(asset+': checkpoint preview blocks protected files and apply binds the source hash',async t=>{
  const f=await fixture(t,asset),p=f.page;f.protect(true);await p.getByRole('button',{name:'Restore checkpoint',exact:true}).click();const modal=p.locator('[data-workbench-dialog="checkpoint-preview"]');await modal.waitFor();assert.equal(await modal.getByRole('button',{name:'Apply restore',exact:true}).isDisabled(),true);assert.match(await modal.innerText(),/large.bin/);await modal.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(f.requests.filter(r=>r.op==='checkpoint-restore').length,0);
  f.protect(false);f.conflict(true);await p.getByRole('button',{name:'Restore checkpoint',exact:true}).click();await modal.waitFor();await modal.getByText('Files to delete (1)',{exact:true}).waitFor();await modal.getByText('old.js',{exact:true}).waitFor();await modal.getByRole('button',{name:'Apply restore',exact:true}).click();await p.locator('[id$="wb-error"]').filter({hasText:'Source changed after preview'}).waitFor();assert.equal(await p.getByText('Checkpoint restore verified.',{exact:true}).count(),0);
  f.conflict(false);await p.getByRole('button',{name:'Restore checkpoint',exact:true}).click();await modal.getByRole('button',{name:'Apply restore',exact:true}).click();await p.getByText('Checkpoint restore verified.',{exact:true}).waitFor();assert(f.requests.filter(r=>r.op==='checkpoint-restore').every(r=>r.sessionId==='s1'&&r.expectedSourceHash==='a'.repeat(64)));assert.deepEqual(f.dialogs,[]);assert.deepEqual(f.errors,[]);
 });
 test(asset+': recovery reports rollback without claiming requested restore; late project previews cannot apply',async t=>{
  const f=await fixture(t,asset),p=f.page;f.pending(true);await p.evaluate(()=>view.refresh());await p.getByRole('button',{name:'Recover interrupted restore',exact:true}).click();await p.getByText('Interrupted restore rolled back. The requested checkpoint has not been applied.',{exact:true}).waitFor();assert.equal(await p.getByText('Checkpoint restore verified.',{exact:true}).count(),0);
  f.hold();await p.getByRole('button',{name:'Version before the last restore',exact:true}).click();await p.waitForTimeout(80);await p.locator('[id$="wb-session"]').evaluate(e=>{e.value='s2';e.dispatchEvent(new Event('change'));});f.release();await p.waitForTimeout(120);assert.equal(await p.locator('[data-workbench-dialog="checkpoint-preview"]').count(),0);assert.equal(f.requests.filter(r=>r.op==='checkpoint-restore').length,0);assert(f.requests.some(r=>r.op==='checkpoint-preview'&&r.key==='beforeRestore'&&r.sessionId==='s1'));assert.deepEqual(f.errors,[]);
 });
 test(asset+': late automatic reconcile preserves an explicit source-bound checkpoint restore',async t=>{
  const f=await fixture(t,asset,{holdReconcile:true}),p=f.page;
  await p.getByRole('button',{name:'Restore checkpoint',exact:true}).click();const modal=p.locator('[data-workbench-dialog="checkpoint-preview"]');await modal.waitFor();
  await modal.getByText('Files to delete (1)',{exact:true}).waitFor();assert.equal(await modal.getByRole('button',{name:'Apply restore',exact:true}).isEnabled(),true);
  const reconciled=p.waitForResponse(r=>r.url().endsWith('/api/workbench')&&r.request().postDataJSON()?.op==='automatic-reconcile');f.releaseReconcile();await(await reconciled).finished();
  await p.locator('[data-automatic-reconciliation]').waitFor({state:'detached'});await modal.getByRole('button',{name:'Apply restore',exact:true}).click();
  await p.getByText('Checkpoint restore verified.',{exact:true}).waitFor();
  assert.deepEqual(f.requests.filter(r=>r.op==='checkpoint-restore'),[{op:'checkpoint-restore',sessionId:'s1',key:'best',expectedSourceHash:'a'.repeat(64)}]);
  assert.equal(f.requests.filter(r=>r.op==='automatic-reconcile').length,2);assert.deepEqual(f.dialogs,[]);assert.deepEqual(f.errors,[]);
 });
}
