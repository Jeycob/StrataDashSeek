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
  if(routes[req.url]){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,routes[req.url])));}
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0}main{display:grid;grid-template-columns:1fr 1fr;max-width:100%}main>div{min-width:0}@media(max-width:600px){main{grid-template-columns:1fr}}</style><main><div id="one"></div><div id="two"></div><div id="docker"></div><div id="deployment"></div></main><script>window.HARNESS_NATIVE_WORKBENCH=true</script><script src="/i18n.js"></script><script src="/apps.js"></script><script src="/workbench.js"></script>');}
  if(req.url==='/api/session/list')return res.end(JSON.stringify({result:{ok:true,value:{items:[{sessionId:'s1',title:'One'},{sessionId:'s2',title:'Two'}]}}}));
  if(req.url==='/api/session/modelCatalog')return res.end(JSON.stringify({result:{ok:true,value:{groups:[]}}}));
  if(req.url==='/api/workbench'){
   if(!value)return res.end(JSON.stringify(workbench));
   assert.equal(value.op,'file');const f=files[value.sessionId];assert.ok(f);const a=value.args;
   if(value.operation==='list')return res.end(JSON.stringify({entries:Object.keys(f).map(name=>({name,directory:false}))}));
   if(value.operation==='read')return res.end(JSON.stringify({path:a.path,text:f[a.path],version:versions[value.sessionId]}));
   if(['write','delete'].includes(value.operation)){assert.equal(a.version,versions[value.sessionId]);if(value.operation==='delete')delete f[a.path];else f[a.path]=a.text;return res.end(JSON.stringify({version:versions[value.sessionId]}));}
  }
  if(req.url.startsWith('/phone/api/apps/state?'))return res.end(JSON.stringify({...apps,context:{scope:'global',workspaceId:null,sessionId:null,projectId:null}}));
  if(req.url.startsWith('/phone/api/apps/container-log'))return res.end(JSON.stringify({text:'fixture runtime log',context:{scope:'global',workspaceId:null,sessionId:null,projectId:null}}));
  if(req.url.startsWith('/phone/api/apps/container-action?')){apps.containers[0].state=value.action==='stop'?'exited':'running';return res.end(JSON.stringify({context:{scope:'global',workspaceId:null,sessionId:null,projectId:null}}));}
  res.writeHead(404);res.end('{}');
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(()=>{HarnessI18n.setLanguage('en');window.a=HarnessWorkbench.mount(document.querySelector('#one'),{sessionId:'s1',instanceId:'tab1'});window.b=HarnessWorkbench.mount(document.querySelector('#two'),{sessionId:'s2',instanceId:'tab2'});window.docker=HarnessApps.mount(document.querySelector('#docker'),{scope:'global',visible:()=>true});window.deployment=HarnessApps.mount(document.querySelector('#deployment'),{scope:'global',settings:true,visible:()=>true});});
  await page.locator('#one .wb-tree button',{hasText:'a.txt'}).click();await page.locator('#two .wb-tree button',{hasText:'b.txt'}).click();
  assert.equal(await page.locator('#one textarea').inputValue(),'alpha');assert.equal(await page.locator('#two textarea').inputValue(),'beta');
  await page.locator('#one textarea').fill('unsaved draft');
  await page.evaluate(()=>a.notifyChange());await page.locator('#one [id$="wb-message"]').filter({hasText:'Files changed.'}).waitFor();assert.equal(await page.locator('#one textarea').inputValue(),'unsaved draft');
  await page.evaluate(()=>{a.destroy();window.a=HarnessWorkbench.mount(document.querySelector('#one'),{sessionId:'s1',instanceId:'new-tab-id'});});
  await page.waitForFunction(()=>document.querySelector('#one textarea')?.value==='unsaved draft');
  await page.getByRole('button',{name:'Save',exact:true}).first().click();await page.waitForFunction(()=>!window.a.dirty);assert.equal(files.s1['a.txt'],'unsaved draft');
  await page.locator('#one').getByRole('button',{name:'Delete',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#one textarea'));assert.equal(files.s2['b.txt'],'beta');
  assert.equal(await page.locator('[id]').evaluateAll(nodes=>new Set(nodes.map(n=>n.id)).size===nodes.length),true,'view IDs are unique');
  await page.locator('#docker').getByRole('button',{name:'Logs',exact:true}).click();await page.locator('#docker pre').filter({hasText:'fixture runtime log'}).waitFor();
  await page.locator('#docker').getByRole('button',{name:'Stop',exact:true}).click();await page.locator('#docker').getByRole('button',{name:'Start',exact:true}).waitFor();
  assert.equal(requests.some(r=>r.url.includes('worker-action')),false);
  assert.equal(await page.locator('#deployment [id$="apps-settings-group"]').isVisible(),true);
  assert.equal(await page.locator('#docker [id$="apps-settings-group"]').isVisible(),false);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile has no horizontal page overflow');
  assert.deepEqual(errors,[]);
 }finally{await page.evaluate(()=>{a?.destroy();b?.destroy();docker?.destroy();deployment?.destroy();}).catch(()=>{});await browser.close();await new Promise(r=>server.close(r));}
});

test('Apps reference drafts and request lifetimes survive real Chromium races in source and generated bundle',{timeout:45000},async t=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const asset of ['source','bundle'])await t.test(asset,{timeout:20000},async()=>{
  const own='a'.repeat(16),other='b'.repeat(16),requests=[],heldStates=[],heldLogs=[];
  let holdState=false,holdLog=false,failSave=false,failState=false,saveCount=0,stateCalls=0,abortedResponses=0;
  const credentials=id=>({scope:{projectId:'original-'+id,environment:'prod',secretPath:'/'},runtime:{API_KEY:'REFERENCE_'+id},build:{}});
  const apps={enabled:true,available:true,busy:false,worker:{managed:true,phase:'ready'},previewSettings:{configured:true,enabled:true},holdUntil:0,
   projects:[own,other].map((id,index)=>({id,name:index?'Other project':'Own project',path:'projects/'+id,port:3000,credentials:credentials(index?'B':'A')})),
   containers:[{id:'fixture-container',name:'fixture',state:'running',ports:[]}],jobs:[],remoteTargets:[],vault:{configured:true,origin:'https://eu.infisical.com',clientId:'public-fixture-id'}};
  const server=http.createServer(async(req,res)=>{try{
   let body='';for await(const chunk of req)body+=chunk;
   requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):undefined});
   res.on('close',()=>{if(!res.writableEnded)abortedResponses++;});
   const json=(value,status=200)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(status<400?{...value,context:{scope:'global',workspaceId:null,sessionId:null,projectId:null}}:value));}};
   if(req.url==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta name="viewport" content="width=device-width"><button id="outside">Outside editor</button><div id="host"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.__ModuleLoader__={load(){}};window.fetchRecords=[];const nativeFetch=window.fetch.bind(window);window.fetch=(url,init)=>{const record={url:String(url),aborted:false,bodyRead:false};fetchRecords.push(record);init?.signal?.addEventListener("abort",()=>record.aborted=true,{once:true});const options=window.ignoreLogAbort&&String(url).includes("container-log")?{...init,signal:undefined}:init;return nativeFetch(url,options).then(response=>{const nativeJSON=response.json.bind(response);response.json=async()=>{const result=await nativeJSON();record.bodyRead=true;return result};return response})};AbortSignal.any=undefined;AbortSignal.timeout=undefined;</script><script src="/client.js"></script>');
   }
   if(req.url==='/client.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,asset==='source'?'mobile/apps.js':'workspace/native-ui/client.js')));}
   if(req.url.startsWith('/phone/api/apps/state?')){stateCalls++;if(failState)return json({error:'fixture-state-unavailable'},503);const snapshot=structuredClone(apps);if(holdState){heldStates.push(()=>json(snapshot));return;}return json(snapshot);}
   if(req.url.startsWith('/phone/api/apps/project-settings?')){
    saveCount++;if(failSave)return json({error:'fixture-save-refused'},503);
    const input=JSON.parse(body),project=apps.projects.find(p=>p.id===input.id);assert.ok(project);
    project.credentials={scope:input.scope,runtime:input.runtime,build:input.build};return json(project);
   }
   if(req.url.startsWith('/phone/api/apps/container-log')){if(holdLog){heldLogs.push((status=200)=>json(status===200?{text:'LATE_LOG_MUST_NOT_RENDER'}:{error:'LATE_ERROR_MUST_NOT_RENDER'},status));return;}return json({text:'fixture log'});}
   return json({error:'unexpected fixture route'},404);
  }catch(error){if(!res.destroyed){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(4000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  const wait=async(predicate,label)=>{const end=Date.now()+3500;while(!predicate()){if(Date.now()>end)assert.fail(label);await new Promise(resolve=>setTimeout(resolve,20));}};
  const editor=id=>page.locator('[data-apps-credentials="'+id+'"]');
  const changeJobs=()=>{apps.jobs=[{id:'fixture-job-'+stateCalls,action:'build',status:'running',stage:'state-'+stateCalls}];};
  const releaseStates=()=>{holdState=false;for(const release of heldStates.splice(0))release();};
  try{
   await page.goto('http://127.0.0.1:'+server.address().port);
   await page.evaluate(()=>{window.view=HarnessApps.mount(document.querySelector('#host'),{scope:'global',visible:()=>true});});
   await editor(own).locator('summary').click();await editor(other).locator('summary').click();
   await editor(own).locator('input').nth(0).fill('  project-draft-A  ');
   await editor(own).locator('input').nth(1).fill('staging');await editor(own).locator('input').nth(2).fill('/draft-a');
   await editor(own).locator('textarea').nth(0).fill('API_KEY=NEW_REFERENCE_A');await editor(own).locator('textarea').nth(1).fill('NPM_AUTH=BUILD_REFERENCE_A');
   await editor(other).locator('textarea').nth(0).fill('API_KEY=UNSAVED_REFERENCE_B');
   // Recover the truthful status even when the successful JSON is unchanged.
   await page.locator('#outside').click();const healthyStatus=await page.locator('[id$="apps-connection"]').innerText(),beforeRecoveryCalls=stateCalls;
   await page.evaluate(id=>{window.beforeRecoveryDetails=document.querySelector('[data-apps-credentials="'+id+'"]');},own);
   failState=true;await page.evaluate(()=>view.refresh());
   assert.match(await page.locator('[id$="apps-connection"]').innerText(),/fixture-state-unavailable/);
   failState=false;await page.evaluate(()=>view.refresh());
   assert.equal(await page.locator('[id$="apps-connection"]').innerText(),healthyStatus,'same-state success must clear stale connection failure');
   assert.equal(stateCalls-beforeRecoveryCalls,2,'recovery uses only the two requested reads');
   assert.equal(await editor(own).evaluate(e=>e===window.beforeRecoveryDetails),true,'status recovery does not replace the credential editor');
   assert.equal(await editor(own).evaluate(e=>e.open),true);assert.equal(await editor(own).locator('input').nth(0).inputValue(),'  project-draft-A  ');
   await page.locator('#outside').click();await page.evaluate(id=>{window.beforeDetails=document.querySelector('[data-apps-credentials="'+id+'"]');},own);
   changeJobs();await page.evaluate(()=>view.refresh());
   assert.equal(await editor(own).evaluate(e=>e!==window.beforeDetails),true,'actual render replaced old editor');
   assert.equal(await editor(own).evaluate(e=>e.open),true);assert.equal(await editor(other).evaluate(e=>e.open),true);
   assert.equal(await editor(own).locator('input').nth(0).inputValue(),'  project-draft-A  ');assert.equal(await editor(own).locator('input').nth(1).inputValue(),'staging');
   assert.equal(await editor(own).locator('input').nth(2).inputValue(),'/draft-a');assert.equal(await editor(own).locator('textarea').nth(0).inputValue(),'API_KEY=NEW_REFERENCE_A');
   assert.equal(await editor(other).locator('textarea').nth(0).inputValue(),'API_KEY=UNSAVED_REFERENCE_B');
   failSave=true;await editor(own).getByRole('button',{name:'Save references',exact:true}).click();
   await page.locator('[id$="apps-error"]').filter({hasText:'fixture-save-refused'}).waitFor();assert.equal(saveCount,1);
   await page.locator('#outside').click();changeJobs();await page.evaluate(()=>view.refresh());
   assert.equal(await editor(own).locator('input').nth(0).inputValue(),'  project-draft-A  ');assert.equal(await editor(own).evaluate(e=>e.open),true);
   // Hold a real HTTP GET snapshot from before the successful write.
   holdState=true;await page.evaluate(()=>{void view.refresh();});await wait(()=>heldStates.length>0,'stale state request must start');
   await page.evaluate(id=>{window.renderedProjectIds=[];window.savedObserver=new MutationObserver(()=>{const e=document.querySelector('[data-apps-credentials="'+id+'"] input');if(e)renderedProjectIds.push(e.value)});savedObserver.observe(view.element,{childList:true,subtree:true});},own);
   failSave=false;await editor(own).getByRole('button',{name:'Save references',exact:true}).click();
   await wait(()=>saveCount===2,'confirmed save must reach fixture');
   await page.waitForFunction(()=>fetchRecords.filter(r=>r.url.includes('/project-settings?')&&r.bodyRead).length===2);
   const stateBeforeRelease=stateCalls;releaseStates();
   await page.waitForFunction(id=>document.querySelector('[data-apps-credentials="'+id+'"] input')?.value==='project-draft-A',own);
   assert.ok(stateCalls>stateBeforeRelease,'one fresh state read follows discarded pre-save GET');
   assert.equal(await page.evaluate(()=>renderedProjectIds.includes('original-A')),false,'stale GET never flashes original references after confirmed save');
   assert.equal(await editor(own).evaluate(e=>e.open),true);assert.equal(await editor(other).locator('textarea').nth(0).inputValue(),'API_KEY=UNSAVED_REFERENCE_B');
   assert.equal(apps.projects[0].credentials.scope.projectId,'project-draft-A');assert.deepEqual(apps.projects[0].credentials.runtime,{API_KEY:'NEW_REFERENCE_A'});
   // A confirmed draft is released: a later authoritative state is visible.
   apps.projects[0].credentials.scope.environment='server-updated';changeJobs();await page.locator('#outside').click();await page.evaluate(()=>view.refresh());
   assert.equal(await editor(own).locator('input').nth(1).inputValue(),'server-updated');
   assert.equal(await page.evaluate(()=>localStorage.length),0,'reference drafts never enter persistent client storage');
   assert.equal((await context.cookies()).length,0);
   await page.evaluate(()=>savedObserver.disconnect());
   // Real fetch cancellation closes its HTTP connection on destroy.
   holdState=true;await page.evaluate(()=>{window.detached=view.element;window.detachedMutations=0;window.detachedObserver=new MutationObserver(rows=>detachedMutations+=rows.length);detachedObserver.observe(detached,{childList:true,subtree:true,characterData:true});void view.refresh();});
   await wait(()=>heldStates.length>0,'state request held before destroy');
   // The resource widget removes its own box synchronously during destroy.
   // Exclude only that teardown record; keep observing every later mutation.
   const abortedBefore=abortedResponses;await page.evaluate(()=>{view.destroy();for(const row of detachedObserver.takeRecords())if(row.type!=='childList'||row.addedNodes.length||![...row.removedNodes].every(node=>node.classList?.contains('apps-resource-inventory')))throw Error('Unexpected synchronous destroy mutation');if(detached.isConnected)throw Error('Destroyed view is still connected');});
   await page.waitForFunction(()=>fetchRecords.some(r=>r.url.includes('/state?')&&r.aborted));await wait(()=>abortedResponses>abortedBefore,'browser fetch abort closes held response');
   releaseStates();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.evaluate(()=>detachedMutations),0);await page.evaluate(()=>detachedObserver.disconnect());
   // Even a transport deliberately ignoring cancellation cannot publish late data/errors.
   for(const responseStatus of [200,503]){
    await page.evaluate(()=>{window.ignoreLogAbort=true;window.view=HarnessApps.mount(document.querySelector('#host'),{scope:'global',visible:()=>true});});
    await page.locator('#host').getByRole('button',{name:'Logs',exact:true}).waitFor();holdLog=true;
    await page.locator('#host').getByRole('button',{name:'Logs',exact:true}).click();await wait(()=>heldLogs.length>0,'late log request must start');
    await page.evaluate(()=>{window.detached=view.element;window.detachedMutations=0;window.detachedObserver=new MutationObserver(rows=>detachedMutations+=rows.length);detachedObserver.observe(detached,{childList:true,subtree:true,characterData:true});view.destroy();for(const row of detachedObserver.takeRecords())if(row.type!=='childList'||row.addedNodes.length||![...row.removedNodes].every(node=>node.classList?.contains('apps-resource-inventory')))throw Error('Unexpected synchronous destroy mutation');if(detached.isConnected)throw Error('Destroyed view is still connected');});
    await page.waitForFunction(()=>fetchRecords.filter(r=>r.url.includes('container-log')).at(-1)?.aborted);
    const release=heldLogs.shift();holdLog=false;release(responseStatus);
    await page.waitForFunction(()=>fetchRecords.filter(r=>r.url.includes('container-log')).at(-1)?.bodyRead);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>detachedMutations),0,'no late render or error text after destroy');
    assert.equal(await page.evaluate(()=>detached.textContent.includes('LATE_')),false);await page.evaluate(()=>detachedObserver.disconnect());
   }
   const countBefore=stateCalls;await page.evaluate(()=>view.refresh());assert.equal(stateCalls,countBefore,'destroyed view never polls');
   assert.equal(requests.some(r=>r.url.includes('worker-action')||r.url.includes('project-action')||r.url.includes('vault-config')),false,'read/save UI test never wakes or deploys');
   assert.deepEqual(errors,[]);
  }catch(error){throw new Error('Fixture host text: '+(await page.locator('#host').innerText().catch(()=>''))+'\nPage errors: '+JSON.stringify(errors),{cause:error});}finally{
   releaseStates();holdLog=false;for(const release of heldLogs.splice(0))release();
   await page.evaluate(()=>{window.savedObserver?.disconnect();window.detachedObserver?.disconnect();window.view?.destroy();}).catch(()=>{});
   await context.close();await new Promise(resolve=>server.close(resolve));
  }
 });
});
