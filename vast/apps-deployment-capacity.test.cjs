'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{budget,admit,verifyCapacity}=require('./apps-deployment-capacity.cjs'),MIB=1024**2;
const spec={images:[{Id:'sha256:'+'a'.repeat(64),Size:160*MIB,InodeCount:10000}],candidateMemoryMiB:512,existingMemoryMiB:512,sourceBytes:8*MIB,sourceFiles:100,dataBytes:16*MIB};
test('VFS admission reserves independent test copies, three data copies and simultaneous old/new memory',()=>{
 const b=budget(spec);assert.equal(b.guestBytes,1040*MIB);assert.equal(b.memoryBytes,1792*MIB);assert.equal(b.hostBytes,3120*MIB);assert.equal(b.candidateAndIndependentTests,true);
 assert.equal(admit(b,{guestBytes:b.guestBytes,hostBytes:b.hostBytes,guestInodes:b.guestInodes,hostInodes:b.hostInodes,memoryBytes:b.memoryBytes}).admitted,true);
 const shared=budget({...spec,images:[spec.images[0],spec.images[0]],containerCount:2});assert.equal(shared.imageBytes,320*MIB);assert(shared.guestInodes>b.guestInodes);assert.equal(shared.guestBytes-b.guestBytes,480*MIB);
});
test('missing measurements or any single byte/inode/memory deficit refuses admission',()=>{
 assert.throws(()=>admit({},{}),{code:'DEPLOYMENT_CAPACITY_UNKNOWN'});
 const b=budget(spec),enough={guestBytes:b.guestBytes,hostBytes:b.hostBytes,guestInodes:b.guestInodes,hostInodes:b.hostInodes,memoryBytes:b.memoryBytes};
 for(const key of Object.keys(enough)){assert.throws(()=>admit(b,{...enough,[key]:undefined}),{code:'DEPLOYMENT_CAPACITY_UNKNOWN'});assert.throws(()=>admit(b,{...enough,[key]:enough[key]-1}),error=>error.code==='DEPLOYMENT_CAPACITY_INSUFFICIENT'&&error.details[key].missing===1);}
 assert.throws(()=>budget({...spec,images:[{Id:spec.images[0].Id}]}),{code:'DEPLOYMENT_CAPACITY_UNKNOWN'});
});
test('an unowned operation or unverified daemon cannot measure, wake or prune its way around admission',async()=>{
 let touched=0;const manager={busy:'another',cfg:{},worker:{status(){touched++;return{};}}};await assert.rejects(verifyCapacity(manager,{id:'job'},spec),{code:'DEPLOYMENT_OPERATION_NOT_OWNED'});assert.equal(touched,0);manager.busy='job';await assert.rejects(verifyCapacity(manager,{id:'job'},spec),{code:'DEPLOYMENT_CAPACITY_UNKNOWN'});assert.equal(touched,1);
});
