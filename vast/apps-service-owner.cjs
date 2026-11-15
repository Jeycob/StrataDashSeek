'use strict';
const path=require('node:path');
// Acquire BEFORE constructing AppsManager: its constructor writes state and
// classifies interrupted jobs. Only one process may perform that reconciliation.
async function ownAppsService(cfg,create,{timeoutMs=2000}={}){
 const {acquireProcessLock}=await import('../workspace/process-lock.mjs');
 const lease=await acquireProcessLock(path.join(cfg.stateDir||'/data/harness/state/applications','apps-service.lock'),{timeoutMs});let app,closed=false;
 try{app=create(cfg);}catch(error){await lease.release();throw error;}
 return{...app,async close(){
  if(closed)return;
  app.manager.serviceClosing=true;
  await new Promise((resolve,reject)=>app.server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));
  // An already accepted handler may have started a background job while close
  // was waiting for its HTTP response. Keep ownership until that work settles.
  if(app.manager.busy||app.manager.previewRequests||app.manager.ticking)throw Object.assign(Error('Application work is still active'),{code:'APPS_SERVICE_BUSY'});
  await app.manager.close?.();await lease.release();closed=true;
 }};
}
module.exports={ownAppsService};
