// Synthetic raw envelopes and Root QA trace, never live benchmark evidence.
import {createHash} from 'node:crypto';
import {disabledSlot,serviceCommit,frozen,promptHashes,primaryPolicy,modelFor,b02Criteria} from './spec.mjs';
import {readActualPreviousRuns} from './prior.mjs';
import {collectorIdentity} from './runner.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex'),uuid=n=>'aaaaaaaa-bbbb-4ccc-8ddd-'+String(n).padStart(12,'0');
export function envelope(p){
 const start=1700000000000+(p.orderPosition-1)*1000000,policy=primaryPolicy(p.scenario),own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,p[k]])),requestId=uuid(p.orderPosition*10+1),checkpointId=uuid(p.orderPosition*10+2),previousCheckpointId=uuid(p.orderPosition*10+3);
 const snapshot={isTemplate:false,status:'FAIL',scenario:p.scenario,variant:p.variant,pairId:p.pairId,runId:p.runId,attemptId:p.attemptId,comparison:{orderPosition:p.orderPosition},identity:{...own,sourceCommit:serviceCommit,runtimeCommit:serviceCommit,manifestSha256:frozen.sourceManifestSha256,promptSha256:promptHashes[p.scenario],acceptanceVersion:frozen.acceptanceVersion,requestedModel:modelFor(p.variant)},limits:policy,
 operator:{finalized:true,requestId,baselineSeq:0,rootHandoff:'synthetic-prior',primaryDeadlineAt:new Date(start+policy.mainSeconds*1000).toISOString(),persistence:{unknownOutcome:false,lastDurableCheckpointId:previousCheckpointId,pendingCheckpointId:checkpointId}},slotHandoffEvidence:'synthetic-prior',nativeObservation:{promptAdmission:'accepted',settled:true,historyComplete:true,events:[{seq:1,type:'turn/start'},{seq:2,type:'turn/end'}]},timestampsUtc:{runSubmittedAt:new Date(start).toISOString(),finishedAt:new Date(start+1000).toISOString(),settledAt:new Date(start+1000).toISOString()},rootFinalization:{status:'SETTLED_VISIBLE',settled:true,visible:true,archiveState:'visible',sourceCommit:serviceCommit,requestId,target:own,tupleSha256:'b'.repeat(64),deadline:start+policy.mainSeconds*1000}};
 return{version:1,phase:'final',attemptId:p.attemptId,target:own,checkpointId,previousCheckpointId,requestId,snapshotSha256:sha(JSON.stringify(snapshot)),snapshot};
}
export function boundSlot(variant='DS'){
 const slot=structuredClone(disabledSlot(variant));Object.assign(slot,{executionEnabled:true,authorizationReference:uuid(100),pairId:'synthetic-current-B02-pair',runId:'synthetic-current-B02-'+variant,attemptId:'synthetic-current-B02-'+variant+'-primary',checkpointDirectory:'/synthetic/attemptA',previousPairs:{B03:'synthetic-current-B03-pair04',B10:'synthetic-current-B10-next',B01:'synthetic-current-B01-next'}});
 Object.assign(slot.target,{sessionId:'synthetic-own-session',workspaceId:'synthetic-own-workspace',projectId:'synthetic-own-project',projectRoot:'/data/harness/workspaces/projects/synthetic-own-session',preparedFixtureEvidence:'/synthetic/B02-fixture-proof.json'});
 const files=new Map();for(const [i,p]of slot.previous.entries()){
  Object.assign(p,{pairId:p.scenario==='B02'?slot.pairId:slot.previousPairs[p.scenario],runId:'synthetic-prior-run-'+i,attemptId:p.scenario==='B03'?'b03-pair04-'+p.variant+'-primary':'synthetic-'+p.scenario+'-'+p.variant+'-primary',sessionId:'synthetic-prior-session-'+i,workspaceId:'synthetic-prior-workspace-'+i,projectId:'synthetic-prior-project-'+i,checkpointDirectory:'/synthetic/n06-b03-pair04-prior-'+i});
  p.checkpointFile=p.checkpointDirectory+'/'+uuid(p.orderPosition*10+2)+'.json';const bytes=Buffer.from(JSON.stringify(envelope(p)));p.checkpointSha256=sha(bytes);files.set(p.checkpointFile,bytes);
 }
 const read=(file,cap)=>{const b=files.get(file);if(b.length>cap)throw Error('cap');return b;};return{slot,files,read,previousRuns:readActualPreviousRuns(slot,read)};
}
export async function syntheticReport(f){
 const receipt=await f.driver.restart(),at=new Date(f.clock.now()).toISOString(),identity=collectorIdentity(f.result),rows=prefix=>frozen.expectedImportedRows.map((r,i)=>({id:prefix+i,...r})),apiRows=rows('synthetic-api-'),uiRows=rows('synthetic-ui-'),savedRows=rows('synthetic-reimport-');
 const evidence=Array.from({length:8},(_,i)=>({phase:'Q'+i,at,collectorIdentity:structuredClone(identity),primaryDeadlineAt:f.result.operator.primaryDeadlineAt,actionEvidence:'synthetic controlled action; not actual QA'}));
 Object.assign(evidence[0],{rows:[],previewEvidence:'synthetic'});
 Object.assign(evidence[1],{apiReport:{scenario:'B02',base:'https://synthetic.invalid/app/',status:'PASS',checks:['CSV Unicode quoting and invalid line','search sort and literal HTML','CSV download actual attachment and roundtrip'].map(name=>({name,status:'PASS'})),created:[]},afterRows:apiRows});
 Object.assign(evidence[2],{deleted:apiRows.map(r=>({id:r.id,status:204})),afterRows:[]});
 Object.assign(evidence[3],{beforeRows:[],afterRows:uiRows,importResponse:{imported:4,errors:[{line:6}]}});
 Object.assign(evidence[4],{zeroResponse:{status:201,body:{id:'synthetic-zero',quantity:0}},zeroDelete:{id:'synthetic-zero',status:204},negativeResponse:{status:400,body:{error:'synthetic'}},fractionResponse:{status:400,body:{error:'synthetic'}},afterRows:uiRows});
 const csv='Synthetic download bytes, not a frozen fixture',download={csv,sha256:sha(csv),contentDisposition:'attachment; filename=synthetic.csv'};
 Object.assign(evidence[5],{beforeRows:uiRows,deleted:uiRows.map(r=>({id:r.id,status:204})),emptyRows:[],download,reimportBodySha256:download.sha256,importResponse:{imported:4,errors:[]},afterRows:savedRows});
 Object.assign(evidence[6],{beforeRows:savedRows,afterRows:structuredClone(savedRows)});evidence[7].completedCriteria=[...b02Criteria];
 return{collectorIdentity:identity,checks:b02Criteria.map(id=>({id,status:'PASS',evidence:['synthetic criterion; not actual QA']})),orderingEvidence:evidence,restartEvidence:{kind:'B02_OWN_CATALOG_RESTART',sourceCommit:serviceCommit,target:Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,f.own[k]])),...receipt,beforeRows:savedRows,afterRows:structuredClone(savedRows)},previewUrl:'https://synthetic.invalid/app/',previewEvidence:'synthetic',artifactEvidence:'synthetic',reopenInstructions:'synthetic',validationStartedAt:at,finishedAt:at,qaWorkSettledAt:at,qaWorkSettlementEvidence:'synthetic controlled collector',provider:f.own.modelSelection.provider,effectiveModel:f.own.modelSelection.model,effectiveInferenceEvidence:'synthetic header',sourceCommit:serviceCommit,runtimeCommit:serviceCommit};
}
