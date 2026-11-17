'use strict';
// Trusted immutable PID1 entrypoint INSIDE the network=none project executor.
// This only transports bytes. A's separate trusted UNIX proxy owns CONNECT,
// DNS/public-address/port policy. No direct network or alternate socket target.
const net=require('node:net'),cp=require('node:child_process');
const HOST='127.0.0.1',PORT=18199,SOCKET='/run/homeai-egress/proxy.sock';
const LIMITS=Object.freeze({connections:32,highWaterMark:65536,idleMs:30000,connectMs:5000,bytes:256*1024*1024,lifetimeMs:600000,shutdownMs:5000});
function parseArguments(argv){if(argv.length!==1||typeof argv[0]!=='string'||!argv[0].trim()||argv[0].includes('\0')||Buffer.byteLength(argv[0])>65536)throw Error('EGRESS_ARGUMENT_INVALID');return argv[0];}
function childEnvironment(environment){
 const value={...environment,HOME:'/home/coder',HTTP_PROXY:'http://127.0.0.1:18199',HTTPS_PROXY:'http://127.0.0.1:18199',http_proxy:'http://127.0.0.1:18199',https_proxy:'http://127.0.0.1:18199',NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1',NODE_USE_ENV_PROXY:'1'};
 delete value.ALL_PROXY;delete value.all_proxy;
 return value;
}
// Network injection is a local-test seam. CLI cannot override any endpoint,
// policy/limit, environment file, command interpreter or executable path.
async function startForwarder({network=net,limits=LIMITS}={}){
 const active=new Set();let stopping=false,totalBytes=0,exhausted=false,closedResolve;
 const closed=new Promise(resolve=>{closedResolve=resolve;});
 const server=network.createServer({allowHalfOpen:true,pauseOnConnect:true,highWaterMark:limits.highWaterMark},client=>{
  if(stopping||exhausted||active.size>=limits.connections){client.destroy();return;}
  client.pause();client.setNoDelay(true);
  let upstream,connectTimer,idleTimer,lifeTimer,failed=false,clientClosed=false,upstreamClosed=false;
  const state={destroy};active.add(state);
  function release(){if(clientClosed&&upstreamClosed){clearTimeout(connectTimer);clearTimeout(idleTimer);clearTimeout(lifeTimer);active.delete(state);}}
  function destroy(){if(failed)return;failed=true;clearTimeout(connectTimer);clearTimeout(idleTimer);clearTimeout(lifeTimer);client.destroy();if(upstream)upstream.destroy();else{upstreamClosed=true;release();}}
  function touch(){clearTimeout(idleTimer);idleTimer=setTimeout(destroy,limits.idleMs);idleTimer.unref();}
  function pump(source,target){
   source.on('data',chunk=>{
    if(failed)return;totalBytes+=chunk.length;
    if(totalBytes>limits.bytes){exhausted=true;for(const connection of active)connection.destroy();return;}
    touch();if(!target.write(chunk))source.pause();
   });
   target.on('drain',()=>{if(!failed)source.resume();});source.on('end',()=>{if(!failed)target.end();});
  }
  client.on('error',destroy);client.on('close',()=>{clientClosed=true;if(!client.readableEnded||!client.writableFinished)destroy();release();});
  connectTimer=setTimeout(destroy,limits.connectMs);connectTimer.unref();lifeTimer=setTimeout(destroy,limits.lifetimeMs);lifeTimer.unref();
  try{
   upstream=network.createConnection({path:SOCKET,allowHalfOpen:true,highWaterMark:limits.highWaterMark});upstream.pause();upstream.on('error',destroy);
   upstream.on('close',()=>{upstreamClosed=true;if(!upstream.readableEnded||!upstream.writableFinished)destroy();release();});
   upstream.once('connect',()=>{clearTimeout(connectTimer);if(failed)return;pump(client,upstream);pump(upstream,client);touch();client.resume();upstream.resume();});
  }catch{upstreamClosed=true;destroy();}
 });
 function close(){
  if(stopping)return closed;stopping=true;
  for(const state of active)state.destroy();
  server.close(()=>closedResolve());return closed;
 }
 server.on('error',()=>{void close();});
 await new Promise((resolve,reject)=>{
  const failed=()=>reject(Error('EGRESS_LISTEN_FAILED'));server.once('error',failed);
  server.listen({host:HOST,port:PORT,exclusive:true,backlog:32},()=>{server.off('error',failed);resolve();});
 });
 return{close,closed,address:()=>server.address(),activeConnections:()=>active.size,transferredBytes:()=>totalBytes};
}
async function launch(command,{environment=process.env,network,spawn=cp.spawn,limits=LIMITS}={}){
 parseArguments([command]);
 const forwarder=await startForwarder({network,limits});let child,timer,stopping=false,finished=false,forwarderFailed=false;
 try{
  child=spawn('/bin/bash',['-o','pipefail','-c',command],{env:childEnvironment(environment),stdio:'inherit',shell:false,detached:false});
  let outcomeResolve;const outcome=new Promise(resolve=>{outcomeResolve=resolve;});
  child.once('error',()=>outcomeResolve({code:127,signal:null}));child.once('close',(code,signal)=>outcomeResolve({code,signal}));
  const stop=signal=>{
   if(stopping)return;stopping=true;void forwarder.close();
   child.kill(signal);timer=setTimeout(()=>child.kill('SIGKILL'),limits.shutdownMs);timer.unref();
  };
  const term=()=>stop('SIGTERM'),interrupt=()=>stop('SIGINT');
  process.once('SIGTERM',term);process.once('SIGINT',interrupt);
  forwarder.closed.then(()=>{if(!stopping&&!finished&&child.exitCode===null&&child.signalCode===null){forwarderFailed=true;stop('SIGTERM');}});
  try{const result=await outcome;finished=true;return{...result,forwarderFailed};}
  finally{process.off('SIGTERM',term);process.off('SIGINT',interrupt);clearTimeout(timer);}
 }finally{await forwarder.close();}
}
async function main(argv=process.argv.slice(2)){
 let result;
 try{result=await launch(parseArguments(argv));}catch{process.stderr.write('EGRESS_LAUNCH_FAILED\n');process.exitCode=127;return;}
 if(result.signal){
  // PID1 may ignore default-action self signals in Linux. Preserve the signal
  // fact when possible; conventional 128+signal is the PID1 fallback.
  const number=require('node:os').constants.signals[result.signal];process.exitCode=128+(number??1);
  try{process.kill(process.pid,result.signal);}catch{}
 }else process.exitCode=result.forwarderFailed?125:result.code??127;
}
module.exports={HOST,PORT,SOCKET,LIMITS,parseArguments,childEnvironment,startForwarder,launch};
if(require.main===module)void main();
