'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const runtime=require('./runtime-paths.cjs'),{canonical}=require('./project-execution-mode.cjs');
const uid=61081,signers=['A'.repeat(40)],commit='a'.repeat(40),prefix='/var/lib/homeai-execution-floor-install-test-';
const source=path.join(__dirname,'startup-install.cjs');
function policy(epoch='11111111-1111-4111-8111-111111111111'){return{version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:epoch,activationSourceCommit:commit};}
function fixture(t,{withPolicy=true,partial=false}={}){
 const root=fs.mkdtempSync(prefix);fs.chmodSync(root,0o755);t.after(()=>{const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),'/var/lib');assert(path.basename(actual).startsWith(path.basename(prefix)));fs.rmSync(actual,{recursive:true,force:true});});
 const privateRoot=path.join(root,'root-secrets'),policyFile=path.join(privateRoot,'runtime/state/project-execution-policy.json'),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'synthetic-signers.gpg');
 fs.mkdirSync(path.dirname(policyFile),{recursive:true,mode:0o700});if(withPolicy)fs.writeFileSync(policyFile,canonical(policy()),{mode:0o600});fs.writeFileSync(keyring,'SYNTHETIC PUBLIC KEYRING\n',{mode:0o600});fs.writeFileSync(onstart,'#!/usr/bin/env bash\nbash '+root+(partial?'/bootstrap/start.sh':'/app/vast/start.sh')+'\n',{mode:0o700});
 if(partial){fs.mkdirSync(path.join(root,'bootstrap'),{mode:0o755});fs.writeFileSync(path.join(root,'bootstrap/start.sh'),'PREVIOUS STABLE ENTRY\n',{mode:0o755});}
 const helper=path.join(root,'install-fixture.cjs');fs.writeFileSync(helper,`'use strict';const fs=require('node:fs'),path=require('node:path'),root=process.argv[2],options=JSON.parse(fs.readFileSync(path.join(root,'install-options.json')));const flags=options.fixtureFlags;delete options.fixtureFlags;if(flags){const rename=fs.renameSync;fs.renameSync=function(from,to){if(flags.publicationFailure&&to===path.join(root,'bootstrap/start.sh'))throw Error('CONTROLLED_ENTRY_PUBLICATION_FAILURE');const value=rename.apply(this,arguments);if(flags.changePolicy&&to===path.join(root,'root-secrets/startup-update.json')){const file=path.join(root,'root-secrets/runtime/state/project-execution-policy.json'),value=JSON.parse(fs.readFileSync(file));value.policyEpoch='22222222-2222-4222-8222-222222222222';fs.writeFileSync(file,require(${JSON.stringify(path.join(__dirname,'project-execution-mode.cjs'))}).canonical(value));}return value;};}try{console.log(JSON.stringify(require(${JSON.stringify(source)}).install(options)));}catch(error){console.error(JSON.stringify({code:error.code||null,error:error.message}));process.exitCode=1;}\n`,{mode:0o600});
 return{root,privateRoot,policyFile,onstart,keyring,helper};
}
function run(f,{upgrade=false,fd9='none',publicationFailure=false,changePolicy=false}={}){
 const options={root:f.root,keyring:f.keyring,signers,onstart:f.onstart,account:{uid,gid:uid},upgradeBootstrap:upgrade,fixtureFlags:{publicationFailure,changePolicy}};fs.writeFileSync(path.join(f.root,'install-options.json'),JSON.stringify(options),{mode:0o600});
 const script='exec 9>"$1/supervisor.lock"; if [ "$2" = lock ]; then flock -n 9 || exit 66; fi; exec "$3" "$4" "$1"';
 const command=fd9==='none'?process.execPath:'bash',args=fd9==='none'?[f.helper,f.root]:['-c',script,'install-fixture',f.root,fd9,process.execPath,f.helper];
 return cp.spawnSync(command,args,{encoding:'utf8',timeout:10000,maxBuffer:128*1024,stdio:runtime.withoutRootLease('pipe','pipe'),env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});
}
if(process.env.HARNESS_EXECUTION_FLOOR_ROOT_TEST==='1'){
 test('floor-enabled first installation requires canonical explicit policy before any stable entry publication',t=>{
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);const f=fixture(t,{withPolicy:false}),before=fs.readFileSync(f.onstart);let result=run(f);assert.notEqual(result.status,0,result.stdout);assert.match(result.stderr,/PROJECT_EXECUTION_POLICY_REQUIRED/);assert.equal(fs.existsSync(path.join(f.root,'bootstrap')),false);assert.deepEqual(fs.readFileSync(f.onstart),before);
  fs.writeFileSync(f.policyFile,JSON.stringify(policy(),null,2),{mode:0o600});result=run(f);assert.notEqual(result.status,0);assert.match(result.stderr,/PROJECT_EXECUTION_FILE_INVALID/);assert.equal(fs.existsSync(path.join(f.root,'bootstrap')),false);
 });
 test('fresh explicit installation installs both floor dependencies and signed status detects either missing helper',t=>{
  const f=fixture(t),result=run(f);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).bootstrapExplicitlyUpgraded,false);
  for(const name of ['project-execution-mode.cjs','project-execution-floor.cjs'])assert.deepEqual(fs.readFileSync(path.join(f.root,'bootstrap',name)),fs.readFileSync(path.join(__dirname,name)));
  const release=path.join(f.root,'releases',commit);fs.mkdirSync(release,{recursive:true,mode:0o755});fs.writeFileSync(path.join(release,'fixture.txt'),'synthetic signed bytes',{mode:0o644});fs.symlinkSync(release,path.join(f.root,'app'));
  fs.writeFileSync(path.join(f.privateRoot,'startup-update-applied.json'),JSON.stringify({commit,digest:require('./startup-update.cjs').releaseDigest(release)}),{mode:0o600});assert.equal(runtime.adoptSignedStatus(f.root).bootstrapUpgradeRequired,false);
  for(const name of ['project-execution-mode.cjs','project-execution-floor.cjs']){const file=path.join(f.root,'bootstrap',name),bytes=fs.readFileSync(file);fs.unlinkSync(file);assert.equal(runtime.adoptSignedStatus(f.root).bootstrapUpgradeRequired,true);fs.writeFileSync(file,bytes,{mode:0o644});assert.equal(runtime.adoptSignedStatus(f.root).bootstrapUpgradeRequired,false);}
  const before=fs.readFileSync(path.join(f.privateRoot,'startup-update-signers.gpg'));assert.equal(run(f).status,0);assert.deepEqual(fs.readFileSync(path.join(f.privateRoot,'startup-update-signers.gpg')),before);
 });
 test('an installed bootstrap missing helpers requires explicit upgrade and inherited root FD9 before replacement',t=>{
  const f=fixture(t,{partial:true}),entry=path.join(f.root,'bootstrap/start.sh'),before=fs.readFileSync(entry);let result=run(f);assert.notEqual(result.status,0);assert.match(result.stderr,/explicit reviewed upgrade/);assert.equal(fs.existsSync(path.join(f.root,'bootstrap/project-execution-floor.cjs')),false);
  result=run(f,{upgrade:true});assert.notEqual(result.status,0);assert.match(result.stderr,/RUNTIME_LAUNCH_LEASE_REQUIRED/);assert.deepEqual(fs.readFileSync(entry),before);
  result=run(f,{upgrade:true,fd9:'lock'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).bootstrapExplicitlyUpgraded,true);assert.deepEqual(fs.readFileSync(entry),fs.readFileSync(path.join(__dirname,'startup-bootstrap.sh')));
 });
 test('a different live root lease holder excludes bootstrap upgrade with zero service-UID writers',async t=>{
  const f=fixture(t,{partial:true}),entry=path.join(f.root,'bootstrap/start.sh'),before=fs.readFileSync(entry);require('./runtime-launcher.cjs').assertNoAgentProcesses(uid);
  const child=cp.spawn('bash',['-c','exec 9>"$1/supervisor.lock"; flock -n 9 || exit 66; echo LOCKED; read -r value','lease-holder',f.root],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}});const exited=new Promise(resolve=>child.once('exit',resolve));t.after(async()=>{if(child.exitCode===null){child.stdin.end('release\n');await exited;}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Lease fixture timeout')),2000);child.stdout.once('data',bytes=>{clearTimeout(timer);assert.match(bytes.toString(),/LOCKED/);resolve();});child.once('error',reject);});
  const result=run(f,{upgrade:true,fd9:'unlocked'});assert.notEqual(result.status,0);assert.match(result.stderr,/RUNTIME_LAUNCH_LEASE_BUSY/);assert.equal(child.exitCode,null);assert.deepEqual(fs.readFileSync(entry),before);assert.equal(fs.existsSync(path.join(f.root,'bootstrap/project-execution-floor.cjs')),false);
 });
 test('the exclusive installer lease also rejects a live service-UID writer without terminating it',async t=>{
  const f=fixture(t,{partial:true}),entry=path.join(f.root,'bootstrap/start.sh'),before=fs.readFileSync(entry),child=cp.spawn('setpriv',['--reuid='+uid,'--regid='+uid,'--clear-groups','--bounding-set=-all',process.execPath,'-e','setInterval(()=>{},1000)'],{stdio:'ignore'}),exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exited;}});const {agentProcesses}=require('./runtime-launcher.cjs'),deadline=Date.now()+2000;while(!agentProcesses(uid).includes(child.pid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert(agentProcesses(uid).includes(child.pid));
  const result=run(f,{upgrade:true,fd9:'lock'});assert.notEqual(result.status,0);assert.match(result.stderr,/RUNTIME_LAUNCH_USER_PROCESS_ACTIVE/);assert.equal(child.exitCode,null);assert.deepEqual(fs.readFileSync(entry),before);
 });
 test('entry publication failure or policy replacement retains previous executable entry and trust bytes',t=>{
  for(const flags of [{publicationFailure:true},{changePolicy:true}]){const f=fixture(t,{partial:true}),entry=path.join(f.root,'bootstrap/start.sh'),before=fs.readFileSync(entry),result=run(f,{upgrade:true,fd9:'lock',...flags});assert.notEqual(result.status,0);assert.match(result.stderr,flags.changePolicy?/PROJECT_EXECUTION_FLOOR_POLICY_CHANGED/:/CONTROLLED_ENTRY_PUBLICATION_FAILURE/);assert.deepEqual(fs.readFileSync(entry),before);assert.deepEqual(fs.readFileSync(path.join(f.privateRoot,'startup-update-signers.gpg')),fs.readFileSync(f.keyring));}
 });
}
