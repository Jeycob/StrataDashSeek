import net from 'node:net';
import {readInspectionDiagnostic} from './browser-server-diagnostic.mjs';
const failure=code=>Object.assign(Error(code),{code});
export async function connectBrowserServerControl(envelope,{signal}={}){
  if(!envelope||Object.keys(envelope).sort().join(',')!=='deadline,nonce,path,version'||envelope.version!==1||!/^[a-f0-9]{64}$/.test(envelope.nonce)||typeof envelope.path!=='string'||envelope.path.length>4096||!Number.isSafeInteger(envelope.deadline))throw failure('BROWSER_SERVER_CHANNEL_INVALID');
  signal?.throwIfAborted();
  const socket=net.createConnection(envelope.path);let pending,buffer='',closed=false;
  const abort=()=>socket.destroy(failure('BROWSER_SERVER_CHANNEL_ABORTED'));
  const end=()=>{closed=true;pending?.reject(failure('BROWSER_SERVER_CHANNEL_CLOSED'));pending=undefined;signal?.removeEventListener('abort',abort);};
  socket.on('error',end);socket.on('close',end);socket.setEncoding('utf8');
  socket.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>16384){socket.destroy();return;}
    let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const reply=JSON.parse(line),waiting=pending;pending=undefined;if(!waiting)throw Error('Unsolicited control reply');if(reply.ok===true)waiting.resolve(reply.value);else{const error=failure(typeof reply.code==='string'?reply.code:'BROWSER_SERVER_CHANNEL_FAILED'),inspection=readInspectionDiagnostic(reply.inspection);if(inspection&&inspection.code===error.code)error.inspection=inspection;waiting.reject(error);}}catch{socket.destroy();}}
  });
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const request=value=>new Promise((resolve,reject)=>{if(closed||pending){reject(failure('BROWSER_SERVER_CHANNEL_CLOSED'));return;}pending={resolve,reject};socket.write(JSON.stringify(value)+'\n');});
  try{await request({type:'hello',nonce:envelope.nonce});}
  catch(error){socket.destroy();throw error;}
  return Object.freeze({deadline:envelope.deadline,start:input=>request({type:'start',...input}),stop:checkId=>request({type:'stop',checkId}),close(){socket.end();}});
}

export async function readBrowserServerEnvelope(input=process.stdin){
  let text='';for await(const bytes of input){text+=bytes.toString('utf8');if(Buffer.byteLength(text)>8192)throw failure('BROWSER_SERVER_CHANNEL_INVALID');}
  try{return JSON.parse(text);}catch{throw failure('BROWSER_SERVER_CHANNEL_INVALID');}
}
