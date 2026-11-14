'use strict';
const fs=require('node:fs');
const {DockerEngine}=require('../vast/apps-engine.cjs');
const {DockerVM}=require('../vast/apps-vm.cjs');
async function main(){
 const cfg={stateDir:'/data/harness/state/applications',firstPort:18080,portCount:8,vm:{root:'/data/harness/docker-worker',idleSeconds:120}};
 fs.mkdirSync(cfg.stateDir,{recursive:true});
 const vm=new DockerVM(cfg,new DockerEngine({url:'http://127.0.0.1:19075'}));
 const action=process.argv[2];if(!['wake','sleep','repair-cache'].includes(action))throw Error('Usage: wake|sleep|repair-cache');if(action==='repair-cache')vm.repairCache=true;
 const started=Date.now();await vm.ensure();if(action==='sleep')await vm.stop();
 console.log(JSON.stringify({action,milliseconds:Date.now()-started,worker:vm.status()}));
 vm.serial?.destroy();vm.child?.unref();
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e.stack);process.exit(1)});
