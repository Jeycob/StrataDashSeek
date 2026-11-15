'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..');
async function fixture(t,asset,{realSDK=false,renameReplyMode='complete',holdRename=false}={}){
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
 const files={s1:{'a.txt':{text:'base\n',version:'v1'}},s2:{'b.txt':{text:'other\n',version:'v1'}}},pending=[],pendingMoves=[],requests=[],dialogs=[],errors=[];
 let held=false,failed=false,revision=1,acceptNext=false;
 let sdk,sdkDirectory,sdkContext;const sdkMoves=[];
 if(realSDK){
  const sdkRoot=process.env.EFFICIENCY_SDK_ROOT||'/data/harness/runtime/node_modules',load=name=>import(pathToFileURL(path.join(sdkRoot,'@deepseek-ai',name,'lib/index.js')).href);
  const[{Context},{LocalFileSystem}]=await Promise.all([load('cordis'),load('dsh-fs-local')]);sdkContext=new Context();sdkDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'editor-real-sdk-'));
  t.after(async()=>{await sdkContext.fiber.dispose();const absolute=path.resolve(sdkDirectory);if(!absolute.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(absolute).startsWith('editor-real-sdk-'))throw Error('Unsafe SDK fixture cleanup');fs.rmSync(absolute,{recursive:true,force:true});});
  sdk=new LocalFileSystem(sdkContext,{cwd:sdkDirectory,diffBasisMaxBytes:1024*1024});
  for(const[sessionId,entries]of Object.entries(files)){fs.mkdirSync(path.join(sdkDirectory,sessionId));for(const[name,file]of Object.entries(entries)){fs.writeFileSync(path.join(sdkDirectory,sessionId,name),file.text);file.version=(await sdk.stat(await sdk.resolve(path.join(sdkDirectory,sessionId,name)))).version;}}
 }
 const state={trash:{},running:[],defaults:{},environment:{},workspaces:[{id:'w1',title:'Workspace',sessionIds:['s1','s2'],settings:{}}],projects:{s1:{root:'/data/harness/workspaces/projects/a'},s2:{root:'/data/harness/workspaces/projects/b'}}};
 const server=http.createServer(async(req,res)=>{try{
  let text='';for await(const bytes of req)text+=bytes;const data=text?JSON.parse(text):null;requests.push(data||{url:req.url});
  const json=(value,status=200)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}};
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="one"></div><div id="two"></div><script>window.HARNESS_NATIVE_WORKBENCH=true;window.__ModuleLoader__={load(){}};window.editorWriteReplies=0;window.editorWritesAborted=0;const originalFetch=window.fetch.bind(window);window.fetch=(url,init)=>{const write=init?.body&&JSON.parse(init.body).operation==="write";if(write)init.signal?.addEventListener("abort",()=>editorWritesAborted++,{once:true});return originalFetch(url,write&&window.ignoreWriteAbort?{...init,signal:undefined}:init).then(r=>{const json=r.json.bind(r);r.json=async()=>{const v=await json();if(write)editorWriteReplies++;return v};return r})};</script>'+(asset==='source'?'<script src="/i18n.js"></script>':'')+'<script src="/client.js"></script>');}
  if(req.url==='/i18n.js'||req.url==='/client.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,req.url==='/i18n.js'?'shared/i18n.cjs':asset==='source'?'workspace/client.js':'workspace/native-ui/client.js')));}
  if(req.url==='/api/session/list')return json({result:{ok:true,value:{items:[{sessionId:'s1',title:'One'},{sessionId:'s2',title:'Two'}]}}});
  if(req.url==='/api/session/modelCatalog')return json({result:{ok:true,value:{groups:[]}}});
  if(req.url!=='/api/workbench')return json({},404);if(!data)return json(state);
  assert.equal(data.op,'file');const store=files[data.sessionId];assert.ok(store);const args=data.args,current=store[args.path];
  if(data.operation==='list')return json({entries:Object.keys(store).map(name=>({name,directory:false}))});
  if(data.operation==='read')return current?json({path:args.path,...current}):json({code:'MISSING',error:'File missing'},404);
  if(data.operation==='stat')return current?json({path:args.path,version:current.version,bytes:Buffer.byteLength(current.text)}):json({code:'MISSING',error:'File missing'},404);
  if(data.operation==='write'){
   if(sdk){const target=await sdk.resolve(path.join(sdkDirectory,data.sessionId,args.path)),result=await sdk.writeText(target,args.text,{kind:'replaceIfVersion',version:args.version});store[args.path]={text:args.text,version:result.version};return json(result);}
   const perform=()=>{if(failed)return json({error:'fixture-write-failed'},503);const latest=store[args.path];if(args.version?latest?.version!==args.version:Boolean(latest))return json({code:'FS_STALE_VERSION',error:'Version conflict'},409);store[args.path]={text:args.text,version:'v'+(++revision)};return json({version:store[args.path].version});};
   if(held){pending.push(perform);return;}return perform();
  }
  if(data.operation==='rename'){
   if(sdk){const source=await sdk.resolve(path.join(sdkDirectory,data.sessionId,args.path)),destination=await sdk.resolve(path.join(sdkDirectory,data.sessionId,args.destination)),result=await sdk.moveFile(source,destination,{expectedSource:{version:args.version},expectedDestination:{kind:'createIfAbsent'}});sdkMoves.push(result);store[args.destination]={text:fs.readFileSync(path.join(sdkDirectory,data.sessionId,args.destination),'utf8'),version:result.destination.version};if(result.sourceDeleted)delete store[args.path];return json(result);}
   const perform=()=>{if(current?.version!==args.version||store[args.destination])return json({code:'FS_STALE_VERSION',error:'Version conflict'},409);store[args.destination]={...current,version:'v'+(++revision)};if(renameReplyMode!=='false')delete store[args.path];const result={destination:{operation:'create',version:store[args.destination].version,after:current.text},sourceDeleted:renameReplyMode!=='false'};if(renameReplyMode==='missing')delete result.sourceDeleted;if(renameReplyMode==='missingVersion')delete result.destination.version;return json(result);};if(holdRename){pendingMoves.push(perform);return;}return perform();}
  return json({error:'Unexpected operation'},400);
 }catch(error){if(!res.destroyed){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1100,height:850}});page.setDefaultTimeout(4000);
 page.on('dialog',async dialog=>{dialogs.push(dialog.type());if(acceptNext){acceptNext=false;await dialog.accept();}else await dialog.dismiss();});page.on('pageerror',error=>errors.push(error.message));
 const wait=async condition=>{const end=Date.now()+3000;while(!condition()){if(Date.now()>end)throw Error('Fixture condition timed out');await new Promise(resolve=>setTimeout(resolve,15));}};
 t.after(async()=>{held=false;for(const finish of [...pending.splice(0),...pendingMoves.splice(0)])finish();await page.evaluate(()=>{window.one?.destroy();window.two?.destroy();}).catch(()=>{});await browser.close();await new Promise(resolve=>server.close(resolve));});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>{HarnessI18n.setLanguage('en');window.one=HarnessWorkbench.mount(document.querySelector('#one'),{sessionId:'s1',instanceId:'first'});window.two=HarnessWorkbench.mount(document.querySelector('#two'),{sessionId:'s1',instanceId:'second'});});
 for(const host of ['#one','#two'])await page.locator(host+' .wb-tree').getByRole('button',{name:'a.txt',exact:true}).click();
 const view=host=>({host:page.locator(host),text:page.locator(host+' .wb-editor'),save:page.locator(host).getByRole('button',{name:'Save',exact:true})});
 return{page,files,requests,dialogs,errors,pending,pendingMoves,wait,view,sdkMoves,sdkDirectory,acceptNext:()=>{acceptNext=true;},hold:()=>{held=true;},fail:value=>{failed=value;},release:()=>{held=false;for(const finish of [...pending.splice(0),...pendingMoves.splice(0)])finish();},async screenshot(name){if(process.env.HARNESS_EDITOR_EVIDENCE){fs.mkdirSync(process.env.HARNESS_EDITOR_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.HARNESS_EDITOR_EVIDENCE,asset+'-'+name+'.png'),fullPage:true});}}};
}

for(const asset of ['source','bundle']){
 for(const mode of ['missing','false','missingVersion'])test(asset+': unconfirmed rename '+mode+' cannot select an unverified version or lose newer edits',{timeout:15000},async t=>{
  const f=await fixture(t,asset,{renameReplyMode:mode,holdRename:true}),a=f.view('#one');await a.text.fill('BEFORE_UNCERTAIN_RENAME\n');await a.host.getByRole('button',{name:'Rename',exact:true}).click();const modal=f.page.locator('dialog[data-workbench-dialog]');await modal.locator('input').fill('uncertain.txt');await modal.getByRole('button',{name:'Rename',exact:true}).click();await f.wait(()=>f.pendingMoves.length===1);await a.text.fill('NEWER_UNCERTAIN_DRAFT\n');f.release();
  await a.host.getByRole('alert').filter({hasText:/retained|confirmed|removed/}).waitFor();assert.equal(await a.text.getAttribute('aria-label'),mode==='missingVersion'?'uncertain.txt':'a.txt');assert.equal(await a.text.inputValue(),'NEWER_UNCERTAIN_DRAFT\n');assert.equal(await a.save.isDisabled(),true);assert.equal(await f.page.evaluate(()=>one.dirty),true);assert.equal(f.requests.some(r=>r.operation==='write'),false);
  await a.host.getByRole('button',{name:'Recheck saved file',exact:true}).click();await f.page.waitForFunction(()=>[...document.querySelectorAll('#one button')].some(b=>b.textContent==='Save'&&!b.disabled));
  assert.equal(await a.text.inputValue(),'NEWER_UNCERTAIN_DRAFT\n');assert.equal(await a.text.getAttribute('aria-label'),mode==='false'?'a.txt':'uncertain.txt');await a.save.click();await f.page.waitForFunction(()=>!one.dirty);assert.equal(f.files.s1[mode==='false'?'a.txt':'uncertain.txt'].text,'NEWER_UNCERTAIN_DRAFT\n');assert.deepEqual(f.errors,[]);
 });
 test(asset+': actual pinned SDK moveFile response and write CAS work through the real Chromium editor',{timeout:15000},async t=>{
  const f=await fixture(t,asset,{realSDK:true}),a=f.view('#one');await a.text.fill('REAL_SDK_DRAFT\n');await a.host.getByRole('button',{name:'Rename',exact:true}).click();const modal=f.page.locator('dialog[data-workbench-dialog]');await modal.locator('input').fill('sdk-renamed.txt');await modal.getByRole('button',{name:'Rename',exact:true}).click();
  await f.page.locator('#one textarea[aria-label="sdk-renamed.txt"]').waitFor();assert.equal(f.sdkMoves.length,1);assert.equal(f.sdkMoves[0].sourceDeleted,true);assert.equal(f.sdkMoves[0].version,undefined);assert.equal(typeof f.sdkMoves[0].destination.version,'string');assert.equal(await a.text.inputValue(),'REAL_SDK_DRAFT\n');assert.equal(fs.existsSync(path.join(f.sdkDirectory,'s1/a.txt')),false);
  await a.save.click();await f.page.waitForFunction(()=>!one.dirty);assert.equal(fs.readFileSync(path.join(f.sdkDirectory,'s1/sdk-renamed.txt'),'utf8'),'REAL_SDK_DRAFT\n');assert.equal(f.requests.filter(r=>r.operation==='write').at(-1).args.version,f.sdkMoves[0].destination.version);assert.deepEqual(f.errors,[]);
 });
 test(asset+': slow save keeps newer typing dirty and CAS prevents a second tab overwriting it',{timeout:20000},async t=>{
  const f=await fixture(t,asset),a=f.view('#one'),b=f.view('#two');
  await a.text.fill('SAVE_FIRST\n');f.hold();await a.save.click();await f.wait(()=>f.pending.length===1);
  await a.text.fill('TYPED_DURING_SAVE\n');f.release();await a.host.locator('[id$="wb-message"]').filter({hasText:/Saved/}).waitFor();
  await f.screenshot('save-during-typing');assert.equal(await f.page.evaluate(()=>one.dirty),true,'newer typing must remain dirty after older save acknowledgement');
  assert.equal(await a.save.isEnabled(),true);assert.equal(await a.text.inputValue(),'TYPED_DURING_SAVE\n');assert.equal(f.files.s1['a.txt'].text,'SAVE_FIRST\n');
  f.fail(true);await a.save.click();await a.host.getByRole('alert').filter({hasText:'fixture-write-failed'}).waitFor();assert.equal(await f.page.evaluate(()=>one.dirty),true);assert.equal(await a.text.inputValue(),'TYPED_DURING_SAVE\n');
  f.fail(false);await a.save.click();await f.page.waitForFunction(()=>!one.dirty);assert.equal(f.files.s1['a.txt'].text,'TYPED_DURING_SAVE\n');
  await b.text.fill('SECOND_TAB_DRAFT\n');await b.save.click();await b.host.getByRole('alert').filter({hasText:/changed|conflict/i}).waitFor();assert.equal(await f.page.evaluate(()=>two.dirty),true);assert.equal(await b.text.inputValue(),'SECOND_TAB_DRAFT\n');assert.equal(f.files.s1['a.txt'].text,'TYPED_DURING_SAVE\n');
  assert.deepEqual(f.errors,[]);
 });
 test(asset+': dirty rename uses an accessible dialog and preserves draft text',{timeout:15000},async t=>{
  const f=await fixture(t,asset),a=f.view('#one');await a.text.fill('UNSAVED_RENAME_DRAFT\n');await a.host.getByRole('button',{name:'Rename',exact:true}).click();
  assert.deepEqual(f.dialogs,[],'rename must not open blocking browser prompt/confirm');
  const modal=f.page.locator('dialog[data-workbench-dialog]');await modal.waitFor();assert.equal(await modal.locator('input').evaluate(e=>e===document.activeElement),true);await f.screenshot('rename-dialog');
  await f.page.keyboard.press('Escape');await modal.waitFor({state:'detached'});assert.equal(await a.text.inputValue(),'UNSAVED_RENAME_DRAFT\n');assert.equal(await a.host.getByRole('button',{name:'Rename',exact:true}).evaluate(e=>e===document.activeElement),true);
  f.files.s1['occupied.txt']={text:'preserve destination\n',version:'occupied-v1'};
  await a.host.getByRole('button',{name:'Rename',exact:true}).click();await modal.locator('input').fill('occupied.txt');await modal.getByRole('button',{name:'Rename',exact:true}).click();
  await a.host.getByRole('alert').filter({hasText:/changed|conflict/i}).waitFor();assert.equal(await a.text.inputValue(),'UNSAVED_RENAME_DRAFT\n');assert.equal(await a.text.getAttribute('aria-label'),'a.txt');assert.equal(f.files.s1['occupied.txt'].text,'preserve destination\n');
  await a.host.getByRole('button',{name:'Rename',exact:true}).click();await modal.locator('input').fill('renamed.txt');await modal.getByRole('button',{name:'Rename',exact:true}).click();
  await f.page.locator('#one textarea[aria-label="renamed.txt"]').waitFor();assert.equal(await a.text.inputValue(),'UNSAVED_RENAME_DRAFT\n');assert.equal(await f.page.evaluate(()=>one.dirty),true);assert.equal(f.files.s1['renamed.txt'].text,'base\n');
  await a.save.click();await f.page.waitForFunction(()=>!one.dirty);assert.equal(f.files.s1['renamed.txt'].text,'UNSAVED_RENAME_DRAFT\n');assert.deepEqual(f.errors,[]);await f.screenshot('rename-draft');
 });
 test(asset+': duplicate save and refresh cannot discard typing; old-session replies cannot change the new document',{timeout:15000},async t=>{
  const f=await fixture(t,asset),a=f.view('#one');await a.text.fill('SAVE_SWITCH\n');f.hold();await a.save.click();await f.wait(()=>f.pending.length===1);
  await a.host.getByRole('button',{name:'Saving…',exact:true}).evaluate(button=>{button.disabled=false;button.click();});assert.equal(f.requests.filter(r=>r.operation==='write').length,1,'one pending immutable save only');
  await a.text.fill('NEWER_BEFORE_SWITCH\n');await f.page.evaluate(()=>one.reload());assert.equal(await a.text.inputValue(),'NEWER_BEFORE_SWITCH\n');assert.equal(await f.page.evaluate(()=>one.dirty),true);assert.ok(f.dialogs.includes('confirm'),'dirty refresh requires explicit discard');
  f.acceptNext();await f.page.locator('#one [id$="wb-session"]').evaluate(select=>{select.value='s2';select.dispatchEvent(new Event('change'));});
  await a.host.locator('.wb-tree').getByRole('button',{name:'b.txt',exact:true}).click();assert.equal(await a.text.inputValue(),'other\n');
  f.release();await f.page.waitForFunction(()=>editorWriteReplies===1);assert.equal(await a.text.inputValue(),'other\n');assert.equal(await a.text.getAttribute('aria-label'),'b.txt');assert.equal(await f.page.evaluate(()=>one.dirty),false);assert.equal(await a.host.locator('[id$="wb-message"]').innerText(),'');
  assert.equal(f.files.s1['a.txt'].text,'SAVE_SWITCH\n');assert.equal(f.files.s2['b.txt'].text,'other\n');assert.deepEqual(f.errors,[]);
 });
 test(asset+': closing a pending save retains the newer draft and ignores a late transport response',{timeout:15000},async t=>{
  const f=await fixture(t,asset),a=f.view('#one');await f.page.evaluate(()=>{window.ignoreWriteAbort=true;});await a.text.fill('BEFORE_CLOSE_SAVE\n');f.hold();await a.save.click();await f.wait(()=>f.pending.length===1);await a.text.fill('AFTER_CLOSE_DRAFT\n');
  await f.page.evaluate(()=>{window.closedRoot=one.element;window.closedMutations=0;window.closedObserver=new MutationObserver(rows=>closedMutations+=rows.length);closedObserver.observe(closedRoot,{childList:true,subtree:true,characterData:true});one.destroy();window.one=HarnessWorkbench.mount(document.querySelector('#one'),{sessionId:'s1',instanceId:'first'});});
  await f.page.waitForFunction(()=>editorWritesAborted===1);await a.text.waitFor();assert.equal(await a.text.inputValue(),'AFTER_CLOSE_DRAFT\n');assert.equal(await f.page.evaluate(()=>one.dirty),true);
  f.release();await f.page.waitForFunction(()=>editorWriteReplies===1);assert.equal(await f.page.evaluate(()=>closedMutations),0);assert.equal(await a.text.inputValue(),'AFTER_CLOSE_DRAFT\n');
  await a.save.click();await a.host.getByRole('alert').filter({hasText:/changed|conflict/i}).waitFor();assert.equal(await f.page.evaluate(()=>one.dirty),true);assert.equal(f.files.s1['a.txt'].text,'BEFORE_CLOSE_SAVE\n');
  await f.page.evaluate(()=>closedObserver.disconnect());assert.deepEqual(f.errors,[]);await f.screenshot('late-close-draft');
 });
}
