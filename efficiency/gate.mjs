/** FIFO permits cover actual resource use, not a whole chat turn. */
export class FairGate {
  constructor({capacity=1,onChange=()=>{}}={}){if(!Number.isInteger(capacity)||capacity<1)throw Error('Invalid capacity');this.capacity=capacity;this.onChange=onChange;this.active=new Map();this.waiting=[];this.sequence=0;this.closed=false;}
  acquire({rootId,sessionId=rootId,signal}={}){
    if(this.closed)return Promise.reject(Error('Scheduler unloaded'));
    if(signal?.aborted)return Promise.reject(signal.reason??Error('Cancelled'));
    return new Promise((resolve,reject)=>{
      const t={id:++this.sequence,rootId,sessionId,queuedAt:Date.now(),signal,resolve,reject};
      t.abort=()=>{const i=this.waiting.indexOf(t);if(i>=0){this.waiting.splice(i,1);reject(signal.reason??Error('Cancelled'));this.changed();}};
      signal?.addEventListener('abort',t.abort,{once:true});this.waiting.push(t);this.pump();
    });
  }
  pump(){
    while(!this.closed&&this.active.size<this.capacity&&this.waiting.length){
      const t=this.waiting.shift();t.signal?.removeEventListener('abort',t.abort);
      if(t.signal?.aborted){t.reject(t.signal.reason??Error('Cancelled'));continue;}
      t.admittedAt=Date.now();this.active.set(t.id,t);let released=false;
      t.resolve({waitMs:t.admittedAt-t.queuedAt,release:()=>{if(released)return;released=true;this.active.delete(t.id);this.pump();this.changed();}});
    }
    this.changed();
  }
  changed(){try{this.onChange(this.snapshot());}catch{/* Diagnostic failure never changes resource ownership. */}}
  snapshot(){const project=t=>({rootId:t.rootId,sessionId:t.sessionId,queuedAt:t.queuedAt,admittedAt:t.admittedAt??null});return{closed:this.closed,capacity:this.capacity,owner:this.active.values().next().value?.rootId??null,active:[...this.active.values()].map(project),waiting:this.waiting.map(project)};}
  close(){this.closed=true;for(const t of this.waiting){t.signal?.removeEventListener('abort',t.abort);t.reject(Error('Scheduler unloaded'));}this.waiting=[];this.changed();}
}

// A slot is admitted capacity, not evidence that a process/model is computing.
// Only this project's counters/timestamps leave the shared gate snapshot.
export function sessionGateStatus(snapshot, rootId) {
  const active = snapshot.active.filter(entry => entry.rootId === rootId);
  const waiting = snapshot.waiting.filter(entry => entry.rootId === rootId);
  return { phase: active.length ? 'admitted' : waiting.length ? 'waiting' : 'idle',
    since: active.length ? Math.min(...active.map(entry => entry.admittedAt)) : waiting.length ? Math.min(...waiting.map(entry => entry.queuedAt)) : null,
    active: active.length, waiting: waiting.length };
}

export function heavyTool(exec) {
  if (exec.name === 'project_preview_restart') return true; // server-only captured-spec ticket
  if (exec.name === 'project_apps') return exec.arguments?.operation === 'verify_deploy';
  if (exec.name === 'verify_project') return true;
  if (!['project_exec', 'bash', 'terminal'].includes(exec.name)) return false;
  if (exec.arguments?.run_in_background === true) return true;
  const command = String(exec.arguments?.command ?? '').trim();
  // Only simple inspection commands bypass admission. Unknown scripts, shell
  // compounds and language runtimes can consume the same resources as a build.
  if (!command || /[\n\r;&|<>`$()]/u.test(command)) return true;
  return !/^(?:(?:pwd|ls|cat|head|tail|wc|stat|readlink|realpath|rg|grep|echo|printf)(?:\s|$)|git\s+(?:status|diff|log|show|ls-files)(?:\s|$))/u.test(command);
}

export const COMPACTION_HANDOFF='HomeAI handoff v2: Write a factual handoff in at most 600 words. Keep separate: original user goal and acceptance constraints; latest actual user correction and how it changes the goal; current files and verified changes; unsaved drafts, save conflicts and pending operations; unresolved errors with exact diagnostics or full-log paths; the next concrete action. Preserve any requested output draft already in progress. A status question or resume does not replace the original goal. Distinguish observed facts, assumptions, failed attempts and checks not run. Keep exact identifiers needed to continue. Omit repeated tool catalogs, environment boilerplate, chronological narration and superseded fixes. Do not invent progress or claim acceptance without evidence.';
export function normalizeCompaction(options){
  if(options.purpose!=='compaction'||options.messages?.some(message=>message.content?.some?.(block=>block.type==='text'&&block.text===COMPACTION_HANDOFF)))return null;
  return{...options,reasoningEffort:'off',maxTokens:4096,messages:[...(options.messages??[]),{role:'user',content:[{type:'text',text:COMPACTION_HANDOFF}]}]};
}
