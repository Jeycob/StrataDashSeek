// Run separately as Linux root: the production pointer and ownership contracts
// cannot be proved by Windows junctions or by disabling the root ownership check.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {activate,restoreTransaction,releaseDigest}=require('./startup-update.cjs');
const {install:installGate}=require('./startup-install.cjs');
const {canonical}=require('./project-execution-mode.cjs');
const install=options=>installGate({...options,account:{uid:60056,gid:60056}});
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Run these checks as root in an isolated Linux test environment');
function temporary(t){const root=fs.mkdtempSync('/var/lib/homeai-startup-update-linux-test-');fs.chmodSync(root,0o755);t.after(()=>{const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),'/var/lib');assert(path.basename(actual).startsWith('homeai-startup-update-linux-test-'));fs.rmSync(actual,{recursive:true,force:true});});for(const directory of['root-secrets','releases','app','workspaces'])fs.mkdirSync(path.join(root,directory));fs.mkdirSync(path.join(root,'app/vast'));const policy=path.join(root,'root-secrets/runtime/state/project-execution-policy.json');fs.mkdirSync(path.dirname(policy),{recursive:true,mode:0o700});fs.writeFileSync(policy,canonical({version:1,contract:'project-execution-v1',mode:'host-compat',policyEpoch:'11111111-2222-4333-8444-555555555555',activationSourceCommit:'a'.repeat(40)}),{mode:0o600});return root;}
function candidate(root,commit){const directory=path.join(root,'releases',commit);fs.mkdirSync(path.join(directory,'vast'),{recursive:true,mode:0o755});return directory;}
function installUnderLease(options){const code="const options=JSON.parse(process.argv[1]);options.account={uid:60056,gid:60056};console.log(JSON.stringify(require(process.argv[2]).install(options)));",script='umask 077; exec 9>"$1/supervisor.lock"; flock -n 9 || exit 3; exec "$2" -e "$3" "$4" "$5"',result=cp.spawnSync('bash',['-c',script,'owned-installer-lease',options.root,process.execPath,code,JSON.stringify(options),path.join(__dirname,'startup-install.cjs')],{encoding:'utf8',timeout:10000,stdio:require('./runtime-paths.cjs').withoutRootLease('pipe','pipe')});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
test('activation failure restores the previous app and preserves project data',t=>{
 const root=temporary(t);fs.writeFileSync(path.join(root,'app/old.txt'),'old');fs.writeFileSync(path.join(root,'workspaces/keep.txt'),'project');const next=candidate(root,'a'.repeat(40));fs.writeFileSync(path.join(next,'new.txt'),'new');
 assert.throws(()=>activate(root,next,'a'.repeat(40),{afterSwitch:()=>{throw Error('simulated activation interruption');}}),/interruption/);
 assert.equal(fs.readFileSync(path.join(root,'app/old.txt'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(root,'workspaces/keep.txt'),'utf8'),'project');assert.equal(fs.existsSync(path.join(root,'root-secrets/startup-update-transaction.json')),false);
});
test('a recorded interrupted pointer switch recovers through stable bootstrap',t=>{
 const root=temporary(t),previous=path.join(root,'releases','e'.repeat(40)),target=candidate(root,'f'.repeat(40));fs.renameSync(path.join(root,'app'),previous);fs.writeFileSync(path.join(previous,'source'),'good');fs.symlinkSync(target,path.join(root,'app'),'dir');fs.writeFileSync(path.join(root,'root-secrets/startup-update-transaction.json'),JSON.stringify({version:1,link:path.join(root,'app'),previous,target,previousApplied:null}));
 assert.equal(restoreTransaction(root),true);assert.equal(fs.readFileSync(path.join(root,'app/source'),'utf8'),'good');
});
test('an interruption before the first rename keeps the original app',t=>{
 const root=temporary(t);fs.writeFileSync(path.join(root,'app/source'),'old');fs.writeFileSync(path.join(root,'root-secrets/startup-update-transaction.json'),JSON.stringify({version:1,link:path.join(root,'app'),previous:path.join(root,'releases/legacy-interrupted'),target:path.join(root,'releases','a'.repeat(40)),previousApplied:null}));assert.equal(restoreTransaction(root),true);assert.equal(fs.readFileSync(path.join(root,'app/source'),'utf8'),'old');
});
test('a successful release remains readable to the unprivileged Harness user',t=>{
 const root=temporary(t);fs.chmodSync(root,0o755);const next=candidate(root,'b'.repeat(40));fs.writeFileSync(path.join(next,'source'),'new',{mode:0o644});activate(root,next,'b'.repeat(40));assert.equal(cp.execFileSync('runuser',['-u','nobody','--','cat',path.join(root,'app/source')],{encoding:'utf8'}),'new');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'root-secrets/startup-update-applied.json'))).commit,'b'.repeat(40));
});
test('release trees refuse links and detect code tampering',t=>{
 const root=temporary(t),file=path.join(root,'app/source');fs.writeFileSync(file,'old');const before=releaseDigest(path.join(root,'app'));fs.writeFileSync(file,'new');assert.notEqual(releaseDigest(path.join(root,'app')),before);fs.symlinkSync('/etc/passwd',path.join(root,'app/link'));assert.throws(()=>releaseDigest(path.join(root,'app')),/writable outside root/);
});
test('a writable candidate root is rejected even when all existing children are protected',t=>{
 const root=temporary(t),directory=candidate(root,'c'.repeat(40));fs.writeFileSync(path.join(directory,'protected'),'source',{mode:0o644});fs.chmodSync(directory,0o777);assert.throws(()=>releaseDigest(directory),/writable outside root/);assert.throws(()=>activate(root,directory,'c'.repeat(40)),{code:'PROJECT_EXECUTION_FLOOR_DESCRIPTOR_UNSAFE'});assert.equal(fs.lstatSync(path.join(root,'app')).isDirectory(),true);
});
test('installer preserves unrelated startup work and supports the production nohup line idempotently',t=>{
 const root=temporary(t);fs.mkdirSync(path.join(root,'state'));const onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');fs.writeFileSync(keyring,'public test key');const prefix='#!/bin/bash\necho preserved\n',line='nohup bash '+root+'/app/vast/start.sh > '+root+'/logs/supervisor.log 2>&1 < /dev/null &\n';fs.writeFileSync(onstart,prefix+line,{mode:0o755});const options={root,keyring,signers:['A'.repeat(40)],onstart};assert.equal(install(options).startsOnNextBoot,true);const updated=fs.readFileSync(onstart,'utf8');assert.equal(updated,prefix+line.replace('/app/vast/start.sh','/bootstrap/start.sh').replace('/logs/supervisor.log','/root-secrets/runtime/logs/supervisor.log'));assert.equal(install(options).installed,true);assert.equal(fs.readFileSync(onstart,'utf8'),updated);assert.match(fs.readFileSync(path.join(root,'bootstrap/startup-update.cjs'),'utf8'),/use strict/);
});
test('installer refuses an unrecognized startup command without changing it',t=>{
 const root=temporary(t),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');fs.writeFileSync(onstart,'custom-launch --options\n',{mode:0o755});fs.writeFileSync(keyring,'public');assert.throws(()=>install({root,keyring,signers:['A'.repeat(40)],onstart}),/recognized/);assert.equal(fs.readFileSync(onstart,'utf8'),'custom-launch --options\n');assert.equal(fs.existsSync(path.join(root,'bootstrap/start.sh')),false);
});

test('fresh bootstrap installs the offline helper before its consumer and coldstarts without purge config',async t=>{
 const root=temporary(t),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg'),bootstrap=path.join(root,'bootstrap');
 fs.writeFileSync(onstart,'bash '+root+'/app/vast/start.sh &\n',{mode:0o755});fs.writeFileSync(keyring,'public fixture');
 const published=[],rename=fs.renameSync;
 fs.renameSync=(from,to)=>{
  if(path.dirname(to)===bootstrap){
   const name=path.basename(to);
   if(name==='runtime-launcher.cjs'||name==='start.sh')assert.deepEqual(fs.readFileSync(path.join(bootstrap,'offline-purge-maintenance.cjs')),fs.readFileSync(path.join(__dirname,'offline-purge-maintenance.cjs')));
   published.push(name);
  }
  return rename(from,to);
 };
 try{install({root,onstart,keyring,signers:['A'.repeat(40)]});}finally{fs.renameSync=rename;}
 assert.ok(published.indexOf('offline-purge-maintenance.cjs')<published.indexOf('runtime-launcher.cjs'));assert.equal(published.at(-1),'start.sh');
 // Load only the installed bootstrap, with no access to app/workspace modules.
 const result=cp.spawnSync(process.execPath,['-e',`const p=require('node:path'),b=process.argv[1];require(p.join(b,'runtime-launcher.cjs'));require(p.join(b,'offline-purge-maintenance.cjs')).beforeNativeStart({root:process.argv[2],uid:60056}).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e);process.exitCode=1;});`,bootstrap,root],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{status:'not-configured'});
});

test('signed bootstrap inventory detects a missing or modified offline helper',t=>{
 const root=temporary(t),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');
 fs.writeFileSync(onstart,'bash '+root+'/app/vast/start.sh &\n',{mode:0o755});fs.writeFileSync(keyring,'public fixture');install({root,onstart,keyring,signers:['A'.repeat(40)]});
 const commit='d'.repeat(40),release=path.join(root,'releases',commit);fs.renameSync(path.join(root,'app'),release);fs.symlinkSync(release,path.join(root,'app'),'dir');
 fs.writeFileSync(path.join(root,'root-secrets/startup-update-applied.json'),JSON.stringify({commit,digest:releaseDigest(release)}));
 const runtime=require('./runtime-paths.cjs'),helper=path.join(root,'bootstrap/offline-purge-maintenance.cjs'),bytes=fs.readFileSync(helper);
 assert.equal(runtime.adoptSignedStatus(root).bootstrapUpgradeRequired,false);
 fs.unlinkSync(helper);assert.equal(runtime.adoptSignedStatus(root).bootstrapUpgradeRequired,true);
 fs.writeFileSync(helper,bytes,{mode:0o644});assert.equal(runtime.adoptSignedStatus(root).bootstrapUpgradeRequired,false);
 fs.appendFileSync(helper,'\n// modified fixture\n');assert.equal(runtime.adoptSignedStatus(root).bootstrapUpgradeRequired,true);
});

test('actual offline maintenance CLI resolves service identity and refuses open admission for every mode',t=>{
 const root=temporary(t),runtime=require('./runtime-paths.cjs');runtime.control(root);runtime.writePrivate(root,'runtime-admission-controller.json',{open:true,epoch:'fixture'});
 // Keep the real CLI, identity function and OS lookup. Map only the service
 // account name to an existing test account, without creating system users.
 const preload=path.join(root,'fixture-service-account.cjs');
 fs.writeFileSync(preload,`const cp=require('node:child_process'),original=cp.execFileSync;cp.execFileSync=function(file,args,...rest){if(file==='/usr/bin/id'&&args?.length===2&&['-u','-g'].includes(args[0])&&args[1]==='harness')args=[args[0],'nobody'];return original.call(this,file,args,...rest);};`);
 for(const mode of ['plan','apply','recover']){
  const result=cp.spawnSync(process.execPath,['--require',preload,path.join(__dirname,'offline-purge-maintenance.cjs'),mode,root],{encoding:'utf8'});
  assert.equal(result.status,1,mode);assert.equal(result.stdout,'',mode);assert.equal(result.stderr.trim(),'PURGE_ADMISSION_NOT_CLOSED',mode);
 }
 assert.equal(fs.existsSync(path.join(runtime.paths(root).privateState,'offline-purge-journal.json')),false);
});

test('stable bootstrap changes require explicit upgrade and retain the previous bytes',t=>{
 const root=temporary(t),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');fs.writeFileSync(onstart,'bash '+root+'/app/vast/start.sh &\n',{mode:0o755});fs.writeFileSync(keyring,'public fixture');const options={root,onstart,keyring,signers:['A'.repeat(40)]};install(options);
 const file=path.join(root,'bootstrap/startup-update.cjs');fs.writeFileSync(file,'previous fixture bootstrap');assert.throws(()=>install(options),/explicit reviewed upgrade/);assert.equal(fs.readFileSync(file,'utf8'),'previous fixture bootstrap');
 assert.equal(installUnderLease({...options,upgradeBootstrap:true}).bootstrapExplicitlyUpgraded,true);assert.match(fs.readFileSync(file,'utf8'),/use strict/);const saved=fs.readdirSync(path.join(root,'root-secrets')).filter(n=>n.startsWith('bootstrap-before-runtime-'));assert.equal(saved.length,1);assert.equal(fs.readFileSync(path.join(root,'root-secrets',saved[0],'startup-update.cjs'),'utf8'),'previous fixture bootstrap');
});
test('an interrupted first install never publishes an executable bootstrap before policy',t=>{
 const root=temporary(t),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');fs.writeFileSync(onstart,'bash '+root+'/app/vast/start.sh &\n',{mode:0o755});fs.writeFileSync(keyring,'public');const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b===path.join(root,'root-secrets/startup-update.json'))throw Error('simulated policy publication failure');return rename(a,b);};try{assert.throws(()=>install({root,keyring,signers:['A'.repeat(40)],onstart}),/publication failure/);}finally{fs.renameSync=rename;}assert.equal(fs.existsSync(path.join(root,'bootstrap/start.sh')),false);assert.match(fs.readFileSync(onstart,'utf8'),/app\/vast\/start.sh/);
});
test('bootstrap refuses missing policy or trust and never launches supervisor',t=>{
 const root=temporary(t),script=path.join(root,'bootstrap-test.sh');fs.writeFileSync(script,fs.readFileSync(path.join(__dirname,'startup-bootstrap.sh'),'utf8').replace('ROOT=/data/harness','ROOT='+root));const missing=cp.spawnSync('bash',[script],{encoding:'utf8'});assert.equal(missing.status,1);assert.match(missing.stderr,/policy or trust is missing/);fs.writeFileSync(path.join(root,'root-secrets/startup-update.json'),'{}');const noTrust=cp.spawnSync('bash',[script],{encoding:'utf8'});assert.equal(noTrust.status,1);assert.match(noTrust.stderr,/policy or trust is missing/);
});
