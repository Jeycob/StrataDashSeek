// Tracks only the existing Apps operation's admission lifetime. This neither
// creates nor cancels Apps jobs. Uncertainty retains the lease for reconciliation.
export function createAppsLifetime(release) {
 let released=false,appsJobId=null,enqueueAttempted=false,reconciliationRequired=false;
 function finish(){if(released)return;released=true;release();}
 return{
  attempted(){enqueueAttempted=true;},
  accepted(id){appsJobId=id;},
  terminal(job){if(job?.id!==appsJobId||job.terminal!==true||job.workSettled!==true||!['passed','failed'].includes(job.status)||job.recoveryRequired)throw Error('PROJECT_APPS_TERMINAL_EVIDENCE_REQUIRED');finish();},
  failed(){if(released)return;if(enqueueAttempted)reconciliationRequired=true;else finish();},
  snapshot(){return{appsJobId,enqueueAttempted,reconciliationRequired,leaseRetained:!released};},
 };
}
