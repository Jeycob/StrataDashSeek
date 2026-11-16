'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {qemuArgs,guestScript,fixtureRoot,checkedCleanup}=require('./project-share-probe.cjs');
const boot=['-name','fixture','-m','384','-smp','1','-nic','none','-kernel','/proc/self/fd/3','-initrd','/proc/self/fd/4','-drive','file=/proc/self/fd/5,media=cdrom,readonly=on,format=raw'];
test('share plan only adds a fixed synthetic directory descriptor to the bounded no-network boot',()=>{
 const args=qemuArgs(boot,'a'.repeat(16));assert.deepEqual(args.slice(0,boot.length),boot);assert.equal(args.filter(a=>a==='-fsdev').length,1);assert.equal(args[args.indexOf('-fsdev')+1],'local,id=project-probe,path=/proc/self/fd/6,security_model=none,multidevs=forbid,writeout=immediate');
 assert.throws(()=>qemuArgs([...boot,'-fsdev','path=/data/harness'],'a'.repeat(16)),/UNEXPECTED_ACCESS/);
 assert.throws(()=>qemuArgs(boot.map(x=>x==='none'?'user':x),'a'.repeat(16)),/NOT_DISPOSABLE/);
 assert.throws(()=>qemuArgs(boot,'a'.repeat(16),'passthrough'),/SECURITY_MODEL/);
 assert.throws(()=>qemuArgs(boot,'a'.repeat(16),'none,readonly=off'),/SECURITY_MODEL/);
});
test('untrusted identifiers and cleanup paths cannot become shell code or delete existing trees',()=>{
 for(const nonce of ['..','a'.repeat(15),'a'.repeat(16)+';id','$(id)'])assert.throws(()=>guestScript(nonce),/NONCE/);
 assert.equal(fixtureRoot('b'.repeat(16)),'/dev/shm/homeai-project-share-probe-'+ 'b'.repeat(16));
 for(const target of ['/','/dev/shm','/data/harness/workspaces/projects','/dev/shm/homeai-project-share-probe-'+ 'b'.repeat(16)+'/..'])assert.throws(()=>checkedCleanup(target),/UNSAFE_CLEANUP_PATH/);
});
test('guest plan distinguishes host escape prevention, trusted sibling access and watcher evidence',()=>{
 const script=guestScript('c'.repeat(16));assert.match(script,/cache=none/);assert.match(script,/SHARE_TRUSTED_GUEST_SEES_BOTH_PROJECTS=expected/);assert.match(script,/escape-absolute/);assert.match(script,/escape-relative/);assert.match(script,/SHARE_HOST_INOTIFY=not_observed/);assert.match(script,/SHARE_BIND_CHILD_SCOPE=passed/);
 assert.doesNotMatch(script,/apk add|dockerd|mkfs|\/dev\/vda|curl|wget|killall|mount -a/);
});
