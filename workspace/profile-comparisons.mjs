// Input is an operator-owned bounded report, never browser-supplied claims.
// Reference #16's exact prompt/input/oracle hashes and #17's frozen paired
// acceptance. This reader neither defines another benchmark nor starts runs.
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const text=(value,max=160)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value)?value:null;
const time=value=>Number.isSafeInteger(value)&&value>0;
const bytes=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function observed(sample,run){
 return sample&&text(sample.evidenceId)&&text(sample.epoch)&&sample.epoch===run.epoch&&time(sample.observedAt)&&time(run.submittedAt)&&time(run.finishedAt)&&sample.observedAt>=run.submittedAt&&sample.observedAt<=run.finishedAt;
}
function record(run){
 if(!text(run?.id)||!text(run.pairId)||!['A','B'].includes(run.arm))return null;
 const identity=run.comparison,comparableIdentity=identity&&text(identity.definition)&&hash(identity.promptSha256)&&hash(identity.inputSha256)&&hash(identity.acceptanceSha256)&&commit(identity.runtimeCommit)&&hash(identity.budgetSha256)&&text(identity.cacheCondition)&&Number.isSafeInteger(identity.contextTokens)&&identity.contextTokens>0?{definition:identity.definition,promptSha256:identity.promptSha256,inputSha256:identity.inputSha256,acceptanceSha256:identity.acceptanceSha256,runtimeCommit:identity.runtimeCommit,budgetSha256:identity.budgetSha256,cacheCondition:identity.cacheCondition,contextTokens:identity.contextTokens}:null;
 const serving=observed(run.serving,run)&&text(run.serving.provider)&&text(run.serving.model)?{provider:run.serving.provider,model:run.serving.model,observedAt:run.serving.observedAt,evidenceId:run.serving.evidenceId,quantization:hash(run.serving.configurationSha256)?text(run.serving.quantization,80):null,configurationSha256:hash(run.serving.configurationSha256)?run.serving.configurationSha256:null}:null;
 const memory=observed(run.memory,run)&&['sample','peak'].includes(run.memory.kind)?{kind:run.memory.kind,rssBytes:bytes(run.memory.rssBytes),vramBytes:bytes(run.memory.vramBytes),observedAt:run.memory.observedAt,evidenceId:run.memory.evidenceId}:null;
 const sample=run.sharedMemory,sharedMemory=observed(sample,run)&&sample.kind==='sample'&&time(sample.monitorStartedAt)&&sample.monitorStartedAt<=sample.observedAt?{kind:'sample',ramScope:['container','host'].includes(sample.ramScope)?sample.ramScope:null,ramUsedBytes:['container','host'].includes(sample.ramScope)?bytes(sample.ramUsedBytes):null,gpuScope:'whole-gpu',gpuUsedBytes:sample.gpuScope==='whole-gpu'?bytes(sample.gpuUsedBytes):null,observedAt:sample.observedAt,evidenceId:sample.evidenceId}:null;
 const accepted=typeof run.acceptance?.passed==='boolean'&&text(run.acceptance.evidenceId)?run.acceptance.passed:null;
 const acceptedMs=accepted===true&&time(run.submittedAt)&&time(run.acceptance.at)&&run.acceptance.at>=run.submittedAt&&time(run.finishedAt)&&run.acceptance.at<=run.finishedAt?run.acceptance.at-run.submittedAt:null;
 const routes=run.requestRoutes,requestRoutes=routes?.complete===true&&text(routes.evidenceId)&&Array.isArray(routes.rows)&&routes.rows.length>0&&routes.rows.length<=128&&routes.rows.every(row=>text(row?.provider)&&text(row?.model))?{rows:routes.rows.map(({provider,model})=>({provider,model})),evidenceId:routes.evidenceId}:null;
 const sourceEvidence=Array.isArray(run.sourceEvidence)?run.sourceEvidence.filter(value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value)).slice(0,3):[];
 const configured=run.requestedConfiguration,sampling=configured?.sampling;
 const requestedConfiguration=sampling&&['maxTokens','thinkingBudget','temperature','topP'].every(key=>Number.isFinite(sampling[key]))?{name:text(configured.name,80),requestedQuantization:text(configured.requestedQuantization,80),sampling:Object.fromEntries(['maxTokens','thinkingBudget','temperature','topP'].map(key=>[key,sampling[key]]))}:null;
 const sourceBinding={sessionId:text(run.sessionId),requestId:text(run.requestId),sourceWorkspaceId:text(run.sourceWorkspaceId),sourceCommit:commit(run.sourceCommit)?run.sourceCommit:null,promptSha256:hash(identity?.promptSha256)?identity.promptSha256:null,inputSha256:hash(identity?.inputSha256)?identity.inputSha256:null,acceptanceSha256:hash(identity?.acceptanceSha256)?identity.acceptanceSha256:null,requestedConfiguration};
 const modelFinishedMs=time(run.modelFinishedAt)&&time(run.submittedAt)&&time(run.finishedAt)&&run.modelFinishedAt>=run.submittedAt&&run.modelFinishedAt<=run.finishedAt?run.modelFinishedAt-run.submittedAt:null;
 return{id:run.id,arm:run.arm,pairId:run.pairId,profileName:text(run.profileName,80),comparison:comparableIdentity,sourceBinding,sourceEvidence,status:['PASS','FAIL','BLOCKED'].includes(run.status)?run.status:null,requestRoutes,requestedQuantization:text(run.requestedQuantization,80),serving,memory,sharedMemory,modelFinishedMs,acceptanceTimeBasis:run.acceptanceTimeBasis==='server-receipt-after-independent-checks'?run.acceptanceTimeBasis:null,accepted,acceptanceEvidence:accepted===null?null:run.acceptance.evidenceId,acceptedMs};
}
export function profileComparisons(report,workspaceId){
 if(report?.version!==1||!Array.isArray(report.runs)||report.runs.length>100)throw Error('PROFILE_HISTORY_INVALID');
 const groups=new Map();
 for(const run of report.runs){if(run?.workspaceId!==workspaceId)continue;const value=record(run);if(!value)continue;const rows=groups.get(value.pairId)??[];rows.push(value);groups.set(value.pairId,rows);}
 const pairs=[...groups].map(([id,rows])=>{
  const sameInput=rows.length===2&&rows[0].id!==rows[1].id&&rows[0].arm!==rows[1].arm&&rows.every(row=>row.comparison)&&JSON.stringify(rows[0].comparison)===JSON.stringify(rows[1].comparison);
  const quantizationComparable=sameInput&&rows.every(row=>row.serving?.quantization&&row.serving?.configurationSha256)&&rows[0].serving.provider===rows[1].serving.provider&&rows[0].serving.model===rows[1].serving.model;
  const [a,b]=[rows.find(row=>row.arm==='A'),rows.find(row=>row.arm==='B')];
  return{id,sameInput,quantizationComparable,rows,acceptedDeltaMs:sameInput&&a.acceptedMs!==null&&b.acceptedMs!==null?b.acceptedMs-a.acceptedMs:null};
 });return{state:'available',pairs};
}
