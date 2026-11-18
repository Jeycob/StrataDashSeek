// Frozen primary policies only. No caller-selected budget, repair or live effects.
export const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
export const serviceCommit='266196e9427db575609cbbe5c8c6fb7c814f27ff';
export const manifestSha256='42fd252df7390ea830b9225b08e0d3f48b49b5358b94dfc7dee4f262d02e832f';
export const acceptanceVersion='paired-20261116 v1 + product-qa supplement v1';
export const promptHashes=Object.freeze({B03:'9e446d2b5b2cf83f803a3a0e35868d8bd258f6851ef9fe4073c2254c1cf34f9e',B10:'e4dc252381e867be2d9c55845c1054fed70b8c15575fc0d0d02bee8888349224',B01:'ee4052dc6f2e4a1b7a82207fc4b8184d15e059695dd4598f23510f488881a431'});
export const campaignOrder=Object.freeze(['B03 HomeAI','B03 DS','B10 DS','B10 HomeAI','B01 HomeAI','B01 DS']);
export const b01Criteria=Object.freeze([...Array.from({length:6},(_,i)=>'B01-'+String(i+1).padStart(2,'0')),...Array.from({length:5},(_,i)=>'B01-C'+String(i+1).padStart(2,'0'))]);
const policies=Object.freeze({B03:Object.freeze({mainSeconds:600,repairSeconds:300,maxRepairs:1}),B10:Object.freeze({mainSeconds:600,repairSeconds:300,maxRepairs:1}),B01:Object.freeze({mainSeconds:900,repairSeconds:300,maxRepairs:1})});
export const primaryPolicy=scenario=>policies[scenario]??null;
export const matchesPrimaryLimits=record=>!!policies[record?.scenario]&&Object.entries(policies[record.scenario]).every(([k,v])=>record.limits?.[k]===v);
export function originalPrimaryDeadline(record,started){need(matchesPrimaryLimits(record)&&Number.isSafeInteger(started)&&Number.isSafeInteger(started+policies[record.scenario].mainSeconds*1000),'ORIGINAL_SCENARIO_POLICY_REQUIRED');return started+policies[record.scenario].mainSeconds*1000;}
export const modelFor=variant=>variant==='HomeAI'?{provider:'strata-vast',model:'strata',reasoningEffort:'medium'}:variant==='DS'?{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'}:null;
export const ineligibleSession='session-5007e9ba-0d62-4255-b375-e8b4fb4fb39d';
const token=x=>typeof x==='string'&&x.length>0&&x.length<=256;
export function validateB01Primary(record,target){
 need(record?.scenario==='B01'&&['HomeAI','DS'].includes(record.variant)&&matchesPrimaryLimits(record),'FIXED_B01_PRIMARY_REQUIRED');
 need(['pairId','runId','attemptId'].every(k=>token(record[k]))&&record.comparison?.orderPosition===(record.variant==='HomeAI'?5:6),'FIXED_B01_ATTEMPT_ORDER_REQUIRED');
 // Actual prompt bytes/hash are verified by the existing inputs.verify boundary.
 // It also permits the canonical in-memory test seam to use synthetic bytes.
 need(record.identity?.sourceCommit===serviceCommit&&record.identity.runtimeCommit===serviceCommit&&record.identity.manifestSha256===manifestSha256&&/^[a-f0-9]{64}$/.test(record.identity.promptSha256??'')&&record.identity.acceptanceVersion===acceptanceVersion,'B01_FROZEN_SERVICE_INPUTS_REQUIRED');
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(k=>token(target[k]))&&target.sessionId!==ineligibleSession&&target.projectRoot==='/data/harness/workspaces/projects/'+target.sessionId&&typeof target.preparedFixtureEvidence==='string'&&target.preparedFixtureEvidence.startsWith('/'),'FRESH_OWN_B01_PROJECT_REQUIRED');
 need(JSON.stringify(target.modelSelection)===JSON.stringify(modelFor(record.variant)),'B01_FROZEN_MODEL_REQUIRED');return true;
}
export function disabledB01Slot(variant){
 need(['HomeAI','DS'].includes(variant),'B01_VARIANT_REQUIRED');
 return{executionEnabled:false,authorizationReference:null,scenario:'B01',variant,orderPosition:variant==='HomeAI'?5:6,pairId:null,runId:null,attemptId:null,limits:primaryPolicy('B01'),
 target:{owned:true,sessionId:null,workspaceId:null,projectId:null,projectRoot:null,sessionUrl:null,preparedFixtureEvidence:null,modelSelection:modelFor(variant)},fixtureFiles:[],checkpointDirectory:null,runtimeProof:null,primaryStartedAt:null,primaryDeadlineAt:null,
 previous:campaignOrder.slice(0,variant==='HomeAI'?4:5).map((label,i)=>({label,orderPosition:i+1,pairId:null,runId:null,attemptId:null,sessionId:null,workspaceId:null,projectId:null,checkpointDirectory:null,checkpointFile:null,checkpointSha256:null,actualWriterReceipt:null}))};
}
