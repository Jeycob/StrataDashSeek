'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),{chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
for(const asset of ['source','bundle'])test(asset+': task undo previews conflicts, requires keeping later edits, and rejects stale apply',async t=>{
 const requests=[],errors=[],task={id:'a'.repeat(32),turn:1,status:'ready',startedAt:1};let stale=true;
 const state={trash:{},running:[],defaults:{},workspaces:[{id:'w',sessionIds:['s1'],settings:{}}],projects:{s1:{root:'/projects/s1',budget:{stage:1,steps:2},checkpoints:{}}}};
 const server=http.createServer(async(req,res)=>{
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="app"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.__ModuleLoader__={load(){}};</script><script src="/i18n.js"></script><script src="/client.js"></script>');}
  const files={'/i18n.js':'shared/i18n.cjs','/client.js':asset==='source'?'workspace/client.js':'workspace/native-ui/client.js','/api/workbench/task-undo-client':'workspace/task-undo-ui.js'};
  if(files[req.url]){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,files[req.url])));}
  if(req.url==='/api/session/list')return json({result:{ok:true,value:{items:[{sessionId:'s1',title:'Fixture'}]}}});
  if(req.url==='/api/session/modelCatalog')return json({result:{ok:true,value:{groups:[]}}});
  if(req.url!=='/api/workbench')return json({},404);
  let body='';for await(const bytes of req)body+=bytes;if(!body)return json(state);const data=JSON.parse(body);requests.push(data);
  if(data.op==='checkpoint-recovery')return json({status:'none',pending:false});
  if(data.op==='automatic-reconcile')return json({automatic:null,blocked:null,continued:false});
  if(data.op==='task-undo-list')return json({version:1,tasks:[task]});
  if(data.op==='task-undo-preview')return json({version:2,task,sourceHash:'b'.repeat(64),canRestore:false,protectedFiles:[],writes:['removed.js'],deletes:['created.js'],taskUndo:{changes:[{path:'app.js',kind:'modified'}],conflicts:['app.js'],alreadyReverted:[],unsupported:[]}});
  if(data.op==='task-undo-apply'){assert.deepEqual(data,{op:'task-undo-apply',sessionId:'s1',taskId:task.id,expectedSourceHash:'b'.repeat(64),skipConflicts:true});return stale?json({code:'RESTORE_SOURCE_CHANGED',error:'Source changed since preview'},409):json({restored:true,preservedConflicts:['app.js'],recovery:{status:'committed',pending:false}});}
  return json({},400);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>{HarnessI18n.setLanguage('en');HarnessWorkbench.mount(document.querySelector('#app'),{sessionId:'s1',section:'review'});});
 const review=page.getByRole('button',{name:'Review task changes',exact:true}),modal=page.locator('[data-task-undo-preview]');await review.click();await modal.waitFor();
 assert.equal(await modal.getByRole('button',{name:'Undo these changes',exact:true}).isDisabled(),true);await modal.getByText('app.js',{exact:true}).waitFor();await modal.getByText('removed.js',{exact:true}).waitFor();
 await modal.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(requests.filter(value=>value.op==='task-undo-apply').length,0);
 await review.click();await modal.getByRole('checkbox').check();await modal.getByRole('button',{name:'Undo these changes',exact:true}).click();await page.getByText('Source changed since preview',{exact:true}).waitFor();assert.equal(await page.getByText('Safe task changes undone. Conflicting and unsupported files were kept.',{exact:true}).count(),0);
 stale=false;await review.click();await modal.getByRole('checkbox').check();await modal.getByRole('button',{name:'Undo these changes',exact:true}).click();await page.getByText('Safe task changes undone. Conflicting and unsupported files were kept.',{exact:true}).waitFor();
 assert.equal(requests.filter(value=>value.op==='task-undo-apply').length,2);assert.deepEqual(errors,[]);
});
