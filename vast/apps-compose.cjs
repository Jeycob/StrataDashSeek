'use strict';
const YAML=require('yaml'),path=require('node:path');
const {LABEL}=require('./apps-engine.cjs');
const id=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
function relative(value){return typeof value==='string'&&value.length<=300&&!path.isAbsolute(value)&&!value.split(/[\\/]/).includes('..')&&!value.includes('\0');}
function parseCompose(source){if(typeof source!=='string'||Buffer.byteLength(source)>256*1024)throw Error('Compose file exceeds 256 KiB');const doc=YAML.parseDocument(source,{uniqueKeys:true,maxAliasCount:30});if(doc.errors.length)throw Error('Invalid Compose YAML: '+doc.errors[0].message);return doc.toJS({maxAliasCount:30});}
function bindEnvironment(spec,values){for(const s of Object.values(spec.services))for(const[k,v]of Object.entries(s.environment||{})){const ref=String(v).match(/^\$\{HARNESS_SECRET:([A-Za-z_][A-Za-z0-9_.-]*)\}$/);if(ref){if(!(ref[1]in values))throw Error('Missing project runtime secret mapping: '+ref[1]);if(values[ref[1]].includes('\0'))throw Error('Runtime credential cannot contain NUL: '+ref[1]);s.environment[k]=values[ref[1]].split('$').join('$$');}}return spec;}
function policy(compose,{projectId,releaseId,entryService,entryPort,hostPort,publishAddress='127.0.0.1',secretFiles={}}){
 if(!compose||typeof compose!=='object'||!compose.services||Array.isArray(compose.services)||Object.keys(compose.services).length>8||!Object.keys(compose.services).length)throw Error('Compose requires 1–8 services');
 for(const k of Object.keys(compose))if(!['name','version','services','volumes','networks','secrets'].includes(k)&&!k.startsWith('x-'))throw Error('Unsupported Compose option: '+k);
 if(!compose.services[entryService]||!Number.isInteger(entryPort)||entryPort<1024||entryPort>65535)throw Error('Choose the web service and its container port');
 const out={name:'sdsh-'+projectId+'-'+releaseId,services:{},volumes:{},networks:{default:{}},secrets:{}};
 for(const[name,v]of Object.entries(compose.volumes||{})){if(!id.test(name)||v&&Object.keys(v).length)throw Error('Only managed named volumes are supported');out.volumes[name]={name:'sdsh-'+projectId+'-'+name,labels:{[LABEL]:'managed',[LABEL+'.project']:projectId}};}
 if(Object.entries(compose.networks||{}).some(([n,v])=>n!=='default'||v&&Object.keys(v).length))throw Error('Use the isolated default Compose network');
 for(const[name,v]of Object.entries(compose.secrets||{})){if(!id.test(name)||!secretFiles[name]||v&&Object.keys(v).some(k=>k!=='x-harness-secret'))throw Error('Compose secrets must be supplied by the project vault: '+name);out.secrets[name]={file:secretFiles[name]};}
 let memoryTotal=0;
 for(const[name,s]of Object.entries(compose.services)){
  if(!id.test(name)||!s||typeof s!=='object'||Array.isArray(s))throw Error('Invalid Compose service');
  const allowed=['image','build','command','entrypoint','environment','depends_on','healthcheck','volumes','secrets','expose','ports','working_dir','user','restart','init','labels','mem_limit','cpus','read_only','tmpfs'];
  for(const k of Object.keys(s))if(!allowed.includes(k)&&!k.startsWith('x-'))throw Error('Unsupported Compose service option: '+name+'.'+k);
  const c={...s};for(const k of Object.keys(c))if(k.startsWith('x-'))delete c[k];
  if(c.image&&(typeof c.image!=='string'||/[\s$]/.test(c.image)||c.image.length>300))throw Error('Invalid image reference');
  if(c.build){const b=typeof c.build==='string'?{context:c.build}:{...c.build};if(Object.keys(b).some(k=>!['context','dockerfile','target','args','secrets'].includes(k))||!relative(b.context||'.')||b.dockerfile&&!relative(b.dockerfile))throw Error('Build context must stay inside the project');if(b.args&&Object.keys(b.args).some(k=>/password|secret|token|key/i.test(k)))throw Error('Pass build secrets through secret mounts, never build arguments');c.build=b;}
  if(!c.image&&!c.build)throw Error('Each service needs an image or build');
  if(c.environment){if(Array.isArray(c.environment)||typeof c.environment!=='object'||Object.entries(c.environment).some(([k,v])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(k)||typeof v!=='string'&&typeof v!=='number'&&typeof v!=='boolean'))throw Error('Use explicit environment values; host environment inheritance is disabled');if(Object.entries(c.environment).some(([k,v])=>/password|secret|token|private.?key/i.test(k)&&!/^\$\{HARNESS_SECRET:[A-Za-z_][A-Za-z0-9_.-]*\}$/.test(String(v))))throw Error('Sensitive environment values must use a project vault reference');}
  c.volumes=(c.volumes||[]).map(v=>{const a=typeof v==='string'?v.split(':'):null;if(!a||a.length<2||a.length>3||!out.volumes[a[0]]||!a[1].startsWith('/')||a[1].includes('..')||a[1].includes('docker.sock')||a[2]&&!['ro','rw'].includes(a[2]))throw Error('Only declared named volumes may be mounted');return v;});
  if(c.tmpfs)throw Error('Custom tmpfs mounts are not supported');
  if(c.ports?.length&&name!==entryService)throw Error('Only the selected web service may publish a port');
  // The gateway assigns the only externally reachable port; source mappings cannot override it.
  c.ports=name===entryService?[{target:entryPort,published:String(hostPort),host_ip:publishAddress,protocol:'tcp'}]:[];
  c.labels={...(typeof s.labels==='object'&&!Array.isArray(s.labels)?s.labels:{}),[LABEL]:'managed',[LABEL+'.project']:projectId,[LABEL+'.release']:releaseId};
  c.cap_drop=['ALL'];c.security_opt=['no-new-privileges:true'];c.pids_limit=128;c.mem_limit=s.mem_limit||'512m';c.cpus=s.cpus||1;c.restart='no';
  if(!/^(?:[1-9]\d{0,3})[mM]$/.test(String(c.mem_limit))||parseInt(c.mem_limit)>2048||!Number.isFinite(Number(c.cpus))||Number(c.cpus)<.1||Number(c.cpus)>2)throw Error('Compose resource limits exceed the approved worker');
  memoryTotal+=parseInt(c.mem_limit);if(memoryTotal>1536)throw Error('Compose services exceed the 1536 MiB application memory budget');
  if(c.depends_on){const deps=Array.isArray(c.depends_on)?c.depends_on:Object.keys(c.depends_on);if(deps.some(n=>!compose.services[n]||n===name))throw Error('Invalid dependency');}
  if(c.secrets?.length)throw Error('Runtime Compose file secrets require a remote file transport; use environment values with ${HARNESS_SECRET:NAME}. Build secrets are supported.');
  out.services[name]=c;
 }
 if(/\$(?:\{|[A-Za-z_])/.test(JSON.stringify(out).replace(/\$\{HARNESS_SECRET:[A-Za-z_][A-Za-z0-9_.-]*\}/g,'').replace(/\$\$/g,'')))throw Error('Compose host interpolation is disabled; use explicit configuration and vault references, or $$ for container variables');
 return out;
}
module.exports={parseCompose,policy,relative,bindEnvironment};
