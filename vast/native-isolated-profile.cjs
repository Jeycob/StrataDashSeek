'use strict';
// No I/O at import. This is a launch composition, not a policy writer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const {canonical,validateProjection}=require('./project-execution-mode.cjs');
const ROOT='/data/harness',SNAPSHOT=ROOT+'/runtime-config/native-isolated.json',MAX_BYTES=2*1024*1024;
const REVIEWED=Object.freeze({
 'dsh-base/cordis.patch.yml':'026fa70d7746609549ea7607f5b60c76fd19476e13549729dc1171f0a1d96cc8',
 'dsh-web-app/cordis.patch.yml':'58dffac57b73cd06b84fb81e6adcfcf3ba7175952e607c0753b5535712388afe',
 'dsh-web-app/presets/standard.patch.yml':'e40bb192ed3b835312c2acd2ccd64d3bc4b85f80a7bc95b132cb18fbee190b5d',
 'dsh-web-app/presets/minimal.patch.yml':'a2a9ba1c9c392a45466708f18bc0aefbf300577f9b544dc06049f73a8a5b3267',
 'dsh-web-app/presets/cordis.patch.yml':'6be896c3d4885f395bf1856753f454cf725709ffdddcc57f1e6b8d8c07181f34',
 'dsh-web-app/presets/ptc.patch.yml':'838665e063dc8bcab4caf24e41ec848373c434df4262feb981306944e1cec7fd',
 'dsh-agent-instructions/lib/index.js':'afbd526d1e3126a368774f24105140adc3ef532ca4aa93cfa0fb1318d5b9b75d',
 'dsh-skill-filesystem/lib/index.js':'c08860e282a01b51bf4726025dbd685b5d92c3e94194596993d07608a2469568',
 'dsh-tool-skill/lib/index.js':'f7d83b1a4b7a3ac67766b36758edabdbc719cf995f085da6a0699af99b2eb1da',
 'dsh-app-boot/lib/index.js':'a8d2138bb274bd982079df14a615f6c0d5d7589c9faeae81973128a72293b6de'
});
const BUNDLES=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'];
const MANAGED=Object.freeze({
 'cloud-owned-range-subprocess':'workspace/owned-range-subprocess.mjs',
 'cloud-native-worktrees':'@deepseek-ai/dsh-experimental-worktree',
 'cloud-workspace-runtime':'workspace/plugin.mjs',
 'cloud-quality-gates':'quality/plugin.mjs',
 'cloud-qwen-efficiency-v1':'efficiency/plugin.mjs',
 'cloud-homeai-turn-queue-v1':'vast/turn-queue/plugin.mjs',
 'cloud-homeai-request-recovery':'vast/homeai-reliability.mjs',
 'cloud-homeai-completion-guard':'vast/completion-guard.mjs',
 'homeai-output-continuation':'runtime/output-continuation/index.mjs',
 'root-runtime-admission':'workspace/runtime-admission-plugin.mjs'
});
const fail=code=>Object.assign(Error(code),{code}),digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function captureBinding(binding){
 if(!binding||typeof binding.assertUnchanged!=='function')throw fail('NATIVE_PROFILE_BINDING_REQUIRED');
 const snapshot=validateProjection(binding.snapshot),expected=canonical(snapshot);
 const check=()=>{if(canonical(validateProjection(binding.assertUnchanged()))!==expected)throw fail('NATIVE_PROFILE_BINDING_CHANGED');return snapshot;};
 check();if(snapshot.mode!=='isolated-guest')throw fail('NATIVE_PROFILE_ISOLATED_REQUIRED');return{snapshot,check};
}
function children(row){
 if(row.name==='@deepseek-ai/dsh-agent-preset')return row.config?.plugins;
 if(row.group===true||row.name==='cordis:group')return row.config;
}
function projectNativeReaders({baselineEntries,entries,binding}){
 const mode=captureBinding(binding),output=structuredClone(entries),counts={instructions:0,skillProviders:0,skillConsumers:0,presets:0};
 if(!Array.isArray(output)||!Array.isArray(baselineEntries))throw fail('NATIVE_PROFILE_INCOMPLETE');
 const known=new Map(),expressions=new Set();
 function expr(value){if(value&&typeof value==='object'){if(Object.hasOwn(value,'__jsExpr'))expressions.add(canonical(value));else for(const item of Object.values(value))expr(item);}}
 function index(rows,prefix=''){
  if(!Array.isArray(rows))throw fail('NATIVE_PROFILE_INCOMPLETE');
  for(const row of rows){const key=prefix+'/'+row.id;if(typeof row.id!=='string'||known.has(key))throw fail('NATIVE_PROFILE_AMBIGUOUS');known.set(key,row);expr(row);const nested=children(row);if(nested!==undefined)index(nested,key);}
 }
 index(baselineEntries);
 const seen=new Set(),presetIds=[];
 function validateExpressions(value){if(value&&typeof value==='object'){if(Object.hasOwn(value,'__jsExpr')){if(!expressions.has(canonical(value)))throw fail('NATIVE_PROFILE_EXPRESSION_UNREVIEWED');}else for(const item of Object.values(value))validateExpressions(item);}}
 function visit(rows,prefix=''){
  if(!Array.isArray(rows))throw fail('NATIVE_PROFILE_INCOMPLETE');
  for(const row of rows){
   const key=prefix+'/'+row?.id;if(!row||typeof row.id!=='string'||seen.has(key))throw fail('NATIVE_PROFILE_AMBIGUOUS');seen.add(key);
   const base=known.get(key),managed=prefix===''?MANAGED[row.id]:undefined;
   if(base){if(row.name!==base.name||Boolean(row.group)!==Boolean(base.group))throw fail('NATIVE_PROFILE_COMPOSITION_UNREVIEWED');}
   else if(managed){const expected=managed.startsWith('@')?managed:'file://'+ROOT+'/releases/'+mode.snapshot.sourceCommit+'/'+managed;if(row.name!==expected&&row.name!=='file://'+ROOT+'/app/'+managed)throw fail('NATIVE_PROFILE_COMPOSITION_UNREVIEWED');if(!managed.startsWith('@'))row.name=expected;}
   else throw fail('NATIVE_PROFILE_COMPOSITION_UNREVIEWED');
   validateExpressions(row);
   if(row.name==='@deepseek-ai/dsh-agent-preset'){
    if(!base||row.config?.id!==base.config.id)throw fail('NATIVE_PROFILE_COMPOSITION_UNREVIEWED');
    presetIds.push(row.config.id);counts.presets++;
   }
   if(row.name==='@deepseek-ai/dsh-agent-instructions'){row.config={maxBytes:0};counts.instructions++;}
   if(row.name==='@deepseek-ai/dsh-skill-filesystem'){row.config={includeDefaultRoots:false,customSkillDirs:[],watch:false,watchFollowSymlinks:false};counts.skillProviders++;}
   // This consumer independently loads user-invoked skills during pre-step,
   // even when its model tool is refused by tools/execute.
   if(row.name==='@deepseek-ai/dsh-tool-skill'){row.disabled=true;counts.skillConsumers++;}
   // The private launch snapshot is immutable for this supervisor. Native
   // config HMR must not replace its preset composition from mutable profiles.
   if(row.name==='@deepseek-ai/dsh-hmr')row.disabled=true;
   const nested=children(row);if(nested!==undefined)visit(nested,key);
  }
 }
 visit(output);
 if(output.some(row=>row.id==='cloud-owned-range-subprocess')&&output.find(row=>row.id==='subprocess')?.disabled!==true)throw fail('NATIVE_PROFILE_COMPOSITION_UNREVIEWED');
 // Whole preset arrays are required: an id-only overlay cannot reach children
 // of a preset (they are not Loader groups).
 for(const [key,row]of known)if((key.startsWith('/preset-')||['agent-instructions','skill-filesystem','tool-skill','hmr'].includes(row.id))&&!seen.has(key))throw fail('NATIVE_PROFILE_INCOMPLETE');
 if(canonical(presetIds.sort())!==canonical(['cordis','minimal','ptc','standard'])||counts.instructions!==4||counts.skillProviders!==4||counts.skillConsumers!==4)throw fail('NATIVE_PROFILE_INCOMPLETE');
 mode.check();return{entries:output,counts};
}
function boundedRead(file,{optional=false,filesystem=fs}={}){
 let fd;try{
  const before=filesystem.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_BYTES||before.size<0)throw fail('NATIVE_PROFILE_INPUT_UNSAFE');
  fd=filesystem.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const opened=filesystem.fstatSync(fd);
  if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw fail('NATIVE_PROFILE_INPUT_CHANGED');
  const bytes=Buffer.alloc(opened.size+1);let used=0;while(used<bytes.length){const n=filesystem.readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}
  const after=filesystem.fstatSync(fd),named=filesystem.lstatSync(file);
  if(used!==opened.size||[after,named].some(s=>s.dev!==opened.dev||s.ino!==opened.ino||s.size!==opened.size||s.mtimeMs!==opened.mtimeMs||s.ctimeMs!==opened.ctimeMs))throw fail('NATIVE_PROFILE_INPUT_CHANGED');
  return bytes.subarray(0,used).toString('utf8');
 }catch(error){if(optional&&error.code==='ENOENT')return undefined;throw error;}finally{if(fd!==undefined)filesystem.closeSync(fd);}
}
async function loadReviewedComposition({sdkRoot,binding,profileText='',homeText='',manifest,admission=[],telemetryDisabledEnv,read=boundedRead}){
 const mode=captureBinding(binding),texts={};
 if(canonical(manifest?.dsh?.profile?.bundles)!==canonical(BUNDLES))throw fail('NATIVE_PROFILE_BUNDLES_UNREVIEWED');
 for(const [file,hash]of Object.entries(REVIEWED)){mode.check();const value=read(path.join(sdkRoot,'@deepseek-ai',file));mode.check();if(digest(value)!==hash)throw fail('NATIVE_PROFILE_SDK_UNREVIEWED');if(file.endsWith('.yml'))texts[file]=value;}
 const installed=createRequire(path.join(sdkRoot,'@deepseek-ai/dsh/package.json')),yaml=installed('js-yaml');
 const js=new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',resolve:v=>typeof v==='string',construct:v=>({__jsExpr:v})}),schema=yaml.JSON_SCHEMA.extend(js);
 const parse=text=>{const value=yaml.load(text||'[]',{schema});if(!Array.isArray(value))throw fail('NATIVE_PROFILE_INCOMPLETE');return value;};
 mode.check();const {composeEntries,resolveTelemetryPatch}=await import(pathToFileURL(path.join(sdkRoot,'@deepseek-ai/dsh-app-boot/lib/index.js')));mode.check();
 const shipped=Object.values(texts).map(parse),strict=()=>{throw fail('NATIVE_PROFILE_PATCH_UNRESOLVED');},baselineEntries=composeEntries(shipped,strict),entries=composeEntries([...shipped,parse(profileText),parse(homeText),admission],strict);
 const telemetry=resolveTelemetryPatch(telemetryDisabledEnv,entries.some(row=>row.id==='session-telemetry-otel'));if(telemetry)entries.find(row=>row.id===telemetry.id).disabled=true;
 mode.check();return projectNativeReaders({baselineEntries,entries,binding});
}
function validateSnapshot(value,binding){
 const mode=captureBinding(binding);
 if(!value||value.version!==1||canonical(value.projection)!==canonical(mode.snapshot)||!Array.isArray(value.entries)||value.entriesSha256!==digest(canonical(value.entries))||Object.keys(value).sort().join(',')!=='entries,entriesSha256,projection,version')throw fail('NATIVE_PROFILE_SNAPSHOT_INVALID');
 mode.check();return value;
}
function nativeRuntimePatch(sourceCommit, root=ROOT){
 const release='file://'+root+'/releases/'+sourceCommit+'/';
 return [{insert:[
  {id:'root-runtime-admission',name:release+MANAGED['root-runtime-admission']},
  {id:'homeai-output-continuation',name:release+MANAGED['homeai-output-continuation']},
 ]}];
}
async function prepareNativeIsolatedLaunch({binding,gid,read=boundedRead,runtime=require('./runtime-paths.cjs'),sdkRoot=ROOT+'/runtime/node_modules'}={}){
 const mode=captureBinding(binding),home=ROOT+'/home/.dsh',profile=home+'/profiles/web';
 if(!Number.isInteger(gid)||gid<1)throw fail('NATIVE_PROFILE_GROUP_REQUIRED');
 mode.check();const manifest=JSON.parse(read(profile+'/package.json')),profileText=read(profile+'/cordis.patch.yml'),homeText=read(home+'/cordis.patch.yml',{optional:true})??'';mode.check();
 const admission=nativeRuntimePatch(mode.snapshot.sourceCommit);
 const projected=await loadReviewedComposition({sdkRoot,binding,manifest,profileText,homeText,admission,telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED,read});mode.check();
 const value=validateSnapshot({version:1,projection:mode.snapshot,entries:projected.entries,entriesSha256:digest(canonical(projected.entries))},binding),bytes=canonical(value);
 if(Buffer.byteLength(bytes)>MAX_BYTES)throw fail('NATIVE_PROFILE_SNAPSHOT_LIMIT');
 // setgid supplies the Harness read group to atomic's new root-owned inode;
 // neither this parent nor this file is writable by that group.
 runtime.ensureDirectory(ROOT+'/runtime-config',0o2750,gid);mode.check();runtime.atomic(SNAPSHOT,bytes,0o640);mode.check();
 if(read(SNAPSHOT)!==bytes)throw fail('NATIVE_PROFILE_PUBLICATION_CHANGED');mode.check();
 return Object.freeze({script:ROOT+'/releases/'+mode.snapshot.sourceCommit+'/vast/native-isolated-start.mjs',args:Object.freeze([]),counts:Object.freeze(projected.counts)});
}
module.exports={ROOT,SNAPSHOT,MAX_BYTES,REVIEWED,captureBinding,projectNativeReaders,boundedRead,loadReviewedComposition,validateSnapshot,nativeRuntimePatch,prepareNativeIsolatedLaunch};
