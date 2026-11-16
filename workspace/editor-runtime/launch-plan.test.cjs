'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{launchPlan}=require('./launch-plan.cjs');
const id='a'.repeat(32),input={id,imageDigest:'sha256:'+ 'b'.repeat(64),guestPort:29000,projectRoot:'/srv/homeai/projects/'+id,editorHome:'/srv/homeai/editor-state/'+id,uid:1001,gid:1001,verified:Object.fromEntries(['canonicalPaths','dedicatedProject','uidMapping','guestFirewall','internalNetwork','cgroupSwap','capacity'].map(k=>[k,true]))};
test('proposal admits only pinned dedicated project mounts after explicit backend proof',()=>{
 const plan=launchPlan(input),argv=plan.argv;assert.equal(plan.binary,'/usr/bin/docker');assert.equal(argv.filter(a=>a==='--mount').length,2);assert(argv.includes('--read-only'));assert(argv.includes('--cap-drop=ALL'));assert(argv.includes('--memory-swap=1g'));assert(!argv.some(a=>/docker\.sock|--privileged|network=host|pid=host|\/data\/harness/.test(a)));
 for(const field of Object.keys(input.verified))assert.throws(()=>launchPlan({...input,verified:{...input.verified,[field]:false}}),/UNVERIFIED_/);
 assert.throws(()=>launchPlan({...input,imageDigest:'editor:latest'}),/IMMUTABLE_IMAGE/);assert.throws(()=>launchPlan({...input,projectRoot:'/srv/homeai/projects/'+id+'/../other'}),/CANONICAL/);
 assert.throws(()=>launchPlan({...input,uid:0}),/NONROOT_ID/);
});
