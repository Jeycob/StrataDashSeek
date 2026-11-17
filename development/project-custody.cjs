'use strict';
// Private launcher protocol. This proves a wrapper frame, NOT socket ownership.
const PREFIX='HOMEAI_CUSTODY_V1 ',MAX_FRAME=512,MAX_INPUT=256;
const fail=()=>Object.assign(Error('PROJECT_CUSTODY_PROTOCOL_INVALID'),{code:'PROJECT_CUSTODY_PROTOCOL_INVALID'});
const hex=(value,size)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+size+'}$').test(value);
function envelope(value){
 if(!value||Object.keys(value).sort().join(',')!=='generation,nonce,version'||value.version!==1||!hex(value.nonce,64)||!hex(value.generation,32))throw fail();
 return{version:1,nonce:value.nonce,generation:value.generation};
}
function readEnvelope(filesystem){
 const buffer=Buffer.alloc(MAX_INPUT+1);let size=0;
 while(size<buffer.length){const count=filesystem.readSync(0,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
 if(size>MAX_INPUT)throw fail();
 const bytes=buffer.subarray(0,size);if(bytes.some(byte=>byte>127))throw fail();
 try{const value=envelope(JSON.parse(bytes.toString('ascii')));if(JSON.stringify(value)!==bytes.toString('ascii'))throw fail();return value;}catch{throw fail();}
}
function identity(value){
 const {pid,ppid,pgrp,startTicks}=value;
 if(!Number.isSafeInteger(pid)||pid<=1||!Number.isSafeInteger(ppid)||ppid<1||!Number.isSafeInteger(pgrp)||pgrp<1||typeof startTicks!=='string'||!/^\d{1,20}$/.test(startTicks)||!/[1-9]/.test(startTicks))throw fail();
 return{pid,ppid,pgrp,startTicks};
}
function identityFromStat(text,pid){
 const end=text.lastIndexOf(')'),fields=text.slice(end+2).trim().split(/\s+/);
 if(!Number.isSafeInteger(pid)||pid<=1||!text.startsWith(pid+' (')||end<0||!/^\d+$/.test(fields[19]||''))throw fail();
 return identity({pid,ppid:Number(fields[1]),pgrp:Number(fields[2]),startTicks:fields[19]});
}
function frame(control,anchor){
 if(typeof anchor.pidNamespace!=='string'||!/^pid:\[[1-9]\d{0,19}\]$/.test(anchor.pidNamespace))throw fail();
 const data={...envelope(control),...identity(anchor),pidNamespace:anchor.pidNamespace};
 const bytes=Buffer.from(PREFIX+JSON.stringify(data)+'\n','ascii');if(bytes.length>MAX_FRAME)throw fail();return bytes;
}
function parseFrame(bytes,expected){
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX_FRAME||bytes.some(byte=>byte>127))throw fail();
 const text=bytes.toString('ascii');if(!text.startsWith(PREFIX)||!text.endsWith('\n'))throw fail();
 let value;try{value=JSON.parse(text.slice(PREFIX.length,-1));}catch{throw fail();}
 if(!value||value.nonce!==expected.nonce||value.generation!==expected.generation)throw fail();
 let canonical;try{canonical=frame({version:value.version,nonce:value.nonce,generation:value.generation},value);}catch{throw fail();}
 if(!canonical.equals(bytes))throw fail(); // rejects duplicate/extra/reordered fields
 return Object.freeze({stage:'wrapper-frame',generation:value.generation,pid:value.pid,ppid:value.ppid,pgrp:value.pgrp,startTicks:value.startTicks,pidNamespace:value.pidNamespace});
}
function startupEnvironment(parent=process.env){
 const env={};
 // Ordinary ambient variables survive the SDK credential scrub. Empty values
 // suppress hooks before the outer bash, dynamic loader or Node can execute.
 for(const key of Object.keys(parent))if(/^(?:BASH_|LD_|DYLD_|NODE_|SHELLOPTS$|BASHOPTS$|ENV$|GCONV_PATH$|GLIBC_TUNABLES$)/i.test(key))env[key]='';
 return{...env,PATH:'/usr/bin:/bin',BASH_ENV:'/dev/null',ENV:'/dev/null',SHELLOPTS:'',BASHOPTS:'',NODE_OPTIONS:'',NODE_PATH:'',LD_PRELOAD:'',LD_AUDIT:'',LD_LIBRARY_PATH:'',GCONV_PATH:'',GLIBC_TUNABLES:''};
}
module.exports={PREFIX,MAX_FRAME,MAX_INPUT,envelope,readEnvelope,identityFromStat,frame,parseFrame,startupEnvironment};
