'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {request} = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {buffer} = require('node:stream/consumers');
const {pathToFileURL} = require('node:url');
const {brotliDecompressSync, gunzipSync} = require('node:zlib');
const {createSourceFixture} = require('./test-bundle.cjs');

function assetResponse(url, encoding, method = 'GET') {
 return new Promise((resolve, reject) => {
  const req = request(url, {method, headers: encoding ? {'Accept-Encoding': encoding} : {}}, async response => {
   try { resolve({status:response.statusCode, headers:response.headers, body:await buffer(response)}); }
   catch (error) { reject(error); }
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(Error('Asset request timed out')));
  req.end();
 });
}

test('Native Code-OSS keeps a protected draft and uses each chat’s real project without Apps', {timeout:120000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli, 'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-native-codeoss-'));
 const plugin = path.join(directory, 'fixture');
 const roots = ['project-one', 'project-two'].map(name => path.join(directory, name));
 const paths = roots.map(root => path.join(root, 'counter.txt'));
 let child, browser, exited, output = '';
 const notes = [];
 try {
  await Promise.all([plugin, ...roots].map(dir => fs.mkdir(dir)));
  await fs.writeFile(paths[0], 'project one');
  await fs.writeFile(paths[1], 'project two');
  await fs.writeFile(path.join(roots[0], 'second.txt'), 'another editor tab');
  await fs.writeFile(path.join(plugin,'package.json'), JSON.stringify({
   name:'native-codeoss-fixture',type:'module',exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},
   dsh:{client:{platform:'web'}},
  }));
  await fs.writeFile(path.join(plugin,'client.js'), `window.__ModuleLoader__.load({
   id:'native-codeoss-fixture',factory:()=>({inject:['uiWorkspace'],apply(ctx){
    window.CodeOssFixture={select(id){
     try {ctx.uiWorkspace.openSession(id);return true;}
     catch(error){if(!error.message.includes('unknown session'))throw error;return false;}
    }};
   }})
  });`);
  const moduleUrl = name => JSON.stringify(pathToFileURL(path.resolve(__dirname, '..', name)).href);
  await fs.writeFile(path.join(plugin, 'index.mjs'), `
   import {WorkspaceManager} from ${moduleUrl('manager.mjs')};
   import {installCodeOss} from ${moduleUrl('codeoss-web/assets.mjs')};
   import {sameRequestOrigin} from ${moduleUrl('http.mjs')};
   import {hostExecutionBinding} from ${moduleUrl('fixtures/execution-binding.mjs')};
   export const inject=['sessions','sessionPersistence','sessionTitle','workingDirectory','workspaceRegistry','agents','fs','connection','llm','sandboxPolicy'];
   export async function apply(ctx) {
    let streams=0, prompts=0, writes=[];
    ctx.on('llm/stream',()=>{ streams++; throw Error('FIXTURE_INFERENCE_REFUSED'); },{prepend:true,global:true});
    ctx.on('agent/inbox/inserted',event=>{if(event.message?.source?.kind==='user')prompts++;},{global:true});
    const roots=${JSON.stringify(roots)};
    const ids=[];
    const manager=new WorkspaceManager(ctx,{stateRoot:${JSON.stringify(path.join(directory,'state'))},projectsRoot:${JSON.stringify(directory)}},hostExecutionBinding());
    await manager.initialize();
    for(const root of roots){
     const workspace=await ctx.workspaceRegistry.create(root);
     const session=ctx.sessions.create(undefined,{meta:{cwd:root}});
     session.append('turn/start',{turn:1});
     session.append('user/message',{id:'question',role:'user',source:{kind:'user'},content:[{type:'text',text:'Saved fixture'}]},{surfaceOp:'append'});
     session.append('turn/end',{turn:1,reason:{kind:'completed'}});
     ctx.sessionTitle.rename(session,'Native editor '+ids.length);
     if(!await ctx.sessions.flush(session))throw Error('FIXTURE_SESSION_NOT_SAVED');
     await workspace.attachSession(session.id);
     ids.push(session.id);
     manager.data.sessions[session.id]={root};
    }
    installCodeOss(ctx, manager);
    const register=(path,methods,fetch)=>ctx.effect(()=>ctx.connection.fetch.register({path,methods,requestBody:'buffered',fetch}));
    register('/api/workbench/execution',['GET'],async()=>Response.json({version:1,available:true,mode:'host-compat'}));
    register('/api/codeoss-fixture',['GET'],async()=>Response.json({ids,streams,prompts,writes}));
    register('/api/workbench',['GET','POST'],async request=>{
     if(request.method==='GET')return Response.json({defaults:{},projects:{},workspaces:[],trash:{},running:[]});
     if(!sameRequestOrigin(request))return Response.json({code:'ORIGIN_REFUSED'},{status:403});
     const data=await request.json();
     if(data.op!=='file')return Response.json({});
     try {
      const value=await manager.files(data.sessionId,data.operation,data.args,request.signal);
      if(data.operation==='write')writes.push({sessionId:data.sessionId,ok:true});
      return Response.json(value);
     } catch(error) {
      if(data.operation==='write')writes.push({sessionId:data.sessionId,code:error.code});
      return Response.json({code:error.code,error:error.message},{status:error.status??400});
     }
    });
   }`);
  const overlay = path.join(directory, 'overlay.json');
  await fs.writeFile(overlay, JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},
   {id:'session-title-llm',disabled:true},{insert:[
    {id:'codeoss-workbench',name:pathToFileURL(createSourceFixture(directory)).href},
    {id:'native-codeoss-fixture',name:pathToFileURL(path.join(plugin,'index.mjs')).href},
   ]}]));
  child = spawn(process.execPath, [cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],
   {cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home')},stdio:['ignore','pipe','pipe'],windowsHide:true});
  exited = once(child,'close');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output=(output+chunk).slice(-12000));
  let url;
  const deadline = Date.now()+30000;
  while (!(url=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0])) {
   if (child.exitCode!==null || Date.now()>=deadline) throw Error('Native fixture startup failed');
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const {chromium} = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:980}});
  const context = page.context();
  page.setDefaultTimeout(12000);
  const oldEditor = [], nonLocal = [];
  const workbenchUrl = new URL('/api/workbench',url).href;
  function workbenchWrite(request) {
   if (request.url()!==workbenchUrl || request.method()!=='POST') return;
   let data;
   try { data = request.postDataJSON(); } catch { return; }
   if (data?.op==='file' && data.operation==='write') return data;
  }
  context.on('request', request => {
   const write = workbenchWrite(request);
   if (write) notes.push('Code OSS write requested for '+write.sessionId+' '+write.args?.path);
  });
  context.on('requestfailed', request => {
   if (workbenchWrite(request)) notes.push('Code OSS write request failed '+request.failure()?.errorText);
  });
  page.on('request', request => {
   const target = new URL(request.url());
   if (target.pathname==='/api/workbench/editor' || /^(?:\/phone)?\/api\/apps(?:\/|$)/.test(target.pathname)) oldEditor.push(target.pathname);
   if (['http:', 'https:'].includes(target.protocol) && target.origin!==new URL(url).origin) nonLocal.push(target.origin);
  });
  page.on('pageerror', error=>notes.push(error.message));
  page.on('console', message=>{if (message.type()==='error' || message.type()==='warning') notes.push(message.text());});
  page.on('response', response=>{if (response.status()>=400) notes.push(response.status()+' '+response.url());});
  const stats = async () => (await page.request.get(new URL('/api/codeoss-fixture',url).href)).json();
  await page.goto(url);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForFunction(()=>window.HarnessNativeUI);
  await page.evaluate(()=>HarnessI18n.setLanguage('en'));
  const {ids:[first, second]} = await stats();
  async function open(id, fromGuide=false) {
   await page.waitForFunction(id=>window.CodeOssFixture?.select(id),id);
   if (fromGuide) {
    await page.getByRole('button',{name:'Open right sidebar',exact:true}).click();
    await page.locator('[data-sidebar-right-guide-entry="harness-codeoss"]').filter({hasText:'Code – OSS'}).click();
   } else await page.evaluate(id=>HarnessNativeUI.openCodeOss(id),id);
   const pane = page.locator('[data-codeoss-session="'+id+'"]');
   const editor = pane.frameLocator('iframe');
   await editor.locator('.monaco-workbench .part.editor').waitFor({timeout:25000});
   return editor;
  }
  async function pick(editor, name) {
   await editor.locator('.explorer-folders-view').getByText(name,{exact:true}).click();
  }
  function content(editor) { return editor.locator('.part.editor .monaco-editor .view-lines').filter({visible:true}).first(); }
  async function saveCounter(editor, sessionId, diskPath, text) {
   await content(editor).getByText(text,{exact:true}).waitFor();
   const [response] = await Promise.all([
    context.waitForEvent('response',{
     predicate(response) {
      const write = workbenchWrite(response.request());
      return write?.sessionId===sessionId && write.args?.path==='counter.txt';
     },
     timeout:15000,
    }),
    page.keyboard.press('Control+s'),
   ]);
   const {args} = workbenchWrite(response.request());
   assert.equal(args.text,text);
   assert.equal(typeof args.version,'string');
   assert.equal(response.status(),200,'Code OSS save was rejected: '+await response.text());
   assert.equal(await fs.readFile(diskPath,'utf8'),text);
  }
  const firstEditor = await open(first,true);
  const mainAsset = new URL('/_homeai/codeoss-0.30.3/vscode/vs/workbench/workbench.web.main.internal.js',url);
  const [br, gzip, identity] = await Promise.all([
   assetResponse(mainAsset,'gzip, br'),
   assetResponse(mainAsset,'br;q=0, gzip;q=1'),
   assetResponse(mainAsset),
  ]);
  for (const [header, response, encoding] of [
   ['gzip, br',br,'br'], ['br;q=0, gzip;q=1',gzip,'gzip'], ['',identity,undefined],
  ]) {
   assert.equal(response.status,200);
   assert.equal(response.headers['content-encoding'],encoding);
   assert.equal(response.headers.vary,'Accept-Encoding');
   assert.equal(response.headers['cache-control'],'public, max-age=86400, no-transform');
   const head = await assetResponse(mainAsset,header,'HEAD');
   assert.equal(head.status,response.status);
   for (const name of ['content-encoding','content-length','vary','cache-control']) {
    assert.equal(head.headers[name],response.headers[name]);
   }
   assert.equal(head.body.length,0);
  }
  assert.equal(Number(identity.headers['content-length']),identity.body.length);
  assert.deepEqual(brotliDecompressSync(br.body),identity.body);
  assert.deepEqual(gunzipSync(gzip.body),identity.body);
  assert(br.body.length < 0.9 * gzip.body.length);
  const unencoded = await assetResponse(mainAsset,'br;q=0, gzip;q=0','HEAD');
  assert.equal(unencoded.headers['content-length'],identity.headers['content-length']);
  assert.equal(unencoded.headers['content-encoding'],undefined);
  const weighted = await assetResponse(mainAsset,'br;q=0.5, gzip;q=0.8','HEAD');
  assert.equal(weighted.headers['content-encoding'],'gzip');
  const refused = await assetResponse(mainAsset,'*;q=0','HEAD');
  assert.equal(refused.status,406);
  assert.equal(refused.headers.vary,'Accept-Encoding');
  const transfer = await firstEditor.locator('html').evaluate((_,href)=>{
   const [resource] = performance.getEntriesByName(href);
   return [resource?.encodedBodySize, resource?.decodedBodySize];
  },mainAsset.href);
  assert.deepEqual(transfer,[br.body.length,identity.body.length]);
  for (const name of ['LICENSE-Code-OSS.txt','LICENSE-GitHub1s.txt','ThirdPartyNotices.txt']) {
   const response = await page.request.get(new URL('/_homeai/codeoss-0.30.3/'+name,url).href);
   assert.equal(response.status(),200);
   assert.deepEqual(await response.body(),await fs.readFile(path.resolve(__dirname,'..','codeoss-web',name)));
  }
  await pick(firstEditor,'counter.txt');
  await content(firstEditor).getByText('project one',{exact:true}).waitFor();
  await pick(firstEditor,'second.txt');
  await content(firstEditor).getByText('another editor tab',{exact:true}).waitFor();
  await fs.writeFile(path.join(roots[0],'generated.txt'),'agent added this file');
  await firstEditor.locator('.explorer-folders-view').getByText('generated.txt',{exact:true}).waitFor();
  await firstEditor.locator('.tabs-container .tab').getByText('counter.txt',{exact:true}).click();
  await fs.writeFile(paths[0],'agent wrote a clean update');
  await content(firstEditor).getByText('agent wrote a clean update',{exact:true}).waitFor();
  await content(firstEditor).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('manual saved update');
  await saveCounter(firstEditor,first,paths[0],'manual saved update');
  await content(firstEditor).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('protected manual draft');
  await fs.writeFile(paths[0],'agent wrote during edit');
  await content(firstEditor).getByText('protected manual draft',{exact:true}).waitFor();
  await page.keyboard.press('Control+s');
  assert.equal(await fs.readFile(paths[0],'utf8'),'agent wrote during edit');
  const other = await open(second);
  await pick(other,'counter.txt');
  await content(other).getByText('project two',{exact:true}).waitFor();
  assert.equal(await fs.readFile(paths[1],'utf8'),'project two');
  const returned = await open(first);
  await content(returned).getByText('protected manual draft',{exact:true}).waitFor();
  assert.equal(await fs.readFile(paths[0],'utf8'),'agent wrote during edit');
  await page.evaluate(()=>HarnessI18n.setLanguage('cs'));
  await page.reload();
  await page.waitForFunction(()=>window.HarnessNativeUI && HarnessI18n.language==='cs');
  const reloaded = await open(first);
  await reloaded.getByText('Průzkumník', {exact:true}).first().waitFor();
  await content(reloaded).getByText('protected manual draft',{exact:true}).waitFor();
  await content(reloaded).click();
  await page.keyboard.press('Control+s');
  await reloaded.locator('.notifications-toasts').getByText(/změnil|novější/i).first().waitFor();
  assert.equal(await fs.readFile(paths[0],'utf8'),'agent wrote during edit');
  await content(reloaded).click();
  await page.keyboard.press('F1');
  await reloaded.locator('.quick-input-widget input').fill('>Obnovit soubor');
  await reloaded.locator('.quick-input-widget').getByText('Obnovit soubor',{exact:false}).first().click();
  await content(reloaded).getByText('agent wrote during edit',{exact:true}).waitFor();
  await content(reloaded).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('saved after explicit revert');
  await saveCounter(reloaded,first,paths[0],'saved after explicit revert');
  const recorded = await stats();
  assert.equal(recorded.prompts,0);
  assert.equal(recorded.streams,0);
  assert(recorded.writes.some(write=>write.sessionId===first && write.ok));
  assert(recorded.writes.every(write=>write.sessionId===first));
  assert.deepEqual(oldEditor,[]);
  assert.deepEqual(nonLocal,[]);
 } catch (error) {
  console.error(output.slice(-4000).replace(/token=[^\s&]+/g,'token=[redacted]'), notes.slice(-30));
  throw error;
 } finally {
  if (browser) await browser.close();
  if (child && child.exitCode===null) child.kill();
  if (exited) await exited;
  await fs.rm(directory,{recursive:true,force:true});
 }
});
