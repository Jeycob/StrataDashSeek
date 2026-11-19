'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {createSourceFixture} = require('./test-bundle.cjs');

function seed(ctx) {
 return ['First', 'Second'].map(label => {
  const session = ctx.sessions.create(undefined,{meta:{cwd:process.cwd()}});
  session.append('turn/start',{turn:1});
  session.append('user/message',{id:label+'-prompt',role:'user',source:{kind:'user'},content:[{type:'text',text:'Build fixture'}]},{surfaceOp:'append'});
  session.append('step/start',{turn:1,step:1});
  session.append('assistant/message',{turn:1,step:1,stream:[],message:{
   id:label+'-reply',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},
   content:[{type:'text',text:label+' completed fixture'}],
  }},{surfaceOp:'append'});
  session.append('step/end',{turn:1,step:1});
  session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  return session.id;
 });
}

function fixtureHtml(color, spacer=790) {
 return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<style>h1{margin:0;line-height:40px}button{width:140px;height:60px;border:0;color:white}'+
  '#target{background:'+color+'}#untouched{background:#222222}</style>'+
  '<h1 id="catalog-title">Catalog details</h1><div style="height:'+spacer+'px"></div>'+
  '<button id="target">Primary action</button> <button id="untouched">Secondary action</button>'+
  '<div style="height:550px"></div>'+
  '<script>fetch("/fixture-write",{method:"POST"}).catch(()=>{});'+
  'fetch("https://outside-preview.invalid/").catch(()=>{});</script>';
}

test('navigate and scroll a real preview snapshot on mobile, then attach and edit the selected element', {timeout:100000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli,'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(),'homeai-preview-select-'));
 const {chromium} = require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
 const channel = process.env.HARNESS_CHROMIUM_CHANNEL;
 const {snapshotOwnedPreview} = await import('../preview-snapshot.mjs');
 const socketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\homeai-preview-select-'+randomUUID()
  : path.join(directory,'app.sock');
 const projectFile = path.join(directory,'index.html');
 await fs.writeFile(projectFile,fixtureHtml('#e00000'));
 const assetRequests = [];
 let rootHasTarget = false;
 const app = http.createServer(async (req,res) => {
  assetRequests.push(req.url);
  if (req.url === '/') {
   const root = rootHasTarget ? fixtureHtml('#0033ee',0) : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">';
   res.writeHead(200,{'Content-Type':'text/html'}).end(root);
   return;
  }
  if (req.url !== '/catalog/details') {res.writeHead(404).end(); return;}
  res.writeHead(200,{'Content-Type':'text/html'});
  res.end(await fs.readFile(projectFile));
 });
 let child, exited, browser;
 try {
  app.listen(socketPath);
  await once(app,'listening');
  const plugin = path.join(directory,'fixture');
  const idsFile = path.join(directory,'sessions.json');
  await fs.mkdir(plugin);
  await fs.writeFile(path.join(plugin,'package.json'),JSON.stringify({
   name:'preview-selection-fixture',type:'module',
   exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},
   dsh:{client:{platform:'web'}},
  }));
  await fs.writeFile(path.join(plugin,'index.mjs'),`
   import {writeFileSync} from 'node:fs';
   export const inject=['sessions'];
   export function apply(ctx){writeFileSync(${JSON.stringify(idsFile)},JSON.stringify((${seed.toString()})(ctx)))}
  `);
  await fs.writeFile(path.join(plugin,'client.js'),`window.__ModuleLoader__.load({
   id:'preview-selection-fixture',factory:()=>({inject:['uiWorkspace','sessions','conversation'],apply(ctx){
    window.previewFixture = {
     open:id=>ctx.uiWorkspace.openSession(id),
     async draft(id){
      const binding=ctx.sessions.binding(id);
      const state=ctx.conversation.input.for(binding.ctx).state.getSnapshot();
      return {text:state.draft, payload:await ctx.conversation.serializeDraftAttachments(state.attachmentIds)};
     },
    };
   }}),
  });`);
  const overlay = path.join(directory,'overlay.json');
  await fs.writeFile(overlay,JSON.stringify([
   {id:'ui-settings-models',config:{credentialOnboarding:false}},
   {insert:[
    {id:'preview-workbench',name:pathToFileURL(createSourceFixture(directory)).href},
    {id:'preview-selection-fixture',name:pathToFileURL(path.join(plugin,'index.mjs')).href},
   ]},
  ]));
  child = spawn(process.execPath,[cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{
   cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home')},stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  exited = once(child,'close');
  let output = '', url;
  child.stdout.on('data',value=>{output+=value;});
  child.stderr.on('data',value=>{output+=value;});
  const deadline = Date.now()+30000;
  while (!(url=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0])) {
   if(child.exitCode!==null||Date.now()>=deadline)throw Error('Native start failed: '+output.slice(-2000));
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const [first,second] = JSON.parse(await fs.readFile(idsFile,'utf8'));
  browser = await chromium.launch({headless:true,...(channel?{channel}:{})});
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const previewId = 'a'.repeat(32), origin = 'https://preview-owner.test';
  const expiresAt = Date.now()+240000;
  let generation = 'fixture-generation', ready = true;
  const requests = [], prompts = [];
  let latest, renderError;
  await context.route('**/api/workbench/preview', async route => {
   const body = route.request().postDataJSON();
   requests.push(body);
   const head = {version:1,sessionId:body.sessionId};
   if (body.operation === 'restart') {
    assert.equal(body.sessionId,first);
    assert.equal(body.previewId,previewId);
    assert.equal(body.generation,generation);
    generation = 'fixture-restarted';
    rootHasTarget = true;
   }
   if (body.operation === 'close') {
    assert.equal(body.sessionId,first);
    ready = false;
   }
   if (['status','restart','close'].includes(body.operation)) return route.fulfill({json:body.sessionId!==first
    ? {...head,state:'closed'}
    : ready ? {...head,state:'ready',previewId,generation,jobId:'fixture-job',expiresAt,url:origin+'/'}
    : {...head,state:'closed',result:{id:'b'.repeat(32),canReopen:true}}});
   assert.equal(body.operation,'snapshot');
   assert.equal(body.sessionId,first);
   assert.equal(body.previewId,previewId);
   assert.equal(body.generation,generation);
   assert.equal(body.layout,'mobile');
   try {
    latest = await snapshotOwnedPreview({socketPath,origin,layout:body.layout,route:body.route,scrollY:body.scrollY,
     signal:AbortSignal.timeout(12000),assertCurrent(){}},{
     chromium,browserChannel:channel,
    });
   } catch (error) {
    renderError = error;
    return route.fulfill({status:503,json:{code:error.code}});
   }
   return route.fulfill({json:{...head,previewId,generation,image:latest}});
  });
  await context.route('**/api/session/prompt',route=>{prompts.push(route.request().method());return route.abort();});
  await context.route('**/fixture-preview-control',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  const controlTab = await context.newPage();
  await controlTab.goto(new URL('/fixture-preview-control',url).href);
  const page = await context.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.setDefaultTimeout(18000);
  await page.goto(url);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForFunction(()=>window.previewFixture);
  await page.evaluate(id=>window.previewFixture.open(id),first);
  await page.getByText('First completed fixture',{exact:true}).waitFor();
  assert.equal(requests.filter(r=>r.operation==='snapshot').length,0);
  const draft = id=>page.evaluate(session=>window.previewFixture.draft(session),id);
  const composer = page.locator('[contenteditable=true][role=textbox]:visible').last();
  await composer.fill('Change only the primary button to blue.');

  const snapshot = (route, scrollY) => page.locator('img[data-preview-route="'+route+'"][data-preview-scroll-y="'+scrollY+'"]');
  const route = '/catalog/details';
  await page.getByRole('button',{name:'Select an element',exact:true}).tap();
  await snapshot('/',0).waitFor().catch(error => {
   throw new Error('Initial snapshot failed: '+JSON.stringify({operations:requests.map(r=>r.operation),errors,renderError:renderError?.code,assetRequests}),{cause:error});
  });
  await page.getByText('No selectable elements in this section.',{exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Application path',exact:true}).fill(route);
  await page.getByRole('button',{name:'Show page',exact:true}).tap();
  await snapshot(route,0).waitFor();
  assert(!latest.regions.some(region=>region.selector==='#target'));
  const nextY = latest.scrollStep;
  assert.equal(nextY,540);
  await page.getByRole('button',{name:'Show next section',exact:true}).tap();

  async function tapTarget(path=route, scroll=nextY) {
   const image=snapshot(path,scroll);
   await image.waitFor();
   await image.evaluate(async node=>node.decode());
   const target=latest.regions.find(region=>region.selector==='#target');
   assert(target);
   const box=await image.boundingBox();
   await image.tap({position:{
    x:(target.x+target.width/2)*box.width/latest.width,
    y:(target.y+target.height/2)*box.height/latest.height,
   }});
   const crop=page.getByRole('img',{name:'Selected element screenshot'});
   await crop.waitFor();
   return crop.evaluate(async node=>{
    await node.decode();
    const canvas=document.createElement('canvas');
    canvas.width=node.naturalWidth;canvas.height=node.naturalHeight;
    const paint=canvas.getContext('2d');paint.drawImage(node,0,0);
    return {width:canvas.width,height:canvas.height,pixel:[...paint.getImageData(2,2,1,1).data]};
   });
  }

  assert.deepEqual(await tapTarget(),{width:140,height:60,pixel:[224,0,0,255]});
  assert.equal((await draft(first)).payload.attachments.length,0);
  await composer.press('Control+a');
  await page.getByRole('button',{name:'Add to next message',exact:true}).tap();
  await page.getByRole('button',{name:'Select an element',exact:true}).waitFor();
  const next = await draft(first);
  assert.match(next.text,/Change only the primary button to blue\./);
  assert.match(next.text,/`#target`/);
  assert.match(next.text,/`\/catalog\/details`.*scroll Y 540 CSS px/);
  assert.equal(next.payload.attachments.length,1);
  assert.equal(next.payload.attachments[0].type,'image');
  // Deterministic local edit of the specifically selected element. No prompt is sent to a model.
  const selected = next.text.match(/`([^\x60]+)`/)[1];
  assert.equal(selected,'#target');
  const original = await fs.readFile(projectFile,'utf8');
  const edited = original.replace(selected+'{background:#e00000}',selected+'{background:#0033ee}');
  assert.notEqual(edited,original);
  assert(edited.includes('#untouched{background:#222222}'));
  await fs.writeFile(projectFile,edited);
  await page.getByRole('button',{name:'Select an element',exact:true}).tap();
  assert.deepEqual(await tapTarget(),{width:140,height:60,pixel:[0,51,238,255]});

  const control = body => controlTab.evaluate(async payload => {
   const response = await fetch('/api/workbench/preview',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   return response.json();
  }, {sessionId:first,...body});
  const attach = page.getByRole('button',{name:'Add to next message',exact:true});
  const changed = page.getByText('The preview changed. Open the current preview and select the element again.',{exact:true});
  const crop = page.getByRole('img',{name:'Selected element screenshot'});
  const restarted = await control({operation:'restart',previewId,generation,requestId:'fixture-restart'});
  assert.equal(restarted.generation,'fixture-restarted');
  await attach.tap();
  await changed.waitFor();
  assert.equal(await crop.count(),0);
  assert.deepEqual(await draft(first),next);

  await page.getByRole('button',{name:'Select an element',exact:true}).tap();
  assert.deepEqual(await tapTarget('/',0),{width:140,height:60,pixel:[0,51,238,255]});
  assert.equal((await control({operation:'close'})).state,'closed');
  await attach.tap();
  await changed.waitFor();
  assert.equal(await crop.count(),0);
  await page.getByRole('button',{name:'Restore preview',exact:true}).waitFor();
  assert.deepEqual(await draft(first),next);

  await page.evaluate(id=>window.previewFixture.open(id),second);
  await page.getByText('Second completed fixture',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-preview-element-picker]').count(),0);
  assert.equal((await draft(second)).payload.attachments.length,0);
  assert.deepEqual(requests.filter(r=>r.operation==='snapshot').map(({route,scrollY})=>[route,scrollY]),[
   ['/',0],[route,0],[route,nextY],[route,nextY],['/',0],
  ]);
  assert.deepEqual(prompts,[]);
  assert.deepEqual(errors,[]);
  assert.deepEqual(assetRequests,['/',route,route,route,'/']);
 } finally {
  if (browser) await browser.close();
  if (child) {
   if (child.exitCode===null&&child.signalCode===null)child.kill();
   await exited;
  }
  if (app.listening) await new Promise(resolve=>app.close(resolve));
  await fs.rm(directory,{recursive:true,force:true});
 }
});
