'use strict';
const fs=require('node:fs'),path=require('node:path'),{atomic,config}=require('./startup-update.cjs');
function install({root='/data/harness',keyring,signers,onstart='/root/onstart.sh'}){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Install the startup gate as root on Linux');
 const settings=config({version:1,enabled:true,repository:'Jeycob/StrataDashSeek',branch:'main',signers});
 const privateRoot=path.join(root,'root-secrets'),bootstrap=path.join(root,'bootstrap');
 for(const file of[root,privateRoot,onstart]){const info=fs.lstatSync(file);if(info.isSymbolicLink()||info.uid!==0||(info.mode&0o022))throw Error('Installation target must be root owned and not writable by other users');}
 const existing=fs.readFileSync(onstart,'utf8'),old='bash '+root+'/app/vast/start.sh',replacement='bash '+root+'/bootstrap/start.sh';
 const forms=command=>[command,command+' &','nohup '+command+' > '+root+'/logs/supervisor.log 2>&1 < /dev/null &'];
 const oldLines=existing.split('\n').filter(line=>forms(old).includes(line.trim()));
 const installed=existing.split('\n').some(line=>forms(replacement).includes(line.trim()));
 if(!installed&&oldLines.length!==1)throw Error('A single recognized Harness onstart line is required');
 const trust=path.join(privateRoot,'startup-update-signers.gpg'),configFile=path.join(privateRoot,'startup-update.json');
 if(fs.existsSync(trust)&&!fs.readFileSync(trust).equals(fs.readFileSync(keyring)))throw Error('Existing update trust differs; review required');
 if(fs.existsSync(configFile)&&JSON.stringify(config(JSON.parse(fs.readFileSync(configFile))))!==JSON.stringify(settings))throw Error('Existing update policy differs; review required');
 fs.mkdirSync(bootstrap,{recursive:true,mode:0o755});
 const bootstrapStat=fs.lstatSync(bootstrap);if(bootstrapStat.isSymbolicLink()||bootstrapStat.uid!==0||(bootstrapStat.mode&0o022))throw Error('Bootstrap directory must be protected');
 const files=[['start.sh','startup-bootstrap.sh'],['startup-update.cjs','startup-update.cjs'],['startup-extract.py','startup-extract.py']];
 for(const[name,source]of files){const target=path.join(bootstrap,name);if(fs.existsSync(target)&&!fs.readFileSync(target).equals(fs.readFileSync(path.join(__dirname,source))))throw Error('Stable bootstrap differs; an explicit reviewed upgrade is required');}
 for(const[name,source]of files.filter(([name])=>name!=='start.sh'))atomic(path.join(bootstrap,name),fs.readFileSync(path.join(__dirname,source)),0o644);
 atomic(trust,fs.readFileSync(keyring));atomic(configFile,settings);
 // Publish the executable entry only after its policy, trust and code exist.
 atomic(path.join(bootstrap,'start.sh'),fs.readFileSync(path.join(__dirname,'startup-bootstrap.sh')),0o755);
 if(!installed){const backup=path.join(privateRoot,'onstart-before-update-'+Date.now()+'.sh');fs.copyFileSync(onstart,backup);fs.chmodSync(backup,0o600);atomic(onstart,existing.split('\n').map(line=>forms(old).includes(line.trim())?line.replace(old,replacement):line).join('\n'),fs.statSync(onstart).mode&0o777);}
 const status={version:1,enabled:true,phase:'checking',checkedAt:new Date().toISOString(),appliedCommit:null,targetCommit:null,error:null,signatureVerified:false};
 atomic(path.join(root,'state/startup-update.json'),status,0o644);return{installed:true,enabled:true,startsOnNextBoot:true,modelRestarted:false};
}
module.exports={install};
if(require.main===module){try{console.log(JSON.stringify(install({keyring:process.argv[2],signers:process.argv.slice(3)})));}catch(e){console.error(e.message);process.exitCode=1;}}
