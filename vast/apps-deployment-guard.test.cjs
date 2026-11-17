'use strict';
const {hostExecutionBinding}=require('./fixtures/execution-binding.cjs');
const {resourceEngine,seedPublishedPolicy}=require('./resource-fixture.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {assertDeploymentIdle,publishedContainer,validateResume}=require('./apps-deployment-guard.cjs'),{DeploymentState}=require('./apps-deployment-state.cjs'),{LABEL}=require('./apps-engine.cjs');
const project='a'.repeat(16),release='b'.repeat(16),generation='c'.repeat(16),containerId='d'.repeat(64);
function fixture(t){const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'sdsh-deploy-guard-'));t.after(()=>{const target=fs.realpathSync(stateDir);assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('sdsh-deploy-guard-'));fs.rmSync(target,{recursive:true,force:true});});return{execution:hostExecutionBinding(),cfg:{stateDir},store:{jobs:[],projects:{[project]:{id:project,containerId,releaseId:release,dataGeneration:generation}}}};}
test('an unresolved transaction prevents a fresh worker operation before any container restoration',t=>{
 const m=fixture(t),identity={projectId:project,releaseId:release,sourceHash:'e'.repeat(64),dataGeneration:generation},state=new DeploymentState(path.join(m.cfg.stateDir,'deployment-transactions'));state.begin(identity);state.close();assert.throws(()=>assertDeploymentIdle(m),{code:'DEPLOYMENT_RECOVERY_REQUIRED'});
 const job={id:release,projectId:project,status:'running',deploymentPlan:identity};m.store.jobs.push(job);m.busy=release;assert.doesNotThrow(()=>assertDeploymentIdle(m));assert.throws(()=>assertDeploymentIdle(m,{allowCurrent:false}),{code:'DEPLOYMENT_RECOVERY_REQUIRED'});
 const next=new DeploymentState(path.join(m.cfg.stateDir,'deployment-transactions'));next.transition(identity,'recovery_required');next.close();assert.throws(()=>assertDeploymentIdle(m),{code:'DEPLOYMENT_RECOVERY_REQUIRED'});
});
test('a lost final report or unknown data helper remains fenced even outside a pending SQLite phase',t=>{
 const m=fixture(t);m.store.jobs.push({id:release,status:'recovery_required',deploymentPlan:{},deploymentPhase:'recovery_required'});assert.throws(()=>assertDeploymentIdle(m),{code:'DEPLOYMENT_RECOVERY_REQUIRED'});m.store.jobs=[{id:release,status:'failed',dataOperations:{operations:{copy:{state:'intent'}}}}];assert.throws(()=>assertDeploymentIdle(m),{code:'DEPLOYMENT_RECOVERY_REQUIRED'});
});
test('resume validates the whole set and refuses test, helper, candidate and historical generations',async t=>{
 const m=fixture(t),make=(patch={})=>({Id:containerId,Config:{Labels:{[LABEL]:'managed',[LABEL+'.project']:project,[LABEL+'.release']:release,[LABEL+'.generation']:generation,...patch}}});assert.equal(publishedContainer(m,make()),true);
 for(const patch of [{[LABEL+'.role']:'data-helper'},{[LABEL+'.role']:'test'},{[LABEL+'.generation']:'f'.repeat(16)},{[LABEL+'.release']:'f'.repeat(16)}])assert.equal(publishedContainer(m,make(patch)),false);
 let reads=0;const current={...make(),Image:'sha256:'+'a'.repeat(64)};m.save=()=>{};m.engine=resourceEngine({json:async()=>({}),owned:async id=>{reads++;return id===containerId?structuredClone(current):{...make(),Id:id,Config:{Labels:{}}};}},{imageResponse:true});await seedPublishedPolicy(m,current);await validateResume(m,[containerId]);await assert.rejects(validateResume(m,[containerId,'f'.repeat(64)]),{code:'DEPLOYMENT_RECOVERY_REQUIRED'});assert.equal(reads,4);
});
