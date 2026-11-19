// Opt-in bridge for the existing authenticated Playwright QA session. It never
// submits a prompt, opens a model connection, or starts/restarts an application.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {makeReport} from './import.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const need=(value,code)=>{if(!value)throw Error(code);};
const MAX=65536;
async function bytes(file){const handle=await fs.open(file,'r');try{need((await handle.stat()).size<=MAX,'QA_FILE_LIMIT');const value=await handle.readFile();need(value.length<=MAX,'QA_FILE_LIMIT');return value;}finally{await handle.close();}}
async function write(file,value){const body=JSON.stringify(value)+'\n';need(Buffer.byteLength(body)<=MAX,'QA_OUTPUT_LIMIT');await fs.writeFile(file,body,{flag:'wx',mode:0o600});return sha(body);}
async function files(root,prefix=''){const output=[];for(const row of await fs.readdir(path.join(root,prefix),{withFileTypes:true})){const relative=path.posix.join(prefix,row.name);need(!row.isSymbolicLink(),'QA_INPUT_SYMLINK');if(row.isDirectory())output.push(...await files(root,relative));else{const value=await bytes(path.join(root,relative));output.push({path:relative,bytes:value.length,sha256:sha(value)});}need(output.length<=30,'QA_INPUT_LIMIT');}return output.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
export async function definition(scenario,root=fileURLToPath(new URL('../roadmap-16-smoke/',import.meta.url))){
 need(['counter','b03','b10'].includes(scenario),'QA_CASE_INVALID');
 const prompt=await bytes(path.join(root,'inputs',scenario+'.prompt.txt')),oracle=await bytes(path.join(root,'expected.json'));
 const inputs=scenario==='counter'?[]:scenario==='b10'?await files(path.join(root,'inputs/b10')):[{path:'expenses.csv',bytes:(await bytes(path.join(root,'inputs/expenses.csv'))).length,sha256:sha(await bytes(path.join(root,'inputs/expenses.csv')))}];
 const preparedInputs=inputs.map(row=>({...row,path:row.path.replace(/\.fixture$/,'')}));
 return{scenario,promptSha256:sha(prompt),inputSha256:sha(JSON.stringify(preparedInputs)),inputs:preparedInputs,acceptanceSha256:sha(Buffer.concat([oracle,await bytes(fileURLToPath(import.meta.url))])),expected:JSON.parse(oracle),csv:path.join(root,'inputs/expenses.csv')};
}
async function json(response){need(response.ok(),'QA_HTTP_UNAVAILABLE');const body=await response.body();need(body.length<=MAX,'QA_RESPONSE_LIMIT');return JSON.parse(body.toString('utf8'));}
async function receipt(page,sessionId,afterSeq){const url=new URL('/api/workbench/qa-receipt',page.url());url.searchParams.set('sessionId',sessionId);if(afterSeq!==undefined)url.searchParams.set('afterSeq',String(afterSeq));const value=await json(await page.request.get(url.href,{timeout:10000}));need(value.kind==='qa-session-receipt'&&value.sessionId===sessionId,'QA_SESSION_MISMATCH');return value;}
async function preview(nativePage,page,sessionId){
 const origin=new URL(nativePage.url()).origin,value=await json(await nativePage.request.post(origin+'/api/workbench/preview',{headers:{Origin:origin},data:{operation:'status',sessionId},timeout:10000}));
 need(value.sessionId===sessionId&&value.state==='ready'&&new URL(value.url).origin===new URL(page.url()).origin,'QA_PREVIEW_MISMATCH');
 return{sessionId,previewId:value.previewId,generation:value.generation,originSha256:sha(new URL(value.url).origin)};
}
export async function beginCase({nativePage,sessionId,scenario,directory,definitionRoot,pairId,cacheCondition=null,budget=null}){
 const frozen=await definition(scenario,definitionRoot),start=await receipt(nativePage,sessionId);
 need(start.runtime&&Number.isSafeInteger(start.cursor),'QA_RUNTIME_UNCONFIRMED');need(typeof pairId==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(pairId),'QA_PAIR_ID_REQUIRED');
 // Verify the prepared synthetic input bytes in this exact SID before its
 // original submit. B10's preserved .fixture suffix is removed on preparation.
 for(const input of frozen.inputs){const url=new URL('/api/workbench/download',nativePage.url());url.searchParams.set('sessionId',sessionId);url.searchParams.set('path',input.path);const response=await nativePage.request.get(url.href,{timeout:10000});need(response.ok(),'QA_PREPARED_INPUT_UNAVAILABLE');const body=await response.body();need(body.length===input.bytes&&sha(body)===input.sha256,'QA_PREPARED_INPUT_CHANGED');}
 // Cache state and limits are preregistered conditions, not retrospectively
 // filled measurements. Omitting either leaves comparison unavailable.
 need(cacheCondition===null||['cold','warm','preserved'].includes(cacheCondition),'QA_CACHE_CONDITION_INVALID');
 need(budget===null||Object.keys(budget).sort().join(',')==='mainSeconds,maxRepairs'&&Number.isSafeInteger(budget.mainSeconds)&&budget.mainSeconds>0&&Number.isSafeInteger(budget.maxRepairs)&&budget.maxRepairs>=0,'QA_BUDGET_INVALID');
 const {expected,csv,...identity}=frozen,begin={version:1,kind:'qa-smoke-begin',pairId,sessionId,scenario,start,definition:identity,cacheCondition,budget:budget?{mainSeconds:budget.mainSeconds,maxRepairs:budget.maxRepairs}:null};
 await fs.mkdir(directory,{recursive:true});await write(path.join(directory,'begin.json'),begin);return begin;
}
export async function checkCounter(page,expected,{value='#value',plus='+',minus='−',reset='Reset'}={}){
 const field=page.locator(value),observed=[Number((await field.innerText()).trim())];
 for(const name of [plus,minus,minus,reset]){await page.getByRole('button',{name,exact:true}).click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));observed.push(Number((await field.innerText()).trim()));}
 assert.deepEqual(observed,expected.counter);return{sequence:observed};
}
export async function checkB03(page,expected,csv){
 await page.getByLabel('CSV soubor',{exact:true}).setInputFiles(csv);await page.getByRole('button',{name:'Načíst CSV',exact:true}).click();
 const field=page.locator('[data-testid="summary-json"]');await field.waitFor();
 await page.waitForFunction(({count,total})=>{try{const value=JSON.parse(document.querySelector('[data-testid="summary-json"]')?.textContent);return value.count===count&&value.totalCents===total;}catch{return false;}},{count:expected.b03.count,total:expected.b03.totalCents},{timeout:10000});
 const summary=JSON.parse(await field.textContent());assert.deepEqual(summary,expected.b03);
 const pending=page.waitForEvent('download',{timeout:10000});await page.getByRole('button',{name:'Stáhnout zprávu',exact:true}).click();const download=await pending;need(!await download.failure(),'QA_DOWNLOAD_FAILED');
 const stream=await download.createReadStream(),parts=[];let size=0;for await(const part of stream){size+=part.length;need(size<=MAX,'QA_DOWNLOAD_LIMIT');parts.push(part);}const report=JSON.parse(Buffer.concat(parts).toString('utf8'));assert.deepEqual(report,summary);
 return{summary,downloadSha256:sha(Buffer.concat(parts))};
}
export async function checkB10(page,expected){
 const response=method=>page.waitForResponse(r=>r.request().method()===method&&/\/api\/notes(?:\/[^/?]+)?$/.test(new URL(r.url()).pathname),{timeout:10000});
 let pending=response('POST');await page.getByRole('button',{name:'Nová poznámka',exact:true}).click();let note=await (await pending).json();assert.equal(note.version,1);
 await page.getByLabel('Název',{exact:true}).fill('QA recorded note');await page.getByLabel('Text',{exact:true}).fill('UI saved text');pending=response('PATCH');await page.getByRole('button',{name:'Uložit',exact:true}).click();const saved=await pending;assert.equal(saved.status(),200);assert.equal((await saved.json()).body,'UI saved text');
 // Use a second UI-created note so the preserved concurrency oracle still
 // starts from baseVersion 1. No existing user note is edited or deleted.
 pending=response('POST');await page.getByRole('button',{name:'Nová poznámka',exact:true}).click();note=await (await pending).json();assert.equal(note.version,1);
 const observed=await page.evaluate(async id=>{
  const url=new URL('./api/notes/'+encodeURIComponent(id),location.href),patch=body=>fetch(url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'QA concurrent note',body,baseVersion:1,delayMs:100})});
  const replies=await Promise.all([patch('first'),patch('second')]),final=await (await fetch(url)).json(),stale=await patch('stale'),after=await (await fetch(url)).json();
  return{concurrentStatuses:replies.map(r=>r.status),finalVersion:final.version,staleStatus:stale.status,winningText:final.body,unchanged:JSON.stringify(final)===JSON.stringify(after)};
 },note.id);
 assert.deepEqual([...observed.concurrentStatuses].sort(),expected.b10.reference.concurrentStatuses);assert.equal(observed.finalVersion,expected.b10.reference.finalVersion);assert.equal(observed.staleStatus,expected.b10.reference.staleStatus);assert(['first','second'].includes(observed.winningText));assert.equal(observed.unchanged,true);return observed;
}
export function projectSmokeRun(begin,end,check,evidenceId){
 need(begin.sessionId===end.sessionId&&begin.start.workspaceId===end.workspaceId&&begin.start.runtime?.sourceCommit===end.runtime?.sourceCommit&&begin.start.runtime?.epoch===end.runtime?.epoch,'QA_RUNTIME_CHANGED');
 const request=end.request;need(request?.state==='completed'&&request.admissionSeq>begin.start.cursor&&request.promptSha256===begin.definition.promptSha256&&request.admittedAt>=begin.start.observedAt&&request.finishedAt<=end.observedAt,'QA_REQUEST_UNCONFIRMED');
 const sample=end.sharedTelemetry,original=begin.start.sharedTelemetry;
 const bound=sample&&original&&sample.monitorStartedAt===original.monitorStartedAt&&sample.at>=request.admittedAt&&sample.at<=end.observedAt&&end.observedAt-sample.at<=20000;
 const sharedMemory=bound&&(sample.ramScope&&sample.ramUsedBytes!==null||sample.gpuUsedBytes!==null)?{epoch:end.runtime.epoch,observedAt:sample.at,evidenceId,kind:'sample',ramScope:sample.ramScope,ramUsedBytes:sample.ramScope?sample.ramUsedBytes:null,gpuScope:'whole-gpu',gpuUsedBytes:sample.gpuUsedBytes,monitorStartedAt:sample.monitorStartedAt}:null;
 return{id:begin.sessionId+'-'+request.messageId,pairId:begin.pairId,workspaceId:end.workspaceId,sourceWorkspaceId:end.workspaceId,sessionId:begin.sessionId,requestId:request.messageId,sourceCommit:end.runtime.sourceCommit,epoch:end.runtime.epoch,profileName:begin.start.configuration?.name??begin.scenario,requestedConfiguration:begin.start.configuration??null,
  submittedAt:request.admittedAt,finishedAt:end.observedAt,modelFinishedAt:request.finishedAt,status:check.passed===true?'PASS':check.passed===false?'FAIL':'BLOCKED',
  comparison:{definition:'roadmap-16-smoke/'+begin.scenario,promptSha256:begin.definition.promptSha256,inputSha256:begin.definition.inputSha256,acceptanceSha256:begin.definition.acceptanceSha256,runtimeCommit:end.runtime.sourceCommit,budgetSha256:begin.budget?sha(JSON.stringify(begin.budget)):null,cacheCondition:begin.cacheCondition,contextTokens:bound?sample.contextTokens:null},
  acceptance:check.passed===null?null:{passed:check.passed,at:end.observedAt,evidenceId},acceptanceTimeBasis:'server-receipt-after-independent-checks',
  requestRoutes:request.requestRoutes?{complete:true,rows:request.requestRoutes,evidenceId}:null,serving:null,memory:null,sharedMemory,sourceEvidence:[evidenceId]};
}
export async function finishCase({nativePage,previewPage,directory,definitionRoot,counterSelectors}){
 const begin=JSON.parse(await bytes(path.join(directory,'begin.json'))),frozen=await definition(begin.scenario,definitionRoot);
 for(const key of ['promptSha256','inputSha256','acceptanceSha256'])need(begin.definition[key]===frozen[key],'QA_DEFINITION_CHANGED');
 const completed=await receipt(nativePage,begin.sessionId,begin.start.cursor);projectSmokeRun(begin,completed,{passed:null},'precheck');
 const before=await preview(nativePage,previewPage,begin.sessionId);
 // A stable origin can serve a new generation while the tab still shows the
 // previous DOM. Load this generation before any acceptance interaction.
 await previewPage.reload({waitUntil:'domcontentloaded'});const loaded=await preview(nativePage,previewPage,begin.sessionId);need(JSON.stringify(before)===JSON.stringify(loaded),'QA_PREVIEW_CHANGED');let observation=null,check;
 try{observation=begin.scenario==='counter'?await checkCounter(previewPage,frozen.expected,counterSelectors):begin.scenario==='b03'?await checkB03(previewPage,frozen.expected,frozen.csv):await checkB10(previewPage,frozen.expected);
  if(begin.scenario==='counter'){const url=new URL('/api/workbench/download',nativePage.url());url.searchParams.set('sessionId',begin.sessionId);url.searchParams.set('path','index.html');const response=await nativePage.request.get(url.href,{timeout:10000});need(response.ok(),'QA_COUNTER_FILE_UNAVAILABLE');const body=await response.body();need(body.length>0&&body.length<=MAX,'QA_COUNTER_FILE_SIZE');observation.file={path:'index.html',bytes:body.length,sha256:sha(body)};}
  check={passed:true,code:'QA_CHECK_PASSED'};}catch(error){check={passed:error.code==='ERR_ASSERTION'?false:null,code:error.code==='ERR_ASSERTION'?'QA_CHECK_FAILED':'QA_CHECK_UNCONFIRMED'};}
 const after=await preview(nativePage,previewPage,begin.sessionId);need(JSON.stringify(before)===JSON.stringify(after),'QA_PREVIEW_CHANGED');
 const end=await receipt(nativePage,begin.sessionId,begin.start.cursor);need(end.request?.state==='completed'&&['messageId','turn','endSeq','finishedAt'].every(key=>end.request[key]===completed.request[key]),'QA_REQUEST_CHANGED');
 const evidence={version:1,kind:'qa-smoke-result',begin,end,preview:after,check,observation};
 const digest=await write(path.join(directory,'result.json'),evidence),row=projectSmokeRun(begin,end,check,'sha256:'+digest);await write(path.join(directory,'history.json'),makeReport([row]));return{check,history:row,evidenceSha256:digest};
}
export async function exportPair(resultFiles,output){
 need(resultFiles.length>0&&resultFiles.length<=100,'QA_PAIR_FILES_REQUIRED');const runs=[];
 for(const file of resultFiles){const raw=await bytes(file),value=JSON.parse(raw);need(value.kind==='qa-smoke-result','QA_RESULT_REQUIRED');runs.push(projectSmokeRun(value.begin,value.end,value.check,'sha256:'+sha(raw)));}
 const report=makeReport(runs);await write(output,report);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const args=process.argv.slice(2);if(args.shift()!=='export'||args.length<2||args.length>101){console.error('Usage: qa.mjs export RESULT.json [RESULT_B.json ...] NEW_REPORT.json');process.exitCode=1;}else exportPair(args.slice(0,-1),args.at(-1)).then(value=>console.log(JSON.stringify({runs:value.runs.length}))).catch(error=>{console.error(error.message);process.exitCode=1;});}
