import path from 'node:path';

const fail=(code,message)=>Object.assign(new Error(message),{code});
// Optional browser-only producer. Port, root, identity and executor are trusted
// runtime inputs, never fields in the project's server declaration.
export function validateBrowserServer(value){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['command','readinessTimeoutMs'].includes(k)))throw fail('INVALID_BROWSER_SERVER','Declare only command and optional readinessTimeoutMs.');
  const command=value.command;
  if(!Array.isArray(command)||!command.length||command.length>64||command.some(x=>typeof x!=='string'||!x||x.includes('\0')||x.length>16384))throw fail('INVALID_BROWSER_SERVER','Server command must be a bounded direct program-and-arguments array.');
  const program=path.basename(command[0]).toLowerCase().replace(/\.exe$/u,'');
  if(['bash','sh','dash','zsh','cmd','powershell','pwsh'].includes(program))throw fail('SHELL_REFUSED','Call the project server directly.');
  if(value.readinessTimeoutMs!==undefined&&(!Number.isInteger(value.readinessTimeoutMs)||value.readinessTimeoutMs<100||value.readinessTimeoutMs>30000))throw fail('INVALID_BROWSER_SERVER','Readiness timeout must be 100–30000 ms within the original check deadline.');
  return Object.freeze({command:Object.freeze([...command]),readinessTimeoutMs:value.readinessTimeoutMs??5000});
}

export function browserServerDeadlines({startedAt,timeoutMs,operationDeadline,readinessTimeoutMs}){
  if(![startedAt,timeoutMs,operationDeadline,readinessTimeoutMs].every(Number.isSafeInteger)||timeoutMs<1||readinessTimeoutMs<1)throw fail('INVALID_BROWSER_SERVER_DEADLINE','Expected absolute operation deadline and bounded phase durations.');
  const deadline=Math.min(startedAt+timeoutMs,operationDeadline);
  return Object.freeze({deadline,readinessDeadline:Math.min(startedAt+readinessTimeoutMs,deadline)});
}

// One admitted operation owns both phases. start() must synchronously publish
// its exact SDK range handle; its done must mean verified range quiescence.
// A timeout stops the range but never manufactures settlement or releases it.
export async function withBrowserServer({server,deadline,readinessDeadline,signal,start,ready,verify,now=Date.now}){
  server=validateBrowserServer(server);
  if(!server||!Number.isSafeInteger(deadline)||!Number.isSafeInteger(readinessDeadline)||readinessDeadline>deadline)throw fail('INVALID_BROWSER_SERVER_DEADLINE','Server verification requires one original absolute deadline.');
  const controller=new AbortController();let lease,stopping=false,phase,stopError;
  const stop=()=>{if(lease&&!stopping){stopping=true;try{lease.terminate();}catch(error){stopError=error;}}};
  const abort=()=>{controller.abort(signal.reason);stop();};
  if(signal?.aborted)throw signal.reason;
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{controller.abort(fail('BROWSER_SERVER_TIMEOUT','Original browser check deadline exhausted.'));stop();},Math.max(0,deadline-now()));
  const aborted=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));void aborted.catch(()=>{});
  let readinessTimer;
  const check=()=>{controller.signal.throwIfAborted();if(now()>=deadline)throw fail('BROWSER_SERVER_TIMEOUT','Original browser check deadline exhausted.');lease?.assertCurrent();};
  try{
    check();
    if(now()>=readinessDeadline)throw fail('BROWSER_SERVER_NOT_READY','Readiness deadline already exhausted.');
    const candidate=start({server,deadline,signal:controller.signal});
    if(!candidate||candidate.then||!candidate.done?.then||typeof candidate.terminate!=='function'||typeof candidate.assertCurrent!=='function')throw fail('BROWSER_SERVER_UNAVAILABLE','An exact synchronous owned SDK range is required.');
    lease=candidate;
    const exited=Promise.resolve(lease.done).then(()=>{if(!stopping)throw fail('BROWSER_SERVER_EXITED','Owned server range exited during verification.');});void exited.catch(()=>{});
    check();readinessTimer=setTimeout(()=>controller.abort(fail('BROWSER_SERVER_NOT_READY','Owned server was not ready before its readiness deadline.')),Math.max(0,readinessDeadline-now()));
    phase=Promise.resolve().then(()=>ready({lease,deadline:readinessDeadline,signal:controller.signal}));
    await Promise.race([phase,aborted,exited]);clearTimeout(readinessTimer);check();
    if(now()>=readinessDeadline)throw fail('BROWSER_SERVER_NOT_READY','Readiness completed after its original deadline.');
    phase=Promise.resolve().then(()=>verify({lease,deadline,signal:controller.signal,assertCurrent:check}));
    const result=await Promise.race([phase,aborted,exited]);check();return result;
  }finally{
    clearTimeout(timer);clearTimeout(readinessTimer);signal?.removeEventListener('abort',abort);
    controller.abort(fail('BROWSER_SERVER_STOPPED','Owned verification phase is closing.'));
    try{if(lease){stop();await lease.done;}}
    // Observe cancellation cleanup even when a proven-empty SDK range has a
    // rejected direct outcome. Unknown range quiescence stays pending in SDK.
    finally{await phase?.catch(()=>{});}
    if(stopError)throw fail('BROWSER_SERVER_STOP_FAILED','Owned server termination failed; its range was drained.');
  }
}
