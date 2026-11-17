import {randomBytes} from 'node:crypto';
import protocol from '../development/project-custody.cjs';
const launches=new WeakMap(),failure=code=>Object.assign(Error(code),{code});
// Trusted in-process opt-in only. Neither tool parameters nor HTTP accepts it.
export function custodyLaunch(spec,context){
 const control={version:1,nonce:randomBytes(32).toString('hex'),generation:randomBytes(16).toString('hex')};
 const launch=Object.freeze({...control,context:Object.freeze({...context})});launches.set(spec,launch);return JSON.stringify(control);
}
export const launchFor=spec=>launches.get(spec);
export const startupEnvironment=protocol.startupEnvironment;

export function custodyReader(process,expected,{signal,timeoutMs=2000,pollMs=5}={}){
 let prefix=null,offset=0,pending=Buffer.alloc(0),ended=false,timer,deadline;
 let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 // Callers may publish a job before they await private capture. Never leak an
 // unhandled rejection; the original promise remains rejected for that caller.
 void ready.catch(()=>{});
 const finish=(error,identity)=>{if(ended)return;ended=true;clearTimeout(timer);clearTimeout(deadline);signal?.removeEventListener('abort',abort);error?rejectReady(error):resolveReady(identity);};
 const abort=()=>finish(failure('PROJECT_CUSTODY_ABORTED'));
 function poll(){
  if(ended)return;
  try{
   const read=process.observed.stdout.readFrom(offset);
   if(read?.lossy!==false||typeof read.text!=='string'||!Number.isSafeInteger(read.nextOffset)||read.nextOffset!==offset+Buffer.byteLength(read.text))throw failure('PROJECT_CUSTODY_OUTPUT_LOST');
   offset=read.nextOffset;const bytes=Buffer.from(read.text),newline=bytes.indexOf(10);
   pending=Buffer.concat([pending,newline<0?bytes:bytes.subarray(0,newline+1)]);
   if(pending.length>protocol.MAX_FRAME)throw failure('PROJECT_CUSTODY_FRAME_TOO_LARGE');
   if(newline>=0){const identity=protocol.parseFrame(pending,expected);prefix=pending.length;finish(null,identity);return;}
   timer=setTimeout(poll,pollMs);
  }catch(error){finish(error);}
 }
 if(signal?.aborted)abort();else{
  signal?.addEventListener('abort',abort,{once:true});deadline=setTimeout(()=>finish(failure('PROJECT_CUSTODY_TIMEOUT')),timeoutMs);
  Promise.resolve(process.done).then(()=>finish(failure('PROJECT_CUSTODY_EXITED')),()=>finish(failure('PROJECT_CUSTODY_EXITED')));poll();
 }
 return{ready,stdout:{readFrom(fromByte){
  if(!Number.isSafeInteger(fromByte)||fromByte<0)throw failure('PROJECT_CUSTODY_OFFSET_INVALID');
  if(prefix===null)return{text:'',nextOffset:fromByte,lossy:false};
  const read=process.observed.stdout.readFrom(fromByte+prefix);
  if(!Number.isSafeInteger(read.nextOffset)||read.nextOffset<fromByte+prefix)throw failure('PROJECT_CUSTODY_OFFSET_INVALID');
  // The SDK spill is the RAW stream and still includes the private frame.
  // Preserve loss evidence, but never publish that raw spill path to a job.
  return{text:read.text,nextOffset:read.nextOffset-prefix,lossy:read.lossy};
 }}};
}
