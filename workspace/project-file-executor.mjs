import path from 'node:path';
import { projectFileWorker } from './project-file-worker.mjs';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const names = Object.freeze(['read','write','edit','glob','grep']);
const fields={read:new Set(['file_path','offset','limit']),write:new Set(['file_path','content']),edit:new Set(['file_path','old_string','new_string','replace_all']),glob:new Set(['pattern','path']),grep:new Set(['pattern','path','include'])};
const workerSource='('+projectFileWorker.toString()+')(JSON.parse(Buffer.from(process.argv[1],"base64").toString("utf8"))).then(value=>process.stdout.write(JSON.stringify(value)),()=>{process.stderr.write("ISOLATED_FILE_FAILED\\n");process.exitCode=1;});';
function fail(code){throw Error(code);}
// execute is A's trusted createProjectCommandRunner, which owns authority,
// read-only policy, isolated OS execution, deadlines and cancellation. Never
// supply a generic host shell. No environment-derived runtime path or fallback.
export function createProjectFileHandlers(execute) {
  if(typeof execute!=='function')return {};
  return Object.fromEntries(names.map(name=>[name,async(request,execution)=>{
    execution.signal.throwIfAborted();
    if(request.name!==name||!request.arguments||Object.keys(request.arguments).some(k=>!fields[name].has(k)))fail('INVALID_FILE_REQUEST');
    const search=name==='glob'||name==='grep',key=search?'path':'file_path';
    const root=request.project.root,p=request.arguments[key]??(search?'.':undefined);
    if(typeof root!=='string'||!path.posix.isAbsolute(root)||path.posix.normalize(root)!==root||root==='/'||typeof p!=='string'||!p||p.includes('\\')||p.includes('\0')||p.length>4096)fail('INVALID_PROJECT_PATH');
    let relative=p;
    if(path.posix.isAbsolute(p)) {
      if(search&&(p===root||p==='/workspace'))relative='.';
      else if(p.startsWith(root+'/'))relative=p.slice(root.length+1);
      else if(p.startsWith('/workspace/'))relative=p.slice('/workspace/'.length);
      else fail('OUTSIDE_PROJECT');
    }
    if(relative.split('/').some(part=>part==='..'))fail('OUTSIDE_PROJECT');
    const payload=Buffer.from(JSON.stringify({name,arguments:{...request.arguments,[key]:relative}}),'utf8');
    // Keep generated argv below the runner's 64KiB command limit and Linux's
    // single-argument limit. Larger writes need a future bounded stdin RPC.
    if(payload.length>32768)fail('FILE_REQUEST_LIMIT');
    const command='/opt/code-server/lib/node -e '+quote(workerSource)+' '+quote(payload.toString('base64'));
    const value=await execute({command,description:'Isolated project '+name,workdir:'.',timeoutMs:30000},execution);
    execution.signal.throwIfAborted();
    const result=value?.result;
    if(!result||result.exitCode!==0||result.signal||result.aborted||result.timedOut||result.stdout?.truncated||typeof result.stdout?.text!=='string'||Buffer.byteLength(result.stdout.text)>262144)fail('ISOLATED_FILE_EXECUTION_FAILED');
    let parsed;try{parsed=JSON.parse(result.stdout.text);}catch{fail('ISOLATED_FILE_RESULT_INVALID');}
    if(!parsed||typeof parsed.text!=='string'||typeof parsed.truncated!=='boolean')fail('ISOLATED_FILE_RESULT_INVALID');
    return {text:parsed.text,truncated:parsed.truncated};
  }]));
}
