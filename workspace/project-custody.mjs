import {randomBytes} from 'node:crypto';
import protocol from '../development/project-custody.cjs';
const launches=new WeakMap(),failure=code=>Object.assign(Error(code),{code});
// Trusted in-process opt-in only. Neither tool parameters nor HTTP accepts it.
export function custodyLaunch(spec,context,restartSeed){
 const control={version:1,nonce:randomBytes(32).toString('hex'),generation:randomBytes(16).toString('hex')};
 const launch=Object.freeze({...control,context:Object.freeze({...context}),restartSeed});launches.set(spec,launch);return JSON.stringify(control);
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
   if(read?.lossy!==false||typeof read.text!=='string'||!Number.isSafeInteger(read.nextOffset)||read.nextOffset<offset)throw failure('PROJECT_CUSTODY_OUTPUT_LOST');
   const newline=read.text.indexOf('\n'),part=newline<0?read.text:read.text.slice(0,newline+1);
   if(part.length>protocol.MAX_FRAME-pending.length)throw failure('PROJECT_CUSTODY_FRAME_TOO_LARGE');
   if(/[^\x00-\x7f]/.test(part))throw failure('PROJECT_CUSTODY_PROTOCOL_INVALID');
   const end=offset+part.length;
   // Only the bounded ASCII prefix has a one-character/one-byte invariant.
   // The SDK decodes the whole raw read with Buffer.toString('utf8'); a partial
   // app byte AFTER the newline may expand to U+FFFD. Do not re-encode it to
   // validate raw offsets or use it to locate the app's first raw byte.
   if(read.nextOffset<end||((newline<0||newline===read.text.length-1)&&read.nextOffset!==end))throw failure('PROJECT_CUSTODY_OUTPUT_LOST');
   offset=read.nextOffset;pending=Buffer.concat([pending,Buffer.from(part,'ascii')]);
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
