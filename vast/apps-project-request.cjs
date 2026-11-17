'use strict';
// Correlation lives on the existing Apps job, not in another job controller.
// An absent receipt is UNKNOWN: it never proves that a timed-out POST cannot
// still arrive, or that a pruned historic job never existed.
const {jobStatus}=require('./apps-job-status.cjs');
const ID=/^[a-f0-9]{16}$/,REQUEST=/^[a-f0-9]{32}$/;
const fail=code=>Object.assign(Error(code),{code,status:409});
function jobRequest(options,projectId,action){
 if(options.requestId===undefined)return{};
 if(!REQUEST.test(options.requestId)||!ID.test(projectId)||action!=='verify')throw fail('PROJECT_REQUEST_INVALID');
 return{requestId:options.requestId};
}
function requestStatus(manager,projectId,requestId){
 if(!ID.test(projectId||'')||!REQUEST.test(requestId||''))throw fail('PROJECT_REQUEST_INVALID');
 const matches=manager.store.jobs.filter(j=>j.requestId===requestId);
 if(matches.length>1)throw fail('PROJECT_REQUEST_CONFLICT');
 const job=matches[0];
 if(!job)return{version:1,requestId,state:'unknown'};
 if(job.projectId!==projectId||job.action!=='verify')throw fail('PROJECT_REQUEST_CONFLICT');
 return{...jobStatus(manager,job.id),requestId,state:'recorded'};
}
function enqueueProjectAction(manager,data){
 if(data.requestId===undefined)return manager.enqueue(data.id,data.action,{releaseId:data.releaseId,targetId:data.targetId});
 if(data._contextProjectId!==data.id||data.action!=='verify'||data.releaseId!==undefined||data.targetId!==undefined)throw fail('PROJECT_REQUEST_INVALID');
 jobRequest(data,data.id,data.action);
 const previous=requestStatus(manager,data.id,data.requestId);
 if(previous.state==='recorded')return manager.store.jobs.find(j=>j.id===previous.job.id);
 return manager.enqueue(data.id,'verify',{requestId:data.requestId});
}
module.exports={jobRequest,requestStatus,enqueueProjectAction};
