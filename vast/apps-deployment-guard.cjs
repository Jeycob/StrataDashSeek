'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DeploymentState}=require('./apps-deployment-state.cjs'),{LABEL}=require('./apps-engine.cjs');
const fault=()=>Object.assign(Error('An application deployment has an unresolved outcome; inspect its recorded release before starting or restoring containers'),{code:'DEPLOYMENT_RECOVERY_REQUIRED',status:409,phase:'recovery_required'});
function assertDeploymentIdle(manager,{allowCurrent=true}={}){
 const current=allowCurrent&&manager.store.jobs.find(job=>job.id===manager.busy&&job.status==='running'&&job.deploymentPlan);
 if(manager.store.jobs.some(job=>job.id!==current?.id&&(job.deploymentPlan&&job.deploymentPhase&&!['active','failed'].includes(job.deploymentPhase)||job.dataOperations&&(!job.dataOperations.operations||Object.values(job.dataOperations.operations).some(operation=>operation?.state!=='complete')))))throw fault();
 const directory=path.join(manager.cfg.stateDir,'deployment-transactions');if(!fs.existsSync(path.join(directory,'deployments.sqlite')))return;
 const state=new DeploymentState(directory,{readOnly:true});try{if(state.pending().some(row=>!current||row.releaseId!==current.id||row.projectId!==current.projectId||row.sourceHash!==current.deploymentPlan.sourceHash||row.dataGeneration!==current.deploymentPlan.dataGeneration||row.phase==='recovery_required'))throw fault();}finally{state.close();}
}
function deploymentRecovery(manager){
 const transactions=[],projects=new Set(),directory=path.join(manager.cfg.stateDir,'deployment-transactions');
 if(fs.existsSync(path.join(directory,'deployments.sqlite'))){const state=new DeploymentState(directory,{readOnly:true});try{for(const row of state.pending().slice(0,64)){const recoveryRequired=row.phase==='recovery_required'||row.releaseId!==manager.busy;transactions.push({projectId:row.projectId,releaseId:row.releaseId,phase:row.phase,recoveryRequired});if(recoveryRequired)projects.add(row.projectId);}}finally{state.close();}}
 for(const job of manager.store.jobs)if(job.deploymentPhase==='recovery_required'&&/^[a-f0-9]{16}$/.test(job.projectId||''))projects.add(job.projectId);
 return{version:1,required:projects.size>0,projects:[...projects].slice(0,64),transactions};
}
function publishedContainer(manager,container){
 const labels=container.Config?.Labels||{},project=manager.store.projects[labels[LABEL+'.project']];
 if(!project||labels[LABEL]!=='managed'||['data-helper','test'].includes(labels[LABEL+'.role']))return false;
 if(project.dataGeneration){if(labels[LABEL+'.generation']!==project.dataGeneration||labels[LABEL+'.release']!==project.releaseId)return false;}
 return container.Id===project.containerId||!!(project.stack&&project.releaseId&&labels[LABEL+'.release']===project.releaseId);
}
async function validateResume(manager,ids){
 assertDeploymentIdle(manager);if(!Array.isArray(ids)||ids.length>64||new Set(ids).size!==ids.length)throw fault();
 // Validate ALL identities before starting ANY service in a retained stack.
 for(const id of ids){if(!/^[a-f0-9]{64}$/.test(id)||!publishedContainer(manager,await manager.engine.owned(id)))throw fault();}
}
module.exports={assertDeploymentIdle,publishedContainer,validateResume,deploymentRecovery};
