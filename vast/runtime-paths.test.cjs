'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const{paths,publicValue}=require('./runtime-paths.cjs');
test('public telemetry contains metrics without launch credentials or log payloads',()=>{
 const secret='SYNTHETIC_LOGIN_CANARY',out=publicValue('telemetry.json',{at:1,harnessLog:secret,token:secret,model:{id:'https://fixture.invalid/?token='+secret,loaded:true,promptTokens:12,clientSecret:secret},requests:[{id:'request-1',outputTokens:2,authorization:'Bearer '+secret}]});
 assert.equal(out.model.promptTokens,12);assert.equal(out.requests[0].outputTokens,2);assert.equal(out.harnessLog,undefined);assert.ok(!JSON.stringify(out).includes(secret));
 assert.throws(()=>publicValue('harness.log',{text:secret}),/Unsupported/);
});
test('root control, public status and agent state have distinct paths and whitelisted update fields',()=>{
 const p=paths('/data/harness');assert.notEqual(p.agentState,p.publicState);assert.ok(p.privateState.startsWith(path.join(p.root,'root-secrets')+path.sep));assert.equal(p.serviceLogs,path.join(p.root,'logs'));
 assert.deepEqual(publicValue('startup-update.json',{phase:'ready',signatureVerified:true,privateKey:'hidden',cookie:'hidden'}),{phase:'ready',signatureVerified:true});
});

test('public storage preserves unknown and stale measurements but removes nested credentials',()=>{
 const out=publicValue('telemetry.json',{storage:{version:1,stale:true,volumes:[{id:'docker-guest',scope:'docker-guest',availableBytes:null,inodesFree:null,stale:true,authorization:'Bearer SYNTHETIC_PRIVATE',categories:[{id:'images',bytes:400,shared:true}],secretPath:'SYNTHETIC_PRIVATE'}]}});
 assert.equal(out.storage.volumes[0].availableBytes,null);assert.equal(out.storage.volumes[0].stale,true);
 assert.deepEqual(out.storage.volumes[0].categories,[{id:'images',bytes:400,shared:true}]);assert.ok(!JSON.stringify(out).includes('SYNTHETIC_PRIVATE'));
});
