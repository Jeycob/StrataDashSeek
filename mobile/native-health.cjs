'use strict';
const fs=require('node:fs');

function launchURL(file,host){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||process.platform==='linux'&&(s.uid!==0||s.mode&0o022))throw Error('Unsafe local launch record');
  const length=Math.min(s.size,65536),buffer=Buffer.alloc(length);fs.readSync(fd,buffer,0,length,s.size-length);
  const matches=[...buffer.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'').matchAll(/https:\/\/[^\s]+\?token=[^\s]+/g)];if(!matches.length)throw Error('Local launch record unavailable');
  const url=new URL(matches.at(-1)[0]);if(url.host!==host||!url.searchParams.get('token')||url.searchParams.get('token').length>8192)throw Error('Local launch authority mismatch');return url;
 }finally{fs.closeSync(fd);}
}
function createNativeHealth(cfg,probe){
 let cookie=null;
 return async()=>{
  const deadline=Date.now()+1500,options=extra=>({timeoutMs:Math.max(1,deadline-Date.now()),hostHeader:cfg.publicHost,...extra});
  try{
   if(!cookie){const url=launchURL(cfg.desktopLog||'/data/harness/logs/harness.log',cfg.publicHost);
    const login=await probe(cfg.harnessPort||3090,'/?token='+encodeURIComponent(url.searchParams.get('token')),options({captureCookies:true}));
    if(login?.status!==303||!Array.isArray(login.cookies)||!login.cookies.length||login.cookies.length>20)return null;
    cookie=login.cookies.map(value=>value.split(';')[0]).join('; ');if(cookie.length>8192){cookie=null;return null;}
   }
   if(Date.now()>=deadline)return null;
   const value=await probe(cfg.harnessPort||3090,'/api/workbench/health',options({json:true,cookie}));
   if(value?.version===1&&value.workspaceReady===true&&/^[a-f0-9]{40}$/.test(value.sourceCommit||''))return{status:200,workspaceReady:true,sourceCommit:value.sourceCommit};
   cookie=null;return null;
  }catch{cookie=null;return null;}
 };
}
module.exports={createNativeHealth,launchURL};
