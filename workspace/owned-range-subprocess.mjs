import {runtimeRequire} from '../runtime/require.cjs';
import {registerOwnedRangeProvider} from './owned-range-state.mjs';
const {LocalSubprocessRuntime}=runtimeRequire('@deepseek-ai/dsh-subprocess-local');

// Installed IN PLACE OF subprocess-local. The actual SDK owns the original
// range, signals, streams, disposal and PTY implementation unchanged.
export default class OwnedRangeSubprocess extends LocalSubprocessRuntime{
 constructor(ctx){super(ctx);registerOwnedRangeProvider(this);}
 spawn(spec){
  const original=super.spawn(spec),terminate=original.terminate.bind(original);
  const done=(async()=>{
   // Match SDK ordering: observing a not-yet-started scope can race startup.
   let outcome,failure,failed=false;
   try{outcome=await original.done;}catch(error){failed=true;failure=error;}
   try{
    if(typeof original.waitForExit!=='function'||await original.waitForExit()!==true)throw Error('HOMEAI_RANGE_EXIT_UNOBSERVABLE');
   }catch{
    // Bash translates provider rejection into fulfilled ShellProcess.done.
    // Unknown quiescence must therefore remain pending, retaining admission.
    try{terminate();}catch{}
    try{this.ctx.logger.warn('HOMEAI_RANGE_EXIT_UNOBSERVABLE: owned completion remains pending; operator intervention required');}catch{}
    return await new Promise(()=>{});
   }
   if(failed)throw failure;return outcome;
  })();
  // Avoid unhandled rejection before consumers attach. Their original done
  // still rejects for direct provider failure AFTER verified range absence.
  void done.catch(()=>{});
  return{stdin:original.stdin,stdout:original.stdout,stderr:original.stderr,control:original.control,collected:original.collected,done,terminate,waitForExit:typeof original.waitForExit==='function'?original.waitForExit.bind(original):async()=>{throw Error('HOMEAI_RANGE_EXIT_UNOBSERVABLE');}};
 }
}
