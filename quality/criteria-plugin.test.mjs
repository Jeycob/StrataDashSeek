import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
import {executeVerification} from './plugin.mjs';
import {WorkspaceManager} from '../workspace/manager.mjs';
import {sourceManifest} from '../workspace/storage.mjs';
import {finalizeCriteria} from './criteria.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),runner='a'.repeat(64),project='b'.repeat(64);
function mode(){const policy={version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-3333-4444-555555555555',activationSourceCommit:'a'.repeat(40)},snapshot={...policy,policySha256:sha(Object.fromEntries(Object.entries(policy).sort(([a],[b])=>a.localeCompare(b)))),sourceCommit:'a'.repeat(40),launchId:'aaaaaaaa-2222-3333-4444-555555555555'};return createProjectExecutionMode({snapshot,assertUnchanged:()=>snapshot}).service;}
function report(){return{passed:true,complete:true,stale:false,sourceHash:runner,checks:[{id:'flow',kind:'test',passed:true,countsMeasured:true,checksPassed:2,checksTotal:2}],criteria:[{id:'usable',text:'The requested flow works.',state:'verified',sourceHash:runner,observedAt:12345,checks:[{id:'flow',kind:'test',state:'verified',checksPassed:2,checksTotal:2}]}]};}
function fixture({stale=false,exitCode=0,timedOut=false,rejectManager=false}={}){let reviews=0;const events=[],value=report(),execution={agent:{session:{id:'s'}},name:'verify_project',callId:'verify-one',signal:new AbortController().signal},ctx={projectExecutionMode:mode(),waterfall:async(name)=>name==='workspace-runtime/review'?{root:path.resolve('managed-project'),sourceHash:stale&&reviews++?'c'.repeat(64):project}:undefined,serial:async(name,args)=>{events.push({name,args});if(rejectManager)throw Object.assign(Error('Manager rejected this report'),{code:rejectManager});},shellEnv:{collect:()=>({})},shell:{sandboxMode:'workspace-write',resolve:x=>x,execute:async()=>({result:async()=>({exitCode,timedOut,stdout:{text:JSON.stringify(value)}})})}};return{ctx,execution,events,value};}

test('actual Native projection retains runner scope/time and confirms only matching source-checked delivery',async()=>{
 const f=fixture(),r=await executeVerification(f.ctx,{},f.execution);assert.equal(r.criteriaConfirmed,true);assert.equal(r.sourceHash,project);assert.equal(r.runnerSourceHash,runner);assert.equal(r.criteria[0].state,'verified');assert.equal(r.criteria[0].sourceHash,runner);assert.equal(r.criteria[0].projectSourceHash,project);assert.equal(r.criteria[0].observedAt,12345);assert.equal(f.events.length,1);assert.equal(f.events[0].args.verificationCallId,'verify-one');
 const final=finalizeCriteria(r,{projectSourceHash:project,outcome:'current'});assert.equal(final[0].state,'verified');
});
test('actual Native stale, wrong exit, timeout and manager refusal cannot carry verified conditions',async()=>{
 for(const options of [{stale:true},{exitCode:7},{timedOut:true},{rejectManager:'STALE_VERIFICATION'},{rejectManager:'POLICY_CHANGED'}]){
  const f=fixture(options),r=await executeVerification(f.ctx,{},f.execution);assert.equal(r.passed,false);assert.equal(r.criteriaConfirmed,false);assert.notEqual(r.criteria[0].state,'verified',JSON.stringify(options));assert.equal(r.criteria[0].state,options.stale||options.rejectManager==='STALE_VERIFICATION'?'stale':'unknown');assert(r.criteria[0].checks.every(c=>c.state!=='verified'));
 }
});
test('expected failing runner keeps a real check failure rather than treating it as an unknown Native acknowledgement',async()=>{
 const f=fixture({exitCode:1});f.value.passed=f.value.complete=false;f.value.checks[0].passed=false;f.value.checks[0].checksPassed=1;f.value.criteria[0].state='failed';f.value.criteria[0].checks[0].state='failed';
 const r=await executeVerification(f.ctx,{},f.execution);assert.equal(r.criteriaConfirmed,true);assert.equal(r.criteria[0].state,'failed');
});
test('manager records pending criteria unknown until the final matching SDK outcome, retaining no fake acceptance',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'criteria-manager-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'source.txt'),'actual project');const current=await sourceManifest(root),agent={id:'s'},record={root},value=report();let saves=0;
 const manager={ctx:{agents:{get:()=>agent}},ownerAgent:()=>agent,data:{sessions:{s:record}},save:async()=>saves++};
 await WorkspaceManager.prototype.reportVerification.call(manager,{sessionId:'s',kind:'all',exitCode:0,sourceHash:current.sha256,verificationCallId:'verify-one',checksPassed:2,checksTotal:2,criteriaReport:value});
 assert.equal(saves,1);assert.equal(record.lastVerification.accepted,false);assert.equal(record.lastVerification.verificationCallId,'verify-one');assert.equal(record.lastVerification.criteria[0].state,'unknown');assert.equal(record.lastVerification.criteria[0].observedAt,12345);
 await assert.rejects(WorkspaceManager.prototype.reportVerification.call(manager,{sessionId:'s',kind:'all',exitCode:0,sourceHash:project}),{code:'STALE_VERIFICATION'});assert.equal(saves,1);
});
