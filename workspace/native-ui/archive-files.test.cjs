'use strict';
// Actual Native registry, archive row, SDK file service and Chromium.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {spawn}=require('node:child_process'), {once}=require('node:events'), {pathToFileURL}=require('node:url');
const {createSourceFixture}=require('./test-bundle.cjs');

test('an archived legacy result can be downloaded from its own Native row without opening the session', {timeout:90000}, async t=>{
 const cli=process.env.HARNESS_NATIVE_CLI;
 assert(cli,'The pinned Native CLI is required');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeai-archive-files-'));
 let child,browser,exited;
 try{
  const archivedProject=path.join(directory,'old-project'), activeProject=path.join(directory,'active-project');
  const plugin=path.join(directory,'fixture'), archivedTitle='Archived counter fixture';
  const bytes='<!doctype html><title>Archived counter only</title>';
  for(const dir of [archivedProject,activeProject,plugin])await fs.mkdir(dir);
  const oldFile=path.join(archivedProject,'index.html');
  await fs.writeFile(oldFile,bytes);
  await fs.writeFile(path.join(activeProject,'index.html'),'Foreign active file');
  const moduleUrl=name=>JSON.stringify(pathToFileURL(path.resolve(__dirname,'..',name)).href);
  await fs.writeFile(path.join(plugin,'package.json'),JSON.stringify({name:'archive-files-fixture',type:'module',
   exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},dsh:{client:{platform:'web'}}}));
  await fs.writeFile(path.join(plugin,'index.mjs'),`
   import {WorkspaceManager} from ${moduleUrl('manager.mjs')};
   import {workspaceDownload} from ${moduleUrl('download.mjs')};
   import {hostExecutionBinding} from ${moduleUrl('fixtures/execution-binding.mjs')};
   export const inject=['sessions','sessionPersistence','sessionQuery','workingDirectory','workspaceRegistry','sessionTitle','agents','fs','connection','llm'];
   export async function apply(ctx){
    let streams=0, prompts=0;
    ctx.on('llm/stream',()=>{streams++;throw Error('FIXTURE_INFERENCE_REFUSED');},{prepend:true,global:true});
    ctx.on('agent/inbox/inserted',event=>{if(event.message?.source?.kind==='user')prompts++;},{global:true});
    async function seed(root,title){
     const workspace=await ctx.workspaceRegistry.create(root);
     const session=ctx.sessions.create(undefined,{meta:{cwd:root}});
     session.append('turn/start',{turn:1});
     session.append('user/message',{id:'question',role:'user',source:{kind:'user'},content:[{type:'text',text:title}]},{surfaceOp:'append'});
     session.append('step/start',{turn:1,step:1});
     session.append('assistant/message',{turn:1,step:1,stream:[],message:{id:'answer',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'Saved result'}]}},{surfaceOp:'append'});
     session.append('step/end',{turn:1,step:1});
     session.append('turn/end',{turn:1,reason:{kind:'completed'}});
     ctx.sessionTitle.rename(session,title);
     if(await ctx.sessions.flush(session)!==true)throw Error('FIXTURE_SESSION_NOT_SAVED');
     await workspace.attachSession(session.id);
     return session.id;
    }
    const archivedId=await seed(${JSON.stringify(archivedProject)},${JSON.stringify(archivedTitle)});
    const activeId=await seed(${JSON.stringify(activeProject)},'Active draft fixture');
    await ctx.workspaceRegistry.archiveSession(archivedId);
    const manager=new WorkspaceManager(ctx,{},hostExecutionBinding());
    manager.data={sessions:{[activeId]:{root:${JSON.stringify(activeProject)}}},trash:{}};
    const downloads=[],lists=[];
    ctx.effect(()=>ctx.connection.fetch.register({path:'/api/archive-files-fixture',methods:['GET'],requestBody:'buffered',fetch(){
     return Response.json({archivedId,activeId,archived:ctx.workspaceRegistry.archivedSessionIds.includes(archivedId),streams,prompts,downloads,lists});
    }}));
    ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench',methods:['POST','GET'],requestBody:'buffered',async fetch(request){
     if(request.method!=='POST')return Response.json({});
     const data=await request.json();
     if(data.op!=='file')return Response.json({});
     lists.push(data);
     try{return Response.json(await manager.files(data.sessionId,data.operation,data.args??{},request.signal));}
     catch(error){return Response.json({code:error.code},{status:error.status??404});}
    }}));
    ctx.effect(()=>ctx.connection.fetch.register({path:'/api/workbench/download',methods:['GET'],requestBody:'buffered',async fetch(request){
     downloads.push(Object.fromEntries(new URL(request.url).searchParams));
     try{return await workspaceDownload(ctx,manager,request);}
     catch(error){return Response.json({code:error.code},{status:error.status??404});}
    }}));
   }
  `);
  await fs.writeFile(path.join(plugin,'client.js'),`window.__ModuleLoader__.load({
   id:'archive-files-fixture',factory:()=>({inject:['uiWorkspace'],apply(ctx){window.ArchiveFixture={open:id=>ctx.uiWorkspace.openSession(id)};}})
  });`);
  const overlay=path.join(directory,'overlay.json');
  await fs.writeFile(overlay,JSON.stringify([{id:'ui-settings-models',config:{credentialOnboarding:false}},
   {id:'session-title-llm',disabled:true},{insert:[
    {id:'archive-workbench',name:pathToFileURL(createSourceFixture(directory)).href},
    {id:'archive-files-fixture',name:pathToFileURL(path.join(plugin,'index.mjs')).href},
   ]}]));
  child=spawn(process.execPath,[cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],
   {cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home')},stdio:['ignore','pipe','pipe'],windowsHide:true});
  exited=once(child,'close');
  let output='';
  child.stdout.on('data',chunk=>output=(output+chunk).slice(-10000));
  child.stderr.on('data',chunk=>output=(output+chunk).slice(-10000));
  let url;
  const deadline=Date.now()+30000;
  while(!(url=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0])){
   if(child.exitCode!==null||Date.now()>=deadline)throw Error('Native archive fixture startup failed: '+output.slice(-2000));
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}}), errors=[];
  page.setDefaultTimeout(12000);
  page.on('pageerror',error=>errors.push(error.message));
  const stats=async()=>await (await page.request.get(new URL('/api/archive-files-fixture',url).href)).json();
  await page.goto(url);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForFunction(()=>window.ArchiveFixture && window.HarnessNativeUI);
  const {activeId,archivedId,archived}=await stats();
  assert.equal(archived,true);
  await page.evaluate(id=>window.ArchiveFixture.open(id),activeId);
  const composer=page.locator('[contenteditable=true][role=textbox]:visible').last();
  await composer.fill('Keep this draft in the active conversation');
  await page.getByRole('button',{name:'View options',exact:true}).click();
  await page.getByText('Archived only',{exact:true}).click();
  const group=page.getByRole('treeitem',{name:/old-project/}).first();
  if(await group.getAttribute('aria-expanded')==='false')await group.click();
  const row=page.getByText(archivedTitle,{exact:true}).first();
  try{await row.click();}catch(error){t.diagnostic((await page.locator('body').innerText()).slice(0,2500));throw error;}
  await page.getByText('Archived sessions cannot be opened. Unarchive it to view.',{exact:true}).waitFor();
  assert.equal(await composer.innerText(),'Keep this draft in the active conversation');
  await row.hover();
  await page.getByRole('button',{name:'Session actions for '+archivedTitle,exact:true}).click();
  await page.getByText('Archived files',{exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Archived files',exact:true});
  await dialog.getByText(archivedId,{exact:true}).waitFor();
  const downloadButton=dialog.getByRole('button',{name:'Download index.html',exact:true});
  const [download]=await Promise.all([page.waitForEvent('download'),downloadButton.click()]);
  assert.equal(download.suggestedFilename(),'index.html');
  assert.equal(await fs.readFile(await download.path(),'utf8'),bytes);
  await fs.unlink(oldFile);
  await downloadButton.click();
  await dialog.getByText('This file is no longer available.',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await composer.innerText(),'Keep this draft in the active conversation');
  const after=await stats();
  assert.equal(after.archived,true);
  assert.deepEqual([after.streams,after.prompts],[0,0]);
  assert.deepEqual(after.downloads,Array(2).fill({sessionId:archivedId,path:'index.html'}));
  assert(after.lists.length>0&&after.lists.every(row=>row.sessionId===archivedId&&row.operation==='list'));
  assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();
  if(child){if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}
  await fs.rm(directory,{recursive:true,force:true});
 }
});
