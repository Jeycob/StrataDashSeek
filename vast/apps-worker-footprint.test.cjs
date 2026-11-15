'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{imageFootprint,scanScript}=require('./apps-worker-footprint.cjs');
const image={Id:'sha256:'+'a'.repeat(64),Size:1};
test('footprint requires an immutable VFS image in the verified managed guest and bounds its diagnostic',async()=>{
 let writes=0;const worker={status:()=>({phase:'ready',controlIsolation:{verified:true}}),serial:{destroyed:false,write(command){writes++;assert.match(command,/timeout -s KILL 12 sh/);const encoded=command.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1],script=Buffer.from(encoded,'base64').toString(),nonce=script.match(/HARNESS_FOOTPRINT_([a-f0-9]{16})=/)[1];assert(script.includes('/var/lib/harness/docker/vfs/dir/managed-layer'));worker.buffer='HARNESS_FOOTPRINT_'+nonce+'=123,456\nHARNESS_FOOTPRINT_DONE_'+nonce+'=0\n';}},buffer:''};
 const manager={worker,engine:{json:async()=>({...image,GraphDriver:{Name:'vfs',Data:{SourceDir:'/var/lib/harness/docker/vfs/dir/managed-layer'}}})}};
 const measured=await imageFootprint(manager,image);assert.equal(measured.Size,123*1024);assert.equal(measured.InodeCount,456);assert.equal(writes,1);
 for(const dir of ['/etc','/var/lib/harness/docker/vfs/dir/../../root','/var/lib/harness/docker/vfs/dir/a;false']){manager.engine.json=async()=>({...image,GraphDriver:{Name:'vfs',Data:{SourceDir:dir}}});await assert.rejects(imageFootprint(manager,image),{code:'DEPLOYMENT_IMAGE_FOOTPRINT_UNKNOWN'});}
 assert.equal(writes,1);assert.throws(()=>scanScript('/tmp/a;id','a'.repeat(16)),{code:'DEPLOYMENT_IMAGE_FOOTPRINT_UNKNOWN'});
});
