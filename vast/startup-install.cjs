'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{atomic,config}=require('./startup-update.cjs');
const runtime=require('./runtime-paths.cjs');
function install({root='/data/harness',keyring,signers,onstart='/root/onstart.sh',account,upgradeBootstrap=false}){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Install the startup gate as root on Linux');
 const settings=config({version:1,enabled:true,repository:'Jeycob/StrataDashSeek',branch:'main',signers});
 const privateRoot=path.join(root,'root-secrets'),bootstrap=path.join(root,'bootstrap');
 for(const file of[root,privateRoot,onstart]){const info=fs.lstatSync(file);if(info.isSymbolicLink()||info.uid!==0||(info.mode&0o022))throw Error('Installation target must be root owned and not writable by other users');}
 const existing=fs.readFileSync(onstart,'utf8'),old='bash '+root+'/app/vast/start.sh',replacement='bash '+root+'/bootstrap/start.sh';
 const forms=command=>[command,command+' &',...['logs/supervisor.log','root-secrets/runtime/logs/supervisor.log'].map(log=>'nohup '+command+' > '+root+'/'+log+' 2>&1 < /dev/null &')];
 const oldLines=existing.split('\n').filter(line=>forms(old).includes(line.trim()));
 const installed=existing.split('\n').some(line=>forms(replacement).includes(line.trim()));
 if(!installed&&oldLines.length!==1)throw Error('A single recognized Harness onstart line is required');
 const trust=path.join(privateRoot,'startup-update-signers.gpg'),configFile=path.join(privateRoot,'startup-update.json');
 if(fs.existsSync(trust)&&!fs.readFileSync(trust).equals(fs.readFileSync(keyring)))throw Error('Existing update trust differs; review required');
 if(fs.existsSync(configFile)&&JSON.stringify(config(JSON.parse(fs.readFileSync(configFile))))!==JSON.stringify(settings))throw Error('Existing update policy differs; review required');
 // Publish a new dependency before its consumer; the executable entry is last.
 const files=[['runtime-paths.cjs','runtime-paths.cjs'],['project-execution-mode.cjs','project-execution-mode.cjs'],['project-execution-floor.cjs','project-execution-floor.cjs'],['process-lock.mjs','../workspace/process-lock.mjs'],['runtime-recovery.cjs','runtime-recovery.cjs'],['runtime-admission-server.cjs','runtime-admission-server.cjs'],['runtime-release.cjs','runtime-release.cjs'],['offline-purge-maintenance.cjs','offline-purge-maintenance.cjs'],['runtime-launcher.cjs','runtime-launcher.cjs'],['startup-extract.py','startup-extract.py'],['startup-update.cjs','startup-update.cjs'],['start.sh','startup-bootstrap.sh']];
 const existingBootstrap=installed||files.some(([name])=>fs.existsSync(path.join(bootstrap,name)));
 if(fs.existsSync(bootstrap)){const s=fs.lstatSync(bootstrap);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error('Bootstrap directory must be protected');}
 const changed=files.filter(([name,source])=>{const target=path.join(bootstrap,name);if(!fs.existsSync(target))return existingBootstrap;runtime.trustedFile(target);return!fs.readFileSync(target).equals(fs.readFileSync(path.join(__dirname,source)));});
 if(changed.length&&!upgradeBootstrap)throw Error('Stable bootstrap differs; an explicit reviewed upgrade is required');
 // An explicit policy must predate the floor consumer. Installation never
 // creates one or interprets absence as host compatibility.
 const floor=require('./project-execution-floor.cjs').createExecutionFloor({rootDirectory:path.resolve(root)}).capturePolicy();
 if(changed.length){const launcher=require('./runtime-launcher.cjs');launcher.inheritedLease(root);launcher.assertNoAgentProcesses(account?.uid??Number(require('node:child_process').execFileSync('id',['-u','harness'],{encoding:'utf8',stdio:runtime.withoutRootLease()})));}
 fs.mkdirSync(bootstrap,{recursive:true,mode:0o755});
 if(changed.length){const backup=path.join(privateRoot,'bootstrap-before-runtime-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex'));runtime.ensureDirectory(backup);for(const[name]of changed){const target=path.join(bootstrap,name);if(runtime.trustedFile(target,{optional:true}))runtime.atomic(path.join(backup,name),fs.readFileSync(target));}}
 runtime.prepare(root,account);const log=runtime.openLog(root,'supervisor');fs.closeSync(log);
 for(const[name,source]of files.filter(([name])=>name!=='start.sh')){floor.assertPolicyUnchanged();atomic(path.join(bootstrap,name),fs.readFileSync(path.join(__dirname,source)),0o644);}
 atomic(trust,fs.readFileSync(keyring));atomic(configFile,settings);
 // Publish the executable entry only after its policy, trust and code exist.
 floor.assertPolicyUnchanged();atomic(path.join(bootstrap,'start.sh'),fs.readFileSync(path.join(__dirname,'startup-bootstrap.sh')),0o755);
 const updated=existing.split('\n').map(line=>forms(old).includes(line.trim())||forms(replacement).includes(line.trim())?line.replace(old,replacement).replace(root+'/logs/supervisor.log',root+'/root-secrets/runtime/logs/supervisor.log'):line).join('\n');
 if(updated!==existing){const backup=path.join(privateRoot,'onstart-before-update-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex')+'.sh');runtime.atomic(backup,existing);runtime.atomic(onstart,updated,fs.statSync(onstart).mode&0o777);}
 const status={version:1,enabled:true,phase:'checking',checkedAt:new Date().toISOString(),appliedCommit:null,targetCommit:null,error:null,signatureVerified:false};
 runtime.writePrivate(root,'startup-update.json',status);runtime.publish(root,'startup-update.json',status);return{installed:true,enabled:true,startsOnNextBoot:true,modelRestarted:false,bootstrapExplicitlyUpgraded:changed.length>0};
}
module.exports={install};
if(require.main===module){try{console.log(JSON.stringify(install({keyring:process.argv[2],signers:process.argv.slice(3).filter(x=>x!=='--upgrade-bootstrap'),upgradeBootstrap:process.argv.includes('--upgrade-bootstrap')})));}catch(e){console.error(e.message);process.exitCode=1;}}
