// Fixed disabled source. Root authors a distinct reviewed bound copy later.
import pins from './frozen-pins.json' with {type:'json'};
export const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
export const serviceCommit=pins.serviceCommit,operatorProducerCommit=pins.operatorProducerCommit;
export const ineligibleSession='session-5007e9ba-0d62-4255-b375-e8b4fb4fb39d';
export const campaignOrder=freeze([['B03','HomeAI'],['B03','DS'],['B10','DS'],['B10','HomeAI']]);
export const limits=freeze({mainSeconds:600,repairSeconds:300,maxRepairs:1,callbackMs:4000,settlementMs:120000,preparationMs:30000,checkpointBudgetBytes:67108864,checkpointBudgetCount:2048});
export const frozen=freeze(pins);
const model=variant=>variant==='DS'?{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'}:{provider:'strata-vast',model:'strata',reasoningEffort:'medium'};
const prior=(scenario,variant,orderPosition)=>({scenario,variant,orderPosition,pairId:null,runId:null,attemptId:null,sessionId:null,workspaceId:null,projectId:null,modelSelection:model(variant),promptSha256:scenario==='B03'?'9e446d2b5b2cf83f803a3a0e35868d8bd258f6851ef9fe4073c2254c1cf34f9e':pins.files.find(x=>x.path==='prompts/B10.txt').sha256,checkpointDirectory:null,checkpointFile:null,checkpointSha256:null,actualWriterReceipt:null});
export function disabledSlot(variant){
 need(['DS','HomeAI'].includes(variant),'B10_VARIANT_REQUIRED');
 const lower=variant.toLowerCase(),orderPosition=variant==='DS'?3:4;
 return freeze({version:1,executionEnabled:false,authorizationReference:null,scenario:'B10',variant,orderPosition,
  pairId:'B10-next-source-20261118',runId:'b10-next-'+lower+'-20261118',attemptId:'b10-next-'+lower+'-primary-20261118',
  serviceCommit,operatorProducerCommit,limits,
  target:{owned:true,scenario:'B10',variant,sessionId:null,workspaceId:null,projectId:null,projectRoot:null,sessionUrl:null,
   modelSelection:model(variant),preparedFixtureEvidence:null},
  checkpointDirectory:null,codeRoot:null,recordSha256:null,frozenRoot:null,qaRoot:null,
  actualRuntimeProofFile:null,actualRuntimeProofSha256:null,
  previous:campaignOrder.slice(0,orderPosition-1).map(([scenario,v],i)=>prior(scenario,v,i+1)),
  actual:{runtimeBaseline:null,pid:null,epoch:null,qualification:null,primaryStartedAt:null,primaryDeadlineAt:null},
 });
}
const token=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const absolute=x=>typeof x==='string'&&x.startsWith('/')&&!x.split('/').includes('..')&&!/[\x00-\x20\\]/.test(x);
export function validateFixedSlot(slot,{requireEnabled=true}={}){
 need(slot?.scenario==='B10'&&['DS','HomeAI'].includes(slot.variant)&&slot.orderPosition===(slot.variant==='DS'?3:4),'B10_FIXED_SLOT_REQUIRED');
 need(slot.serviceCommit===serviceCommit&&slot.operatorProducerCommit===operatorProducerCommit&&slot.serviceCommit!==slot.operatorProducerCommit,'SERVICE_PRODUCER_IDENTITY_MISMATCH');
 need(JSON.stringify(slot.limits)===JSON.stringify(limits),'ORIGINAL_B10_LIMITS_REQUIRED');
 if(requireEnabled)need(slot.executionEnabled===true&&token(slot.authorizationReference),'SOURCE_DISABLED_ROOT_BINDING_REQUIRED');
 need(['sessionId','workspaceId','projectId'].every(k=>token(slot.target?.[k]))&&slot.target.sessionId!==ineligibleSession&&!slot.target.projectRoot?.includes(ineligibleSession),'FRESH_ELIGIBLE_B10_TARGET_REQUIRED');
 need(slot.target.owned===true&&slot.target.scenario==='B10'&&slot.target.variant===slot.variant&&absolute(slot.target.projectRoot)&&absolute(slot.target.preparedFixtureEvidence)&&absolute(slot.checkpointDirectory),'FIXED_ROOT_LOCATIONS_REQUIRED');
 const expected=disabledSlot(slot.variant).target.modelSelection;
 need(JSON.stringify(slot.target.modelSelection)===JSON.stringify(expected),'FROZEN_MODEL_SELECTION_REQUIRED');
 need(Array.isArray(slot.previous)&&slot.previous.length===slot.orderPosition-1,'EXACT_CAMPAIGN_PRIORS_REQUIRED');
 for(const [i,p]of slot.previous.entries()){
  need(p.scenario===campaignOrder[i][0]&&p.variant===campaignOrder[i][1]&&p.orderPosition===i+1,'EXACT_CAMPAIGN_PRIORS_REQUIRED');
  need(['pairId','runId','attemptId','sessionId','workspaceId','projectId'].every(k=>token(p[k]))&&p.sessionId!==ineligibleSession,'ACTUAL_PRIOR_IDENTITY_REQUIRED');
  need(JSON.stringify(p.modelSelection)===JSON.stringify(model(p.variant))&&p.promptSha256===prior(p.scenario,p.variant,i+1).promptSha256,'EXACT_PRIOR_MODEL_PROMPT_REQUIRED');
  if(p.scenario==='B03')need(p.attemptId.startsWith('b03-pair04-')&&p.checkpointDirectory?.includes('/n06-b03-pair04-'),'NEW_B03_PAIR04_PRIOR_REQUIRED');
  need(absolute(p.checkpointDirectory)&&typeof p.checkpointFile==='string'&&p.checkpointFile.startsWith(p.checkpointDirectory+'/')&&/^[a-f0-9-]{36}\.json$/.test(p.checkpointFile.slice(p.checkpointDirectory.length+1))&&/^[a-f0-9]{64}$/.test(p.checkpointSha256??''),'ACTUAL_PRIOR_PATH_HASH_REQUIRED');
 }
 if(slot.variant==='HomeAI')need(slot.previous[2].pairId===slot.pairId,'B10_DS_FIRST_SAME_PAIR_REQUIRED');
 need(new Set([...slot.previous.map(p=>p.sessionId),slot.target.sessionId]).size===slot.orderPosition,'DISTINCT_FRESH_TARGETS_REQUIRED');
 return slot;
}
export function validateAuthority(slot,handoff){
 validateFixedSlot(slot);
 need(handoff?.liveAuthorized===true&&handoff.rootOperator===true&&token(handoff.id),'ROOT_HANDOFF_REQUIRED');
 need(handoff.sourceCommit===serviceCommit&&handoff.runtimeCommit===serviceCommit&&handoff.orderPosition===slot.orderPosition,'B10_RUNTIME_ORDER_REQUIRED');
 need(handoff.settlementObservationMs===limits.settlementMs,'FIXED_SETTLEMENT_WINDOW_REQUIRED');
 return handoff;
}
export function validateRuntimeBindings(slot){
 validateFixedSlot(slot);
 need(['codeRoot','frozenRoot','qaRoot','actualRuntimeProofFile'].every(k=>absolute(slot[k])&&slot[k].startsWith('/data/harness/root-secrets/')),'ACTUAL_PROTECTED_RUNTIME_PATHS_REQUIRED');
 need(['recordSha256','actualRuntimeProofSha256'].every(k=>/^[a-f0-9]{64}$/.test(slot[k]??'')),'ACTUAL_RECORD_RESTART_PROOF_PINS_REQUIRED');
 return slot;
}
