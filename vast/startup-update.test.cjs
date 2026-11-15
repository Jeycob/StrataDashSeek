'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {commitPayload,config,verifySignature,activate,restoreTransaction,sameRuntime,atomic,update}=require('./startup-update.cjs');
const fixture=require('./fixtures/startup-signature.json');
function temporary(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-update-test-'));t.after(()=>{if(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep+'harness-update-test-'))fs.rmSync(directory,{recursive:true,force:true});});return directory;}
test('real pinned GPG signature passes; modified commit content and unpinned signer fail',t=>{
 const directory=temporary(t);fs.mkdirSync(path.join(directory,'update-cache/home'),{recursive:true});
 const keyring=path.join(directory,'signers.gpg');fs.writeFileSync(keyring,Buffer.from(fixture.publicKeyBase64,'base64'));
 const input=Buffer.from(fixture.commit,'utf8');assert.equal(verifySignature(input,keyring,[fixture.fingerprint],directory),true);
 assert.throws(()=>verifySignature(Buffer.from(fixture.commit+'tamper'),keyring,[fixture.fingerprint],directory),/gpgv failed/);
 assert.throws(()=>verifySignature(input,keyring,['0'.repeat(40)],directory),/not pinned/);
});
test('unsigned or ambiguous signatures cannot become an update',()=>{
 assert.throws(()=>commitPayload(Buffer.from('tree x\n\nmessage\n')),/signature/);
 assert.throws(()=>commitPayload(Buffer.from('tree x\ngpgsig one\ngpgsig two\n\nmessage')),/Multiple/);
 assert.throws(()=>config({version:1,repository:'evil/repo',branch:'main',signers:[fixture.fingerprint]}),/source/);
 assert.throws(()=>config({version:1,repository:'Jeycob/StrataDashSeek',branch:'main',signers:['short']}),/fingerprints/);
 for(const reserve of['invalid',NaN,Infinity,-1,1.5])assert.throws(()=>config({version:1,repository:'Jeycob/StrataDashSeek',branch:'main',signers:[fixture.fingerprint],minimumFreeBytes:reserve}),/finite nonnegative/);
});
test('bootstrap code is written as exact bytes rather than serialized Buffer data',t=>{
 const root=temporary(t),target=path.join(root,'bootstrap.cjs'),bytes=Buffer.from('#!/usr/bin/env node\nconsole.log("ready");\n');atomic(target,bytes);assert.deepEqual(fs.readFileSync(target),bytes);
});
test('dependency upgrades are detected before activation',t=>{
 const root=temporary(t),candidate=path.join(root,'candidate');for(const dir of[root,candidate]){fs.mkdirSync(path.join(dir,'runtime'),{recursive:true});for(const name of['package.json','package-lock.json'])fs.writeFileSync(path.join(dir,'runtime',name),'{}\n');}
 assert.equal(sameRuntime(candidate,root),true);fs.writeFileSync(path.join(candidate,'runtime/package-lock.json'),'{"changed":true}\n');assert.equal(sameRuntime(candidate,root),false);
});

const enabledPolicy=()=>({version:1,enabled:true,repository:'Jeycob/StrataDashSeek',branch:'main',signers:[fixture.fingerprint]});
test('managed startup policy requires explicit boolean enablement and valid metadata',()=>{
 for(const enabled of[undefined,false,null,0,1,'true','false'])assert.throws(()=>config({...enabledPolicy(),enabled}),/must be enabled/);
 for(const raw of[null,[],true,'policy',{}])assert.throws(()=>config(raw),/Unsupported update source/);
 assert.equal(config(enabledPolicy()).enabled,true);
 assert.equal(config({...enabledPolicy(),minimumFreeBytes:0}).minimumFreeBytes,2*1024**3);
});

test('missing, disabled and malformed policy block actual and check-only update before staging',async t=>{
 const cases=[{name:'missing',pattern:/policy is missing/},{name:'disabled',value:JSON.stringify({...enabledPolicy(),enabled:false}),pattern:/must be enabled/},
  {name:'implicit',value:JSON.stringify({...enabledPolicy(),enabled:undefined}),pattern:/must be enabled/},
  {name:'malformed',value:'{invalid-json',pattern:/JSON|position|property|Unexpected/i},
  {name:'null',value:'null',pattern:/Unsupported update source/},
  {name:'wrong-repository',value:JSON.stringify({...enabledPolicy(),repository:'untrusted/source'}),pattern:/Unsupported update source/}];
 for(const scenario of cases)for(const checkOnly of[false,true]){
  const root=temporary(t);fs.mkdirSync(path.join(root,'root-secrets'));fs.mkdirSync(path.join(root,'state'));
  const status=path.join(root,'state/startup-update.json'),before=JSON.stringify({phase:'ready',appliedCommit:'previous'});fs.writeFileSync(status,before);
  const policy=path.join(root,'root-secrets/startup-update.json');if(scenario.value!==undefined)fs.writeFileSync(policy,scenario.value,{mode:0o600});
  await assert.rejects(update(root,{checkOnly}),scenario.pattern,scenario.name);
  assert.equal(fs.existsSync(path.join(root,'update-cache')),false);assert.equal(fs.existsSync(path.join(root,'releases')),false);
  if(checkOnly)assert.equal(fs.readFileSync(status,'utf8'),before);
  else if(process.platform==='linux'&&process.getuid()===0)assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runtime-status/startup-update.json'))).phase,'blocked');
  else assert.equal(fs.readFileSync(status,'utf8'),before,'unsupported privileged writes never use the legacy agent-owned diagnostic');
 }
});

test('first-install missing policy still rejects when no diagnostic directory exists',async t=>{
 const root=temporary(t);await assert.rejects(update(root),/policy is missing/);
 assert.equal(fs.existsSync(path.join(root,'state')),false);assert.equal(fs.existsSync(path.join(root,'update-cache')),false);
});

test('start launcher has no service fallback; real shell refuses absent or non-executable bootstrap when available',t=>{
 const source=fs.readFileSync(path.join(__dirname,'start.sh'),'utf8');
 assert.match(source,/\[ ! -f "\$BOOTSTRAP" \] \|\| \[ ! -x "\$BOOTSTRAP" \]/);
 assert.doesNotMatch(source,/supervisor\.cjs|node\/bin\/node/);assert.match(source,/exec bash "\$BOOTSTRAP"/);
 const candidates=[process.env.HARNESS_BASH,'bash'].filter(Boolean);
 const bash=candidates.find(command=>cp.spawnSync(command,['--version'],{encoding:'utf8',timeout:3000}).status===0);
 if(!bash){t.diagnostic('No local bash available: launcher source contract checked; real shell/Unix execute-bit cases require the isolated Linux gate.');return;}
 // Keep fixture creation, permission checks and cleanup in the same shell/FS.
 // This also exercises real Unix execute bits when Windows resolves bash to WSL.
 const script=[
  'set -euo pipefail',
  'task_dir=$(mktemp -d /tmp/harness-update-launcher-XXXXXX)',
  `trap 'case "$task_dir" in /tmp/harness-update-launcher-*) rm -rf -- "$task_dir";; *) exit 1;; esac' EXIT`,
  'export FIXTURE_ROOT="$task_dir"',
  'cat > "$task_dir/start.sh" <<\'HARNESS_LAUNCHER\'',
  source.replaceAll('\r\n','\n').replace('BOOTSTRAP=/data/harness/bootstrap/start.sh','BOOTSTRAP="$FIXTURE_ROOT/bootstrap.sh"'),
  'HARNESS_LAUNCHER',
  'check_rejected() {',
  ' set +e; bash "$task_dir/start.sh" > "$task_dir/out" 2> "$task_dir/err"; result=$?; set -e',
  ' test "$result" -eq 1',
  ' grep -q "bootstrap is missing or not executable" "$task_dir/err"',
  '}',
  'check_rejected',
  'mkdir "$task_dir/bootstrap.sh"; check_rejected; rmdir "$task_dir/bootstrap.sh"',
  `printf '%s\\n' '#!/usr/bin/env bash' 'echo TRUSTED_BOOTSTRAP' 'exit 37' > "$task_dir/bootstrap.sh"`,
  'chmod 600 "$task_dir/bootstrap.sh"; test ! -x "$task_dir/bootstrap.sh"; check_rejected',
  'chmod 700 "$task_dir/bootstrap.sh"',
  'set +e; bash "$task_dir/start.sh" > "$task_dir/out" 2> "$task_dir/err"; result=$?; set -e',
  'test "$result" -eq 37; grep -q TRUSTED_BOOTSTRAP "$task_dir/out"',
  'echo REAL_SHELL_CASES_PASSED',
 ].join('\n')+'\n';
 const result=cp.spawnSync(bash,['-s'],{input:script,encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/REAL_SHELL_CASES_PASSED/);
});
