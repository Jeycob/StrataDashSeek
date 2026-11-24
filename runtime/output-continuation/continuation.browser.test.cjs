'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');

test('Native replaces the historical limit banner and shows a recovered turn without a warning', {timeout:90000}, async () => {
 const cli = process.env.HARNESS_NATIVE_CLI;
 assert(cli, 'The pinned Native CLI is required');
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homeai-output-browser-'));
 const fixture = path.join(directory, 'fixture'), state = path.join(directory, 'sessions.json');
 let child, browser, closed, output = '';
 try {
  await fs.mkdir(fixture);
  await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({
   name:'output-browser-fixture',type:'module',dsh:{client:{platform:'web'}},
   exports:{'.':'./index.mjs','./client':'./client.js','./package.json':'./package.json'},
  }));
  await fs.writeFile(path.join(fixture,'client.js'),`window.__ModuleLoader__.load({
   id:'output-browser-fixture',factory:()=>({inject:['uiWorkspace'],apply(ctx){
    window.openOutputFixture=id=>{try {ctx.uiWorkspace.openSession(id);return true;}
     catch(error){if(!error.message.includes('unknown session'))throw error;return false;}};
   }})
  });`);
  await fs.writeFile(path.join(fixture,'index.mjs'),`
   import fs from 'node:fs/promises';
   export const inject=['sessions','workspaceRegistry','sessionTitle'];
   export async function apply(ctx){
    const cwd=${JSON.stringify(directory)}, workspace=await ctx.workspaceRegistry.create(cwd), ids={};
    for(const [label,kind] of [['Historical','max-tokens'],['Recovered','completed']]){
     const session=ctx.sessions.create(undefined,{meta:{cwd}});
     session.append('turn/start',{turn:1});
     session.append('user/message',{id:'initial',role:'user',source:{kind:'user'},content:[{type:'text',text:label+' prompt'}]},{surfaceOp:'append'});
     const contents=kind==='max-tokens'?['Historical saved fragment']:['Recovered initial fragment','Recovered final answer'];
     for(const [index,text] of contents.entries()){
      const turn=1,step=index+1;
      session.append('step/start',{turn,step});
      session.append('assistant/message',{turn,step,stream:[],message:{id:'assistant-'+step,role:'assistant',source:{kind:'model',provider:'fixture',model:'inert'},content:[{type:'text',text}]}},{surfaceOp:'append'});
      session.append('step/end',{turn,step});
     }
     session.append('turn/end',{turn:1,reason:{kind}});
     ctx.sessionTitle.rename(session,label);
     if(!await ctx.sessions.flush(session))throw Error('FIXTURE_SESSION_NOT_SAVED');
     await workspace.attachSession(session.id);
     ids[label]=session.id;
    }
    await fs.writeFile(${JSON.stringify(state)},JSON.stringify(ids));
   }`);
  const overlay = path.join(directory,'overlay.json');
  await fs.writeFile(overlay,JSON.stringify([
   {id:'ui-settings-models',config:{credentialOnboarding:false}},{id:'session-title-llm',disabled:true},
   {insert:[
    {id:'homeai-output-continuation',name:pathToFileURL(path.join(__dirname,'index.mjs')).href},
    {id:'output-browser-fixture',name:pathToFileURL(path.join(fixture,'index.mjs')).href},
   ]},
  ]));
  child=spawn(process.execPath,[cli,'web','--patch',overlay,'--no-open','--host','127.0.0.1','--port','0'],{
   cwd:directory,env:{...process.env,DSH_HOME:path.join(directory,'home')},stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  closed=once(child,'close');
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>output=(output+chunk).slice(-5000));
  let url;
  const deadline=Date.now()+30000;
  while(!(url=output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)?.[0])){
   if(child.exitCode!==null || Date.now()>=deadline)throw Error(output.replace(/token=[^\s&]+/g,'token=[redacted]'));
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE || 'playwright');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({locale:'en-US',viewport:{width:1280,height:900}});
  page.setDefaultTimeout(15000);
  const {Historical,Recovered}=JSON.parse(await fs.readFile(state,'utf8'));
  await page.goto(url);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const open=id=>page.waitForFunction(id=>window.openOutputFixture?.(id),id);
  await open(Historical);
  const notice=page.locator('[data-homeai-output-limit]:visible');
  await notice.getByText('Reply incomplete',{exact:true}).waitFor();
  await page.getByText('Historical saved fragment',{exact:true}).waitFor();
  assert.equal(await page.getByText('Output token limit reached',{exact:true}).count(),0);
  assert.equal(await page.getByText(/send "continue" to let the model resume/i).count(),0);
  await page.reload();
  await open(Historical);
  await notice.getByText('Reply incomplete',{exact:true}).waitFor();
  await open(Recovered);
  await page.getByText('Recovered final answer',{exact:true}).waitFor();
  await notice.waitFor({state:'hidden'});
 } finally {
  if(browser)await browser.close();
  if(child && child.exitCode===null)child.kill();
  if(closed)await closed;
  await fs.rm(directory,{recursive:true,force:true});
 }
});
