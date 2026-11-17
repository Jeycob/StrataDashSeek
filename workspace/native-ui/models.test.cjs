'use strict';
// Actual pinned Native Host/browser; controlled data/model APIs, no model calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs'),{changesFixture}=require('./changes-scenarios.cjs');
test('Native scoped model selection retains Files drafts and Changes without a guest editor',{timeout:90000},async()=>{
 assert(process.env.HARNESS_NATIVE_CLI,'The actual pinned Native CLI is required');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-model-ui-')),tools=path.join(directory,'tools');fs.mkdirSync(tools);
 fs.writeFileSync(path.join(tools,'package.json'),JSON.stringify({name:'model-fixture',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));fs.writeFileSync(path.join(tools,'index.mjs'),'export function apply(){}');
 fs.writeFileSync(path.join(tools,'client.js'),"window.__ModuleLoader__.load({id:'model-fixture',factory:()=>({inject:['sessions'],apply(ctx){window.ModelFixture={create:cwd=>ctx.sessions.create({cwd})};}})});");
 const overlay=path.join(directory,'overlay.json');fs.writeFileSync(overlay,JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},{insert:[{id:'model-workbench',name:pathToFileURL(createSourceFixture(directory)).href},{id:'model-fixture',name:pathToFileURL(path.join(tools,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[process.env.HARNESS_NATIVE_CLI,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',browser,release;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Native model fixture did not start'));},40000),poll=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(poll);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',reject);});
  const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],modelWrites=[],fileWrites=[],choices=new Map(),changes=changesFixture();let hold=false;
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const defaults={provider:'local',model:'local-model'},groups=[{id:'local',name:'Local',models:[{id:'local-model',name:'Local model'}]},{id:'cloud',name:'Cloud',models:[{id:'cloud/model+preview',name:'Cloud model',reasoning:{efforts:[{id:'off',name:'Off'},{id:'max',name:'Maximum'}],defaultEffort:'max'}}]}],state={defaults,workspaces:[{id:'w1',title:'Workspace',sessionIds:[],settings:{}}],projects:{},trash:{},running:[]};
  await page.route('**/api/workbench/models**',async route=>{const request=route.request(),data=request.method()==='POST'?request.postDataJSON():null,id=data?.sessionId||new URL(request.url()).searchParams.get('sessionId');if(data){modelWrites.push(data);if(hold)await new Promise(resolve=>{release=resolve;});choices.set(id,data.selection);}return route.fulfill({json:{version:1,sessionId:id,source:choices.get(id)?'session':'workspace',selection:choices.get(id)||defaults,workspaceDefault:defaults,lastUsed:null,...(!data?{groups}:{} )}});});
  await page.route('**/api/workbench',route=>{const data=route.request().postDataJSON();if(!data)return route.fulfill({json:state});if(data.op==='changes')return changes.handle(route,data);assert.equal(data.op,'file');if(data.operation==='write')fileWrites.push(data);return route.fulfill({json:data.operation==='list'?{entries:[{name:'draft.txt',directory:false}]}:data.operation==='write'?{version:'v2'}:{path:'draft.txt',text:'saved-'+data.sessionId,version:'v1'}});});
  await page.goto(url);await page.waitForFunction(()=>window.HarnessNativeUI&&window.ModelFixture);const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.waitFor();await preview.click();await preview.waitFor({state:'hidden'});
  const first=await page.evaluate(cwd=>ModelFixture.create(cwd),directory),secondDir=path.join(directory,'second');fs.mkdirSync(secondDir);const second=await page.evaluate(cwd=>ModelFixture.create(cwd),secondDir);state.workspaces[0].sessionIds=[first,second];state.projects[first]={root:'/data/harness/workspaces/projects/first'};state.projects[second]={root:'/data/harness/workspaces/projects/second'};
  let targetSession=first;const panel=()=>page.locator('.harness-model-pane:has([data-harness-native-view="files"]) [data-model-session="'+targetSession+'"]:visible'),picker=()=>panel().getByRole('combobox',{name:'Model for this conversation',exact:true}),cloud=JSON.stringify({provider:'cloud',model:'cloud/model+preview'});
  const ready=async id=>{targetSession=id;await panel().locator('select:enabled').first().waitFor();};
  await page.evaluate(id=>HarnessNativeUI.openFiles(id),first);await ready(first);await picker().waitFor();await page.getByRole('button',{name:'draft.txt',exact:true}).click();await page.locator('.wb-editor:visible').fill('UNSAVED_FILE_DRAFT');
  hold=true;await picker().selectOption(cloud);await panel().getByRole('status').filter({hasText:'Saving model'}).waitFor();await page.evaluate(()=>HarnessI18n.setLanguage('cs'));assert.equal(await page.locator('.wb-editor:visible').inputValue(),'UNSAVED_FILE_DRAFT');assert.equal(await panel().getByRole('combobox',{name:'Model této konverzace',exact:true}).isDisabled(),true);
  while(!release)await new Promise(resolve=>setTimeout(resolve,10));hold=false;release();release=null;await ready(first);await page.evaluate(()=>HarnessI18n.setLanguage('en'));assert.equal(await picker().inputValue(),cloud);assert.equal(await page.locator('.wb-editor:visible').inputValue(),'UNSAVED_FILE_DRAFT');
  await panel().getByRole('combobox',{name:'Reasoning level',exact:true}).selectOption('max');await ready(first);assert.deepEqual(modelWrites.at(-1),{sessionId:first,selection:{provider:'cloud',model:'cloud/model+preview',reasoningEffort:'max'}});
  await page.evaluate(id=>HarnessNativeUI.openFiles(id),second);await page.waitForFunction(id=>Boolean(document.querySelector('[data-model-session="'+id+'"]')),second);await ready(second);await picker().waitFor();assert.equal(await picker().inputValue(),'workspace');assert.equal(choices.has(second),false);
  await page.evaluate(id=>HarnessNativeUI.openFiles(id),first);await ready(first);await picker().waitFor();await page.waitForFunction(()=>document.querySelector('.wb-editor')?.value==='UNSAVED_FILE_DRAFT');assert.equal(await picker().inputValue(),cloud);
  await page.evaluate(id=>HarnessNativeUI.openChanges(id),first);const diff=page.locator('[data-harness-changes-session="'+first+'"]:visible');await diff.getByRole('button',{name:/src\/app\.js/}).click();await diff.locator('.hc-code').filter({hasText:'const title = "After";'}).waitFor();assert.equal(await page.locator('iframe[data-editor-session]').count(),0);
  await page.evaluate(id=>HarnessNativeUI.openFiles(id),first);await ready(first);await picker().selectOption('workspace');await ready(first);assert.equal(await picker().inputValue(),'workspace');assert.equal(await page.locator('.wb-editor:visible').inputValue(),'UNSAVED_FILE_DRAFT');assert.equal(fileWrites.length,0,'model changes never save or discard the file draft');
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await panel().getByRole('combobox').evaluate(element=>element.getBoundingClientRect().right<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{
  release?.();if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('homeai-model-ui-'))throw Error('Unsafe fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});
 }
});

// Deliberately deliver canceled requests: AbortController alone cannot prove that
// a response/finally still belongs to the current component/session lifecycle.
function modelRaceBridge(){
 window.ModelLifecycleComponent=ConversationModel;
 const original=modelJSON,requests=[];window.ModelLifecycleWire={requests};
 modelJSON=(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null,sessionId=body?.sessionId||new URL(url,location.href).searchParams.get('sessionId');
  if(!sessionId?.startsWith('race-'))return original(url,options);
  return new Promise((resolve,reject)=>{
   const row={index:requests.length,sessionId,method:options.method||'GET',body,aborted:options.signal?.aborted===true,settled:false};
   const abort=()=>{row.aborted=true;};options.signal?.addEventListener('abort',abort);
   const finish=callback=>value=>{if(row.settled)throw Error('Fixture response already settled');row.settled=true;options.signal?.removeEventListener('abort',abort);callback(value);};
   row.resolve=finish(resolve);row.reject=finish(message=>reject(Error(message)));requests.push(row);
  });
 };
}
function modelRacePlugin(require){
 const React=require('react');return{inject:['slots','sidebarRightTabs','sidebarRight','sessions'],apply(ctx){
  let switchSession;
  function Pane(){
   const [sessionId,setSessionId]=React.useState('race-a'),[draft,setDraft]=React.useState('');switchSession=setSessionId;
   return React.createElement('section',{'data-model-race-fixture':true},React.createElement('textarea',{'aria-label':'Fixture draft',value:draft,onChange:event=>setDraft(event.target.value)}),React.createElement(window.ModelLifecycleComponent,{sessionId}));
  }
  const definition={id:'model-lifecycle-fixture',kind:'model-lifecycle-fixture',keepMounted:true,title:()=> 'Model lifecycle fixture'};
  ctx.effect(()=>ctx.sidebarRightTabs.register(definition));
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:definition.id,inject:()=>({})},Pane)));
  window.ModelLifecycleFixture={create:cwd=>ctx.sessions.create({cwd}),open:()=>ctx.sidebarRight.openTab(definition.kind),switch:sessionId=>switchSession(sessionId)};
 }};
}
const raceDefaults={provider:'local',model:'local-model'},raceCloud={provider:'cloud',model:'cloud/model+preview'},raceGroups=[{id:'local',name:'Local',models:[{id:'local-model',name:'Local model'}]},{id:'cloud',name:'Cloud',models:[{id:'cloud/model+preview',name:'Cloud model',reasoning:{efforts:[{id:'off',name:'Off'},{id:'max',name:'Maximum'}],defaultEffort:'max'}}]}];
async function modelRaceFixture(t){
 assert(process.env.HARNESS_NATIVE_CLI,'The actual pinned Native CLI is required');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-model-race-')),tools=path.join(directory,'tools');fs.mkdirSync(tools);
 fs.writeFileSync(path.join(tools,'package.json'),JSON.stringify({name:'model-lifecycle-fixture',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));fs.writeFileSync(path.join(tools,'index.mjs'),'export function apply(){}');
 fs.writeFileSync(path.join(tools,'client.js'),"window.__ModuleLoader__.load({id:'model-lifecycle-fixture',factory:"+modelRacePlugin.toString()+'});');
 const overlay=path.join(directory,'overlay.json');fs.writeFileSync(overlay,JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},{insert:[{id:'model-workbench',name:pathToFileURL(createSourceFixture(directory,{appendSource:'('+modelRaceBridge.toString()+')();'})).href},{id:'model-lifecycle-fixture',name:pathToFileURL(path.join(tools,'index.mjs')).href}]}]));
 const child=spawn(process.execPath,[process.env.HARNESS_NATIVE_CLI,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home'),PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',browser;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('homeai-model-race-'))throw Error('Unsafe fixture cleanup path');fs.rmSync(resolved,{recursive:true,force:true});});
 const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error('Native lifecycle fixture did not start: '+output));},40000),poll=setInterval(()=>{const match=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);if(match){clearInterval(poll);clearTimeout(timer);resolve(match[0]);}},50);child.once('error',reject);});
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],unexpectedWrites=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 const state={defaults:raceDefaults,workspaces:[{id:'w1',title:'Workspace',sessionIds:[],settings:{}}],projects:{},trash:{},running:[]};
 await page.route('**/api/workbench/execution',route=>route.fulfill({json:{version:1,mode:'host-compat',available:true}}));
 await page.route('**/api/workbench/models**',route=>{const request=route.request(),sessionId=new URL(request.url()).searchParams.get('sessionId');if(request.method()!=='GET')unexpectedWrites.push(request.postDataJSON());return route.fulfill({json:{version:1,sessionId,source:'workspace',selection:raceDefaults,workspaceDefault:raceDefaults,lastUsed:null,groups:raceGroups}});});
 await page.route('**/api/workbench',route=>{const data=route.request().postDataJSON();if(data)unexpectedWrites.push(data);return route.fulfill({json:!data?state:data.operation==='list'?{entries:[]}:{}});});
 await page.goto(url);await page.waitForFunction(()=>window.HarnessNativeUI&&window.ModelLifecycleFixture);const preview=page.getByRole('button',{name:'Continue',exact:true});await preview.click();await preview.waitFor({state:'hidden'});
 const actual=await page.evaluate(cwd=>ModelLifecycleFixture.create(cwd),directory);state.workspaces[0].sessionIds=[actual];state.projects[actual]={root:'/data/harness/workspaces/projects/synthetic'};
 await page.evaluate(id=>HarnessNativeUI.openFiles(id),actual);await page.evaluate(()=>ModelLifecycleFixture.open());const root=page.locator('[data-model-race-fixture]:visible');await root.waitFor();
 const panel=()=>root.locator('[data-model-session]'),picker=()=>panel().getByRole('combobox',{name:'Model for this conversation',exact:true});
 const next=async(sessionId,method='GET',after=-1)=>{await page.waitForFunction(({sessionId,method,after})=>ModelLifecycleWire.requests.some(row=>row.sessionId===sessionId&&row.method===method&&row.index>after&&!row.settled),{sessionId,method,after});return page.evaluate(({sessionId,method,after})=>ModelLifecycleWire.requests.find(row=>row.sessionId===sessionId&&row.method===method&&row.index>after&&!row.settled).index,{sessionId,method,after});};
 const reply=async(index,overrides={},catalog=true)=>{await page.evaluate(({index,overrides,catalog,defaults,groups})=>{const row=ModelLifecycleWire.requests[index];row.resolve({version:1,sessionId:row.sessionId,source:'workspace',selection:defaults,workspaceDefault:defaults,lastUsed:null,...(catalog?{groups}:{}),...overrides});},{index,overrides,catalog,defaults:raceDefaults,groups:raceGroups});};
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const ready=async()=>{await page.waitForFunction(()=>[...document.querySelectorAll('[data-model-race-fixture] select')].some(el=>el.getClientRects().length&&!el.disabled));};
 const switchTo=async sessionId=>{await page.evaluate(id=>ModelLifecycleFixture.switch(id),sessionId);await root.locator('[data-model-session="'+sessionId+'"]').waitFor();};
 const writes=()=>page.evaluate(()=>ModelLifecycleWire.requests.filter(row=>row.method==='POST').map(row=>row.body));
 const assertClean=()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpectedWrites.filter(row=>row.op!=='file'||row.operation!=='list'),[]);assert.deepEqual(state.defaults,raceDefaults);};
 return{page,root,panel,picker,next,reply,settle,ready,switchTo,writes,assertClean};
}
test('Native model catalog is unconfirmed until the current session GET; canceled old reads cannot publish metadata',{timeout:90000},async t=>{
 const f=await modelRaceFixture(t),a=await f.next('race-a');
 await f.reply(a,{source:'session',selection:{...raceCloud,reasoningEffort:'max'},lastUsed:{provider:'A_ONLY',model:'A_LAST_USED'},selectionError:'unavailable',workspaceDefaultError:'unavailable',failures:['A_PROVIDER']});await f.ready();
 assert.equal(await f.picker().inputValue(),JSON.stringify(raceCloud));assert.equal(await f.panel().getByRole('combobox',{name:'Reasoning level',exact:true}).inputValue(),'max');assert.match(await f.panel().innerText(),/A_ONLY/);
 await f.root.getByRole('textbox',{name:'Fixture draft'}).fill('UNSAVED_LIFECYCLE_DRAFT');
 await f.panel().getByRole('button',{name:'Refresh models',exact:true}).click();const old=await f.next('race-a','GET',a);await f.switchTo('race-b');const b=await f.next('race-b');
 assert.equal(await f.picker().isDisabled(),true);assert.equal(await f.picker().inputValue(),'');assert.equal(await f.panel().getByRole('combobox').count(),1);assert.doesNotMatch(await f.panel().innerText(),/A_ONLY|A_LAST_USED|unavailable|providers could not|Workspace default|Cloud model/);
 // An event on a tampered/queued stale DOM control still cannot issue a write.
 await f.picker().evaluate(el=>{el.disabled=false;el.add(new Option('stale cloud',JSON.stringify({provider:'cloud',model:'cloud/model+preview'})));el.value=el.options[1].value;el.dispatchEvent(new Event('change',{bubbles:true}));});assert.deepEqual(await f.writes(),[]);await f.picker().evaluate(el=>{el.options[1].remove();el.value='';el.disabled=true;});
 assert.equal(await f.page.evaluate(index=>ModelLifecycleWire.requests[index].aborted,old),true);
 await f.reply(old,{source:'session',selection:raceCloud,lastUsed:{provider:'OLD_A',model:'OLD_MODEL'}});await f.settle();
 assert.equal(await f.picker().inputValue(),'');assert.equal(await f.panel().getByRole('button',{name:'Refresh models',exact:true}).isDisabled(),true);assert.doesNotMatch(await f.panel().innerText(),/OLD_A|A_ONLY|Saving model/);
 await f.reply(b,{sessionId:'race-a'});await f.panel().getByRole('alert').filter({hasText:'Invalid model response'}).waitFor();assert.equal(await f.picker().isDisabled(),true);assert.equal(await f.picker().inputValue(),'');
 await f.panel().getByRole('button',{name:'Refresh models',exact:true}).click();await f.reply(await f.next('race-b','GET',b));await f.ready();assert.equal(await f.picker().inputValue(),'workspace');assert.equal(await f.panel().getByRole('alert').count(),0);assert.equal(await f.root.getByRole('textbox',{name:'Fixture draft'}).inputValue(),'UNSAVED_LIFECYCLE_DRAFT');assert.deepEqual(await f.writes(),[]);f.assertClean();
});
test('Native old model writes and finally cannot clear a newer session write or error lifecycle',{timeout:90000},async t=>{
 const f=await modelRaceFixture(t);await f.reply(await f.next('race-a'));await f.ready();await f.root.getByRole('textbox',{name:'Fixture draft'}).fill('UNSAVED_WRITE_DRAFT');
 await f.picker().selectOption(JSON.stringify(raceCloud));const a=await f.next('race-a','POST');await f.switchTo('race-b');const b=await f.next('race-b');assert.equal(await f.picker().isDisabled(),true);assert.equal(await f.picker().inputValue(),'');assert.equal(await f.page.evaluate(index=>ModelLifecycleWire.requests[index].aborted,a),true);
 await f.reply(b);await f.ready();await f.picker().selectOption(JSON.stringify(raceCloud));const writeB=await f.next('race-b','POST');
 await f.reply(a,{source:'session',selection:{...raceCloud,reasoningEffort:'off'},lastUsed:{provider:'OLD_A',model:'OLD_MODEL'}},false);await f.settle();assert.equal(await f.picker().isDisabled(),true);assert.match(await f.panel().innerText(),/Saving model/);assert.doesNotMatch(await f.panel().innerText(),/OLD_A|Reasoning level/);
 await f.reply(writeB,{source:'session',selection:{...raceCloud,reasoningEffort:'max'}},false);await f.ready();assert.equal(await f.picker().inputValue(),JSON.stringify(raceCloud));assert.equal(await f.panel().getByRole('combobox',{name:'Reasoning level',exact:true}).inputValue(),'max');assert.equal(await f.picker().locator('optgroup').count(),2,'POST without groups retains only its own confirmed catalog');
 await f.picker().selectOption('workspace');const oldB=await f.next('race-b','POST',writeB);await f.switchTo('race-c');const c=await f.next('race-c');await f.page.evaluate(index=>ModelLifecycleWire.requests[index].reject('OLD_B_FAILED'),oldB);await f.settle();assert.equal(await f.picker().isDisabled(),true);assert.equal(await f.picker().inputValue(),'');assert.equal(await f.panel().getByRole('alert').count(),0);assert.equal(await f.panel().getByRole('button',{name:'Refresh models',exact:true}).isDisabled(),true);
 await f.reply(c);await f.ready();await f.picker().selectOption(JSON.stringify(raceCloud));const oldC=await f.next('race-c','POST');await f.switchTo('race-b');const newB=await f.next('race-b','GET',b);assert.equal(await f.picker().inputValue(),'');await f.reply(oldC,{source:'session',selection:raceCloud},false);await f.settle();assert.equal(await f.panel().getByRole('button',{name:'Refresh models',exact:true}).isDisabled(),true);await f.reply(newB);await f.ready();assert.equal(await f.picker().inputValue(),'workspace');
 // A current uncertain write invalidates the catalog until a fresh read.
 await f.picker().selectOption(JSON.stringify(raceCloud));const failed=await f.next('race-b','POST',oldB);await f.page.evaluate(index=>ModelLifecycleWire.requests[index].reject('CURRENT_WRITE_UNCONFIRMED'),failed);await f.panel().getByRole('alert').filter({hasText:'CURRENT_WRITE_UNCONFIRMED'}).waitFor();assert.equal(await f.picker().isDisabled(),true);assert.equal(await f.picker().inputValue(),'');await f.panel().getByRole('button',{name:'Refresh models',exact:true}).click();await f.reply(await f.next('race-b','GET',newB));await f.ready();
 assert.deepEqual(await f.writes(),[{sessionId:'race-a',selection:raceCloud},{sessionId:'race-b',selection:raceCloud},{sessionId:'race-b',selection:null},{sessionId:'race-c',selection:raceCloud},{sessionId:'race-b',selection:raceCloud}]);assert.equal(await f.root.getByRole('textbox',{name:'Fixture draft'}).inputValue(),'UNSAVED_WRITE_DRAFT');f.assertClean();
});
