'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
function addWorkspaceRuntime(text,yaml,options={}){
 const root=options.appRoot||'/data/harness/app',stateRoot=options.stateRoot||'/data/harness/state/workbench',projectsRoot=options.projectsRoot||'/data/harness/workspaces/projects';
 const doc=yaml.parseDocument(text);if(doc.errors.length)throw doc.errors[0];const rows=doc.contents.items;
 const definitions=[{id:'cloud-native-worktrees',name:'@deepseek-ai/dsh-experimental-worktree',config:{retainOnArchive:true}},{id:'cloud-workspace-runtime',name:'file://'+root+'/workspace/plugin.mjs',config:{stateRoot,projectsRoot,environmentReport:options.environmentReport||'/data/harness/state/development.json'}}];
 let changed=false;for(const entry of definitions)if(!rows.some(x=>x.get?.('id')===entry.id||x.get?.('insert')?.items?.some(y=>y.get?.('id')===entry.id))){rows.push(doc.createNode({insert:[entry]}));changed=true;}
 return changed?String(doc):text;
}
module.exports={addWorkspaceRuntime};
if(require.main===module){
 const root='/data/harness',yaml=createRequire(root+'/runtime/node_modules/@deepseek-ai/dsh/package.json')('yaml'),file=root+'/home/.dsh/profiles/web/cordis.patch.yml',before=fs.readFileSync(file,'utf8'),after=addWorkspaceRuntime(before,yaml);
 if(before===after){console.log(JSON.stringify({alreadyInstalled:true}));process.exit(0);}
 const backup=root+'/root-secrets/workspace-runtime-'+Date.now();fs.mkdirSync(backup,{mode:0o700});fs.writeFileSync(backup+'/cordis.patch.yml',before,{mode:0o600});
 const stat=fs.statSync(file),temp=file+'.workspace-runtime.tmp';fs.writeFileSync(temp,after,{mode:stat.mode&0o777});fs.chownSync(temp,stat.uid,stat.gid);fs.renameSync(temp,file);console.log(JSON.stringify({installed:true,existingProfilePreserved:true,backupCreated:true}));
}
