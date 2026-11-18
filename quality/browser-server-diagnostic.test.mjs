import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBrowserServerChannel} from './browser-server-host.mjs';
import {connectBrowserServerControl} from './browser-server-client.mjs';
import {verifyProject,compactReport,runProgram} from './core.mjs';
import {apply} from './plugin.mjs';
import {createHash} from 'node:crypto';
import {createProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
import {browserServerInspection,readInspectionDiagnostic,safeInspectionCode} from './browser-server-diagnostic.mjs';

function hostMode(){
 const policy={version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)},policySha256=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'),snapshot={...policy,policySha256,sourceCommit:'a'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'};
 return createProjectExecutionMode({snapshot,assertUnchanged:()=>snapshot}).service;
}

test('owned real inspector failure reaches rendered compact report; missing browser artifact is secondary',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'quality-inspector-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'source.txt'),'owned fixture');
 const plan={version:1,baseURL:'http://127.0.0.1:21000',viewports:[{name:'desktop',width:800,height:600}],flows:[{name:'ready',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',minCount:1},{action:'checkpoint',name:'ready'}]}]};
 await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan));
 await fs.writeFile(path.join(root,'.harness-quality.json'),JSON.stringify({version:1,sources:['source.txt'],requiredKinds:['browser'],checks:[{id:'flows',kind:'browser',plan:'plan.json',server:{command:['node','server.mjs']}}]}));
 const agent={id:'owner'},record={root,workspaceId:'workspace',ports:[21000,21001,21002,21003]},sourceHash='a'.repeat(64);
 const ctx={projectExecutionMode:{assertTool(){}},agents:{get:id=>id===agent.id?agent:undefined},workspaceRegistry:{archivedSessionIds:[],list:()=>[{id:'workspace',sessionIds:['owner']}]}},manager={ownerAgent:a=>a,data:{sessions:{owner:record},trash:{}},review:async()=>({sourceHash})};
 let inspections=0,serverStarts=0,browserRuns=0,inner;
 const run=async({command})=>{
  inspections++;assert(command.includes('browser-server-inspect.mjs'));
  inner=await runProgram([process.execPath,fileURLToPath(new URL('./browser-server-inspect.mjs',import.meta.url)),root,'.harness-quality.json','flows'],{cwd:root,env:{PATH:process.env.PATH??'',HARNESS_QUALITY_ALLOWED_PORTS:''},timeoutMs:5000});
  assert.equal(inner.exitCode,1);assert.equal(JSON.parse(inner.stdout).code,'BROWSER_SERVER_PORTS_UNAVAILABLE');
  return{result:{exitCode:inner.exitCode,stdout:{text:inner.stdout,truncated:inner.truncated},stderr:{text:inner.stderr,truncated:inner.truncated},timedOut:inner.timedOut}};
 };
 run.startWithCustody=async()=>{serverStarts++;assert.fail('failed inspector cannot start a producer');};
 const channel=await createBrowserServerChannel(ctx,manager,run,{execution:{agent,signal:new AbortController().signal},projectRoot:root,sourceHash,kind:'browser',deadline:Date.now()+15000},{supported:()=>true});
 const control=await connectBrowserServerControl(channel.envelope);
 try{
  const report=await verifyProject({workspace:root,kind:'browser',serverControl:control,run:async()=>{browserRuns++;assert.fail('browser cannot run after inspection failure');}});
  const compact=compactReport(report);assert.equal(compact.passed,false);assert.equal(compact.complete,false);
  const check=compact.checks[0];assert.equal(check.primaryDiagnosticCode,'BROWSER_SERVER_PORTS_UNAVAILABLE');
  assert.equal(check.inspection.exitCode,1);assert.equal(check.inspection.stdout.truncated,false);
  assert.equal(check.diagnostics[0],'BROWSER_SERVER_PORTS_UNAVAILABLE');assert(!check.diagnostics.includes('ENOENT'));assert.deepEqual(check.secondaryDiagnostics,['ENOENT']);
  let definition;apply({projectExecutionMode:hostMode(),tools:{register:value=>{definition=value;}}});
  const rendered=definition.output.render({},compact)[0].text;assert(rendered.includes('BROWSER_SERVER_PORTS_UNAVAILABLE'));assert(rendered.includes('secondaryDiagnostics'));assert(!rendered.includes(root));assert(!rendered.includes(root.replaceAll('\\','\\\\')));
  assert.equal(inspections,1);assert.equal(serverStarts,0);assert.equal(browserRuns,0);
 }finally{control.close();await channel.close();}
});

const failed=(stdout,extra={})=>({exitCode:1,stdout:{text:stdout,truncated:false},stderr:{text:'',truncated:false},...extra});
test('only inspector allowlisted codes and bounded sanitized stderr identifiers are retained',()=>{
 const secret='sk-private-fixture-env-value';let diagnostic;
 assert.throws(()=>browserServerInspection(failed(JSON.stringify({code:'UNASSIGNED_PORT'}),{stderr:{text:'Error [ERR_MODULE_NOT_FOUND]: /private/'+secret+' TOKEN='+secret+'\n'+'x'.repeat(5000),truncated:true}})),error=>{diagnostic=error.inspection;return error.code==='UNASSIGNED_PORT';});
 assert.equal(diagnostic.exitCode,1);assert.equal(diagnostic.stderr.truncated,true);assert.equal(diagnostic.stderr.detailTruncated,true);assert.equal(diagnostic.stderr.retainedBytes,1024);assert.deepEqual(diagnostic.stderrCodes,['ERR_MODULE_NOT_FOUND']);assert(!JSON.stringify(diagnostic).includes(secret));assert(!JSON.stringify(diagnostic).includes('/private/'));assert(Buffer.byteLength(JSON.stringify(diagnostic))<2048);
 const received=readInspectionDiagnostic({...diagnostic,detail:secret});assert(received);assert(!JSON.stringify(received).includes(secret));assert.equal(readInspectionDiagnostic({...diagnostic,stderrCodes:[secret]}),undefined);
 assert.equal(safeInspectionCode(secret),'BROWSER_SERVER_INSPECTION_FAILED');
});
test('truncated malformed unknown and unexpected error output never becomes success or leaks raw stdout',()=>{
 const secret='fixture-secret-never-relay';
 for(const result of [failed('{invalid '+secret),failed(JSON.stringify({code:secret})),failed(JSON.stringify({code:'INVALID_ENV',env:{TOKEN:secret}})),failed(JSON.stringify({code:'INVALID_ENV'}),{stdout:{text:JSON.stringify({code:'INVALID_ENV'}),truncated:true}}),failed(JSON.stringify({code:'INVALID_ENV'}),{exitCode:0})]){
  assert.throws(()=>browserServerInspection(result),error=>{assert(readInspectionDiagnostic(error.inspection));assert(!JSON.stringify(error.inspection).includes(secret));assert.notEqual(error.code,secret);return true;});
 }
 assert.throws(()=>browserServerInspection(failed('{}',{timedOut:true})),error=>error.inspection.timedOut===true);
});
test('successful complete inspector data retains the existing host validation path',()=>{
 const data={checkId:'ui',contractHash:'a'.repeat(64),planHash:'b'.repeat(64),port:21000,env:{PORT:'21000'}};
 assert.deepEqual(browserServerInspection({exitCode:0,stdout:{text:JSON.stringify(data),truncated:false},stderr:{text:'',truncated:false}}),data);
 assert.throws(()=>browserServerInspection({exitCode:0,stdout:{text:JSON.stringify(data),truncated:false},stderr:{text:'clipped',truncated:true}}),{code:'BROWSER_SERVER_INSPECTION_FAILED'});
});
