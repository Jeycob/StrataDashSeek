'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
function addWorkspaceRuntime(text,yaml,options={}){
 const root=options.appRoot||'/data/harness/app',stateRoot=options.stateRoot||'/data/harness/state/workbench',projectsRoot=options.projectsRoot||'/data/harness/workspaces/projects';
 const doc=yaml.parseDocument(text);if(doc.errors.length)throw doc.errors[0];const rows=doc.contents.items;
 const definitions=[{id:'cloud-owned-range-subprocess',name:'file://'+root+'/workspace/owned-range-subprocess.mjs'},{id:'cloud-native-worktrees',name:'@deepseek-ai/dsh-experimental-worktree',config:{retainOnArchive:true}},{id:'cloud-workspace-runtime',name:'file://'+root+'/workspace/plugin.mjs',config:{stateRoot,projectsRoot,environmentReport:options.environmentReport||'/data/harness/state/development.json'}},...(options.quality===false?[]:[{id:'cloud-quality-gates',name:'file://'+root+'/quality/plugin.mjs'}])];
 let changed=false;
 const appGuidance='[Managed application deployment] For a requested Docker build or deployed application test, read /data/harness/app/docs/applications.md. Prepare Dockerfile and .harness-app.json in the project; use /data/harness/app/vast/apps-cli.cjs and wait for the final operation state. Test the exact deployed image at its actual address. HTTP availability alone is not an application or visual test. If the worker is unavailable, report the concrete blocker; do not rent another instance or attach a host Docker socket.';
 function guidance(node){if(yaml.isMap(node)){const prefix=node.get('prefix');if(typeof prefix==='string'&&prefix.includes('[Focused local coding defaults]')&&!prefix.includes('[Managed application deployment]')){node.set('prefix',prefix+'\n\n'+appGuidance);changed=true;}for(const pair of node.items)guidance(pair.value);}else if(yaml.isSeq(node))for(const item of node.items)guidance(item);}
 guidance(doc.contents);
 const existing=rows.filter(row=>row.get?.('id')==='subprocess');
 const replacements=rows.flatMap(row=>row.get?.('insert')?.items??[]).filter(row=>row.get?.('id')==='cloud-owned-range-subprocess');
 if(replacements.length>1||replacements.some(row=>row.get('name')!=='file://'+root+'/workspace/owned-range-subprocess.mjs'))throw Error('UNREVIEWED_SUBPROCESS_PROVIDER');
 if(existing.length>1)throw Error('AMBIGUOUS_SUBPROCESS_PROVIDER');
 if(existing.length){const name=existing[0].get('name');if(name&&name!=='@deepseek-ai/dsh-subprocess-local')throw Error('UNREVIEWED_SUBPROCESS_PROVIDER');if(existing[0].get('disabled')!==true){existing[0].set('disabled',true);changed=true;}}
 else{rows.push(doc.createNode({id:'subprocess',name:'@deepseek-ai/dsh-subprocess-local',disabled:true}));changed=true;}
 for(const entry of definitions)if(!rows.some(x=>x.get?.('id')===entry.id||x.get?.('insert')?.items?.some(y=>y.get?.('id')===entry.id))){rows.push(doc.createNode({insert:[entry]}));changed=true;}
 return changed?String(doc):text;
}
module.exports={addWorkspaceRuntime};
if(require.main===module){
 const root='/data/harness',yaml=createRequire(root+'/runtime/node_modules/@deepseek-ai/dsh/package.json')('yaml'),file=root+'/home/.dsh/profiles/web/cordis.patch.yml',before=fs.readFileSync(file,'utf8'),after=addWorkspaceRuntime(before,yaml);
 if(before===after){console.log(JSON.stringify({alreadyInstalled:true}));process.exit(0);}
 const backup=root+'/root-secrets/workspace-runtime-'+Date.now();fs.mkdirSync(backup,{mode:0o700});fs.writeFileSync(backup+'/cordis.patch.yml',before,{mode:0o600});
 const stat=fs.statSync(file),temp=file+'.workspace-runtime.tmp';fs.writeFileSync(temp,after,{mode:stat.mode&0o777});fs.chownSync(temp,stat.uid,stat.gid);fs.renameSync(temp,file);console.log(JSON.stringify({installed:true,existingProfilePreserved:true,backupCreated:true}));
}
