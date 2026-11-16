'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
const probe=require('./project-container-share-probe.cjs');
const base=['-name','fixture','-m','2048','-nic','none','-blockdev',JSON.stringify({driver:'file',filename:'/proc/self/fd/6','read-only':true}),'-blockdev',JSON.stringify({driver:'raw','read-only':true})];
test('plan preserves old disk readonly and exports only two fixed synthetic FDs',()=>{
 const args=probe.qemuArgs(base);assert.deepEqual(args.slice(0,base.length),base);
 const shares=args.flatMap((v,i)=>v==='-fsdev'?[args[i+1]]:[]);assert.equal(shares.length,2);
 assert.match(shares[0],/path=\/proc\/self\/fd\/7,security_model=none,multidevs=forbid,writeout=immediate$/);
 assert.match(shares[1],/path=\/proc\/self\/fd\/8,security_model=none,multidevs=forbid,readonly=on$/);
 assert.throws(()=>probe.qemuArgs([...base,'-fsdev','path=/data/harness']),/UNSAFE/);
 assert.throws(()=>probe.qemuArgs(base.map(x=>x==='none'?'user':x)),/UNSAFE/);
 assert.throws(()=>probe.qemuArgs(base.map(x=>x.includes('"read-only":true')?x.replace('true','false'):x)),/READONLY/);
});
test('actual reviewer template composes one leaf daemon, scoped mounts and witnessed negatives',()=>{
 const proof=require(process.env.HOMEAI_CONTAINER_PROOF??'./guest-container-isolation-probe.cjs');
 const script=probe.guestScript('a'.repeat(16),proof),syntax=spawnSync('sh',['-n'],{input:script,encoding:'utf8'});
 assert.equal(syntax.status,0,syntax.stderr);assert.equal((script.match(/ dockerd /g)||[]).length,1);
 assert.match(script,/homeai-probe-daemons\/isolation/);assert.match(script,/test "\$\(cat \/tmp\/isolation-caps\)" = 'true true true true true 2'/);
 assert.match(script,/source=\/mnt\/combined-projects\/project-a,target=\/workspace/);
 assert.doesNotMatch(script,/source=\/mnt\/combined-projects,target=/);
 assert.match(script,/source=\/mnt\/combined-transport\/scope-a\/gen-a,target=\/run\/homeai-transport,readonly/);
 assert.doesNotMatch(script,/source=\/mnt\/combined-transport,target=/);
 assert.match(script,/test "\$status" -eq 1/);assert.match(script,/COMBINED_GUEST_WRITE_aaaaaaaaaaaaaaaa=ready/);
 assert.match(script,/COMBINED_HOST_WRITE_VISIBLE=passed/);assert.match(script,/ISOLATION_PROJECT_READONLY=passed/);
 assert.throws(()=>probe.guestScript('$(id)',proof),/NONCE/);
 assert.throws(()=>probe.guestScript('b'.repeat(16),{guestScript:()=>''}),/TEMPLATE_CHANGED/);
});
test('acceptance requires every negative witness and independent positive markers',()=>{
 const markers=['CENSUS_OLD_DISK_READONLY=1','ISOLATION_REQUIRED_DAEMON_CAPABILITIES=passed','ISOLATION_UID_CAPS_NNP_CGROUP_READBACK=passed','ISOLATION_PROJECT_READONLY=passed','COMBINED_HOST_WRITE_VISIBLE=passed','COMBINED_TRANSPORT_POSITIVE=passed','COMBINED_TRANSPORT_READONLY=passed','COMBINED_RESULT=passed',...[0,1,2,3].flatMap(i=>['COMBINED_READ_NEGATIVE_'+i+'=1','COMBINED_WRITE_NEGATIVE_'+i+'=1','COMBINED_TRANSPORT_NEGATIVE_'+i+'=1'])];
 assert(probe.evidence(markers.join('\r\n')));
 for(const marker of markers)assert.equal(probe.evidence(markers.filter(x=>x!==marker).join('\n')),false,marker);
 assert.equal(probe.evidence(markers.join('\n').replace('COMBINED_READ_NEGATIVE_1=1','COMBINED_READ_NEGATIVE_1=127')),false);
});
test('own exclusive tmpfs fixture exposes only projects and synthetic transport; cleanup rejects arbitrary roots',{skip:process.platform!=='linux'},()=>{
 const nonce=require('node:crypto').randomBytes(8).toString('hex'),f=probe.fixture(nonce);
 try{
  assert.equal(fs.readFileSync(f.live,'utf8'),'HOST_INITIAL_'+nonce);
  assert(fs.lstatSync(f.projects+'/project-a/host-absolute').isSymbolicLink());
  assert.equal(fs.readFileSync(f.transport+'/scope-b/gen-b/canary','utf8'),'TRANSPORT_SIBLING_'+nonce);
  assert.throws(()=>probe.cleanup('/dev/shm'),/UNSAFE/);assert.throws(()=>probe.cleanup(f.root+'/..'),/UNSAFE/);
 }finally{probe.cleanup(f.root);}
 assert.equal(fs.existsSync(f.root),false);
});
