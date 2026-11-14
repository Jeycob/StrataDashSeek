'use strict';
// Shared executable, private project state. No network or installs on startup.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
function projectEnvironment(cwd,base=process.env){
 let root=base.DSH_PROJECT_ROOT||cwd;
 if(!base.DSH_PROJECT_ROOT){for(let p=cwd;;p=path.dirname(p)){if(fs.existsSync(path.join(p,'.harness/project.json'))){root=p;break;}if(path.dirname(p)===p)throw Error('No isolated project manifest.');}}
 const project=JSON.parse(fs.readFileSync(path.join(root,'.harness/project.json'),'utf8'));
 const local=path.join(root,'.harness');for(const p of ['home','tmp','npm','nuget','dotnet'])fs.mkdirSync(path.join(local,p),{recursive:true});
 return {...base,HOME:path.join(local,'home'),TMPDIR:path.join(local,'tmp'),PORT:String(project.ports[0]),API_PORT:String(project.ports[1]),TEST_PORT:String(project.ports[2]),DATABASE_URL:'file:'+project.databasePath,DSH_PROJECT_ROOT:root,NPM_CONFIG_CACHE:path.join(local,'npm'),NUGET_PACKAGES:path.join(local,'nuget'),DOTNET_CLI_HOME:path.join(local,'dotnet'),DOTNET_ROOT:'/data/harness/dev/dotnet',DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',PLAYWRIGHT_BROWSERS_PATH:'/data/harness/dev/browsers',NODE_PATH:'/data/harness/dev/browser/node_modules',PATH:'/data/harness/dev/dotnet:/data/harness/node/bin:'+(base.PATH||'/usr/bin:/bin')};
}
module.exports={projectEnvironment};
if(require.main===module){const args=process.argv.slice(2);if(args[0]==='--')args.shift();if(!args.length)throw Error('Program required.');const child=cp.spawn(args[0],args.slice(1),{stdio:'inherit',env:projectEnvironment(process.cwd())});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',(code,signal)=>{process.exitCode=code??(signal?128:1);});}
