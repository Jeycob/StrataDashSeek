// Constructed identities/envelopes only; none represent a live benchmark.
import {createHash} from 'node:crypto';
import {disabledSlot,frozen,serviceCommit} from './spec.mjs';
import {readActualPreviousRuns} from './prior.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const uuid=n=>'aaaaaaaa-bbbb-4ccc-8ddd-'+String(n).padStart(12,'0');
export function envelope(expected){
 const start=1700000000000,own=Object.fromEntries(['sessionId','workspaceId','projectId'].map(k=>[k,expected[k]])),requestId=uuid(1),checkpointId=uuid(2),previousCheckpointId=uuid(3);
 const snapshot={isTemplate:false,status:'FAIL',scenario:expected.scenario,variant:expected.variant,pairId:expected.pairId,runId:expected.runId,attemptId:expected.attemptId,comparison:{orderPosition:expected.orderPosition},
 identity:{...own,sourceCommit:serviceCommit,runtimeCommit:serviceCommit,manifestSha256:frozen.frozenManifestSha256,promptSha256:expected.promptSha256,acceptanceVersion:'paired-20261116 v1 + product-qa supplement v1',requestedModel:expected.modelSelection},
 operator:{requestId,baselineSeq:0,rootHandoff:'synthetic-prior-only',primaryDeadlineAt:new Date(start+600000).toISOString(),finalized:true,persistence:{unknownOutcome:false,pendingCheckpointId:checkpointId,lastDurableCheckpointId:previousCheckpointId}},slotHandoffEvidence:'synthetic-prior-only',
 nativeObservation:{promptAdmission:'accepted',settled:true,historyComplete:true,events:[{seq:1,type:'turn/start'},{seq:2,type:'turn/end'}]},limits:{mainSeconds:600},timestampsUtc:{runSubmittedAt:new Date(start).toISOString(),finishedAt:new Date(start+1000).toISOString(),settledAt:new Date(start+1000).toISOString()},
 rootFinalization:{status:'SETTLED_VISIBLE',settled:true,visible:true,archiveState:'visible',sourceCommit:serviceCommit,requestId,target:own,tupleSha256:'d'.repeat(64),deadline:start+600000}};
 return{version:1,phase:'final',attemptId:expected.attemptId,target:own,checkpointId,previousCheckpointId,requestId,snapshot,snapshotSha256:sha(JSON.stringify(snapshot))};
}
export function boundSlot(variant='DS'){
 const slot=structuredClone(disabledSlot(variant));Object.assign(slot,{executionEnabled:true,authorizationReference:uuid(4),checkpointDirectory:'/synthetic/attemptA'});
 Object.assign(slot.target,{sessionId:'synthetic-own-session',workspaceId:'synthetic-own-workspace',projectId:'synthetic-own-project',projectRoot:'/data/harness/workspaces/projects/synthetic-own-session',preparedFixtureEvidence:'/synthetic/frozen-seed.json'});
 const files=new Map();
 for(const [i,p]of slot.previous.entries()){
  Object.assign(p,{pairId:p.scenario==='B10'?slot.pairId:'synthetic-b03-pair04',runId:'synthetic-prior-run-'+i,attemptId:p.scenario==='B03'?'b03-pair04-'+p.variant.toLowerCase()+'-primary':'b10-next-ds-primary-20261118',sessionId:'synthetic-prior-session-'+i,workspaceId:'synthetic-prior-workspace-'+i,projectId:'synthetic-prior-project-'+i,checkpointDirectory:'/synthetic/n06-b03-pair04-'+i});
  p.checkpointFile=p.checkpointDirectory+'/'+uuid(2)+'.json';const bytes=Buffer.from(JSON.stringify(envelope(p)));p.checkpointSha256=sha(bytes);files.set(p.checkpointFile,bytes);
 }
 const previousRuns=readActualPreviousRuns(slot,(file,cap)=>{const b=files.get(file);if(b.length>cap)throw Error('cap');return b;});
 return{slot,previousRuns,files};
}
