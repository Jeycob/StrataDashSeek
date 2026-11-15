'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const ID=/^[a-f0-9]{16}$/,HASH=/^[a-f0-9]{64}$/,APP=0x53445348;
const fail=code=>Object.assign(new Error(code),{code,status:409});
const edges={planned:['prepared','failed','recovery_required'],prepared:['verifying','failed','recovery_required'],verifying:['promotable','failed','recovery_required'],promotable:['promoting','failed','recovery_required'],promoting:['active','recovery_required'],recovery_required:['active','failed'],active:[],failed:[]};
function identity(value){if(!value||!ID.test(value.projectId||'')||!ID.test(value.releaseId||'')||!HASH.test(value.sourceHash||'')||!ID.test(value.dataGeneration||''))throw fail('DEPLOYMENT_IDENTITY_INVALID');return Object.fromEntries(['projectId','releaseId','sourceHash','dataGeneration'].map(key=>[key,value[key]]));}
function sameIdentity(a,b){return Object.keys(identity(a)).every(key=>a[key]===b[key]);}
function privatePath(file){
 const parent=path.dirname(file);fs.mkdirSync(parent,{recursive:true,mode:0o700});let current=path.parse(parent).root;
 for(const component of parent.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,component);const info=fs.lstatSync(current);if(!info.isDirectory()||info.isSymbolicLink())throw fail('DEPLOYMENT_STORE_UNSAFE');}
 const info=fs.lstatSync(parent);if(process.platform!=='win32'&&(info.uid!==process.getuid()||info.mode&0o077))throw fail('DEPLOYMENT_STORE_UNSAFE');
 for(const candidate of[file,file+'-wal',file+'-shm'])try{const s=fs.lstatSync(candidate);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||process.platform!=='win32'&&(s.uid!==process.getuid()||s.mode&0o077))throw fail('DEPLOYMENT_STORE_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}
}
function validateFields(fields,projectId){
 const allowed=new Set(['previousReleaseId','previousDataGeneration','candidateDataGeneration','candidateContainers','activeContainers','images','checksHash','activeObservedHash','recoveryObservedHash','candidateHostPort','activeHostPort','previewPort','productionVolumes','candidateVolumes','oldStopIntent','errorCode']);
 if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(key=>!allowed.has(key)))throw fail('DEPLOYMENT_FIELDS_INVALID');
 for(const[key,value]of Object.entries(fields)){
  if(['previousReleaseId','previousDataGeneration'].includes(key)){if(value!==null&&!ID.test(value))throw fail('DEPLOYMENT_FIELDS_INVALID');}
  else if(key==='candidateDataGeneration'){if(!ID.test(value))throw fail('DEPLOYMENT_FIELDS_INVALID');}
  else if(key.endsWith('Hash')){if(!HASH.test(value))throw fail('DEPLOYMENT_FIELDS_INVALID');}
  else if(key==='oldStopIntent'){if(typeof value!=='boolean')throw fail('DEPLOYMENT_FIELDS_INVALID');}
  else if(key==='errorCode'){if(!/^[A-Z][A-Z0-9_]{0,79}$/.test(value))throw fail('DEPLOYMENT_FIELDS_INVALID');}
  else if(key.endsWith('Port')){if(!Number.isInteger(value)||value<1024||value>65535)throw fail('DEPLOYMENT_FIELDS_INVALID');}
  else{
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>8)throw fail('DEPLOYMENT_FIELDS_INVALID');
   for(const[name,item]of Object.entries(value)){if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)||typeof item!=='string')throw fail('DEPLOYMENT_FIELDS_INVALID');
    if(key==='images'?!/^sha256:[a-f0-9]{64}$/.test(item):key.endsWith('Containers')?!HASH.test(item):!new RegExp('^sdsh-'+projectId+'-[a-f0-9]{16}-[a-zA-Z0-9_.-]{1,63}$').test(item))throw fail('DEPLOYMENT_FIELDS_INVALID');
   }
  }
 }
 if(Buffer.byteLength(JSON.stringify(fields))>32768)throw fail('DEPLOYMENT_FIELDS_INVALID');
 return fields;
}
function validateGenerations(id,fields){const candidate=fields.candidateDataGeneration,previous=fields.previousDataGeneration;
 if(candidate===id.dataGeneration||Object.keys(fields.candidateVolumes||{}).length&&!candidate)throw fail('DEPLOYMENT_DATA_GENERATION_ALIAS');
 if(previous&&(previous===id.dataGeneration||previous===candidate))throw fail('DEPLOYMENT_DATA_GENERATION_ALIAS');
 for(const[key,generation]of [['productionVolumes',id.dataGeneration],['candidateVolumes',candidate]])for(const name of Object.values(fields[key]||{}))if(!name.startsWith('sdsh-'+id.projectId+'-'+generation+'-'))throw fail('DEPLOYMENT_VOLUME_IDENTITY_CONFLICT');
 if(Object.values(fields.productionVolumes||{}).some(name=>Object.values(fields.candidateVolumes||{}).includes(name)))throw fail('DEPLOYMENT_DATA_GENERATION_ALIAS');
}
class DeploymentState {
 constructor(directory,{now=Date.now}={}){
  this.now=now;this.file=path.join(path.resolve(directory),'deployments.sqlite');privatePath(this.file);
  try{const fd=fs.openSync(this.file,'wx',0o600);fs.closeSync(fd);}catch(error){if(error.code!=='EEXIST')throw error;}
  let db;
  try{db=new DatabaseSync(this.file);const app=db.prepare('PRAGMA application_id').get().application_id,version=db.prepare('PRAGMA user_version').get().user_version,tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
   if(app!==APP&&(app!==0||version!==0||tables.length)||app===APP&&version!==1)throw fail('DEPLOYMENT_STORE_FOREIGN');
   db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');if(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode!=='wal')throw fail('DEPLOYMENT_DURABILITY_UNAVAILABLE');
   db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS deployments(project_id TEXT NOT NULL,release_id TEXT NOT NULL,source_hash TEXT NOT NULL,data_generation TEXT NOT NULL,phase TEXT NOT NULL,revision INTEGER NOT NULL,fields TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(project_id,release_id));
    CREATE TABLE IF NOT EXISTS deployment_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,release_id TEXT NOT NULL,phase TEXT NOT NULL,at INTEGER NOT NULL,FOREIGN KEY(project_id,release_id) REFERENCES deployments(project_id,release_id)); PRAGMA application_id=0x53445348; PRAGMA user_version=1; COMMIT;`);this.db=db;
  }catch(error){db?.close();throw error;}
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 row(projectId,releaseId){if(!ID.test(projectId||'')||!ID.test(releaseId||''))throw fail('DEPLOYMENT_IDENTITY_INVALID');const row=this.db.prepare('SELECT * FROM deployments WHERE project_id=? AND release_id=?').get(projectId,releaseId);return row?{projectId:row.project_id,releaseId:row.release_id,sourceHash:row.source_hash,dataGeneration:row.data_generation,phase:row.phase,revision:row.revision,fields:JSON.parse(row.fields),createdAt:row.created_at,updatedAt:row.updated_at}:null;}
 begin(input,fields={}){const id=identity(input);validateFields(fields,id.projectId);validateGenerations(id,fields);return this.transaction(()=>{const existing=this.row(id.projectId,id.releaseId);if(existing){if(!sameIdentity(existing,id))throw fail('DEPLOYMENT_IDENTITY_CONFLICT');for(const[key,value]of Object.entries(fields))if(JSON.stringify(existing.fields[key])!==JSON.stringify(value))throw fail('DEPLOYMENT_FIELD_CONFLICT');return existing;}const at=this.now();this.db.prepare('INSERT INTO deployments VALUES(?,?,?,?,?,0,?,?,?)').run(id.projectId,id.releaseId,id.sourceHash,id.dataGeneration,'planned',JSON.stringify(fields),at,at);this.db.prepare('INSERT INTO deployment_events(project_id,release_id,phase,at) VALUES(?,?,?,?)').run(id.projectId,id.releaseId,'planned',at);return this.row(id.projectId,id.releaseId);});}
 transition(input,next,patch={},expectedRevision){const id=identity(input);validateFields(patch,id.projectId);if(!Object.hasOwn(edges,next))throw fail('DEPLOYMENT_PHASE_INVALID');return this.transaction(()=>{
  const current=this.row(id.projectId,id.releaseId);if(!current||!sameIdentity(current,id))throw fail('DEPLOYMENT_IDENTITY_CONFLICT');if(expectedRevision!==undefined&&current.revision!==expectedRevision)throw fail('DEPLOYMENT_REVISION_CONFLICT');
  const fields={...current.fields};for(const[key,value]of Object.entries(patch)){if(key!=='errorCode'&&Object.hasOwn(fields,key)&&JSON.stringify(fields[key])!==JSON.stringify(value))throw fail('DEPLOYMENT_FIELD_CONFLICT');fields[key]=value;}
  validateGenerations(id,fields);if(['active','failed'].includes(current.phase)&&JSON.stringify(fields)!==JSON.stringify(current.fields))throw fail('DEPLOYMENT_PHASE_CONFLICT');
  if(next===current.phase){if(JSON.stringify(fields)===JSON.stringify(current.fields))return current;}else if(!edges[current.phase].includes(next))throw fail('DEPLOYMENT_PHASE_CONFLICT');
  if(['promotable','promoting','active'].includes(next)&&(!HASH.test(fields.checksHash||'')||!Object.keys(fields.images||{}).length||!Object.keys(fields.candidateContainers||{}).length))throw fail('DEPLOYMENT_PROOF_REQUIRED');
  const keys=value=>Object.keys(value||{}).sort().join('\0');
  if(['promotable','promoting','active'].includes(next)&&keys(fields.images)!==keys(fields.candidateContainers))throw fail('DEPLOYMENT_PROOF_REQUIRED');
  if(next==='promoting'&&(fields.previousReleaseId||fields.previousDataGeneration)&&fields.oldStopIntent!==true)throw fail('DEPLOYMENT_STOP_INTENT_REQUIRED');
  if(next==='active'&&(!HASH.test(fields.activeObservedHash||'')||keys(fields.activeContainers)!==keys(fields.images)))throw fail('DEPLOYMENT_PROOF_REQUIRED');
  if(next==='failed'&&current.phase==='recovery_required'&&!HASH.test(fields.recoveryObservedHash||''))throw fail('DEPLOYMENT_RECOVERY_PROOF_REQUIRED');
  const at=this.now();this.db.prepare('UPDATE deployments SET phase=?,revision=revision+1,fields=?,updated_at=? WHERE project_id=? AND release_id=?').run(next,JSON.stringify(fields),at,id.projectId,id.releaseId);this.db.prepare('INSERT INTO deployment_events(project_id,release_id,phase,at) VALUES(?,?,?,?)').run(id.projectId,id.releaseId,next,at);return this.row(id.projectId,id.releaseId);
 });}
 pending(projectId){if(projectId!==undefined&&!ID.test(projectId))throw fail('DEPLOYMENT_IDENTITY_INVALID');return this.db.prepare("SELECT project_id,release_id FROM deployments WHERE phase NOT IN ('active','failed')"+(projectId?' AND project_id=?':'')).all(...(projectId?[projectId]:[])).map(row=>this.row(row.project_id,row.release_id));}
 events(projectId,releaseId){this.row(projectId,releaseId);return this.db.prepare('SELECT phase,at FROM deployment_events WHERE project_id=? AND release_id=? ORDER BY sequence').all(projectId,releaseId);}
 close(){if(this.db){this.db.close();this.db=null;}}
}
function evidenceHash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
module.exports={DeploymentState,evidenceHash,edges};
