'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
async function fixture(t){
 const requests=[],context={scope:'project',sessionId:'fixture-chat',projectId:'a'.repeat(16)},items=[{kind:'image',id:'sha256:'+ 'a'.repeat(64),name:'Shared base',state:'unused',sizeBytes:1024,shared:true,protected:true,reasons:['rollback-reference'],actions:[]},{kind:'container',id:'b'.repeat(64),name:'Fixture notes',state:'running',sizeBytes:2048,actions:['stop','delete','export']}];let uncertain=true,operation;
 const server=http.createServer(async(req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="anchor"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.HarnessI18n={language:"en",locale:"en-US"};</script><script src="/apps.js"></script>');}if(req.url==='/apps.js'){res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(__dirname,'apps.js')));}let text='';for await(const chunk of req)text+=chunk;const data=text?JSON.parse(text):null,url=new URL(req.url,'http://fixture');requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),data});const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,context,...value}));};
  if(url.pathname==='/api/resources'&&url.searchParams.has('operationId'))return json({operation:{...operation,state:'completed',...(operation.action==='export'?{export:{format:'container-filesystem',bytes:100,includesVolumes:false,includesRestoreConfig:false,expiresAt:Date.now()+60000}}:{})}});
  if(url.pathname==='/api/resources')return json({availability:'ready',observedAt:Date.now(),stale:false,inventoryId:'inventory-1',items:url.searchParams.has('cursor')?[{kind:'image',id:'sha256:'+ 'c'.repeat(64),name:'Inactive image',state:'unused',sizeBytes:4096,actions:['delete','export']}]:items,nextCursor:url.searchParams.has('cursor')?null:'page2',totalKnown:3});
  if(url.pathname==='/api/resource-action'){if(data.phase==='preview')return json({plan:{planId:'plan1',planHash:'hash1',expiresAt:Date.now()+60000,kind:data.kind,id:data.id,action:data.action,blocked:false,reasons:[],warning:data.action==='delete'?'Writable layer will be lost':'',format:'container-filesystem',includesVolumes:false,includesRestoreConfig:false},operation:null});operation={operationId:data.operationId,planId:data.planId,state:'queued',action:data.action,jobId:'job-1'};if(uncertain){uncertain=false;res.writeHead(503);return res.end("Operation outcome unknown");}return json({operation});}
  res.writeHead(404);res.end();
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>{window.controller=new AbortController();window.view=HarnessDockerResources.mount(document.getElementById('anchor'),{scope:'project',sessionId:'fixture-chat',signal:controller.signal,blocked:()=>false,visible:()=>true,url:route=>'/phone/api/apps/'+route+'&sessionId=fixture-chat',api:async(route,data)=>{const response=await fetch('/api/'+route,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});if(!response.ok)throw Error('API failure');return response.json();}});void view.refresh();});return{page,requests,errors};
}
test('resource inventory paginates, protects shared items, previews deletion and reconciles the same operation after transport failure',async t=>{
 const f=await fixture(t),p=f.page;await p.getByText('Shared base',{exact:true}).waitFor();assert.equal(await p.locator('[data-resource-id="sha256:'+ 'a'.repeat(64)+'"] button').count(),0);await p.getByRole('button',{name:'Load more',exact:true}).click();await p.getByText('Inactive image',{exact:true}).waitFor();assert.match(await p.locator('.apps-resource-inventory').innerText(),/3 \/ 3 known resources/);
 const container=p.locator('[data-resource-id="'+ 'b'.repeat(64)+'"]');await container.getByRole('button',{name:'Delete',exact:true}).click();await p.getByText('Deleting loses the container’s writable layer. Volumes are not deleted.',{exact:true}).waitFor();assert.equal(f.requests.filter(r=>r.data?.phase==='apply').length,0);await p.getByRole('button',{name:'Confirm this operation',exact:true}).click();await p.getByText(/Outcome not confirmed/).waitFor();await p.getByRole('button',{name:'Check original operation',exact:true}).click();await p.getByText('completed',{exact:true}).waitFor();const mutations=f.requests.filter(r=>r.data?.phase==='apply');assert.equal(mutations.length,1);assert.equal(mutations[0].data.id,'b'.repeat(64));assert.equal(mutations[0].data.planHash,'hash1');assert(f.requests.some(r=>r.query.operationId===mutations[0].data.operationId));assert.deepEqual(f.errors,[]);
});
test('container export explains exclusions and only offers an authenticated scoped download after completion',async t=>{
 const f=await fixture(t),p=f.page;const container=p.locator('[data-resource-id="'+ 'b'.repeat(64)+'"]');await container.getByRole('button',{name:'Export / download',exact:true}).click();await p.getByText('Container filesystem only. Excludes volumes and full restore configuration.',{exact:true}).waitFor();assert.equal(await p.getByRole('link',{name:'Download export'}).count(),0);await p.getByRole('button',{name:'Confirm this operation',exact:true}).click();await p.getByText(/Outcome not confirmed/).waitFor();await p.getByRole('button',{name:'Check original operation',exact:true}).click();const download=p.getByRole('link',{name:'Download export',exact:true});await download.waitFor();assert.match(await download.getAttribute('href'),/^\/phone\/api\/apps\/resource-export-download\?operationId=[a-f0-9]{32}&sessionId=fixture-chat$/);assert.match(await p.locator('.apps-resource-inventory').innerText(),/No volumes or full restore configuration/);assert.deepEqual(f.errors,[]);
});

// Mount the current Apps controller, including its binding/lifetime/timeout API.
// Every object and operation below is synthetic and served on a fresh loopback port.
async function mountedFixture(t,{scope='project',language='en',width=390,count=2}={}){
 const requests=[],errors=[],operations=new Map(),held=[];
 const controls={enabled:true,available:true,stale:false,observedAt:()=>Date.now(),previewExpiry:()=>Date.now()+60000,failApply:false,forceContext:null,changedPage:false,holdQuery:null,holdSession:null};
 const state={enabled:true,available:true,busy:null,worker:{managed:true,phase:'ready'},previewSettings:{configured:false,enabled:false},holdUntil:0,vault:{configured:false},remoteTargets:[],features:{},deploymentRecovery:{version:1,required:false,projects:[],transactions:[]},projects:[],containers:[],jobs:[]};
 const item=(index,session)=>({kind:index===0?'image':'container',id:index===0?'sha256:'+'a'.repeat(64):(index+16).toString(16).padStart(64,'0'),name:(session||'global')+' resource '+index,state:index===0?'unused':'running',sizeBytes:4096,actions:index===0?['delete','export']:['stop','delete','export'],sessionIds:['fixture-chat','other-chat']});
 const context=(url,data)=>{const global=url.searchParams.get('scope')==='global',sessionId=url.searchParams.get('sessionId')||data?.sessionId;return global?{scope:'global',workspaceId:null,sessionId:null,projectId:null}:{scope:'project',workspaceId:'fixture-workspace',sessionId,projectId:controls.forceContext||(sessionId==='other-chat'?'b':'a').repeat(16)};};
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0}#app{width:100%;min-width:0}</style><div id="app"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;AbortSignal.any=undefined;AbortSignal.timeout=undefined;</script><script src="/i18n.js"></script><script src="/apps.js"></script>');}
  if(['/apps.js','/i18n.js'].includes(url.pathname)){res.setHeader('Content-Type','application/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(__dirname,url.pathname==='/apps.js'?'apps.js':'../shared/i18n.cjs')));}
  let text='';for await(const chunk of req)text+=chunk;const data=text?JSON.parse(text):null,ctx=context(url,data);requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),data});
  const json=value=>{if(res.destroyed)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,context:ctx,...value}));};
  const route=url.pathname.replace('/phone/api/apps/','');
  if(route==='state')return json({...state,enabled:controls.enabled,available:controls.available});
  if(route==='resources'&&url.searchParams.has('operationId')){const op=operations.get(url.searchParams.get('operationId'));return json({operation:{...op,state:'completed',...(op?.action==='export'?{export:{format:op.kind==='image'?'docker-image-archive':'container-filesystem',bytes:1234,includesVolumes:false,includesRestoreConfig:false,expiresAt:Date.now()+60000}}:{})}});}
  if(route==='resources'){
   const q=url.searchParams.get('q')||'',offset=Number(url.searchParams.get('cursor')||0),session=ctx.sessionId||'global',items=controls.itemsForSession?.(session)??(q?[{...item(1,session),name:q+' result'}]:Array.from({length:count},(_,i)=>item(i,session))),respond=()=>json({inventoryId:controls.changedPage&&offset?'changed':'snapshot-1',availability:'ready',stale:controls.stale,observedAt:controls.observedAt(),items:items.slice(offset,offset+50),totalKnown:items.length,nextCursor:offset+50<items.length?String(offset+50):null});
   if(q&&q===controls.holdQuery||controls.holdSession&&ctx.sessionId===controls.holdSession){held.push(respond);return;}return respond();
  }
  if(route==='resource-action'){
   if(data.phase==='preview')return json({plan:{planId:'fixture-plan',planHash:'fixture-hash',expiresAt:controls.previewExpiry(),id:data.id,kind:data.kind,action:data.action,blocked:false,reasons:[]}});
   const operation={operationId:data.operationId,planId:data.planId,kind:data.kind,id:data.id,action:data.action,state:'queued'};operations.set(data.operationId,operation);
   if(controls.failApply){controls.failApply=false;res.writeHead(503);return res.end('Outcome unknown');}return json({operation});
  }
  if(route==='container-log')return json({text:'Synthetic resource log'});
  if(route==='cleanup')return json({enabled:false,availability:'ready',inventory:[]});
  res.writeHead(404);res.end('{}');
 }catch(error){if(!res.destroyed){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width,height:950}});page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await page.evaluate(()=>appView?.destroy()).catch(()=>{});for(const release of held.splice(0))release();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(({scope,language})=>{HarnessI18n.setLanguage(language);window.mountOptions={scope,sessionId:scope==='project'?'fixture-chat':undefined,workspaceId:scope==='project'?'fixture-workspace':undefined,settings:scope==='global'};window.appView=HarnessApps.mount(document.getElementById('app'),mountOptions);},{scope,language});
 await page.locator('.apps-resource').first().waitFor();return{page,controls,state,requests,errors,operations,held,async release(){for(const fn of held.splice(0))fn();}};
}

test('current Apps mount loads all105 resources without silent truncation, then rejects a changed inventory page',async t=>{
 const f=await mountedFixture(t,{count:105,width:1280}),p=f.page,box=p.locator('.apps-resource-inventory');assert.equal(await box.locator('.apps-resource').count(),50);
 await box.getByRole('button',{name:'Load more',exact:true}).click();await p.waitForFunction(()=>document.querySelectorAll('.apps-resource').length===100);await box.getByRole('button',{name:'Load more',exact:true}).click();await p.waitForFunction(()=>document.querySelectorAll('.apps-resource').length===105);assert.match(await box.innerText(),/105 \/ 105 known resources/);assert.equal(await box.getByRole('button',{name:'Load more',exact:true}).isHidden(),true);
 assert.deepEqual(f.requests.filter(r=>r.path.endsWith('/resources')).map(r=>r.query.cursor),[undefined,'50','100']);
 await box.getByRole('button',{name:'Refresh inventory',exact:true}).click();await p.waitForFunction(()=>document.querySelectorAll('.apps-resource').length===50);f.controls.changedPage=true;await box.getByRole('button',{name:'Load more',exact:true}).click();await box.getByRole('alert').filter({hasText:'Inventory changed'}).waitFor();assert.equal(await box.locator('.apps-resource').count(),50);assert.match(await box.innerText(),/retained snapshot, not a live census/);assert.equal(await box.locator('.apps-resource button:enabled').count(),0);assert.deepEqual(f.errors,[]);
});

test('Apps OFF keeps a disabled stored snapshot, blocks forced actions/logs and needs a fresh inventory after reenable',async t=>{
 const f=await mountedFixture(t),p=f.page,box=p.locator('.apps-resource-inventory');f.controls.enabled=false;await p.evaluate(()=>appView.refresh());assert.match(await box.innerText(),/Applications are disabled.*retained snapshot, not a live census/s);assert.equal(await box.locator('.apps-resource button:enabled').count(),0);
 await box.locator('.apps-resource button').evaluateAll(buttons=>buttons.forEach(button=>{button.disabled=false;button.click();}));assert.equal(f.requests.filter(r=>r.path.endsWith('/resource-action')||r.path.endsWith('/container-log')).length,0);
 f.controls.enabled=true;await p.evaluate(()=>appView.refresh());assert.match(await box.innerText(),/retained snapshot, not a live census/);assert.equal(await box.locator('.apps-resource button:enabled').count(),0);await box.getByRole('button',{name:'Refresh inventory',exact:true}).click();await p.waitForFunction(()=>!!document.querySelector('.apps-resource button:not(:disabled)'));assert.equal(f.requests.filter(r=>r.data).length,0);assert.deepEqual(f.errors,[]);
});

test('unknown freshness and expired observations never enable resource mutations',async t=>{
 const f=await mountedFixture(t),p=f.page,box=p.locator('.apps-resource-inventory');
 for(const stale of [undefined,true]){f.controls.stale=stale;await box.getByRole('button',{name:'Refresh inventory',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('.apps-resource-inventory>div button').disabled);assert.equal(await box.locator('.apps-resource button:enabled').count(),0);}
 f.controls.stale=false;f.controls.observedAt=()=>Date.now()-31000;await box.getByRole('button',{name:'Refresh inventory',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('.apps-resource-inventory>div button').disabled);assert.match(await box.innerText(),/retained snapshot, not a live census/);assert.equal(await box.locator('.apps-resource button:enabled').count(),0);assert.equal(f.requests.filter(r=>r.data).length,0);
});

test('a delayed old search cannot overwrite the newest resource query',async t=>{
 const f=await mountedFixture(t),p=f.page,box=p.locator('.apps-resource-inventory');f.controls.holdQuery='slow';const search=box.getByRole('searchbox');await search.fill('slow');await assertEventually(()=>f.requests.some(r=>r.query.q==='slow'));await search.fill('newest');await box.getByText('newest result',{exact:true}).waitFor();await f.release();await p.waitForTimeout(100);assert.equal(await box.getByText('slow result',{exact:true}).count(),0);assert.equal(await search.inputValue(),'newest');assert.deepEqual(f.errors,[]);
});

test('fast conversation switch aborts the old API lifetime even when its transport ignores the abort signal',async t=>{
 const f=await mountedFixture(t),p=f.page;f.controls.holdSession='fixture-chat';await p.evaluate(()=>{const original=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/resources')){const {signal,...rest}=options||{};return original(url,rest);}return original(url,options);};});await p.locator('.apps-resource-inventory').getByRole('button',{name:'Refresh inventory',exact:true}).click();await assertEventually(()=>f.held.length===1);
 await p.evaluate(()=>{appView.destroy();window.appView=HarnessApps.mount(document.getElementById('app'),{scope:'project',sessionId:'other-chat',workspaceId:'fixture-workspace'});});await p.getByText('other-chat resource 0',{exact:true}).waitFor();await f.release();await p.waitForTimeout(100);assert.equal(await p.getByText('fixture-chat resource 0',{exact:true}).count(),0);assert.equal(await p.locator('.apps-resource-inventory').count(),1);assert(f.requests.some(r=>r.query.sessionId==='other-chat'));assert.equal(f.requests.filter(r=>r.data).length,0);assert.deepEqual(f.errors,[]);
});

test('the owner sidebar shows container actions in order and a different chat has none', async t => {
 const f = await mountedFixture(t), { page } = f, box = page.locator('.apps-resource-inventory');
 const id = 'f'.repeat(64), row = box.locator('[data-resource-id="' + id + '"]');
 f.controls.itemsForSession = session => {
  if (session !== 'fixture-chat') return [];
  const stopped = [...f.operations.values()].some(operation => operation.action === 'stop' && operation.id === id);
  return [{ kind: 'container', id, name: 'Owned container', state: stopped ? 'exited' : 'running',
   actions: stopped ? ['delete', 'export'] : ['stop'] }];
 };
 await box.getByRole('button', { name: 'Refresh inventory', exact: true }).click();
 await row.getByRole('button', { name: 'Stop', exact: true }).click();
 assert.equal(await row.getByRole('button', { name: 'Delete', exact: true }).count(), 0);
 assert.equal(await row.getByRole('button', { name: 'Export / download', exact: true }).count(), 0);
 await box.getByRole('button', { name: 'Confirm this operation', exact: true }).click();
 await box.getByRole('button', { name: 'Check original operation', exact: true }).click();
 await box.getByText('completed', { exact: true }).waitFor();
 await box.getByRole('button', { name: 'Refresh inventory', exact: true }).click();
 await row.getByRole('button', { name: 'Export / download', exact: true }).waitFor();
 assert.equal(await row.getByRole('button', { name: 'Delete', exact: true }).isEnabled(), true);
 assert.equal(await row.getByRole('button', { name: 'Stop', exact: true }).count(), 0);

 const other = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/resources')
   && new URL(response.url()).searchParams.get('sessionId') === 'other-chat');
 await page.evaluate(() => {
  appView.destroy();
  window.appView = HarnessApps.mount(document.getElementById('app'), {
   scope: 'project', sessionId: 'other-chat', workspaceId: 'fixture-workspace',
  });
 });
 await other;
 await row.waitFor({ state: 'detached' });
 for (const name of ['Stop', 'Export / download', 'Delete']) {
  assert.equal(await box.getByRole('button', { name, exact: true }).count(), 0);
 }
 assert.deepEqual(f.requests.filter(request => request.data?.phase === 'apply')
   .map(request => [request.data.sessionId, request.data.action]), [['fixture-chat', 'stop']]);
 assert.deepEqual(f.errors, []);
});

test('uncertain stop is reconciled under its original operation after remount, with immutable session references',async t=>{
 const f=await mountedFixture(t),p=f.page,box=p.locator('.apps-resource-inventory');f.controls.failApply=true;await box.getByRole('button',{name:'Stop',exact:true}).click();await box.getByRole('button',{name:'Confirm this operation',exact:true}).click();await box.getByText(/Outcome not confirmed/).waitFor();const sent=f.requests.find(r=>r.data?.phase==='apply');assert.equal(sent.data.sessionId,'fixture-chat');assert.equal(sent.data.workspaceId,'fixture-workspace');assert.equal(sent.data.planHash,'fixture-hash');
 await box.locator('.apps-resource button').evaluateAll(buttons=>buttons.forEach(button=>{button.disabled=false;button.click();}));assert.equal(f.requests.filter(r=>r.data?.phase==='apply').length,1);
 await p.evaluate(()=>{appView.destroy();window.appView=HarnessApps.mount(document.getElementById('app'),mountOptions);});await p.locator('.apps-resource-inventory').getByText('completed',{exact:true}).waitFor();assert.equal(f.requests.filter(r=>r.data?.phase==='apply').length,1);assert(f.requests.some(r=>r.query.operationId===sent.data.operationId&&r.query.sessionId==='fixture-chat'));assert.deepEqual(f.errors,[]);
});

for(const language of ['en','cs'])test(`global ${language} resource UI distinguishes image archives and container filesystems on mobile`,async t=>{
 const f=await mountedFixture(t,{scope:'global',language}),p=f.page,box=p.locator('.apps-resource-inventory'),exportName=language==='cs'?'Export / stáhnout':'Export / download',confirm=language==='cs'?'Potvrdit tuto operaci':'Confirm this operation',download=language==='cs'?'Stáhnout export':'Download export';
 assert.match(await box.innerText(),language==='cs'?/Všechny známé Docker/:/All known Docker/);await box.locator('.apps-resource').first().getByRole('button',{name:exportName,exact:true}).click();await box.getByText(language==='cs'?'Archiv Docker image. Neobsahuje běžící kontejnery ani volumes.':'Docker image archive. Does not include running containers or volumes.',{exact:true}).waitFor();await box.getByRole('button',{name:confirm,exact:true}).click();await box.getByRole('button',{name:language==='cs'?'Ověřit původní operaci':'Check original operation',exact:true}).click();const link=box.getByRole('link',{name:download,exact:true});await link.waitFor();assert.match(await link.getAttribute('href'),/^\/phone\/api\/apps\/resource-export-download\?operationId=[a-f0-9]{32}&scope=global$/);assert.match(await box.innerText(),/docker-image-archive/);assert(f.requests.filter(r=>r.data).every(r=>r.data.confirmGlobal===true&&r.query.scope==='global'));
 await box.locator('.apps-resource').nth(1).getByRole('button',{name:exportName,exact:true}).click();await box.getByText(language==='cs'?'Pouze souborový systém kontejneru. Bez volumes a úplné konfigurace pro obnovu.':'Container filesystem only. Excludes volumes and full restore configuration.',{exact:true}).waitFor();assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(f.errors,[]);
});

async function assertEventually(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}assert(predicate(),'fixture condition was not observed');}

test('recovery and changed server binding invalidate a retained resource confirmation before any apply',async t=>{
 const f=await mountedFixture(t),p=f.page,box=p.locator('.apps-resource-inventory');await box.getByRole('button',{name:'Stop',exact:true}).click();const confirm=box.getByRole('button',{name:'Confirm this operation',exact:true});await confirm.waitFor();await confirm.evaluate(e=>window.oldResourceConfirm=e);
 f.state.deploymentRecovery.required=true;await p.evaluate(()=>appView.refresh());assert.equal(await box.locator('[data-resource-confirm]').count(),0);await p.evaluate(()=>oldResourceConfirm.click());assert.equal(f.requests.filter(r=>r.data?.phase==='apply').length,0);
 f.state.deploymentRecovery.required=false;f.controls.forceContext='b'.repeat(16);await p.evaluate(()=>appView.refresh());assert.match(await p.locator('[data-apps-context]').innerText(),/binding changed/);await box.locator('.apps-resource button').evaluateAll(buttons=>buttons.forEach(b=>{b.disabled=false;b.click();}));assert.equal(f.requests.filter(r=>r.data?.phase==='apply').length,0);assert.deepEqual(f.errors,[]);
});

test('an expired resource plan is discarded without dispatching an apply',async t=>{
 const f=await mountedFixture(t),p=f.page,box=p.locator('.apps-resource-inventory');f.controls.previewExpiry=()=>Date.now()+500;await box.getByRole('button',{name:'Stop',exact:true}).click();await box.getByRole('button',{name:'Confirm this operation',exact:true}).waitFor();await p.waitForTimeout(550);await box.getByRole('button',{name:'Confirm this operation',exact:true}).click();await box.getByRole('alert').filter({hasText:'Plan expired'}).waitFor();assert.equal(f.requests.filter(r=>r.data?.phase==='apply').length,0);assert.equal(await box.locator('[data-resource-confirm]').count(),0);assert.deepEqual(f.errors,[]);
});
