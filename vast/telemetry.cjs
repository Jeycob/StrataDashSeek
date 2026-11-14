'use strict';
const fs=require('node:fs'),os=require('node:os'),cp=require('node:child_process'),util=require('node:util');
const exec=util.promisify(cp.execFile),R='/data/harness',stateFile=R+'/state/telemetry.json';
const {readCpuStats,readMemoryStats,readIoStats,parseIoStat}=require('./cgroup.cjs'),readCgroup=p=>fs.readFileSync(p,'utf8');
const {performance}=require('node:perf_hooks');
const startedAt=Date.now();let previousCpu,previousDisk,previousAt=performance.now(),energyWh=0,history=[];
function wattSecondsToWh(watts,seconds){return Number.isFinite(watts)&&watts>=0&&Number.isFinite(seconds)&&seconds>=0?watts*seconds/3600:0;}
function number(v){const n=Number.parseFloat(v);return Number.isFinite(n)?n:null;}
function memory(){const m={};for(const line of fs.readFileSync('/proc/meminfo','utf8').split('\n')){const match=line.match(/^(\w+):\s+(\d+)/);if(match)m[match[1]]=Number(match[2])*1024;}return readMemoryStats(readCgroup,{total:m.MemTotal,used:m.MemTotal-m.MemAvailable,available:m.MemAvailable});}
function cpuPercentFromUsage(previous,current,seconds,cores){if(!Number.isFinite(previous)||!Number.isFinite(current)||current<previous||!(seconds>0)||!(cores>0))return null;return Math.min(100,100*(current-previous)/(seconds*1e6*cores));}
function cpu(seconds){
 const cpus=os.cpus(),info={name:cpus[0]?.model,threads:cpus.length};
 try{const {usage,cores,version}=readCpuStats(readCgroup,os.availableParallelism());const percent=cpuPercentFromUsage(previousCpu?.usage,usage,seconds,cores);previousCpu={usage};return {...info,scope:'container',cgroupVersion:version,effectiveCores:cores,percent};}catch{}
 let idle=0,total=0;for(const c of cpus){idle+=c.times.idle;total+=Object.values(c.times).reduce((a,b)=>a+b,0);}const percent=previousCpu?.total?100*(1-(idle-previousCpu.idle)/(total-previousCpu.total)):null;previousCpu={idle,total};return {...info,scope:'host',percent:Number.isFinite(percent)?percent:null};
}
function disk(seconds){const counters=readIoStats(readCgroup);if(!counters){previousDisk=null;return {scope:'unavailable',readBytesPerSecond:null,writeBytesPerSecond:null};}const {read,write}=counters;const speed=previousDisk&&read>=previousDisk.read&&write>=previousDisk.write?{readBytesPerSecond:(read-previousDisk.read)/seconds,writeBytesPerSecond:(write-previousDisk.write)/seconds}:{readBytesPerSecond:null,writeBytesPerSecond:null};previousDisk={read,write};return {scope:'container',cgroupVersion:counters.version,...speed};}
function queueSnapshot(q,now){const waiting=(q.waiting||[]),ages=tickets=>tickets.map(x=>Number(x.queuedAt)).filter(Number.isFinite),oldest=ages(waiting),owner=ages((q.active||[]).filter(x=>x.rootId===q.owner));return {working:!!q.owner,waiting:waiting.length,oldestWaitSeconds:oldest.length?Math.max(0,(now-Math.min(...oldest))/1000):0,ownerSeconds:owner.length?Math.max(0,(now-Math.min(...owner))/1000):0};}
async function get(route){try{const r=await fetch('http://127.0.0.1:8080/'+route,{signal:AbortSignal.timeout(1800)});return r.ok?await r.json():null;}catch{return null;}}
async function tick(){
 const now=Date.now(),monotonic=performance.now(),seconds=Math.max(.001,(monotonic-previousAt)/1000);previousAt=monotonic;let gpu=null;
 try{const {stdout}=await exec('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.gr,pcie.link.gen.current,pcie.link.width.current','--format=csv,noheader,nounits'],{timeout:2200});const p=stdout.trim().split('\n')[0].split(',').map(s=>s.trim());gpu={name:p[0],percent:number(p[1]),vramUsedMiB:number(p[2]),vramTotalMiB:number(p[3]),temperatureC:number(p[4]),powerW:number(p[5]),powerLimitW:number(p[6]),fanPercent:number(p[7]),clockMHz:number(p[8]),pcieGeneration:number(p[9]),pcieWidth:number(p[10])};if(gpu.powerW!==null)energyWh+=wattSecondsToWh(gpu.powerW,seconds);}catch{}
 const [health,status,metrics]=await Promise.all([get('health'),get('status'),get('metrics')]);
 const requests=normalizeRequests(metrics);
 const last=requests.at(-1)||null,sample={at:now,gpuPercent:gpu?.percent,vramMiB:gpu?.vramUsedMiB};history.push(sample);history=history.slice(-60);
 let idle=null;try{idle=JSON.parse(fs.readFileSync(R+'/state/idle-status.json','utf8'));}catch{}
 let agentQueue=null;try{const q=JSON.parse(fs.readFileSync(R+'/state/turn-queue.json','utf8'));if(!q.closed&&now-JSON.parse(fs.readFileSync(R+'/state/lifecycle.json','utf8')).at<20000)agentQueue=queueSnapshot(q,now);}catch{}
 const data={at:now,source:'Vast instance',gpu,cpu:cpu(seconds),ram:memory(),disk:disk(seconds),model:{id:health?.model,loaded:health?.loaded,contextMax:health?.max_context,busy:status?.busy,queued:status?.queued,phase:status?.phase,promptTokens:status?.prompt_tokens,generatedTokens:status?.generated,maxOutputTokens:status?.max_tokens,elapsedSeconds:metrics?.live?.elapsed_s},agentQueue,last,requests,history,liveTokensPerSecond:metrics?.live?.tok_s_mean??metrics?.live?.tok_s??null,energyWhSinceMonitorStart:energyWh,monitorStartedAt:startedAt,idle};
 const temporary=stateFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(data),{mode:0o644});fs.renameSync(temporary,stateFile);
 setTimeout(tick,3000);
}
function normalizeRequests(metrics){return (Array.isArray(metrics?.requests)?metrics.requests:[]).slice(0,12).sort((a,b)=>(a.time||0)-(b.time||0)).map(r=>({id:r.id,time:r.time,status:r.finish??r.status,promptTokens:r.prompt_tokens,outputTokens:r.output_tokens,cachedTokens:r.reused??r.cached_tokens??r.reused_tokens,decodeTokensPerSecond:r.decode_tok_s,prefillTokensPerSecond:r.prompt_tok_s??(r.prompt_ms>0?(r.prompt_read??r.prompt_tokens)/(r.prompt_ms/1000):null),durationSeconds:r.duration_s??(r.total_ms?r.total_ms/1000:null)}));}
module.exports={normalizeRequests,wattSecondsToWh,cpuPercentFromUsage,parseIoStat,queueSnapshot};
 if(require.main===module)tick().catch(e=>{console.error(e.message);process.exitCode=1;});


