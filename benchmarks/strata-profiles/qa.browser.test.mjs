import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {definition,checkCounter,checkB03,checkB10,beginCase,finishCase,exportPair} from './qa.mjs';
const require=createRequire(import.meta.url),definitions=process.env.HOMEAI_SMOKE_ROOT??path.resolve('benchmarks/roadmap-16-smoke');
test('ordinary QA bridge clicks the preserved counter, imports/downloads B03 and exercises B10 UI plus concurrent requests',{timeout:60000},async t=>{
 const {chromium}=require(process.env.HARNESS_PLAYWRIGHT_MODULE||'playwright'),browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(5000);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-qa-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('profile-qa-'));return fs.rm(root,{recursive:true,force:true});});
 const expected=JSON.parse(await fs.readFile(path.join(definitions,'expected.json'),'utf8')),counter=await fs.readFile(path.join(definitions,'reference/counter.html'),'utf8');let broken=false;
 const b03=`<!doctype html><label>CSV soubor<input type="file"></label><button>Načíst CSV</button><pre data-testid="summary-json"></pre><button>Stáhnout zprávu</button><script>const summary=${JSON.stringify(expected.b03)};document.querySelectorAll('button')[0].onclick=()=>{if(!document.querySelector('input').files.length)throw Error('No input');document.querySelector('pre').textContent=JSON.stringify(summary)};document.querySelectorAll('button')[1].onclick=()=>{const a=document.createElement('a');a.download='report.json';a.href=URL.createObjectURL(new Blob([document.querySelector('pre').textContent],{type:'application/json'}));a.click()};</script>`;
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/b03'?b03:broken?counter.replace('value -= 1;','value = Math.max(0, value - 1);'):counter);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port;
 const selectors={plus:'Přičíst',minus:'Odečíst'};await page.goto(origin);assert.deepEqual(await checkCounter(page,expected,selectors),{sequence:expected.counter});broken=true;await page.reload();await assert.rejects(checkCounter(page,expected,selectors),{code:'ERR_ASSERTION'});broken=false;
 await page.goto(origin+'/b03');assert.deepEqual((await checkB03(page,expected,path.join(definitions,'inputs/expenses.csv'))).summary,expected.b03);
 // The preserved faulty B10 server plus one local version guard is the
 // positive fixture. The original fixture below must fail the same check.
 const b10=path.join(root,'b10');await fs.cp(path.join(definitions,'inputs/b10'),b10,{recursive:true});const serverFile=path.join(b10,'server.mjs'),original=await fs.readFile(serverFile,'utf8');await fs.writeFile(serverFile,original.replace('const updated=updateNote(note,body);',"if(note.version!==body.baseVersion)return respond(res,409,{error:'conflict'});const updated=updateNote(note,body);"));
 let child;async function launch(){let stdout='';child=spawn(process.execPath,[serverFile],{cwd:b10,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup')),5000);child.stdout.on('data',chunk=>{stdout+=chunk;const found=stdout.match(/notes listening (\d+)/);if(found){clearTimeout(timer);resolve('http://127.0.0.1:'+found[1]);}});child.once('error',reject);});}
 async function stop(){const owned=child;child=null;if(owned&&owned.exitCode===null&&owned.signalCode===null){const ended=new Promise(resolve=>owned.once('exit',resolve));owned.kill();await ended;}}t.after(stop);
 await page.goto(await launch());await checkB10(page,expected);await stop();await fs.writeFile(serverFile,original);await page.goto(await launch());await assert.rejects(checkB10(page,expected),{code:'ERR_ASSERTION'});await stop();
 // Same public producer API used by a QA script: writes begin/result/history,
 // reads the observed values, and exports without hand-entered measurements.
 await page.goto(origin);const frozen=await definition('counter',definitions),startAt=1800000000000;let finished=false;
 const identity={sourceCommit:'b'.repeat(40),epoch:'epoch'},sample={at:startAt+5500,monitorStartedAt:startAt-1000,ramScope:'host',ramUsedBytes:1234,gpuScope:'whole-gpu',gpuUsedBytes:0,contextTokens:131072};
 const response=value=>({ok:()=>true,body:async()=>Buffer.from(JSON.stringify(value))});
 const nativePage={url:()=>origin,request:{get:async()=>response({version:1,kind:'qa-session-receipt',sessionId:'sid',workspaceId:'workspace',cursor:finished?10:0,observedAt:startAt+(finished?6000:0),runtime:identity,sharedTelemetry:{...sample,at:startAt+(finished?5500:0)},request:finished?{state:'completed',messageId:'prompt',turn:1,endSeq:8,admissionSeq:1,admittedAt:startAt+100,finishedAt:startAt+5000,promptSha256:frozen.promptSha256,requestRoutes:[{provider:'fixture',model:'fixture'}]}:null}),post:async()=>response({sessionId:'sid',state:'ready',previewId:'preview',generation:'generation',url:origin})}};
 const getReceipt=nativePage.request.get;nativePage.request.get=async url=>url.includes('/download')?{ok:()=>true,body:async()=>Buffer.from(counter)}:getReceipt(url);
 const output=path.join(root,'qa');await beginCase({nativePage,sessionId:'sid',scenario:'counter',pairId:'pair',directory:output,definitionRoot:definitions});
 await assert.rejects(finishCase({nativePage,previewPage:{reload(){throw Error('An unfinished turn must not reach UI checks');}},directory:output,definitionRoot:definitions}),/QA_REQUEST_UNCONFIRMED/);finished=true;
 const result=await finishCase({nativePage,previewPage:page,directory:output,definitionRoot:definitions,counterSelectors:selectors});assert.equal(result.check.passed,true);assert.equal(result.history.acceptance.at,startAt+6000);assert.equal(result.history.sharedMemory.ramScope,'host');assert.equal(result.history.memory,null);
 const exported=await exportPair([path.join(output,'result.json')],path.join(root,'export.json'));assert.equal(exported.runs.length,1);assert.equal(exported.runs[0].requestId,'prompt');
 const normalGet=nativePage.request.get,stale=path.join(root,'stale-dom');finished=false;await beginCase({nativePage,sessionId:'sid',scenario:'counter',pairId:'stale',directory:stale,definitionRoot:definitions});finished=true;broken=true;
 const rejected=await finishCase({nativePage,previewPage:page,directory:stale,definitionRoot:definitions,counterSelectors:selectors});assert.equal(rejected.check.passed,false,'a good old DOM is reloaded and cannot accept the currently broken preview');broken=false;
 const changed=path.join(root,'changed-request');finished=false;await beginCase({nativePage,sessionId:'sid',scenario:'counter',pairId:'changed',directory:changed,definitionRoot:definitions});finished=true;let reads=0;
 nativePage.request.get=async url=>{const value=await normalGet(url);if(url.includes('/qa-receipt')&&++reads===2){const data=JSON.parse(await value.body());data.request.endSeq++;return response(data);}return value;};
 await assert.rejects(finishCase({nativePage,previewPage:page,directory:changed,definitionRoot:definitions,counterSelectors:selectors}),/QA_REQUEST_CHANGED/);nativePage.request.get=normalGet;
 finished=false;const prepare={nativePage,sessionId:'sid',scenario:'b03',pairId:'csv-pair',directory:path.join(root,'bad-input'),definitionRoot:definitions};await assert.rejects(beginCase(prepare),/QA_PREPARED_INPUT_CHANGED/);
 nativePage.request.get=async url=>url.includes('/download')?{ok:()=>true,body:()=>fs.readFile(path.join(definitions,'inputs/expenses.csv'))}:getReceipt(url);
 const prepared=await beginCase({...prepare,directory:path.join(root,'valid-input')});assert.equal(prepared.definition.inputs[0].path,'expenses.csv');
});
