'use strict';
// Explicit source API, no startup hook, model tool, environment switch or CLI.
const path=require('node:path'),{validatePlan,canonical,sha256}=require('./guest-disk-grow.cjs');
const CONTRACT='owned-overlay-copyup-grow-v1',GiB=1024**3,fail=code=>Object.assign(Error(code),{code});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
function validateOwnedPlan(p){
 if(!exact(p,['version','kind','growth','cold','operationTimeoutMs'])||p.version!==1||p.kind!==CONTRACT||!Number.isSafeInteger(p.operationTimeoutMs)||p.operationTimeoutMs<1000||p.operationTimeoutMs>600000)throw fail('COPYUP_PLAN_INVALID');
 const g=validatePlan(p.growth),c=p.cold,keys=['sourceCommit','epoch','manifestSha256','coldJournalFile','coldJournalSha256','fsckQualifierSha256','toolTimeoutMs','raw'];
 if(!exact(c,keys)||!hex(c.sourceCommit,40)||c.sourceCommit!==g.coldFence.sourceCommit||c.epoch!==g.coldFence.epoch||c.manifestSha256!==g.source.manifestSha256||!hex(c.coldJournalSha256,64)||!hex(c.fsckQualifierSha256,64)||c.toolTimeoutMs!==g.toolTimeoutMs)throw fail('COPYUP_COLD_PLAN_INVALID');
 if(typeof c.coldJournalFile!=='string'||c.coldJournalFile.length>4096||!/^\/data\/harness\/root-secrets\/[A-Za-z0-9_./-]+\/whole-stop-journal\.json$/.test(c.coldJournalFile)||path.posix.normalize(c.coldJournalFile)!==c.coldJournalFile)throw fail('COPYUP_COLD_PLAN_INVALID');
 const fields=['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'];
 if(!exact(c.raw,fields)||!Object.values(c.raw).every(v=>typeof v==='string'&&/^\d{1,20}$/.test(v))||c.raw.nlink!=='1'||(BigInt(c.raw.mode)&0o170022n)!==0o100000n)throw fail('COPYUP_COLD_PLAN_INVALID');
 for(const [a,b]of [['dev','dev'],['ino','ino'],['uid','uid'],['gid','gid'],['size','bytes']])if(c.raw[a]!==String(g.source[b]))throw fail('COPYUP_COLD_PLAN_INVALID');
 if(g.installationRoot!=='/data/harness'||g.serviceUid!==1001||g.serviceGid!==1001||g.capacity.copyUpBytes<g.source.bytes)throw fail('COPYUP_PLAN_INVALID');
 return JSON.parse(canonical(p));
}
function assessOwnedCapacity(plan,host,materialized){
 const g=validatePlan(plan),c=g.capacity,delta=g.targetBytes-g.source.bytes;
 if(!host||host.backing!=='overlay'||!Number.isSafeInteger(host.availableBytes)||host.availableBytes<0||!Number.isSafeInteger(host.availableInodes)||host.availableInodes<32||c.copyUpBytes<g.source.bytes)throw fail('GROW_HOST_CAPACITY_UNKNOWN');
 const requiredHostBytes=c.reserveBytes+c.workBytes+(materialized?delta+c.additionalHostBytes:c.copyUpBytes);
 if(!Number.isSafeInteger(requiredHostBytes)||host.availableBytes<requiredHostBytes)throw fail('GROW_HOST_CAPACITY');
 const projectedGuestFreeBytes=g.source.fs.freeBlocks*g.source.fs.blockSize+delta-c.metadataGrowthBytes;
 if(projectedGuestFreeBytes<c.guestReserveBytes+c.guestNewBytes||g.source.fs.freeInodes<c.guestReserveInodes+c.guestNewInodes)throw fail('GROW_GUEST_CAPACITY');
 return{deltaBytes:delta,requiredHostBytes,projectedGuestFreeBytes,phase:materialized?'after_owned_copyup_unshare':'before_owned_copyup'};
}
// Selecting this entry does not assert completion: the owned worker must prove
// it. No persisted receipt can be passed here as a live descriptor capability.
async function growOfflineOwned(input){return require('./guest-disk-owned-worker.cjs').launchOwnedWorker(input);}
module.exports={CONTRACT,validateOwnedPlan,assessOwnedCapacity,growOfflineOwned,sha256};
