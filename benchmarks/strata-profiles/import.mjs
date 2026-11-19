// Offline projection of existing N06 collector exports. Never submits prompts,
// reads credentials, imports executable input, or treats a plan as a result.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const MAX_INPUT=1024*1024,MAX_OUTPUT=32768;
const need=(value,code)=>{if(!value)throw Error(code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u001f\u007f]/u.test(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
function pinnedList(rows){
 need(Array.isArray(rows)&&rows.length<=100,'FROZEN_HASH_LIST_REQUIRED');
 need(rows.every(row=>text(row?.path)&&hash(row.sha256)&&Number.isSafeInteger(row.bytes)&&row.bytes>=0),'FROZEN_HASH_LIST_INVALID');
 need(new Set(rows.map(row=>row.path)).size===rows.length,'DUPLICATE_FROZEN_PATH');
 return rows.map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function completeRows(value){return value?.known===true&&value.truncated===false&&value.omittedRows===0&&Array.isArray(value.rows)&&value.rows.length<=128&&value.totalRows===value.rows.length&&value.returnedRows===value.rows.length?value.rows:null;}
export async function readArtifact(file){
 const handle=await fs.open(file,'r');
 try{const stat=await handle.stat();need(stat.isFile()&&stat.size<=MAX_INPUT,'ARTIFACT_TOO_LARGE');const bytes=Buffer.alloc(MAX_INPUT+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);need(bytesRead<=MAX_INPUT,'ARTIFACT_TOO_LARGE');const raw=bytes.subarray(0,bytesRead);return{value:JSON.parse(raw.toString('utf8')),sha256:sha(raw)};}finally{await handle.close();}
}
export function importCollectorRun({plan,terminal,metrics},workspaceId){
 need(text(workspaceId),'WORKSPACE_REQUIRED');
 for(const artifact of [plan,terminal,metrics])need(artifact?.value&&hash(artifact.sha256),'ARTIFACT_DIGEST_REQUIRED');
 const p=plan.value,t=terminal.value,m=metrics.value,c=t.collectorIdentity,i=p.identity;
 need(p.recordVersion===1&&p.recordKind==='model_benchmark_attempt'&&i,'COLLECTOR_PLAN_REQUIRED');
 need(t.version===1&&t.event==='terminal'&&t.started===true&&c?.version===1,'ACTUAL_TERMINAL_REQUIRED');
 need(m.version===1&&m.status==='OBSERVED_READ_ONLY_PROJECTION'&&m.readOnly===true&&m.checkpoint?.phase==='final'&&hash(m.checkpoint.sha256),'FINAL_METRICS_REQUIRED');
 for(const key of ['scenario','variant','pairId','runId','attemptId'])need(text(p[key])&&p[key]===c[key]&&p[key]===m.record?.[key],'RUN_IDENTITY_MISMATCH');
 for(const key of ['sessionId','workspaceId','projectId','sourceCommit','runtimeCommit'])need(text(i[key])&&i[key]===c[key]&&i[key]===m.identity?.[key],'SESSION_IDENTITY_MISMATCH');
 for(const key of ['sessionId','workspaceId','projectId','sourceCommit'])need(t[key]===c[key],'TERMINAL_IDENTITY_MISMATCH');
 need(commit(i.sourceCommit)&&commit(i.runtimeCommit)&&hash(i.promptSha256)&&hash(i.manifestSha256)&&i.promptSha256===c.promptSha256&&i.manifestSha256===c.manifestSha256&&i.acceptanceVersion===c.acceptanceVersion,'FROZEN_IDENTITY_MISMATCH');
 need(text(c.requestId)&&c.requestId===m.operator?.requestId&&c.requestId===m.checkpoint.requestId&&c.attemptId===m.checkpoint.attemptId,'REQUEST_IDENTITY_MISMATCH');
 need(m.nativeObservation?.promptAdmission==='accepted'&&m.operator.finalized===true&&m.operator.persistenceFailed!==true&&m.operator.persistence?.unknownOutcome!==true,'RESULT_NOT_CONFIRMED');
 const submittedAt=date(m.timestampsUtc?.runSubmittedAt),finishedAt=date(m.timestampsUtc?.settledAt??m.timestampsUtc?.finishedAt);
 need(submittedAt!==null&&submittedAt===date(t.primaryStartedAt)&&finishedAt!==null&&finishedAt>=submittedAt&&date(t.observedAtUtc)>=finishedAt,'RUN_TIMING_MISMATCH');
 const fixtureHashes=pinnedList(i.fixtureHashes),acceptanceHashes=pinnedList(i.acceptanceHashes);need(acceptanceHashes.length>0,'ACCEPTANCE_HASHES_REQUIRED');
 const budget=p.limits;need(budget&&['mainSeconds','repairSeconds','maxRepairs'].every(key=>Number.isSafeInteger(budget[key])&&budget[key]>=0),'FROZEN_BUDGET_REQUIRED');
 const evidenceId='sha256:'+metrics.sha256,checks=completeRows(m.quality?.checks);
 // A deadline/blocked result is not a failed correctness check. Only completed
 // independent criteria establish pass/fail; acceptance time also needs PASS.
 const allPass=checks?.length>0&&checks.length===m.quality.mandatoryCriteriaCount&&new Set(checks.map(row=>row.id)).size===checks.length&&checks.every(row=>row.status==='PASS'&&Array.isArray(row.evidence)&&row.evidence.length>0);
 const accepted=m.quality?.accepted===true&&allPass?true:checks?.some(row=>row.status==='FAIL'&&Array.isArray(row.evidence)&&row.evidence.length>0)?false:null;
 const acceptedAt=date(m.timestampsUtc?.acceptedAt);
 const routes=completeRows(m.resolvedRequestRoutes),requestRoutes=routes?.length&&routes.every(row=>text(row.provider)&&text(row.model))?[...new Map(routes.map(row=>[row.provider+'\0'+row.model,{provider:row.provider,model:row.model}])).values()]:null;
 return{id:p.attemptId,pairId:p.pairId,workspaceId,sourceWorkspaceId:i.workspaceId,sessionId:i.sessionId,requestId:c.requestId,sourceCommit:i.sourceCommit,profileName:p.variant,
  submittedAt,finishedAt,epoch:null,status:['PASS','FAIL','BLOCKED'].includes(m.record.status)?m.record.status:null,
  comparison:{definition:i.acceptanceVersion,promptSha256:i.promptSha256,inputSha256:sha(JSON.stringify(fixtureHashes)),acceptanceSha256:sha(JSON.stringify(acceptanceHashes)),runtimeCommit:i.runtimeCommit,budgetSha256:sha(JSON.stringify({mainSeconds:budget.mainSeconds,repairSeconds:budget.repairSeconds,maxRepairs:budget.maxRepairs})),cacheCondition:m.identity.cacheState==='unknown'?null:m.identity.cacheState,contextTokens:m.identity.contextLimit??null},
  acceptance:accepted===null?null:{passed:accepted,at:acceptedAt!==null&&acceptedAt>=submittedAt&&acceptedAt<=finishedAt?acceptedAt:null,evidenceId},
  requestRoutes:requestRoutes?{complete:true,rows:requestRoutes,evidenceId}:null,
  // The archived projection does not prove process residency, quantization or
  // memory at this run. Do not borrow a current health sample or B005 receipt.
  serving:null,memory:null,sourceEvidence:[plan.sha256,terminal.sha256,metrics.sha256].map(value=>'sha256:'+value)};
}
export function makeReport(runs){
 need(runs.length>0&&runs.length<=100&&new Set(runs.map(row=>row.id)).size===runs.length,'DUPLICATE_OR_EXCESS_RUNS');
 const groups=new Map();for(const row of runs){const key=row.workspaceId+'\0'+row.pairId,group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 const output=[];for(const group of groups.values()){need(group.length<=2,'PAIR_HAS_MORE_THAN_TWO_RUNS');group.sort((a,b)=>a.submittedAt-b.submittedAt||a.id.localeCompare(b.id));for(const [index,row]of group.entries())output.push({...row,arm:index===0?'A':'B'});}
 const report={version:1,runs:output};need(Buffer.byteLength(JSON.stringify(report))<=MAX_OUTPUT,'REPORT_TOO_LARGE');return report;
}
export async function main(args){
 let workspaceId,output;const runs=[];
 for(let index=0;index<args.length;){const flag=args[index++];if(flag==='--workspace'&&!workspaceId)workspaceId=args[index++];else if(flag==='--output'&&!output)output=args[index++];else if(flag==='--run'){const paths=args.slice(index,index+3);need(paths.length===3&&paths.every(value=>!value.startsWith('--')),'RUN_NEEDS_PLAN_TERMINAL_METRICS');runs.push(paths);index+=3;}else throw Error('USAGE: --workspace ID --output NEW.json --run PLAN.json TERMINAL.json METRICS.json [--run ...]');}
 need(text(workspaceId)&&output&&runs.length>0&&runs.length<=100,'IMPORT_ARGUMENTS_REQUIRED');
 const imported=[];for(const paths of runs){const [plan,terminal,metrics]=await Promise.all(paths.map(readArtifact));imported.push(importCollectorRun({plan,terminal,metrics},workspaceId));}
 const report=makeReport(imported);await fs.writeFile(output,JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});
 return{runs:report.runs.length,sha256:sha(await fs.readFile(output)),unknownServing:report.runs.filter(row=>!row.serving).length,unknownMemory:report.runs.filter(row=>!row.memory).length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
