import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main,importCollectorRun,makeReport} from './import.mjs';
import {profileComparisons} from '../../workspace/profile-comparisons.mjs';
const digest='a'.repeat(64),source='b'.repeat(40),stamp=value=>new Date(value).toISOString();
function artifacts(){
 const identity={sessionId:'session-real',workspaceId:'source-workspace',projectId:'project',sourceCommit:source,runtimeCommit:source,promptSha256:digest,manifestSha256:digest,acceptanceVersion:'frozen-v1',fixtureHashes:[],acceptanceHashes:[{path:'expected.json',bytes:10,sha256:digest}]};
 const record={scenario:'B03',variant:'HomeAI',pairId:'pair',runId:'run',attemptId:'attempt'};
 const collectorIdentity={version:1,...record,...identity,requestId:'request'};
 const plan={recordVersion:1,recordKind:'model_benchmark_attempt',isTemplate:true,...record,identity,limits:{mainSeconds:600,repairSeconds:300,maxRepairs:1}};
 const terminal={version:1,event:'terminal',started:true,...identity,collectorIdentity,primaryStartedAt:stamp(1000),observedAtUtc:stamp(4100)};
 const metrics={version:1,status:'OBSERVED_READ_ONLY_PROJECTION',readOnly:true,checkpoint:{phase:'final',sha256:digest,requestId:'request',attemptId:'attempt'},record:{...record,status:'FAIL'},identity:{...identity,cacheState:'unknown',contextLimit:null},operator:{requestId:'request',finalized:true},nativeObservation:{promptAdmission:'accepted'},timestampsUtc:{runSubmittedAt:stamp(1000),settledAt:stamp(4000)},quality:{accepted:false,mandatoryCriteriaCount:1,checks:{known:true,totalRows:0,returnedRows:0,omittedRows:0,truncated:false,rows:[]}},resolvedRequestRoutes:{known:true,totalRows:1,returnedRows:1,omittedRows:0,truncated:false,rows:[{provider:'strata-vast',model:'strata'}]}};
 return Object.fromEntries(Object.entries({plan,terminal,metrics}).map(([key,value])=>[key,{value,sha256:digest}]));
}
test('collector import binds actual SID/request/source/input and never converts plan, timeout or configured model into acceptance or physical measurements',()=>{
 const input=artifacts(),row=importCollectorRun(input,'display-workspace'),view=profileComparisons(makeReport([row]),'display-workspace').pairs[0];
 assert.equal(view.sameInput,false);assert.equal(view.rows[0].accepted,null);assert.equal(view.rows[0].status,'FAIL');assert.equal(view.rows[0].sourceBinding.sessionId,'session-real');assert.equal(view.rows[0].sourceBinding.sourceWorkspaceId,'source-workspace');assert.equal(view.rows[0].serving,null);assert.equal(view.rows[0].memory,null);assert.equal(view.rows[0].requestRoutes.rows[0].model,'strata');
 for(const [target,key,value]of [[input.metrics.value.identity,'sessionId','wrong'],[input.terminal.value.collectorIdentity,'promptSha256','c'.repeat(64)],[input.metrics.value.checkpoint,'requestId','wrong']]){const old=target[key];target[key]=value;assert.throws(()=>importCollectorRun(input,'display-workspace'),/MISMATCH/);target[key]=old;}
 input.metrics.value.resolvedRequestRoutes.truncated=true;assert.equal(importCollectorRun(input,'display-workspace').requestRoutes,null);
 input.terminal.value.started=false;assert.throws(()=>importCollectorRun(input,'display-workspace'),/ACTUAL_TERMINAL_REQUIRED/);
});
test('acceptance requires complete independently evidenced criteria, and the offline CLI creates a bounded new report without overwriting evidence',async t=>{
 const input=artifacts(),m=input.metrics.value;m.quality.accepted=true;m.timestampsUtc.acceptedAt=stamp(3500);
 assert.equal(importCollectorRun(input,'w').acceptance,null);
 m.quality.checks={known:true,totalRows:1,returnedRows:1,omittedRows:0,truncated:false,rows:[{id:'criterion',status:'PASS',evidence:['qa-receipt']}]};
 assert.equal(importCollectorRun(input,'w').acceptance.at,3500);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-import-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files=[];for(const [key,artifact]of Object.entries(input)){const file=path.join(root,key+'.json');await fs.writeFile(file,JSON.stringify(artifact.value));files.push(file);}
 const output=path.join(root,'report.json'),args=['--workspace','w','--output',output,'--run',...files],result=await main(args);
 assert.equal(result.runs,1);assert.equal(result.unknownMemory,1);assert.match(result.sha256,/^[a-f0-9]{64}$/);await assert.rejects(main(args),{code:'EEXIST'});
 const report=JSON.parse(await fs.readFile(output,'utf8'));assert.equal(profileComparisons(report,'w').pairs[0].rows[0].acceptedMs,2500);
 assert.throws(()=>makeReport([report.runs[0],report.runs[0]]),/DUPLICATE/);
});
