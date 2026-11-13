// Track a whole agent turn, including its tools/builds, independently of LLM traffic.
import fs from 'node:fs';
import path from 'node:path';
export const name='harness-idle-lifecycle';
export function apply(ctx,config={}) {
 const file=config.file||'/data/harness/state/lifecycle.json';const active=new Set();let lastActivity=Date.now();
 fs.mkdirSync(path.dirname(file),{recursive:true});
 function write(){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid:process.pid,at:Date.now(),active:active.size,lastActivity}),{mode:0o600});fs.renameSync(tmp,file);}
 ctx.on('session/event',(session,event)=>{if(event.type==='turn/start')active.add(session);if(event.type==='turn/end')active.delete(session);if(['turn/start','turn/end','user/message','tool/call','tool/result'].includes(event.type))lastActivity=Date.now();write();});
 const timer=setInterval(write,5000);timer.unref();ctx.on('dispose',()=>clearInterval(timer));write();
}
