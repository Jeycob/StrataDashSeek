'use strict';
const fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process'),util=require('node:util');
const exec=util.promisify(cp.execFile),R='/data/harness',stateFile=R+'/state/telemetry.json';
const {performance}=require('node:perf_hooks');
const startedAt=Date.now();let previousCpu,previousDisk,previousAt=performance.now(),energyWh=0,history=[];
function wattSecondsToWh(watts,seconds){return Number.isFinite(watts)&&watts>=0&&Number.isFinite(seconds)&&seconds>=0?watts*seconds/3600:0;}
function number(v){const n=Number.parseFloat(v);return Number.isFinite(n)?n:null;}
function memory(){const m={};for(const line of fs.readFileSync('/proc/meminfo','utf8').split('\n')){const match=line.match(/^(\w+):\s+(\d+)/);if(match)m[match[1]]=Number(match[2])*1024;}const result={total:m.MemTotal,used:m.MemTotal-m.MemAvailable,available:m.MemAvailable};try{const limit=number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8'));if(limit&&limit<result.total){result.total=limit;result.used=Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8'));result.available=Math.max(0,result.total-result.used);}}catch{}return result;}
function cpu(){const cpus=os.cpus();let idle=0,total=0;for(const c of cpus){idle+=c.times.idle;total+=Object.values(c.times).reduce((a,b)=>a+b,0);}const usage=previousCpu?100*(1-(idle-previousCpu.idle)/(total-previousCpu.total)):null;previousCpu={idle,total};return {name:cpus[0]?.model,threads:cpus.length,percent:Number.isFinite(usage)?usage:null};}
function disk(seconds){let read=0,write=0;for(const line of fs.readFileSync('/proc/diskstats','utf8').trim().split('\n')){const p=line.trim().split(/\s+/);if(!/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+)$/.test(p[2]))continue;read+=Number(p[5])*512;write+=Number(p[9])*512;}const speed=previousDisk?{readBytesPerSecond:Math.max(0,(read-previousDisk.read)/seconds),writeBytesPerSecond:Math.max(0,(write-previousDisk.write)/seconds)}:{readBytesPerSecond:null,writeBytesPerSecond:null};previousDisk={read,write};return speed;}
async function get(route){try{const r=await fetch('http://127.0.0.1:8080/'+route,{signal:AbortSignal.timeout(1800)});return r.ok?await r.json():null;}catch{return null;}}
async function tick(){
 const now=Date.now(),monotonic=performance.now(),seconds=Math.max(.001,(monotonic-previousAt)/1000);previousAt=monotonic;let gpu=null;
 try{const {stdout}=await exec('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.gr,pcie.link.gen.current,pcie.link.width.current','--format=csv,noheader,nounits'],{timeout:2200});const p=stdout.trim().split('\n')[0].split(',').map(s=>s.trim());gpu={name:p[0],percent:number(p[1]),vramUsedMiB:number(p[2]),vramTotalMiB:number(p[3]),temperatureC:number(p[4]),powerW:number(p[5]),powerLimitW:number(p[6]),fanPercent:number(p[7]),clockMHz:number(p[8]),pcieGeneration:number(p[9]),pcieWidth:number(p[10])};if(gpu.powerW!==null)energyWh+=wattSecondsToWh(gpu.powerW,seconds);}catch{}
 const [health,status,metrics]=await Promise.all([get('health'),get('status'),get('metrics')]);
 const requests=normalizeRequests(metrics);
 const last=requests.at(-1)||null,sample={at:now,gpuPercent:gpu?.percent,vramMiB:gpu?.vramUsedMiB};history.push(sample);history=history.slice(-60);
 let idle=null;try{idle=JSON.parse(fs.readFileSync(R+'/state/idle-status.json','utf8'));}catch{}
 const data={at:now,source:'Vast instance',gpu,cpu:cpu(),ram:memory(),disk:disk(seconds),model:{id:health?.model,loaded:health?.loaded,contextMax:health?.max_context,busy:status?.busy,queued:status?.queued,phase:status?.phase,promptTokens:status?.prompt_tokens,generatedTokens:status?.generated},last,requests,history,liveTokensPerSecond:metrics?.live?.tok_s_mean??metrics?.live?.tok_s??null,energyWhSinceMonitorStart:energyWh,monitorStartedAt:startedAt,idle};
 const temporary=stateFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(data),{mode:0o644});fs.renameSync(temporary,stateFile);
 setTimeout(tick,3000);
}
function normalizeRequests(metrics){return (Array.isArray(metrics?.requests)?metrics.requests:[]).slice(0,12).sort((a,b)=>(a.time||0)-(b.time||0)).map(r=>({id:r.id,time:r.time,status:r.finish??r.status,promptTokens:r.prompt_tokens,outputTokens:r.output_tokens,cachedTokens:r.reused??r.cached_tokens??r.reused_tokens,decodeTokensPerSecond:r.decode_tok_s,prefillTokensPerSecond:r.prompt_tok_s??(r.prompt_ms>0?(r.prompt_read??r.prompt_tokens)/(r.prompt_ms/1000):null),durationSeconds:r.duration_s??(r.total_ms?r.total_ms/1000:null)}));}
module.exports={normalizeRequests,wattSecondsToWh};
 if(require.main===module)tick().catch(e=>{console.error(e.message);process.exitCode=1;});
