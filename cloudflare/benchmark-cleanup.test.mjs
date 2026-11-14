import test from 'node:test';import assert from 'node:assert/strict';import {cleanupBenchmark} from './benchmark-cleanup.mjs';
test('benchmark expiry never selects production or acts without fixed valid settings',async()=>{
 const original=globalThis.fetch;let calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({success:true});};
 const base={INSTANCE_ID:'42',VAST_API_KEY:'test-only',BENCH_INSTANCE_ID:'99',BENCH_EXPIRES_AT:'2026-11-14T01:00:00Z'},now=Date.parse('2026-11-14T02:00:00Z');
 try{
  for(const env of [{}, {...base,BENCH_INSTANCE_ID:'42'},{...base,BENCH_INSTANCE_ID:'0042'},{...base,INSTANCE_ID:''},{...base,BENCH_EXPIRES_AT:'invalid'},{...base,BENCH_INSTANCE_ID:'99/path'}])assert.deepEqual(await cleanupBenchmark(env,now),{action:'none'});
  assert.deepEqual(await cleanupBenchmark(base,Date.parse('2026-11-14T00:59:59Z')),{action:'none'});assert.equal(calls.length,0);
  assert.deepEqual(await cleanupBenchmark(base,now),{action:'removed',instanceId:'99'});assert.equal(calls[0].url,'https://console.vast.ai/api/v0/instances/99/');assert.equal(calls[0].options.method,'DELETE');
  globalThis.fetch=async()=>new Response('',{status:404});assert.equal((await cleanupBenchmark(base,now)).action,'already-removed');
  globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(cleanupBenchmark(base,now),/503/);
  globalThis.fetch=async()=>Response.json({success:false});await assert.rejects(cleanupBenchmark(base,now),/not confirmed/);
 }finally{globalThis.fetch=original;}
});
