// Run separately as Linux root: the production pointer and ownership contracts
// cannot be proved by Windows junctions or by disabling the root ownership check.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {activate,restoreTransaction,releaseDigest}=require('./startup-update.cjs');
const {install}=require('./startup-install.cjs');
if(process.platform!=='linux'||process.getuid()!==0)throw Error('Run these checks as root in an isolated Linux test environment');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-update-linux-'));t.after(()=>{if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'harness-update-linux-'))fs.rmSync(root,{recursive:true,force:true});});for(const directory of['root-secrets','releases','app','workspaces'])fs.mkdirSync(path.join(root,directory));return root;}
test('activation failure restores the previous app and preserves project data',t=>{
 const root=temporary(t);fs.writeFileSync(path.join(root,'app/old.txt'),'old');fs.writeFileSync(path.join(root,'workspaces/keep.txt'),'project');const next=path.join(root,'releases/new');fs.mkdirSync(next);fs.writeFileSync(path.join(next,'new.txt'),'new');
 assert.throws(()=>activate(root,next,'a'.repeat(40),{afterSwitch:()=>{throw Error('simulated activation interruption');}}),/interruption/);
 assert.equal(fs.readFileSync(path.join(root,'app/old.txt'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(root,'workspaces/keep.txt'),'utf8'),'project');assert.equal(fs.existsSync(path.join(root,'root-secrets/startup-update-transaction.json')),false);
});
test('a recorded interrupted pointer switch recovers through stable bootstrap',t=>{
 const root=temporary(t);fs.renameSync(path.join(root,'app'),path.join(root,'releases/old'));fs.mkdirSync(path.join(root,'releases/new'));fs.writeFileSync(path.join(root,'releases/old/source'),'good');fs.symlinkSync(path.join(root,'releases/new'),path.join(root,'app'),'dir');fs.writeFileSync(path.join(root,'root-secrets/startup-update-transaction.json'),JSON.stringify({link:path.join(root,'app'),previous:path.join(root,'releases/old')}));
 assert.equal(restoreTransaction(root),true);assert.equal(fs.readFileSync(path.join(root,'app/source'),'utf8'),'good');
});
test('an interruption before the first rename keeps the original app',t=>{
 const root=temporary(t);fs.writeFileSync(path.join(root,'app/source'),'old');fs.writeFileSync(path.join(root,'root-secrets/startup-update-transaction.json'),JSON.stringify({link:path.join(root,'app'),previous:path.join(root,'releases/legacy-interrupted')}));assert.equal(restoreTransaction(root),true);assert.equal(fs.readFileSync(path.join(root,'app/source'),'utf8'),'old');
});
test('a successful release remains readable to the unprivileged Harness user',t=>{
 const root=temporary(t);fs.chmodSync(root,0o755);const next=path.join(root,'releases/new');fs.mkdirSync(next,{mode:0o755});fs.writeFileSync(path.join(next,'source'),'new',{mode:0o644});activate(root,next,'b'.repeat(40));assert.equal(cp.execFileSync('runuser',['-u','nobody','--','cat',path.join(root,'app/source')],{encoding:'utf8'}),'new');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'root-secrets/startup-update-applied.json'))).commit,'b'.repeat(40));
});
test('release trees refuse links and detect code tampering',t=>{
 const root=temporary(t),file=path.join(root,'app/source');fs.writeFileSync(file,'old');const before=releaseDigest(path.join(root,'app'));fs.writeFileSync(file,'new');assert.notEqual(releaseDigest(path.join(root,'app')),before);fs.symlinkSync('/etc/passwd',path.join(root,'app/link'));assert.throws(()=>releaseDigest(path.join(root,'app')),/writable outside root/);
});
test('a writable candidate root is rejected even when all existing children are protected',t=>{
 const root=temporary(t),candidate=path.join(root,'releases/writable');fs.mkdirSync(candidate,{mode:0o755});fs.writeFileSync(path.join(candidate,'protected'),'source',{mode:0o644});fs.chmodSync(candidate,0o777);assert.throws(()=>releaseDigest(candidate),/writable outside root/);assert.throws(()=>activate(root,candidate,'c'.repeat(40)),/writable outside root/);assert.equal(fs.lstatSync(path.join(root,'app')).isDirectory(),true);
});
test('installer preserves unrelated startup work and supports the production nohup line idempotently',t=>{
 const root=temporary(t);fs.mkdirSync(path.join(root,'state'));const onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');fs.writeFileSync(keyring,'public test key');const prefix='#!/bin/bash\necho preserved\n',line='nohup bash '+root+'/app/vast/start.sh > '+root+'/logs/supervisor.log 2>&1 < /dev/null &\n';fs.writeFileSync(onstart,prefix+line,{mode:0o755});const options={root,keyring,signers:['A'.repeat(40)],onstart};assert.equal(install(options).startsOnNextBoot,true);const updated=fs.readFileSync(onstart,'utf8');assert.equal(updated,prefix+line.replace('/app/vast/start.sh','/bootstrap/start.sh'));assert.equal(install(options).installed,true);assert.equal(fs.readFileSync(onstart,'utf8'),updated);assert.match(fs.readFileSync(path.join(root,'bootstrap/startup-update.cjs'),'utf8'),/use strict/);
});
test('installer refuses an unrecognized startup command without changing it',t=>{
 const root=temporary(t),onstart=path.join(root,'onstart.sh'),keyring=path.join(root,'public.gpg');fs.writeFileSync(onstart,'custom-launch --options\n',{mode:0o755});fs.writeFileSync(keyring,'public');assert.throws(()=>install({root,keyring,signers:['A'.repeat(40)],onstart}),/recognized/);assert.equal(fs.readFileSync(onstart,'utf8'),'custom-launch --options\n');assert.equal(fs.existsSync(path.join(root,'bootstrap/start.sh')),false);
});
