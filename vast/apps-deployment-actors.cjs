'use strict';
const {LABEL}=require('./apps-engine.cjs');
const ID=/^[a-f0-9]{16}$/,CID=/^[a-f0-9]{64}$/,IMAGE=/^sha256:[a-f0-9]{64}$/;
const fail=code=>Object.assign(Error(code),{code,status:409});
function publishedProof(state,projectId,previous){
 // Legacy publications have no generation journal. Never infer that one of
 // their retained containers is disposable from its stopped status alone.
 if(previous.dataGeneration==null)return null;
 if(!ID.test(previous.releaseId||'')||!ID.test(previous.dataGeneration)||!CID.test(previous.containerId||''))throw fail('DEPLOYMENT_PUBLISHED_PROOF_INVALID');
 const row=state.row(projectId,previous.releaseId),f=row?.fields;
 const entries=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.entries(value):[];
 const candidates=entries(f?.candidateContainers),active=entries(f?.activeContainers),images=entries(f?.images),keys=list=>list.map(([name])=>name).sort().join('\0');
 if(!row||row.phase!=='active'||row.projectId!==projectId||row.releaseId!==previous.releaseId||row.dataGeneration!==previous.dataGeneration||!ID.test(f?.candidateDataGeneration||'')||f.candidateDataGeneration===row.dataGeneration||!active.length||active.length>8||keys(active)!==keys(candidates)||keys(active)!==keys(images)||[...active,...candidates].some(([,id])=>!CID.test(id))||images.some(([,id])=>!IMAGE.test(id))||new Set([...active,...candidates].map(([,id])=>id)).size!==active.length+candidates.length||!active.some(([,id])=>id===previous.containerId)||previous.source?.sha256&&previous.source.sha256!==row.sourceHash)throw fail('DEPLOYMENT_PUBLISHED_PROOF_INVALID');
 const volumes=key=>Object.values(f[key]||{});
 const candidateVolumes=volumes('candidateVolumes'),productionVolumes=volumes('productionVolumes');
 if(candidateVolumes.some(name=>typeof name!=='string'||!name.startsWith('sdsh-'+projectId+'-'+f.candidateDataGeneration+'-')||productionVolumes.includes(name))||productionVolumes.some(name=>typeof name!=='string'||!name.startsWith('sdsh-'+projectId+'-'+row.dataGeneration+'-')))throw fail('DEPLOYMENT_PUBLISHED_PROOF_INVALID');
 return{row,candidates:new Map(candidates.map(([name,id])=>[id,name])),active:new Set(active.map(([,id])=>id)),images:new Map(images),candidateVolumes,productionVolumes};
}
async function publishedActors(manager,state,projectId,previous,projectRows){
 const proof=publishedProof(state,projectId,previous);
 const rows=projectRows.filter(c=>proof
  ? c.Id===previous.containerId||proof.candidates.has(c.Id)||proof.active.has(c.Id)||c.Labels?.[LABEL+'.release']===previous.releaseId||c.Labels?.[LABEL+'.generation']===proof.row.dataGeneration
  : c.Id===previous.containerId||previous.releaseId&&c.Labels?.[LABEL+'.release']===previous.releaseId&&!['test','data-helper'].includes(c.Labels?.[LABEL+'.role']));
 if(!proof)return{rows,retainedCandidateIds:[]};
 const selected=[],retainedCandidateIds=[];
 for(const row of rows){
  if(!CID.test(row.Id))throw fail('DEPLOYMENT_OLD_IDENTITY_UNKNOWN');
  const c=await manager.engine.owned(row.Id,projectId),labels=c.Config?.Labels||{},service=labels['com.docker.compose.service'];
  if(c.Id!==row.Id||labels[LABEL]!=='managed'||labels[LABEL+'.project']!==projectId||labels[LABEL+'.release']!==previous.releaseId||labels[LABEL+'.job']!==previous.releaseId||c.Image!==proof.images.get(service))throw fail('DEPLOYMENT_EXISTING_PROJECT_WORK_UNRESOLVED');
  if(proof.candidates.has(c.Id)){
   // This is an exact journaled verification actor, never a generic stopped
   // writer. Reinspect its stopped state and disjoint shadow mounts before
   // excluding it; keep its container and database intact for diagnostics.
   if(service!==proof.candidates.get(c.Id)||labels[LABEL+'.role']!=='candidate'||labels[LABEL+'.generation']!==proof.row.fields.candidateDataGeneration||c.State?.Running!==false||c.State?.Status!=='exited'||c.State?.Paused===true||c.State?.Restarting===true||c.HostConfig?.RestartPolicy?.Name!=='no'||!Array.isArray(c.Mounts)||c.Mounts.some(m=>m.Type!=='volume'||m.RW!==true||!proof.candidateVolumes.includes(m.Name)||proof.productionVolumes.includes(m.Name)))throw fail('DEPLOYMENT_EXISTING_PROJECT_WORK_UNRESOLVED');
   retainedCandidateIds.push(c.Id);
  }else{
   if(labels[LABEL+'.generation']!==proof.row.dataGeneration||['test','data-helper'].includes(labels[LABEL+'.role'])||proof.active.has(c.Id)&&labels[LABEL+'.role']!=='candidate')throw fail('DEPLOYMENT_EXISTING_PROJECT_WORK_UNRESOLVED');
   selected.push(row); // Includes every proven published-generation writer,
                       // even when stopped; the data adapter proves mounts.
  }
 }
 if([...proof.active].some(id=>!selected.some(row=>row.Id===id)))throw fail('DEPLOYMENT_EXISTING_PROJECT_WORK_UNRESOLVED');
 return{rows:selected,retainedCandidateIds};
}
module.exports={publishedActors};
