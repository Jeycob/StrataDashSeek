'use strict';
// Shared executable, private project state. No network or installs on startup.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const custody=require('./project-custody.cjs');
function projectEnvironment(cwd,base=process.env,filesystem=fs){
 let root=base.DSH_PROJECT_ROOT||cwd;
 if(!base.DSH_PROJECT_ROOT){for(let p=cwd;;p=path.dirname(p)){if(filesystem.existsSync(path.join(p,'.harness/project.json'))){root=p;break;}if(path.dirname(p)===p)throw Error('No isolated project manifest.');}}
 const project=JSON.parse(filesystem.readFileSync(path.join(root,'.harness/project.json'),'utf8'));
  const local=path.join(root,'.harness');if(base.DSH_PROJECT_READ_ONLY!=='1')for(const p of ['home','tmp','npm','nuget','dotnet'])filesystem.mkdirSync(path.join(local,p),{recursive:true});
 return {...base,HOME:path.join(local,'home'),TMPDIR:path.join(local,'tmp'),PORT:String(project.ports[0]),API_PORT:String(project.ports[1]),TEST_PORT:String(project.ports[2]),DATABASE_URL:'file:'+project.databasePath,HARNESS_QUALITY_ALLOWED_PORTS:project.ports.join(','),DSH_PROJECT_ROOT:root,NPM_CONFIG_CACHE:path.join(local,'npm'),NUGET_PACKAGES:path.join(local,'nuget'),DOTNET_CLI_HOME:path.join(local,'dotnet'),DOTNET_ROOT:'/data/harness/dev/dotnet',DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',PLAYWRIGHT_BROWSERS_PATH:'/data/harness/dev/browsers',NODE_PATH:'/data/harness/dev/browser/node_modules',PATH:'/data/harness/dev/dotnet:/data/harness/node/bin:'+(base.PATH||'/usr/bin:/bin')};
}
function startProject(argv,{filesystem=fs,spawn=cp.spawn,runtime=process}={}){
 const args=[...argv];
 if(args[0]==='--host-custody-v1'){
  args.shift();if(runtime.platform!=='linux')throw Error('PROJECT_CUSTODY_PLATFORM_UNSUPPORTED');
  const control=custody.readEnvelope(filesystem),identity={...custody.identityFromStat(filesystem.readFileSync('/proc/self/stat','utf8'),runtime.pid),pidNamespace:filesystem.readlinkSync('/proc/self/ns/pid')},bytes=custody.frame(control,identity);
  // No project file, user shell or child runs before this single bounded write.
  // A short/failed write is fatal; never launch after a partial protocol frame.
  if(filesystem.writeSync(1,bytes)!==bytes.length)throw Error('PROJECT_CUSTODY_FRAME_WRITE_FAILED');
 }
 if(args[0]==='--')args.shift();if(!args.length)throw Error('Program required.');
 const child=spawn(args[0],args.slice(1),{stdio:'inherit',env:projectEnvironment(runtime.cwd(),runtime.env,filesystem)});
 for(const s of ['SIGTERM','SIGINT'])runtime.on(s,()=>child.kill(s));
 child.on('error',e=>{console.error(e.message);runtime.exitCode=1;});child.on('exit',(code,signal)=>{runtime.exitCode=code??(signal?128:1);});return child;
}
module.exports={projectEnvironment,startProject};
if(require.main===module)startProject(process.argv.slice(2));
