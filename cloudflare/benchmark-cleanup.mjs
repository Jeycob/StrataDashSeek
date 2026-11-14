// Optional, fixed-ID expiry for an explicitly approved disposable benchmark.
// Never select the production instance or accept a target from an HTTP request.
export async function cleanupBenchmark(env, now=Date.now()) {
 const id=String(env.BENCH_INSTANCE_ID||''),production=String(env.INSTANCE_ID||'');
 const expires=Date.parse(env.BENCH_EXPIRES_AT||'');
 if(!/^[1-9]\d*$/.test(id)||!/^[1-9]\d*$/.test(production)||Number(id)===Number(production)||!Number.isFinite(expires)||now<expires)return {action:'none'};
 if(!env.VAST_API_KEY)throw Error('Missing Vast credential');
 const response=await fetch('https://console.vast.ai/api/v0/instances/'+id+'/',{
  method:'DELETE',headers:{Authorization:'Bearer '+env.VAST_API_KEY},signal:AbortSignal.timeout(12000)
 });
 if(!response.ok&&response.status!==404)throw Error('Benchmark cleanup failed: '+response.status);
 if(response.status!==404&&(await response.json()).success!==true)throw Error('Benchmark cleanup was not confirmed');
 return {action:response.status===404?'already-removed':'removed',instanceId:id};
}
