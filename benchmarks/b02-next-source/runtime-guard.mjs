// Metadata seal, NOT a signing/provider proof. Caller must perform full trusted
// source/profile qualification BETWEEN capture and assert, before using it.
import fs from 'node:fs';
import path from 'node:path';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const keys=['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'];
const identityKeys=['dev','ino','uid','gid','mode'];
const stamp=(stat,identityOnly=false)=>(identityOnly?identityKeys:keys).map(key=>{need(typeof stat[key]==='bigint','NANOSECOND_METADATA_REQUIRED');return String(stat[key]);}).join(':');
export function createQualificationSeal({sourceRoot,protectedFiles,profileFile,bootstrapDirectory},trusted={}){
 const io=trusted.fs??fs,now=trusted.now??Date.now,rows=new Map();let entries=0,total=0n;
 need(/^\/data\/harness\/releases\/[a-f0-9]{40}$/.test(sourceRoot)&&profileFile==='/data/harness/home/.dsh/profiles/web/cordis.patch.yml'&&bootstrapDirectory==='/data/harness/bootstrap'&&Array.isArray(protectedFiles)&&protectedFiles.length<=64,'FIXED_QUALIFICATION_PATHS_REQUIRED');
 const guard=input=>need(Number.isSafeInteger(input?.deadline)&&now()<input.deadline&&!input.signal?.aborted,'ROOT_DRIVER_DEADLINE');
 function inspect(file,{directory=false,service=false,identityOnly=false,max=16777216n}={}){
  const stat=io.lstatSync(file,{bigint:true}),owner=stat.uid===0n||service&&stat.uid===1001n;
  need(owner&&!stat.isSymbolicLink()&&!(stat.mode&0o022n)&&(directory?stat.isDirectory():stat.isFile()&&stat.nlink===1n&&stat.size>=0n&&stat.size<=max),'QUALIFIED_PATH_UNSAFE');
  return{stat,signature:stamp(stat,identityOnly)};
 }
 function retain(file,kind){const row=inspect(file,kind),old=rows.get(file);if(old){need(old.signature===row.signature||old.kind.identityOnly,'QUALIFICATION_ALIAS');if(!kind.identityOnly)rows.set(file,{kind,signature:row.signature});}else rows.set(file,{kind,signature:row.signature});}
 function parents(file,service=false){let at='/';retain(at,{directory:true,identityOnly:true,service});for(const part of path.posix.dirname(file).slice(1).split('/').filter(Boolean)){at=path.posix.join(at,part);retain(at,{directory:true,identityOnly:true,service});need(io.realpathSync(at)===at,'QUALIFIED_PARENT_ALIAS');}}
 function visit(file){
  need(++entries<=4097,'QUALIFIED_SOURCE_ENTRY_CAP');const stat=io.lstatSync(file,{bigint:true});
  if(stat.isDirectory()){retain(file,{directory:true});for(const name of io.readdirSync(file).sort()){need(name!=='.'&&name!=='..'&&!name.includes('/'),'QUALIFIED_SOURCE_NAME');visit(path.posix.join(file,name));}}
  else{retain(file,{});total+=stat.size;need(total<=67108864n,'QUALIFIED_SOURCE_BYTE_CAP');}
 }
 return Object.freeze({
  capture(input){guard(input);need(rows.size===0,'QUALIFICATION_SEAL_ONCE');parents(sourceRoot+'/placeholder');visit(sourceRoot);for(const file of protectedFiles){need(typeof file==='string'&&file.startsWith('/')&&path.posix.normalize(file)===file,'FIXED_PROTECTED_PATH_REQUIRED');parents(file);retain(file,{});guard(input);}retain(bootstrapDirectory,{directory:true});parents(profileFile,true);retain(profileFile,{service:true,max:262144n});guard(input);return{entries,sourceBytes:total.toString(),watchedPaths:rows.size};},
  assert(input){guard(input);need(rows.size>0,'FULL_QUALIFICATION_SEAL_REQUIRED');let checked=0;for(const[file,row]of rows){need(inspect(file,row.kind).signature===row.signature,'QUALIFIED_IMMUTABLE_PATH_CHANGED');if(++checked%16===0)guard(input);}guard(input);return checked;},
 });
}

// Supported SDK !!js is preserved as text, NEVER evaluated. Explicit known tag
// resolution prevents warnings; malformed/unknown tags and aliases still fail.
export function parseStrictWebProfile(yaml,bytes){
 need(yaml&&typeof yaml.parseDocument==='function'&&Buffer.isBuffer(bytes)&&bytes.length<=262144,'PROFILE_PARSER_REQUIRED');
 let doc;try{doc=yaml.parseDocument(bytes.toString('utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}],prettyErrors:false,strict:true,uniqueKeys:true,logLevel:'silent'});}catch{need(false,'STRICT_PROFILE_PARSE_FAILED');}
 need(Array.isArray(doc.errors)&&doc.errors.length===0&&Array.isArray(doc.warnings)&&doc.warnings.length===0,'STRICT_PROFILE_PARSE_FAILED');try{return doc.toJS({maxAliasCount:100});}catch{need(false,'STRICT_PROFILE_PARSE_FAILED');}
}

// Fixed path metadata only: no service-owned file/content is opened as Root.
export function projectDirectoryIdentity(root,input,trusted={}){
 const io=trusted.fs??fs,now=trusted.now??Date.now;need(/^\/data\/harness\/workspaces\/projects\/session-[a-f0-9-]{36}$/.test(root),'FIXED_PROJECT_ROOT_REQUIRED');
 const guard=()=>need(Number.isSafeInteger(input?.deadline)&&now()<input.deadline&&!input.signal?.aborted,'ROOT_DRIVER_DEADLINE');let at='',last;const seen=[];
 for(const part of root.slice(1).split('/')){guard();at+='/'+part;const stat=io.lstatSync(at,{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.uid===0n||stat.uid===1001n)&&!(stat.mode&0o022n)&&io.realpathSync(at)===at,'PROJECT_IDENTITY_REFUSED');seen.push([at,stamp(stat,true)]);last=stat;}
 for(const[file,signature]of seen){guard();need(stamp(io.lstatSync(file,{bigint:true}),true)===signature,'PROJECT_IDENTITY_REFUSED');}guard();return{root,identity:['dev','ino','uid','gid','mode'].map(key=>String(last[key])).join(':')};
}

// Full source/bootstrap/trust/profile content was checked once while the seal
// remained unchanged. Every call freshly checks that seal AND mutable issuer,
// recovery, binding and actual process state. No common.witness cache shortcut.
export function createRuntimeFastGuard({o,binding,seal,qualifiedWitness:initialWitness,target:initialTarget,sourceCommit,sourceDigest,policySha256,publishedProfileSha256},trusted={}){
 const io=trusted.fs??fs,now=trusted.now??Date.now,R='/data/harness',qualifiedWitness=structuredClone(initialWitness),target=structuredClone(initialTarget);let pinnedIdentity,pinnedRoot;
 need(target?.owned===true&&typeof target.projectRoot==='string'&&o&&['pinned','json','privateState','actor','identity','canonical','absent','hash'].every(key=>typeof o[key]==='function')&&typeof binding?.assertUnchanged==='function'&&typeof seal?.assert==='function'&&qualifiedWitness?.commit===sourceCommit&&qualifiedWitness.digest===sourceDigest&&qualifiedWitness.policySha256===policySha256,'FULL_RUNTIME_QUALIFICATION_REQUIRED');
 need(target.projectRoot===R+'/workspaces/projects/'+target.sessionId,'FIXED_PROJECT_ROOT_REQUIRED');
 const guard=input=>need(Number.isSafeInteger(input?.deadline)&&now()<input.deadline&&!input.signal?.aborted,'ROOT_DRIVER_DEADLINE');
 function metadata(input){
  guard(input);seal.assert(input);binding.assertUnchanged();guard(input);
  const current=R+'/releases/'+sourceCommit;need(io.lstatSync(R+'/app').isSymbolicLink()&&io.realpathSync(R+'/app')===current&&o.absent(current+'/vast/project-execution-compatibility.json')&&o.absent(R+'/root-secrets/startup-update-transaction.json'),'ROOT_DRIVER_SOURCE_OR_TRANSACTION_CHANGED');
  const policyBytes=o.pinned(R+'/root-secrets/runtime/state/project-execution-policy.json',policySha256,4096),policy=JSON.parse(policyBytes);
  need(policy.mode==='host-compat'&&policy.activationSourceCommit===qualifiedWitness.activationSourceCommit,'UNCHANGED_HOST_REQUIRED');
  const applied=o.json(R+'/root-secrets/startup-update-applied.json'),attestation=o.privateState('release-'+sourceCommit+'.json'),rawRecovery=o.privateState('runtime-recovery.json'),row=rawRecovery.history?.find(value=>value.id===rawRecovery.active),admission=o.privateState('runtime-admission-controller.json'),status=o.privateState('runtime-recovery-status.json');guard(input);
  need(applied.commit===sourceCommit&&applied.digest===sourceDigest&&attestation.commit===sourceCommit&&attestation.digest===sourceDigest&&attestation.admissionProtocol===1&&attestation.securityEpoch===2,'VERIFIED_RELEASE_RECORD_REQUIRED');
  need(row?.phase==='healthy'&&row.servingCommit===sourceCommit&&rawRecovery.lastGood?.commit===sourceCommit&&rawRecovery.lastGood.digest===sourceDigest&&status.phase==='healthy','ROOT_DRIVER_UNHEALTHY_RECOVERY');
  const mode=binding.snapshot;need(mode.mode==='host-compat'&&mode.policySha256===policySha256&&mode.sourceCommit===sourceCommit&&admission.open===true&&admission.sourceCommit===sourceCommit&&typeof admission.epoch==='string'&&Number.isSafeInteger(admission.acceptedWork)&&admission.acceptedWork>=0,'ROOT_DRIVER_UNHEALTHY_RUNTIME');
  need(o.canonical(o.identity())===o.canonical(qualifiedWitness.admissionIdentity),'ROOT_DRIVER_ADMISSION_IDENTITY_CHANGED');
  const actor=o.actor(o.privateState('services.json').names?.harness);guard(input);need(actor&&actor.uid===1001&&actor.state!=='Z','ROOT_DRIVER_NATIVE_PROCESS_UNKNOWN');
  const project=projectDirectoryIdentity(target.projectRoot,input,{fs:io,now});need(!pinnedRoot||project.identity===pinnedRoot,'ROOT_DRIVER_PROJECT_CHANGED');pinnedRoot=project.identity;
  const nativeProcess=Object.fromEntries(['pid','uid','ppid','startTicks','argsSha256'].map(key=>[key,actor[key]]));
  // Keep EXACT original metadata shape so an actual saved original tuple can be
  // matched for manual archived recovery; no current-only provider witness.
  const identity={sourceCommit,sourceDigest,policySha256,launchId:mode.launchId,admissionEpoch:admission.epoch,recoveryAttempt:row.id,profileSha256:publishedProfileSha256,nativeProcess};
  need(!pinnedIdentity||o.canonical(pinnedIdentity)===o.canonical(identity),'ROOT_DRIVER_GENERATION_CHANGED');pinnedIdentity=structuredClone(identity);guard(input);return structuredClone(identity);
 }
 return Object.freeze({metadata,project:input=>{metadata(input);return projectDirectoryIdentity(target.projectRoot,input,{fs:io,now});}});
}
