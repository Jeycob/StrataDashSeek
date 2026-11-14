'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('Native views isolate files, retain drafts, use safe CRUD and never wake on read',async t=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
 const requests=[],files={s1:{'a.txt':'alpha'},s2:{'b.txt':'beta'}},versions={s1:'v1',s2:'v2'};
 const workbench={trash:{},running:[],defaults:{},environment:{},workspaces:[{id:'w1',title:'Workspace',sessionIds:['s1','s2'],settings:{}}],projects:{s1:{root:'/data/harness/workspaces/projects/a'},s2:{root:'/data/harness/workspaces/projects/b'}}};
 const apps={enabled:true,available:true,busy:false,worker:{managed:true,phase:'ready'},previewSettings:{configured:true,enabled:true},holdUntil:0,projects:[],containers:[{id:'c1',name:'fixture',state:'running',ports:[]}],jobs:[],remoteTargets:[],vault:{configured:false}};
 const routes={'/i18n.js':'shared/i18n.cjs','/apps.js':'mobile/apps.js','/workbench.js':'workspace/client.js'};
 const server=http.createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;const value=body?JSON.parse(body):null;requests.push({url:req.url,body:value});res.setHeader('Content-Type','application/json');
  if(routes[req.url]){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,routes[req.url])));}
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0}main{display:grid;grid-template-columns:1fr 1fr;max-width:100%}main>div{min-width:0}@media(max-width:600px){main{grid-template-columns:1fr}}</style><main><div id="one"></div><div id="two"></div><div id="docker"></div><div id="deployment"></div></main><script>window.HARNESS_NATIVE_WORKBENCH=true</script><script src="/i18n.js"></script><script src="/apps.js"></script><script src="/workbench.js"></script>');}
  if(req.url==='/api/session/list')return res.end(JSON.stringify({result:{ok:true,value:{items:[{sessionId:'s1',title:'One'},{sessionId:'s2',title:'Two'}]}}}));
  if(req.url==='/api/session/modelCatalog')return res.end(JSON.stringify({result:{ok:true,value:{groups:[]}}}));
  if(req.url==='/api/workbench'){
   if(!value)return res.end(JSON.stringify(workbench));
   assert.equal(value.op,'file');const f=files[value.sessionId];assert.ok(f);const a=value.args;
   if(value.operation==='list')return res.end(JSON.stringify({entries:Object.keys(f).map(name=>({name,directory:false}))}));
   if(value.operation==='read')return res.end(JSON.stringify({path:a.path,text:f[a.path],version:versions[value.sessionId]}));
   if(['write','delete'].includes(value.operation)){assert.equal(a.version,versions[value.sessionId]);if(value.operation==='delete')delete f[a.path];else f[a.path]=a.text;return res.end(JSON.stringify({version:versions[value.sessionId]}));}
  }
  if(req.url==='/phone/api/apps/state')return res.end(JSON.stringify(apps));
  if(req.url.startsWith('/phone/api/apps/container-log'))return res.end(JSON.stringify({text:'fixture runtime log'}));
  if(req.url==='/phone/api/apps/container-action'){apps.containers[0].state=value.action==='stop'?'exited':'running';return res.end('{}');}
  res.writeHead(404);res.end('{}');
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(()=>{HarnessI18n.setLanguage('en');window.a=HarnessWorkbench.mount(document.querySelector('#one'),{sessionId:'s1',instanceId:'tab1'});window.b=HarnessWorkbench.mount(document.querySelector('#two'),{sessionId:'s2',instanceId:'tab2'});window.docker=HarnessApps.mount(document.querySelector('#docker'),{visible:()=>true});window.deployment=HarnessApps.mount(document.querySelector('#deployment'),{settings:true,visible:()=>true});});
  await page.locator('#one .wb-tree button',{hasText:'a.txt'}).click();await page.locator('#two .wb-tree button',{hasText:'b.txt'}).click();
  assert.equal(await page.locator('#one textarea').inputValue(),'alpha');assert.equal(await page.locator('#two textarea').inputValue(),'beta');
  await page.locator('#one textarea').fill('unsaved draft');
  await page.evaluate(()=>a.notifyChange());await page.locator('#one [id$="wb-message"]').filter({hasText:'Files changed.'}).waitFor();assert.equal(await page.locator('#one textarea').inputValue(),'unsaved draft');
  await page.evaluate(()=>{a.destroy();window.a=HarnessWorkbench.mount(document.querySelector('#one'),{sessionId:'s1',instanceId:'new-tab-id'});});
  await page.waitForFunction(()=>document.querySelector('#one textarea')?.value==='unsaved draft');
  await page.getByRole('button',{name:'Save',exact:true}).first().click();await page.waitForFunction(()=>!window.a.dirty);assert.equal(files.s1['a.txt'],'unsaved draft');
  await page.locator('#one').getByRole('button',{name:'Delete',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#one textarea'));assert.equal(files.s2['b.txt'],'beta');
  assert.equal(await page.locator('[id]').evaluateAll(nodes=>new Set(nodes.map(n=>n.id)).size===nodes.length),true,'view IDs are unique');
  await page.locator('#docker').getByRole('button',{name:'Logy',exact:true}).click();await page.locator('#docker pre').filter({hasText:'fixture runtime log'}).waitFor();
  await page.locator('#docker').getByRole('button',{name:'Zastavit',exact:true}).click();await page.locator('#docker').getByRole('button',{name:'Spustit',exact:true}).waitFor();
  assert.equal(requests.some(r=>r.url.includes('worker-action')),false);
  assert.equal(await page.locator('#deployment [id$="apps-settings-group"]').isVisible(),true);
  assert.equal(await page.locator('#docker [id$="apps-settings-group"]').isVisible(),false);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile has no horizontal page overflow');
  assert.deepEqual(errors,[]);
 }finally{await page.evaluate(()=>{a?.destroy();b?.destroy();docker?.destroy();deployment?.destroy();}).catch(()=>{});await browser.close();await new Promise(r=>server.close(r));}
});
