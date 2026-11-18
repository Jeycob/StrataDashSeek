'use strict';
// Bounded, sanitized evidence for forced read-only ext4 checks. No CLI.
const crypto=require('node:crypto'),cp=require('node:child_process');
const CONTRACT='forced-ext4-readonly-v1',OUTPUT_LIMIT=4096,TEXT_LIMIT=1024,PROOF_LIMIT=4096;
const PASSES=['Pass 1: Checking inodes, blocks, and sizes','Pass 2: Checking directory structure','Pass 3: Checking directory connectivity','Pass 4: Checking reference counts','Pass 5: Checking group summary information'];
const BANNER=/^e2fsck [0-9]+\.[0-9]+\.[0-9]+ \([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4}\)$/;
const SUMMARY=/^.+: ([0-9]+)\/([0-9]+) files (?:\([0-9.]+% non-contiguous\), )?([0-9]+)\/([0-9]+) blocks$/;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=()=>Object.assign(Error('GROW_FSCK_PROOF_REQUIRED'),{code:'GROW_FSCK_PROOF_REQUIRED'});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const outputDigest=p=>hash(JSON.stringify([CONTRACT,p.stdout.bytes,p.stdout.sha256,p.stderr.bytes,p.stderr.sha256]));
function parse(stdout,stderr){
 const lines=s=>(s.endsWith('\n')?s.slice(0,-1):s).split('\n'),out=lines(stdout),err=lines(stderr),m=out.at(-1)?.match(SUMMARY);
 if(out.length!==6||!PASSES.every((s,i)=>out[i]===s)||err.length!==1||!BANNER.test(err[0])||!m)return null;
 const summary=Object.fromEntries(['usedInodes','totalInodes','usedBlocks','totalBlocks'].map((k,i)=>[k,Number(m[i+1])]));
 return Object.values(summary).every(integer)&&summary.usedInodes<=summary.totalInodes&&summary.usedBlocks<=summary.totalBlocks?summary:null;
}
function safeLine(s){
 if(s===''||PASSES.includes(s)||BANNER.test(s)||/^Free (?:blocks|inodes) count wrong \([0-9]+, counted=[0-9]+\)\.$/.test(s)||s==='Fix? no')return s;
 const m=s.match(SUMMARY);if(m)return'<filesystem>: '+s.slice(s.lastIndexOf(': ')+2);
 if(/^\[REDACTED_LINE sha256=[a-f0-9]{64}\]$/.test(s))return s;
 return'[REDACTED_LINE sha256='+hash(Buffer.from(s))+']';
}
function sanitize(buffers){
 let left=TEXT_LIMIT,complete=true;const text={};
 for(const name of ['stdout','stderr']){
  const input=buffers[name].toString('utf8').split('\n'),kept=[];
  for(let i=0;i<input.length;i++){
   const line=safeLine(input[i]),bytes=Buffer.byteLength(line)+(i?1:0);
   if(bytes>left){complete=false;break;}kept.push(line);left-=bytes;
  }
  text[name]=kept.join('\n');
 }
 return{text,complete};
}
function toolValid(t){
 return exact(t,['path','sha256','dev','ino','size','uid','gid','mode','mtimeNs','ctimeNs'])&&/^\/(?:usr\/)?sbin\/e2fsck$/.test(t.path)&&hex(t.sha256)&&['dev','ino','size','mtimeNs','ctimeNs'].every(k=>typeof t[k]==='string'&&/^[0-9]{1,20}$/.test(t[k]))&&BigInt(t.size)>0n&&BigInt(t.size)<=8n*1024n**2n&&t.uid===0&&integer(t.gid)&&t.gid<=0xffffffff&&integer(t.mode)&&t.mode<=0o177777&&(t.mode&0o170000)===0o100000&&!!(t.mode&0o111)&&!(t.mode&0o022);
}
function makeWitness({stdout,stderr,code,signal=null,expired=false,clipped=false,spawnError=false,streamError=false,closed=false,streams=null,tool}){
 const buffers={stdout,stderr},sanitized=sanitize(buffers);let encodingKnown=true;
 for(const b of Object.values(buffers))try{new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{encodingKnown=false;}
 const proof={version:1,contract:CONTRACT,tool,code,signal,expired,clipped,spawnError,streamError,closed,toolStable:true,inputStable:true,fullStreamsHashed:!streamError,sanitizedComplete:sanitized.complete&&encodingKnown,warningFree:false,summary:null,outputSha256:null};
 for(const name of ['stdout','stderr']){
  const b=buffers[name],observed=streams?.[name]??{bytes:b.length,sha256:hash(b)};
  proof[name]={bytes:observed.bytes,sha256:observed.sha256,retainedBytes:b.length,retainedSha256:hash(b),text:sanitized.text[name],contentComplete:!streamError&&observed.bytes===b.length};
 }
 proof.summary=encodingKnown?parse(stdout.toString('utf8'),stderr.toString('utf8')):null;
 proof.outputSha256=outputDigest(proof);
 proof.warningFree=!!proof.summary&&proof.sanitizedComplete&&toolValid(tool)&&code===0&&signal===null&&!expired&&!clipped&&!spawnError&&!streamError&&closed&&proof.stdout.contentComplete&&proof.stderr.contentComplete;
 return retainWitness(proof);
}
function retainWitness(value){
 const keys=['version','contract','tool','code','signal','expired','clipped','spawnError','streamError','closed','toolStable','inputStable','fullStreamsHashed','sanitizedComplete','warningFree','summary','outputSha256','stdout','stderr'];
 if(!exact(value,keys)||value.version!==1||value.contract!==CONTRACT||!toolValid(value.tool)||!(value.code===null||Number.isSafeInteger(value.code))||!(value.signal===null||/^SIG[A-Z0-9]{1,16}$/.test(value.signal))||['expired','clipped','spawnError','streamError','closed','toolStable','inputStable','fullStreamsHashed','sanitizedComplete','warningFree'].some(k=>typeof value[k]!=='boolean'))throw fail();
 let textBytes=0,retainedBytes=0;
 for(const name of ['stdout','stderr']){
  const s=value[name];if(!exact(s,['bytes','sha256','retainedBytes','retainedSha256','text','contentComplete'])||!integer(s.bytes)||!integer(s.retainedBytes)||s.retainedBytes>s.bytes||!hex(s.sha256)||!hex(s.retainedSha256)||typeof s.text!=='string'||typeof s.contentComplete!=='boolean')throw fail();
  if(s.contentComplete&&(s.bytes!==s.retainedBytes||s.sha256!==s.retainedSha256))throw fail();
  if(s.text.split('\n').some(line=>safeLine(line)!==line))throw fail();
  textBytes+=Buffer.byteLength(s.text);retainedBytes+=s.retainedBytes;
 }
 if(textBytes>TEXT_LIMIT||retainedBytes>OUTPUT_LIMIT)throw fail();
 if(!hex(value.outputSha256)||value.outputSha256!==outputDigest(value))throw fail();
 if(value.summary!==null&&(!exact(value.summary,['usedInodes','totalInodes','usedBlocks','totalBlocks'])||!Object.values(value.summary).every(integer)))throw fail();
 const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>PROOF_LIMIT)throw fail();
 // Detach the durable record from an adapter's mutable return value.
 return JSON.parse(bytes);
}
function assertWitness(value,geometry){
 const p=retainWitness(value),summary=parse(p.stdout.text,p.stderr.text);
 if(!summary||!p.summary||Object.keys(summary).some(k=>summary[k]!==p.summary[k])||!p.warningFree||p.code!==0||p.signal!==null||!p.closed||!p.toolStable||!p.inputStable||!p.fullStreamsHashed||!p.sanitizedComplete||['expired','clipped','spawnError','streamError'].some(k=>p[k])||!p.stdout.contentComplete||!p.stderr.contentComplete)throw fail();
 if(geometry&&(Object.hasOwn(geometry,'clean')&&geometry.clean!==true||summary.totalInodes!==geometry.inodeCount||summary.totalBlocks!==geometry.blockCount||summary.usedInodes!==geometry.inodeCount-geometry.freeInodes||summary.usedBlocks!==geometry.blockCount-geometry.freeBlocks))throw fail();
 return p;
}
async function runFsck({setpriv,e2fsck,uid,gid,fd,timeoutMs,tool}){
 if(!toolValid(tool)||tool.path!==e2fsck||!integer(uid)||!integer(gid)||!integer(fd)||!integer(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw fail();
 const child=cp.spawn(setpriv,['--reuid',String(uid),'--regid',String(gid),'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',e2fsck,'-f','-n','/proc/self/fd/3'],{cwd:'/',env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe',fd],windowsHide:true});
 const capture=Object.fromEntries(['stdout','stderr'].map(name=>[name,{hash:crypto.createHash('sha256'),bytes:0,chunks:[]}]));
 let kept=0,expired=false,clipped=false,spawnError=false,streamError=false,killRequested=false;
 const stop=()=>{if(!killRequested){killRequested=true;child.kill('SIGKILL');}};
 for(const name of ['stdout','stderr']){
  const stream=child[name],record=capture[name];stream.on('data',b=>{
   record.bytes+=b.length;record.hash.update(b);
   const n=Math.min(b.length,OUTPUT_LIMIT-kept);if(n){record.chunks.push(Buffer.from(b.subarray(0,n)));kept+=n;}
   if(n<b.length){clipped=true;stop();}
  });stream.once('error',()=>{streamError=true;stop();});
 }
 child.once('error',()=>{spawnError=true;});const timer=setTimeout(()=>{expired=true;stop();},timeoutMs);
 const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
 const streams=Object.fromEntries(Object.entries(capture).map(([name,s])=>[name,{bytes:s.bytes,sha256:s.hash.digest('hex')}]));
 return makeWitness({...result,closed:true,stdout:Buffer.concat(capture.stdout.chunks),stderr:Buffer.concat(capture.stderr.chunks),streams,tool,expired,clipped,spawnError,streamError});
}
module.exports={CONTRACT,OUTPUT_LIMIT,TEXT_LIMIT,PROOF_LIMIT,qualifyReadOnlyFsck:makeWitness,retainWitness,assertWitness,runFsck};
