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

export const heavyTool = exec => exec.name==='verify_project'||exec.name==='project_exec'&&/\b(?:npm|pnpm|yarn|dotnet|pytest|playwright|tsc|vite|cargo|make|cmake|gcc|clang|pip)\b/u.test(exec.arguments?.command??'');

export function normalizeCompaction(options){
  if(options.purpose!=='compaction'||options.reasoningEffort==='off'&&(options.maxTokens??0)>=8192)return null;
  return{...options,reasoningEffort:'off',maxTokens:Math.max(8192,options.maxTokens??0),messages:[...(options.messages??[]),{role:'user',content:[{type:'text',text:'Write a factual handoff in at most1000 words. Preserve the concrete goal, constraints, exact paths, verified changes, unresolved errors and next actions. Do not repeat tool catalogs or environment boilerplate. Do not invent facts.'}]}]};
}
