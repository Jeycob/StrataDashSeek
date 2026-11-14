'use strict';
// Explicit provisioning only. Never called by normal wake/start paths.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root='/data/harness/dev',node='/data/harness/node/bin/node',versions=require('./versions.json');
function run(exe,args,options={}){cp.execFileSync(exe,args,{stdio:'inherit',env:{...process.env,PATH:'/data/harness/node/bin:/usr/bin:/bin',PLAYWRIGHT_BROWSERS_PATH:root+'/browsers',DEBIAN_FRONTEND:'noninteractive',DOTNET_CLI_TELEMETRY_OPTOUT:'1',...options.env},timeout:600000,...options});}
(async()=>{
 if(process.getuid()!==0)throw Error('Provision as root; normal doctor and project commands run unprivileged.');
 if(Number(fs.statfsSync('/data').bavail)*Number(fs.statfsSync('/data').bsize)<2.5*1073741824)throw Error('At least 2.5 GiB free space is required.');
 fs.mkdirSync(root+'/browser',{recursive:true});
 fs.writeFileSync(root+'/browser/package.json',JSON.stringify({name:'harness-prepared-browser',private:true,dependencies:{playwright:versions.playwright}},null,2));
 run('/data/harness/node/bin/npm',['install','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org/','--userconfig=/dev/null','--globalconfig=/dev/null'],{cwd:root+'/browser'});
 const lock=JSON.parse(fs.readFileSync(root+'/browser/package-lock.json'));if(lock.packages['node_modules/playwright'].integrity!==versions.playwrightIntegrity)throw Error('Playwright integrity differs from pinned official metadata.');
 run(node,[root+'/browser/node_modules/playwright/cli.js','install','--with-deps','--only-shell','chromium']);
 if(!fs.existsSync(root+'/dotnet/dotnet')||cp.execFileSync(root+'/dotnet/dotnet',['--version'],{encoding:'utf8'}).trim()!==versions.dotnetVersion){
  const u=new URL(versions.dotnetURL);if(u.protocol!=='https:'||u.hostname!=='builds.dotnet.microsoft.com')throw Error('Unexpected SDK source.');
  const response=await fetch(u,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('SDK download failed');
  const file=root+'/dotnet-sdk.tar.gz',out=fs.createWriteStream(file,{mode:0o600}),digest=crypto.createHash('sha512');for await(const chunk of response.body){digest.update(chunk);if(!out.write(chunk))await new Promise(r=>out.once('drain',r));}await new Promise((resolve,reject)=>{out.on('error',reject);out.end(resolve);});
  if(digest.digest('hex')!==versions.dotnetSHA512.toLowerCase())throw Error('SDK SHA-512 mismatch.');
  const entries=cp.execFileSync('tar',['-tzf',file],{encoding:'utf8',maxBuffer:8*1024*1024}).split('\n');if(entries.some(p=>p.startsWith('/')||p.split('/').includes('..')))throw Error('Unsafe SDK archive.');
  fs.mkdirSync(root+'/dotnet',{recursive:true});run('tar',['-xzf',file,'-C',root+'/dotnet']);fs.unlinkSync(file);
 }
 const uid=Number(cp.execFileSync('id',['-u','harness'])),gid=Number(cp.execFileSync('id',['-g','harness']));
 fs.mkdirSync('/data/harness/state/development',{recursive:true,mode:0o700});fs.chownSync('/data/harness/state/development',uid,gid);
 run('runuser',['-u','harness','--',node,path.join(__dirname,'doctor.cjs'),'--output','/data/harness/state/development.json']);
 console.log(JSON.stringify({provisioned:true,playwright:versions.playwright,dotnet:versions.dotnetVersion,downloadsOnOrdinaryBoot:false}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
