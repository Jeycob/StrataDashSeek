// Disabled source metadata. Root authors a separate reviewed bound copy.
import pins from './frozen-pins.json' with {type:'json'};
export const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
export const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const frozen=freeze(pins),serviceCommit=pins.expectedServiceCommit;
export const campaignOrder=freeze(['B03 HomeAI','B03 DS','B10 DS','B10 HomeAI','B01 HomeAI','B01 DS','B02 DS','B02 HomeAI']);
export const b02Criteria=freeze([...Array.from({length:7},(_,i)=>'B02-'+String(i+1).padStart(2,'0')),...Array.from({length:5},(_,i)=>'B02-C'+String(i+1).padStart(2,'0'))]);
export const limits=freeze({mainSeconds:900,repairSeconds:300,maxRepairs:1,callbackMs:4000,settlementMs:120000,preparationMs:30000,checkpointBudgetBytes:67108864,checkpointBudgetCount:2048});
export const ineligibleSession='session-5007e9ba-0d62-4255-b375-e8b4fb4fb39d';
export const promptHashes=freeze({B03:'9e446d2b5b2cf83f803a3a0e35868d8bd258f6851ef9fe4073c2254c1cf34f9e',B10:'e4dc252381e867be2d9c55845c1054fed70b8c15575fc0d0d02bee8888349224',B01:'ee4052dc6f2e4a1b7a82207fc4b8184d15e059695dd4598f23510f488881a431',B02:'dcade0591f5d6f70ffb7ee11f9f17b276f01e2568e98f8cd5b6dd1365028196f'});
export const modelFor=v=>v==='DS'?{provider:'deepseek-official',model:'deepseek-v4-pro',reasoningEffort:'high'}:v==='HomeAI'?{provider:'strata-vast',model:'strata',reasoningEffort:'medium'}:null;
const seconds=freeze({B03:600,B10:600,B01:900,B02:900});
export const primaryPolicy=s=>seconds[s]?freeze({mainSeconds:seconds[s],repairSeconds:300,maxRepairs:1}):null;
export const matchesPrimaryLimits=r=>!!primaryPolicy(r?.scenario)&&Object.entries(primaryPolicy(r.scenario)).every(([k,v])=>r.limits?.[k]===v);
export function originalPrimaryDeadline(r,start){need(matchesPrimaryLimits(r)&&Number.isSafeInteger(start)&&Number.isSafeInteger(start+seconds[r.scenario]*1000),'ORIGINAL_SCENARIO_POLICY_REQUIRED');return start+seconds[r.scenario]*1000;}
export const token=x=>typeof x==='string'&&x.length>0&&x.length<=256;
export const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
export const absolute=x=>typeof x==='string'&&x.startsWith('/')&&!x.split('/').some(p=>p==='.'||p==='..')&&!/[\x00-\x20\\]/.test(x);
export function disabledSlot(variant){
 need(['DS','HomeAI'].includes(variant),'B02_VARIANT_REQUIRED');const orderPosition=variant==='DS'?7:8;
 return freeze({version:1,executionEnabled:false,authorizationReference:null,scenario:'B02',variant,orderPosition,pairId:null,runId:null,attemptId:null,serviceCommit,limits,
 target:{owned:true,scenario:'B02',variant,sessionId:null,workspaceId:null,projectId:null,projectRoot:null,sessionUrl:null,modelSelection:modelFor(variant),preparedFixtureEvidence:null},
 previousPairs:{B03:null,B10:null,B01:null},previous:campaignOrder.slice(0,orderPosition-1).map((label,i)=>{const [scenario,v]=label.split(' ');return{scenario,variant:v,orderPosition:i+1,pairId:null,runId:null,attemptId:null,sessionId:null,workspaceId:null,projectId:null,checkpointDirectory:null,checkpointFile:null,checkpointSha256:null,actualWriterReceipt:null};}),
 checkpointDirectory:null,codeRoot:null,recordSha256:null,frozenRoot:null,qaRoot:null,actualRuntimeProofFile:null,actualRuntimeProofSha256:null,qualifiedProducerCommit:null,sourceClosureSha256:null,
 actual:{runtimeBaseline:null,pid:null,epoch:null,qualification:null,primaryStartedAt:null,primaryDeadlineAt:null}});
}
export function validatePrimary(record,target){
 need(record?.scenario==='B02'&&['DS','HomeAI'].includes(record.variant)&&matchesPrimaryLimits(record)&&['pairId','runId','attemptId'].every(k=>token(record[k]))&&record.comparison?.orderPosition===(record.variant==='DS'?7:8),'FIXED_B02_PRIMARY_REQUIRED');
 need(record.identity?.sourceCommit===serviceCommit&&record.identity.runtimeCommit===serviceCommit&&record.identity.manifestSha256===frozen.sourceManifestSha256&&hex(record.identity.promptSha256)&&record.identity.acceptanceVersion===frozen.acceptanceVersion,'B02_FROZEN_SERVICE_INPUTS_REQUIRED');
 need(target?.owned===true&&['sessionId','workspaceId','projectId'].every(k=>token(target[k]))&&target.sessionId!==ineligibleSession&&target.projectRoot==='/data/harness/workspaces/projects/'+target.sessionId&&absolute(target.preparedFixtureEvidence),'FRESH_OWN_B02_PROJECT_REQUIRED');
 need(JSON.stringify(target.modelSelection)===JSON.stringify(modelFor(record.variant)),'B02_FROZEN_MODEL_REQUIRED');
}
export function validateFixedSlot(slot){
 need(slot?.executionEnabled===true&&uuid(slot.authorizationReference),'DISABLED_ROOT_BINDING_REQUIRED');
 need(slot.scenario==='B02'&&slot.serviceCommit===serviceCommit&&JSON.stringify(slot.limits)===JSON.stringify(limits)&&slot.orderPosition===(slot.variant==='DS'?7:8),'EXACT_B02_SLOT_POLICY_REQUIRED');
 validatePrimary({scenario:slot.scenario,variant:slot.variant,pairId:slot.pairId,runId:slot.runId,attemptId:slot.attemptId,comparison:{orderPosition:slot.orderPosition},limits:slot.limits,identity:{sourceCommit:serviceCommit,runtimeCommit:serviceCommit,manifestSha256:frozen.sourceManifestSha256,promptSha256:promptHashes.B02,acceptanceVersion:frozen.acceptanceVersion}},slot.target);
 need(absolute(slot.checkpointDirectory)&&['B03','B10','B01'].every(k=>token(slot.previousPairs?.[k]))&&new Set(Object.values(slot.previousPairs)).size===3,'EXACT_CURRENT_PREVIOUS_PAIRS_REQUIRED');
 need(Array.isArray(slot.previous)&&slot.previous.length===slot.orderPosition-1,'ALL_ACTUAL_B02_PRIORS_REQUIRED');
 for(const [i,p]of slot.previous.entries()){
  need(p.scenario+' '+p.variant===campaignOrder[i]&&p.orderPosition===i+1&&['pairId','runId','attemptId','sessionId','workspaceId','projectId'].every(k=>token(p[k]))&&p.sessionId!==ineligibleSession,'EXACT_PREDECESSOR_ORDER_IDENTITY_REQUIRED');
  need(p.pairId===(p.scenario==='B02'?slot.pairId:slot.previousPairs[p.scenario]),'CURRENT_PAIR_BINDING_REQUIRED');
  need(absolute(p.checkpointDirectory)&&p.checkpointFile?.startsWith(p.checkpointDirectory+'/')&&p.checkpointFile.endsWith('.json')&&uuid(p.checkpointFile.slice(p.checkpointDirectory.length+1,-5))&&hex(p.checkpointSha256),'EXACT_PRIOR_CP_PIN_REQUIRED');
  if(p.scenario==='B03')need(p.attemptId.startsWith('b03-pair04-')&&p.checkpointDirectory.includes('/n06-b03-pair04-'),'NEW_B03_PAIR04_PRIOR_REQUIRED');
 }
 need(new Set([...slot.previous.map(p=>p.sessionId),slot.target.sessionId]).size===slot.orderPosition&&new Set([...slot.previous.map(p=>p.attemptId),slot.attemptId]).size===slot.orderPosition&&new Set(slot.previous.map(p=>p.checkpointFile)).size===slot.previous.length,'DISTINCT_CURRENT_PREDECESSORS_REQUIRED');return slot;
}
export function validateAuthority(slot,handoff){validateFixedSlot(slot);need(handoff?.liveAuthorized===true&&handoff.rootOperator===true&&token(handoff.id)&&handoff.sourceCommit===serviceCommit&&handoff.runtimeCommit===serviceCommit&&handoff.orderPosition===slot.orderPosition&&handoff.settlementObservationMs===120000,'EXACT_B02_ROOT_HANDOFF_REQUIRED');return handoff;}
export function validateRuntimeBindings(slot){validateFixedSlot(slot);need(['codeRoot','frozenRoot','qaRoot','actualRuntimeProofFile'].every(k=>absolute(slot[k])&&slot[k].startsWith('/data/harness/root-secrets/'))&&hex(slot.recordSha256)&&hex(slot.actualRuntimeProofSha256)&&hex(slot.sourceClosureSha256)&&/^[a-f0-9]{40}$/.test(slot.qualifiedProducerCommit??'')&&slot.qualifiedProducerCommit!==serviceCommit,'FRESH_B02_RUNTIME_PRODUCER_PINS_REQUIRED');return slot;}
