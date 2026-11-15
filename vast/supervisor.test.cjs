'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process');

test('managed service imports preserve immutable releases without changing model cache policy',async()=>{
 const launched=[],source=fs.readFileSync(path.join(__dirname,'supervisor.cjs'),'utf8');let pid=100;
 const files={readFileSync:()=>JSON.stringify({publicHost:'fixture.invalid'}),mkdirSync(){},chownSync(){},writeFileSync(){},existsSync:()=>false,unlinkSync(){},openSync:()=>3,fchownSync(){},closeSync(){}};
 const childProcess={execFileSync(exe){if(exe==='id')return Buffer.from('1000');throw Error('fixture service absent');},spawn(exe,args,options){launched.push({exe,args,options});return{pid:++pid,on(){return this;},kill(){}};}};
 const http={get(){const request={on(event,fn){if(event==='error')queueMicrotask(()=>fn(Error('fixture model absent')));return this;},setTimeout(){},destroy(){}};return request;}};
 const originalEnv={KEEP:'retained',PYTHONDONTWRITEBYTECODE:'inherited',VAST_API_KEY:'fixture-private',CLOUDFLARE_API_TOKEN:'fixture-private'};
 const logOptions=[],runtime={prepare(){},adoptSignedStatus(){},writePrivate(){},publish(){},openLog(root,name,options){logOptions.push({name,...options});return 3;},lockFile(){return'/fixture/billing.lock';}};
 vm.runInNewContext(source,{require(name){return({'node:fs':files,'node:http':http,'node:child_process':childProcess,'./runtime-paths.cjs':runtime})[name]??assert.fail('Unexpected dependency '+name);},process:{env:originalEnv,on(){},exit(){assert.fail('Unexpected supervisor failure');}},console:{log(){},error(){assert.fail('Unexpected supervisor failure');}},setTimeout(){},setInterval(){return{unref(){}};}});
 await new Promise(setImmediate);
 const managed=launched.filter(p=>p.args.some(arg=>typeof arg==='string'&&arg.startsWith('/data/harness/app/')));
 assert.ok(managed.length>=7,'exercise the actual supervisor launch paths');
 for(const child of managed){assert.equal(child.options.env.PYTHONDONTWRITEBYTECODE,'1');assert.equal(child.options.env.KEEP,'retained');assert.equal(child.options.env.VAST_API_KEY,undefined);assert.equal(child.options.env.CLOUDFLARE_API_TOKEN,undefined);}
 const model=launched.find(p=>p.args.includes('/data/start-strata.sh'));
 assert.ok(model);assert.equal(model.options.env.PYTHONDONTWRITEBYTECODE,'inherited');assert.equal(originalEnv.VAST_API_KEY,'fixture-private');
 assert.equal(logOptions.find(x=>x.name==='strata').serviceGroup,null);assert.equal(logOptions.find(x=>x.name==='harness').serviceGroup,1000);
 assert.equal(logOptions.find(x=>x.name==='push').serviceGroup,null);assert.equal(logOptions.find(x=>x.name==='applications').serviceGroup,null);
 const guard=managed.find(p=>p.args.includes('/data/harness/app/vast/idle-guard.py'));assert.ok(guard);
 const script=[
  'set -euo pipefail',
  'task_dir=$(mktemp -d /tmp/harness-python-release-XXXXXX)',
  `trap 'case "$task_dir" in /tmp/harness-python-release-*) rm -rf -- "$task_dir";; *) exit 1;; esac' EXIT`,
  'cd "$task_dir"',
  `printf '%s\n' 'value = 42' > managed_fixture.py`,
  `env -u PYTHONDONTWRITEBYTECODE -u PYTHONPYCACHEPREFIX python3 -c 'import managed_fixture; assert managed_fixture.value == 42'`,
  'test -d __pycache__; test "$(find __pycache__ -name "*.pyc" | wc -l)" -ge 1',
  'rm -rf -- "$task_dir/__pycache__"',
  `env -u PYTHONPYCACHEPREFIX PYTHONDONTWRITEBYTECODE=${guard.options.env.PYTHONDONTWRITEBYTECODE} python3 -c 'import managed_fixture; assert managed_fixture.value == 42'`,
  'test ! -e __pycache__; test "$(find . -type f | wc -l)" -eq 1',
  'echo ACTUAL_PYTHON_IMPORT_PRESERVED_RELEASE',
 ].join('\n')+'\n';
 const imported=cp.spawnSync(process.env.HARNESS_BASH||'bash',['-s'],{input:script,encoding:'utf8',timeout:15000});
 assert.equal(imported.status,0,imported.stderr);assert.match(imported.stdout,/ACTUAL_PYTHON_IMPORT_PRESERVED_RELEASE/);
});
