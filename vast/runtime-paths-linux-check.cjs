'use strict';
// Explicit Linux/root suite; never replace this proof with Windows mode bits.
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const runtime=require('./runtime-paths.cjs');
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Run as root in an isolated local Linux fixture');
const account={uid:65534,gid:65534};
function fixture(t){const root=fs.mkdtempSync('/tmp/harness-rootio-');fs.chmodSync(root,0o755);t.after(()=>{if(path.resolve(root).startsWith('/tmp/harness-rootio-'))fs.rmSync(root,{recursive:true,force:true});});return root;}
function agent(code,args=[],options={}){return cp.spawnSync('/usr/bin/setpriv',['--reuid','65534','--regid','65534','--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',process.execPath,'-e',code,...args],{encoding:'utf8',timeout:7000,...options});}
function same(file,before){assert.equal(fs.readFileSync(file,'utf8'),before.text);const s=fs.statSync(file);assert.equal(s.uid,before.uid);assert.equal(s.mode&0o777,before.mode);}
function victim(root){const file=path.join(root,'protected-victim');fs.writeFileSync(file,'ROOT_ONLY_FIXTURE',{mode:0o600});return{file,before:{text:'ROOT_ONLY_FIXTURE',uid:0,mode:0o600}};}
test('legacy symlink logs are quarantined without following or chowning targets; two service starts work',t=>{
 const root=fixture(t),v=victim(root),old=path.join(root,'logs');fs.mkdirSync(old,{mode:0o755});fs.chownSync(old,65534,65534);assert.equal(agent('require("fs").symlinkSync(process.argv[1],process.argv[2])',[v.file,path.join(old,'harness.log')]).status,0);
 const first=runtime.prepare(root,account),p=runtime.paths(root);assert.equal(first.legacyLogsRetained,true);same(v.file,v.before);
 for(let i=0;i<2;i++){const fd=runtime.openLog(root,'harness',{serviceGroup:65534});const r=agent('process.stdout.write("SERVICE_STARTED\\n")',[],{stdio:['ignore',fd,'pipe']});fs.closeSync(fd);assert.equal(r.status,0,r.stderr);}
 assert.equal(fs.readFileSync(path.join(p.serviceLogs,'harness.log'),'utf8'),'SERVICE_STARTED\nSERVICE_STARTED\n');assert.equal(fs.statSync(path.join(p.serviceLogs,'harness.log')).uid,0);
 const before=fs.readdirSync(p.legacy);runtime.prepare(root,account);assert.deepEqual(fs.readdirSync(p.legacy),before);same(v.file,v.before);
 const overwrite=agent('require("fs").unlinkSync(process.argv[1])',[path.join(p.serviceLogs,'harness.log')]);assert.notEqual(overwrite.status,0);assert.equal(agent('process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))',[path.join(p.serviceLogs,'harness.log')]).status,0);
});
test('direct symlink and hardlink log targets are refused before content, mode or ownership changes',t=>{
 const root=fixture(t),v=victim(root);runtime.prepare(root,account);const target=path.join(root,'logs/harness.log');
 for(const link of['symlinkSync','linkSync']){fs[link](v.file,target);assert.throws(()=>runtime.openLog(root,'harness',{serviceGroup:65534}),/Untrusted|Unsafe/);same(v.file,v.before);fs.unlinkSync(target);}
});
test('an interrupted log quarantine resumes without losing its retained destination',t=>{
 const root=fixture(t),old=path.join(root,'logs');fs.mkdirSync(old);fs.chownSync(old,65534,65534);fs.writeFileSync(path.join(old,'retained.log'),'BEFORE_MIGRATION');
 assert.throws(()=>runtime.prepare(root,account,{afterLogMove(){throw Error('fixture interruption');}}),/interruption/);
 const p=runtime.paths(root),pending=JSON.parse(fs.readFileSync(path.join(p.control,'layout.json'))).pendingLogs;assert.equal(fs.readFileSync(path.join(pending,'retained.log'),'utf8'),'BEFORE_MIGRATION');
 assert.equal(runtime.prepare(root,account).legacyLogsRetained,true);const final=JSON.parse(fs.readFileSync(path.join(p.control,'layout.json')));assert.equal(final.pendingLogs,null);assert.equal(final.logsBackup,pending);assert.equal(fs.readFileSync(path.join(pending,'retained.log'),'utf8'),'BEFORE_MIGRATION');
});
test('writable, replaced and symlinked parent directories cannot redirect privileged state writes',t=>{
 const root=fixture(t),v=victim(root);runtime.prepare(root,account);const p=runtime.paths(root);
 fs.chmodSync(p.publicState,0o777);fs.symlinkSync(v.file,path.join(p.publicState,'telemetry.json'));assert.throws(()=>runtime.publish(root,'telemetry.json',{at:1}),/writable|Writable|Untrusted/);same(v.file,v.before);
 fs.unlinkSync(path.join(p.publicState,'telemetry.json'));fs.chmodSync(p.publicState,0o755);
 const attack=agent('const fs=require("fs");for(let i=0;i<100;i++){try{fs.renameSync(process.argv[1],process.argv[1]+".stolen");process.exit(8)}catch{}}',[p.publicState]);assert.equal(attack.status,0,attack.stderr);
 for(let i=0;i<50;i++)runtime.publish(root,'telemetry.json',{at:i});assert.equal(JSON.parse(fs.readFileSync(path.join(p.publicState,'telemetry.json'))).at,49);same(v.file,v.before);
 const badParent=path.join(root,'untrusted');fs.mkdirSync(badParent);fs.chownSync(badParent,65534,65534);const child=path.join(badParent,'root-owned-child');fs.mkdirSync(child);assert.throws(()=>runtime.control(child),/Untrusted/);
});
test('hardlinks in private state are refused and root-only state cannot be read by the service UID',t=>{
 const root=fixture(t),v=victim(root);runtime.prepare(root,account);const p=runtime.paths(root),target=path.join(p.privateState,'services.json');fs.linkSync(v.file,target);assert.throws(()=>runtime.writePrivate(root,'services.json',{}),/Untrusted/);same(v.file,v.before);fs.unlinkSync(target);
 runtime.writePrivate(root,'services.json',{pids:[12],names:{harness:12}});runtime.publish(root,'services.json',{pids:[12],names:{harness:12}});
 assert.notEqual(agent('require("fs").readFileSync(process.argv[1])',[target]).status,0);assert.equal(agent('JSON.parse(require("fs").readFileSync(process.argv[1]))',[path.join(p.publicState,'services.json')]).status,0);
});
test('maintenance input is read as the agent and cannot cause a privileged private-file read',t=>{
 const root=fixture(t);runtime.prepare(root,account);const p=runtime.paths(root),file=path.join(p.agentState,'maintenance.json');const put=agent('require("fs").writeFileSync(process.argv[1],JSON.stringify({until:123,owner:"fixture"}))',[file]);assert.equal(put.status,0,put.stderr);assert.equal(runtime.readAgent(root,'maintenance.json',account,4096).until,123);
 runtime.writePrivate(root,'only-root.json',{secret:'NOT_FOR_AGENT'});fs.unlinkSync(file);fs.symlinkSync(path.join(p.privateState,'only-root.json'),file);assert.throws(()=>runtime.readAgent(root,'maintenance.json',account,4096),/unavailable|unsafe/);
});
test('public status cannot publish the private Harness login log',t=>{
 const root=fixture(t);runtime.prepare(root,account);const p=runtime.paths(root),canary='FIXTURE_LAUNCH_SECRET';const fd=runtime.openLog(root,'harness',{serviceGroup:65534});fs.writeSync(fd,'https://fixture.invalid/?token='+canary);fs.closeSync(fd);
 runtime.publish(root,'telemetry.json',{at:1,harnessLog:canary,model:{id:'https://fixture.invalid/?token='+canary,loaded:true,promptTokens:1}});const text=fs.readFileSync(path.join(p.publicState,'telemetry.json'),'utf8');assert.ok(!text.includes(canary));assert.throws(()=>runtime.publish(root,'harness.log',{text:canary}),/Unsupported/);
 const privateFD=runtime.openLog(root,'idle-guard');fs.writeSync(privateFD,'private');fs.closeSync(privateFD);assert.notEqual(agent('require("fs").readFileSync(process.argv[1])',[path.join(p.privateLogs,'idle-guard.log')]).status,0);
});
test('existing agent data and ownership survive migration; malformed privileged ancestors fail closed',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'state'));fs.mkdirSync(path.join(root,'state/workbench'));const keep=path.join(root,'state/workbench/retained.json');fs.writeFileSync(keep,'{"retained":true}');const before=fs.statSync(keep);runtime.prepare(root,account);assert.equal(fs.readFileSync(keep,'utf8'),'{"retained":true}');assert.equal(fs.statSync(keep).uid,before.uid);
 const root2=fixture(t),v=victim(root2);fs.symlinkSync(path.dirname(v.file),path.join(root2,'root-secrets'));assert.throws(()=>runtime.control(root2),/Untrusted/);same(v.file,v.before);
});
test('supervisor lock rejects symlinks and hardlinks without truncating the target',t=>{
 const root=fixture(t),v=victim(root),file=path.join(root,'supervisor.lock');
 for(const link of['symlinkSync','linkSync']){fs[link](v.file,file);assert.throws(()=>runtime.lockFile(root),/Untrusted|Unsafe/);same(v.file,v.before);fs.unlinkSync(file);}
 runtime.lockFile(root);const inode=fs.statSync(file).ino;runtime.lockFile(root);assert.equal(fs.statSync(file).ino,inode);
});
test('root billing never appends or chowns through an agent-controlled ledger path',async t=>{
 const{collectPrivateBilling}=await import('./root-billing.mjs');const root=fixture(t),v=victim(root);runtime.prepare(root,account);const p=runtime.paths(root),legacy=path.join(root,'state/efficiency/billing-observations.jsonl');
 const attack=agent('const fs=require("fs");fs.unlinkSync(process.argv[1]);fs.symlinkSync(process.argv[2],process.argv[1]);',[legacy,v.file]);assert.equal(attack.status,0,attack.stderr);
 fs.writeFileSync(path.join(root,'root-secrets/guard.json'),JSON.stringify({instanceId:1234}),{mode:0o600});
 let at=0;const sample=async()=>({at:at+=60000,instanceId:1234,status:'running',computeUsdPerHour:0.1,storageUsdPerHour:0.01,source:'synthetic fixture',costBasis:'synthetic estimate',harnessLog:'PRIVATE_BILLING_CANARY'});
 await collectPrivateBilling(root,{sample});await collectPrivateBilling(root,{sample});same(v.file,v.before);
 const published=fs.readFileSync(path.join(p.publicState,'billing-observations.jsonl'),'utf8');assert.ok(!published.includes('PRIVATE_BILLING_CANARY'));assert.equal(published.trim().split('\n').length,2);
 const windows=fs.readFileSync(path.join(p.publicState,'billing-windows.jsonl'),'utf8');assert.equal(JSON.parse(windows).to,120000);
 assert.notEqual(agent('require("fs").readFileSync(process.argv[1])',[path.join(p.privateState,'billing/billing-observations.jsonl')]).status,0);
});
test('old stable-bootstrap diagnostics migrate from protected applied metadata without blocking normal startup',t=>{
 const root=fixture(t);runtime.prepare(root,account);const sha='a'.repeat(40),release=path.join(root,'releases',sha);fs.mkdirSync(release,{recursive:true});fs.writeFileSync(path.join(release,'source.txt'),'VERIFIED_FIXTURE_SOURCE');fs.symlinkSync(release,path.join(root,'app'));fs.mkdirSync(path.join(root,'bootstrap'));fs.writeFileSync(path.join(root,'bootstrap/start.sh'),'old reviewed bootstrap');
 const digest=require('./startup-update.cjs').releaseDigest(release);fs.writeFileSync(path.join(root,'root-secrets/startup-update-applied.json'),JSON.stringify({commit:sha,digest}),{mode:0o600});
 const out=runtime.adoptSignedStatus(root);assert.equal(out.appliedCommit,sha);assert.equal(out.signatureVerified,true);assert.equal(out.bootstrapUpgradeRequired,true);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runtime-status/startup-update.json'))).phase,'ready');
 fs.writeFileSync(path.join(release,'source.txt'),'TAMPERED');assert.throws(()=>runtime.adoptSignedStatus(root),/differs/);
});
