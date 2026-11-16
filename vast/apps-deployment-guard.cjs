'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DeploymentState}=require('./apps-deployment-state.cjs'),{LABEL}=require('./apps-engine.cjs');
const {validateManagedStarts,assertStartOutcomesKnown}=require('./apps-managed-resources.cjs');
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
 assertStartOutcomesKnown(manager);assertDeploymentIdle(manager);if(!Array.isArray(ids)||ids.length>64||new Set(ids).size!==ids.length)throw fault();
 // Validate ALL identities before starting ANY service in a retained stack.
 for(const id of ids){if(!/^[a-f0-9]{64}$/.test(id)||!publishedContainer(manager,await manager.engine.owned(id)))throw fault();}
 await validateManagedStarts(manager,ids);
}
function cancelSavedResume(manager,id){
 const worker=manager.worker,saved=worker?.saved;
 const stable=()=>worker?.phase==='asleep'&&!worker.pending&&!worker.stopping&&typeof worker.pid==='function'&&worker.pid()===null;
 const refuse=()=>Object.assign(Error('Offline application stop could not verify its published saved intent; no worker was woken'),{code:'DEPLOYMENT_OFFLINE_STOP_UNPROVEN',status:409});
 if(!/^[a-f0-9]{64}$/.test(id)||!stable()||typeof worker.save!=='function'||!Array.isArray(saved?.resumeIds)||!Array.isArray(saved?.containers))throw refuse();
 const rows=saved.containers.filter(c=>c.Id===id);if(rows.length!==1||!publishedContainer(manager,{Id:id,Config:{Labels:rows[0].Labels||{}}}))throw refuse();
 const previousIds=[...saved.resumeIds],row=rows[0],previousState=row.State;
 if(!stable())throw refuse();saved.resumeIds=previousIds.filter(value=>value!==id);row.State='exited';
 try{worker.save();}catch(error){saved.resumeIds=previousIds;row.State=previousState;throw error;}
 return{ok:true,asleep:true,resumeCancelled:true};
}
module.exports={assertDeploymentIdle,publishedContainer,validateResume,deploymentRecovery,cancelSavedResume};
