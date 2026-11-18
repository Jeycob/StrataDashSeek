'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CONTRACT,sha,absentState,validatePlan,runReconciliation,gatePending}=require('./apps-vm-reconciliation.cjs');
const fs=require('node:fs'),path=require('node:path'),fsck=require('../development/guest-disk-fsck.cjs');
const {fixture:controller}=require('./fixtures/vm-ownership.cjs');
const clone=v=>structuredClone(v);
function fixture(){
 const original=Buffer.from('{ "initialized":true,"resumeIds":["keep"],"containers":[],"future":900719925474099312345 }\n');let state=Buffer.from(original),journal,gate,backup;
 const events=[],plan={version:1,kind:CONTRACT,reconciliationId:'1'.repeat(32),sourceCommit:'2'.repeat(40),epoch:'11111111-2222-4333-8444-555555555555',legacySha256:sha(original),manifestSha256:'3'.repeat(64),coldJournalFile:'/data/harness/root-secrets/synthetic-cold/whole-stop-journal.json',coldJournalSha256:'4'.repeat(64),fsckQualifierSha256:'5'.repeat(64),toolTimeoutMs:30000,raw:{dev:'64',ino:'123',uid:'1001',gid:'1001',mode:String(0o100600),nlink:'1',size:String(3*1024**3),mtimeNs:'100',ctimeNs:'200'}};
 const ops={assertCold:async()=>{events.push('cold');},assertSource:async commit=>{assert.equal(commit,plan.sourceCommit);events.push('source');},readJournal:async()=>clone(journal),readGate:async()=>clone(gate),readState:async()=>Buffer.from(state),stateIdentity:async()=>({dev:'64',ino:'12',uid:'1001',gid:'1001',mode:'33152',nlink:'1',size:String(state.length),mtimeNs:'10',ctimeNs:'11'}),assertRaw:async(r,m)=>{assert.deepEqual(r,plan.raw);assert.equal(m,plan.manifestSha256);events.push('raw');},fsck:async()=>{events.push('fsck');return{code:0,warningFree:true,outputSha256:'6'.repeat(64)};},writeOriginal:async b=>{assert(!backup);backup=Buffer.from(b);events.push('backup');},writeJournal:async v=>{journal=clone(v);events.push('journal:'+v.phase);},writeGate:async v=>{gate=clone(v);events.push('gate:'+v.phase);},publishState:async(b,expected)=>{assert.equal(sha(state),expected);assert.equal(gate.phase,'pending');state=Buffer.from(b);events.push('publish');}};
 return{plan,ops,events,original,get state(){return state;},set state(v){state=Buffer.from(v);},get journal(){return journal;},set journal(v){journal=v;},get gate(){return gate;},set gate(v){gate=v;},get backup(){return backup;}};
}
test('one absent span preserves opaque bytes, nested fields, Unicode and precision',()=>{
 for(const text of ['{\n"initialized": true, "opaque":900719925474099312345,"x":"žluťoučký"}\r\n','{"initialized":false,"workerProcess":{"version":1,"state":"starting","opaque":[1,2]},"after" : 1e123}']){
  const out=absentState(Buffer.from(text)).toString(),replacement='{"version":1,"state":"absent"}';
  assert(out.includes('900719925474099312345')||out.includes('"after" : 1e123'));assert(out.endsWith(text.endsWith('\r\n')?'\r\n':'}'));
  assert.deepEqual(JSON.parse(out).workerProcess,{version:1,state:'absent'});if(text.includes('"workerProcess"'))assert.equal(out,text.replace('{"version":1,"state":"starting","opaque":[1,2]}',replacement));
 }
});
test('malformed, duplicate, nonobject or already absent records cannot be reconciled',()=>{
 for(const text of ['null','[]','{}','{"initialized":true,"initialized":false}','{"initialized":true,"nested":{"x":1,"x":2}}','{"initialized":true,"workerProcess":{"version":1,"state":"absent"}}','{"initialized":true,}'])assert.throws(()=>absentState(Buffer.from(text)),/^Error: VM_RECONCILE_/);
 assert.throws(()=>absentState(Buffer.from([0xff])));const f=fixture();assert.equal(validatePlan(f.plan).raw.ino,'123');for(const change of [p=>p.raw.nlink='2',p=>p.raw.mode=String(0o100666),p=>p.legacySha256=null,p=>p.coldJournalFile='/tmp/receipt.json',p=>p.toolTimeoutMs=60001]){const p=clone(f.plan);change(p);assert.throws(()=>validatePlan(p));}
 assert.throws(()=>absentState(Buffer.from('\ufeff{"initialized":true}')),{code:'VM_RECONCILE_STATE_INVALID'},'BOM may not be silently removed outside the owned span');
 assert.deepEqual(JSON.parse(absentState(Buffer.from('{"initialized":true,"workerProcess":{"version":1,"state":"absent","unconfirmed":true}}'))).workerProcess,{version:1,state:'absent'},'an extra-field receipt is UNKNOWN to the real consumer and still needs the explicit cold workflow');
});
test('actual workflow backs up first and publishes only between durable pending and final complete',async()=>{
 const f=fixture();f.plan.fsckQualifierSha256=sha(fs.readFileSync(path.join(__dirname,'../development/guest-disk-fsck.cjs')));
 const witness=fsck.qualifyReadOnlyFsck({code:0,closed:true,stdout:Buffer.from(['Pass 1: Checking inodes, blocks, and sizes','Pass 2: Checking directory structure','Pass 3: Checking directory connectivity','Pass 4: Checking reference counts','Pass 5: Checking group summary information','synthetic: 67799/196608 files (0.0% non-contiguous), 782328/786432 blocks',''].join('\n')),stderr:Buffer.from('e2fsck 1.47.2 (1-Jan-2025)\n'),tool:{path:'/usr/sbin/e2fsck',sha256:'6'.repeat(64),dev:'1',ino:'2',size:'3',uid:0,gid:0,mode:0o100755,mtimeNs:'4',ctimeNs:'5'}});
 fsck.assertWitness(witness,{blockCount:786432,inodeCount:196608,freeBlocks:4104,freeInodes:128809,clean:true});f.ops.fsck=async(_,qualifierSha)=>{assert.equal(qualifierSha,f.plan.fsckQualifierSha256);f.events.push('fsck');return{code:0,warningFree:witness.warningFree,outputSha256:sha(Buffer.from(JSON.stringify([witness.stdout,witness.stderr]))),witness};};
 const r=await runReconciliation(f.plan,f.ops);assert.equal(r.phase,'complete');assert.equal(r.fsck.witness.contract,'forced-ext4-readonly-v1');assert.deepEqual(f.backup,f.original);assert.equal(f.gate.phase,'complete');
 assert(f.events.indexOf('fsck')<f.events.indexOf('backup'));assert(f.events.indexOf('backup')<f.events.indexOf('gate:pending'));assert(f.events.indexOf('gate:pending')<f.events.indexOf('publish'));assert(f.events.indexOf('publish')<f.events.indexOf('gate:complete'));
 assert.deepEqual(JSON.parse(f.state).resumeIds,['keep']);assert(f.state.includes(Buffer.from('900719925474099312345')));assert.equal(r.publishedSha256,sha(f.state));
});
test('fsck code0 with warning or missing qualified proof does not publish or create audit',async()=>{
 for(const value of [{code:0,outputSha256:'6'.repeat(64)},{code:0,warningFree:false,outputSha256:'6'.repeat(64)},{code:4,warningFree:true,outputSha256:'6'.repeat(64)}]){const f=fixture();f.ops.fsck=async()=>value;await assert.rejects(runReconciliation(f.plan,f.ops),{code:'VM_RECONCILE_FSCK_UNQUALIFIED'});assert(!f.events.includes('publish'));assert.equal(f.backup,undefined);}
});
test('source, cold or raw changes after an await cannot reach publication',async()=>{
 for(const which of ['cold','source','raw']){const f=fixture();let late=false;const fsck=f.ops.fsck;f.ops.fsck=async()=>{const r=await fsck();late=true;return r;};const key={cold:'assertCold',source:'assertSource',raw:'assertRaw'}[which],original=f.ops[key];f.ops[key]=async(...args)=>{if(late)throw Error('changed');return original(...args);};await assert.rejects(runReconciliation(f.plan,f.ops));assert(!f.events.includes('publish'));assert.deepEqual(f.state,f.original);}
});
test('changed legacy bytes after pending are held without replacing unknown fields',async()=>{
 const f=fixture(),write=f.ops.writeGate;f.ops.writeGate=async g=>{await write(g);if(g.phase==='pending')f.state=Buffer.from('{"initialized":true,"foreign":"preserve"}');};await assert.rejects(runReconciliation(f.plan,f.ops),{code:'VM_RECONCILE_RECOVERY_REQUIRED'});assert.equal(f.gate.phase,'recovery_required');assert(!f.events.includes('publish'));assert(JSON.parse(f.state).foreign);
});
test('uncertain state rename/readback or final publication leaves durable denial and no replay',async()=>{
 for(const where of ['publishState','writeJournal','writeGate']){const f=fixture(),original=f.ops[where];let once=false;f.ops[where]=async(...args)=>{await original(...args);if(!once&&(where==='publishState'||args[0].phase==='complete')){once=true;throw Error('ambiguous');}};await assert.rejects(runReconciliation(f.plan,f.ops),{code:'VM_RECONCILE_RECOVERY_REQUIRED'});assert.equal(f.gate.phase,'recovery_required');const publishes=f.events.filter(x=>x==='publish').length;await assert.rejects(runReconciliation(f.plan,f.ops),{code:'VM_RECONCILE_UNFINISHED'});assert.equal(f.events.filter(x=>x==='publish').length,publishes);}
});
test('unfinished journals never replay; complete observations never restore an old absence',async()=>{
 const f=fixture();await runReconciliation(f.plan,f.ops);f.state=Buffer.from('{"initialized":true,"workerProcess":{"version":1,"state":"starting"}}');const before=f.events.length,r=await runReconciliation(f.plan,f.ops);assert.equal(r.observedOnly,true);assert.equal(r.currentAbsenceProven,false);assert(!f.events.slice(before).includes('publish'));assert.equal(JSON.parse(f.state).workerProcess.state,'starting');f.gate={...f.gate,phase:'pending'};await assert.rejects(runReconciliation(f.plan,f.ops),{code:'VM_RECONCILE_UNFINISHED'});assert.equal(f.events.filter(x=>x==='publish').length,1,'crash after complete journal but before complete gate does not replay');
});
test('pending gate denies v1 absence but a complete gate never authorizes legacy/starting state',async()=>{
 const denied=controller({savedState:{initialized:true,workerProcess:{version:1,state:'absent'}},reconciliationPending:true});assert.equal(denied.worker.phase,'quarantined');await assert.rejects(denied.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.deepEqual(denied.events,[]);
 for(const savedState of [{initialized:true},{initialized:true,workerProcess:{version:1,state:'starting'}}]){const f=controller({savedState,reconciliationPending:false});assert.equal(f.worker.phase,'quarantined');await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.deepEqual(f.events,[]);}
});
test('pending gate does not hide a retained actual child; close cannot bypass a pending gate',async()=>{
 let pending=false;const f=controller({reconciliationPending:()=>pending});await f.worker.start();pending=true;assert.equal(f.worker.pid(),731);f.setRecord(null);f.exit();f.close();assert.equal(f.worker.pid(),null);await assert.rejects(f.worker.start(),{code:'APPS_VM_RECONCILIATION_REQUIRED'});assert.equal(f.events.filter(x=>x==='spawn').length,1);
});
test('root gate parser refuses pending/corrupt/unsafe metadata and accepts complete as non-authority only',()=>{
 const complete={version:1,contract:CONTRACT,phase:'complete',reconciliationId:'1'.repeat(32),planSha256:'2'.repeat(64),originalSha256:'3'.repeat(64),publishedSha256:'4'.repeat(64)};
 function read(g,{uid=0,symlink=false,readError=false}={}){const data=Buffer.from(JSON.stringify(g)),stat={uid,gid:0,mode:0o100644,nlink:1,size:data.length,dev:1,ino:2,mtimeMs:1,ctimeMs:1,isFile:()=>true,isSymbolicLink:()=>symlink};const io={lstatSync:p=>p.endsWith('.json')?stat:{uid:0,mode:0o40755,isDirectory:()=>true,isSymbolicLink:()=>false},realpathSync:p=>p,openSync:()=>10,fstatSync:()=>stat,readSync:(fd,b,o,n,pos)=>{if(readError)throw Error('denied');const k=Math.min(n,Math.max(0,data.length-pos));data.copy(b,o,pos,pos+k);return k;},closeSync(){}};return gatePending('/data/harness/docker-worker',io);}
 assert.equal(read(complete),false);for(const g of [{...complete,phase:'pending'},{...complete,phase:'recovery_required'},{...complete,planSha256:null},null])assert.equal(read(g),true);for(const opts of [{uid:1001},{symlink:true},{readError:true}])assert.equal(read(complete,opts),true);
});
