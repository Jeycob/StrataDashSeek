'use strict';
// Explicit cold operator workflow only. Importing this file performs no I/O.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const CONTRACT='apps-vm-cold-reconcile-v1',MAX=1024*1024;
const fail=code=>Object.assign(Error(code),{code});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const copy=v=>JSON.parse(JSON.stringify(v));
function validatePlan(p){
 const planKeys=['version','kind','reconciliationId','sourceCommit','epoch','legacySha256','manifestSha256','coldJournalFile','coldJournalSha256','fsckQualifierSha256','toolTimeoutMs','raw'];
 if(!p||Object.keys(p).length!==planKeys.length||!planKeys.every(k=>Object.hasOwn(p,k))||p.version!==1||p.kind!==CONTRACT||!hex(p.reconciliationId,32)||!hex(p.sourceCommit,40)||!hex(p.legacySha256,64)||!hex(p.manifestSha256,64)||!hex(p.coldJournalSha256,64)||!hex(p.fsckQualifierSha256,64))throw fail('VM_RECONCILE_PLAN_INVALID');
 if(typeof p.coldJournalFile!=='string'||p.coldJournalFile.length>4096||!/^\/[A-Za-z0-9_./-]+$/.test(p.coldJournalFile)||!p.coldJournalFile.startsWith('/data/harness/root-secrets/')||p.coldJournalFile.includes('/../')||path.posix.normalize(p.coldJournalFile)!==p.coldJournalFile||!p.coldJournalFile.endsWith('/whole-stop-journal.json'))throw fail('VM_RECONCILE_PLAN_INVALID');
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.epoch||''))throw fail('VM_RECONCILE_PLAN_INVALID');
 const keys=['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'];
 if(!p.raw||Object.keys(p.raw).sort().join(',')!==keys.sort().join(',')||!Object.values(p.raw).every(v=>typeof v==='string'&&/^\d{1,20}$/.test(v))||p.raw.uid!=='1001'||p.raw.gid!=='1001'||p.raw.nlink!=='1'||BigInt(p.raw.size)<3n*1024n**3n||BigInt(p.raw.mode)>0o177777n||(BigInt(p.raw.mode)&0o170022n)!==0o100000n)throw fail('VM_RECONCILE_PLAN_INVALID');
 if(!Number.isSafeInteger(p.toolTimeoutMs)||p.toolTimeoutMs<1000||p.toolTimeoutMs>60000)throw fail('VM_RECONCILE_PLAN_INVALID');
 return copy(p);
}
// Keep every original byte outside this single value/addition, including opaque
// numbers and future fields. Reject ambiguous duplicate keys before any write.
function absentState(input){
 const b=Buffer.from(input);if(!b.length||b.length>MAX||b.length>=3&&b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf)throw fail('VM_RECONCILE_STATE_INVALID');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{throw fail('VM_RECONCILE_STATE_INVALID');}
 let i=0,nodes=0,span,end,top;
 const ws=()=>{while(/[\x20\t\r\n]/.test(text[i]||'!'))i++;};
 const string=()=>{const at=i++;while(i<text.length){const ch=text[i++];if(ch==='"'){try{return JSON.parse(text.slice(at,i));}catch{break;}}if(ch==='\\')i++;else if(ch<' ')break;}throw fail('VM_RECONCILE_STATE_INVALID');};
 function value(depth=0){
  if(++nodes>100000||depth>64)throw fail('VM_RECONCILE_STATE_INVALID');ws();const at=i,ch=text[i];
  if(ch==='"')string();
  else if(ch==='{'||ch==='['){const object=ch==='{',close=object?'}':']',seen=new Set();i++;ws();if(text[i]!==close)for(;;){let key;if(object){if(text[i]!=='"')throw fail('VM_RECONCILE_STATE_INVALID');key=string();if(seen.has(key))throw fail('VM_RECONCILE_STATE_INVALID');seen.add(key);ws();if(text[i++]!==':')throw fail('VM_RECONCILE_STATE_INVALID');ws();}const start=i;value(depth+1);if(depth===0&&object&&key==='workerProcess')span=[start,i];ws();if(text[i]===close)break;if(text[i++]!==',')throw fail('VM_RECONCILE_STATE_INVALID');ws();}if(text[i++]!==close)throw fail('VM_RECONCILE_STATE_INVALID');if(depth===0){end=i-1;top=object;}}
  else{const match=text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);if(!match)throw fail('VM_RECONCILE_STATE_INVALID');i+=match[0].length;}
  if(i===at)throw fail('VM_RECONCILE_STATE_INVALID');
 }
 value();ws();if(i!==text.length||!top)throw fail('VM_RECONCILE_STATE_INVALID');let parsed;try{parsed=JSON.parse(text);}catch{throw fail('VM_RECONCILE_STATE_INVALID');}
 if(typeof parsed.initialized!=='boolean'||parsed.workerProcess?.version===1&&parsed.workerProcess.state==='absent'&&Object.keys(parsed.workerProcess).length===2)throw fail('VM_RECONCILE_NOT_LEGACY');
 const receipt='{"version":1,"state":"absent"}',out=span?text.slice(0,span[0])+receipt+text.slice(span[1]):text.slice(0,end)+(Object.keys(parsed).length?',':'')+'"workerProcess":'+receipt+text.slice(end);
 return Buffer.from(out);
}
function gatePending(workerRoot,filesystem=fs){
 // A gate can only DENY ordinary startup. Even a complete gate cannot turn a
 // legacy/starting state or a PID into absence, or hide a retained OWNED child.
 const file=path.join(path.dirname(workerRoot),'runtime-status/apps-vm-reconciliation.json');let fd;
 try{
  let at=path.parse(file).root;for(const part of path.dirname(file).slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,part);const s=filesystem.lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.mode&0o022||filesystem.realpathSync(at)!==at)return true;}
  const s=filesystem.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||s.mode&0o022||s.size<1||s.size>16384)return true;
  fd=filesystem.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const b=Buffer.alloc(s.size+1);let n=0;while(n<b.length){const k=filesystem.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}
  const stable=x=>['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>s[k]===x[k]);if(n!==s.size||!stable(filesystem.fstatSync(fd))||!stable(filesystem.lstatSync(file)))return true;
  const g=JSON.parse(b.subarray(0,n));return g.version!==1||g.contract!==CONTRACT||g.phase!=='complete'||!hex(g.reconciliationId,32)||!hex(g.planSha256,64)||!hex(g.originalSha256,64)||!hex(g.publishedSha256,64);
 }catch(e){return e.code!=='ENOENT';}finally{if(fd!==undefined)try{filesystem.closeSync(fd);}catch{return true;}}
}
async function runReconciliation(input,ops){
 const plan=validatePlan(input),planSha256=sha(Buffer.from(JSON.stringify(plan)));let journal,started=false;
 const guard=async()=>{await ops.assertCold();await ops.assertSource(plan.sourceCommit);};
 await guard();const old=await ops.readJournal(),previousGate=await ops.readGate();
 if(previousGate&&(previousGate.contract!==CONTRACT||previousGate.phase!=='complete'))throw fail('VM_RECONCILE_UNFINISHED');
 if(old){if(old.phase!=='complete'||old.planSha256!==planSha256||previousGate?.planSha256!==planSha256||previousGate?.publishedSha256!==old.publishedSha256)throw fail('VM_RECONCILE_UNFINISHED');return{...old,observedOnly:true,currentAbsenceProven:false};}
 const original=Buffer.from(await ops.readState()),originalMetadata=await ops.stateIdentity();if(sha(original)!==plan.legacySha256)throw fail('VM_RECONCILE_STATE_CHANGED');const published=absentState(original),publishedSha256=sha(published);
 await ops.assertRaw(plan.raw,plan.manifestSha256);await guard();
 // No caller's boolean/receipt qualifies fsck. Production ops owns the actual
 // read-only tool and the pinned warning-free parser before minting this proof.
 const check=await ops.fsck(plan.toolTimeoutMs,plan.fsckQualifierSha256);
 if(!check||check.code!==0||check.warningFree!==true||!hex(check.outputSha256,64))throw fail('VM_RECONCILE_FSCK_UNQUALIFIED');
 await guard();await ops.assertRaw(plan.raw,plan.manifestSha256);if(sha(await ops.readState())!==plan.legacySha256||JSON.stringify(originalMetadata)!==JSON.stringify(await ops.stateIdentity()))throw fail('VM_RECONCILE_STATE_CHANGED');
 journal={version:1,contract:CONTRACT,reconciliationId:plan.reconciliationId,planSha256,plan:copy(plan),originalSha256:plan.legacySha256,originalMetadata,publishedSha256,sourceCommit:plan.sourceCommit,epoch:plan.epoch,phase:'prepared',fsck:check};
 try{
  await ops.writeOriginal(original);await ops.writeJournal(journal);
  started=true;await ops.writeGate({...journal,phase:'pending'});await guard();
  if(sha(await ops.readState())!==plan.legacySha256||JSON.stringify(originalMetadata)!==JSON.stringify(await ops.stateIdentity()))throw fail('VM_RECONCILE_STATE_CHANGED');await ops.assertRaw(plan.raw,plan.manifestSha256);
  journal={...journal,phase:'publication_intent'};await ops.writeJournal(journal);await guard();
  await ops.publishState(published,plan.legacySha256);await guard();await ops.assertRaw(plan.raw,plan.manifestSha256);
  if(sha(await ops.readState())!==publishedSha256)throw fail('VM_RECONCILE_PUBLICATION_UNKNOWN');
  journal={...journal,phase:'complete'};await ops.writeJournal(journal);await guard();
  await ops.writeGate(journal);return journal;
 }catch(error){if(started){try{await ops.writeGate({...journal,phase:'recovery_required'});}catch{}try{await ops.writeJournal({...journal,phase:'recovery_required',errorCode:/^[A-Z0-9_]{1,96}$/.test(error.code||'')?error.code:'VM_RECONCILE_UNCONFIRMED'});}catch{}}throw fail('VM_RECONCILE_RECOVERY_REQUIRED');}
 finally{original.fill(0);published.fill(0);}
}
module.exports={CONTRACT,MAX,sha,validatePlan,absentState,gatePending,runReconciliation};
