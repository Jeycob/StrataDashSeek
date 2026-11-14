'use strict';
// Runs only against the explicitly prepared dedicated loopback Docker worker.
const fs=require('node:fs'),path=require('node:path');
const {AppsManager}=require('../vast/apps-manager.cjs');
async function main(){
 const root=path.resolve(__dirname,'..');
 const manager=new AppsManager({enabled:true,workspaceRoot:path.join(root,'examples'),stateDir:path.join(root,'.worker-check'),minFreeBytes:2*1024**3,docker:{url:'http://127.0.0.1:19075'},publishAddress:'0.0.0.0',applicationHost:'127.0.0.1',checkHost:'127.0.0.1',firstPort:18080,portCount:1});
 await manager.engine.available();const project=await manager.register('docker-demo');const result={at:new Date().toISOString(),projectId:project.id,operations:[]};
 async function perform(action){const job=manager.enqueue(project.id,action);for(let n=0;n<1800&&['queued','running'].includes(job.status);n++)await new Promise(r=>setTimeout(r,100));result.operations.push({...job,log:manager.jobLog(job.id)});if(job.status!=='passed')throw Error(action+': '+job.status+': '+job.error);}
 try{
  await perform('build');await perform('deploy');await perform('check');
  const saved=manager.project(project.id),response=await fetch('http://127.0.0.1:'+saved.hostPort+'/');result.http={status:response.status,body:await response.text()};if(response.status!==200||!result.http.body.includes('HARNESS_DEPLOYED_APP_OK'))throw Error('Deployed content mismatch');
  result.containerId=saved.containerId;result.imageId=saved.deployedImageId;result.source=saved.source;result.containerLogs=await manager.logs(saved.containerId);
  await manager.containerAction(saved.containerId,'stop');result.stopped=!(await manager.engine.owned(saved.containerId)).State.Running;if(!result.stopped)throw Error('Container did not stop');result.passed=true;
 }catch(e){result.passed=false;result.error=e.message;process.exitCode=1;}
 finally{fs.writeFileSync(path.join(root,'real-worker-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
