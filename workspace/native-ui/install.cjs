'use strict';
// Additive profile change, separately deployable after building the browser bundle.
function addNativeWorkbench(text,yaml,{appRoot='/data/harness/app',appsWorkspaceRoot='/data/harness/workspaces'}={}){
 const doc=yaml.parseDocument(text);if(doc.errors.length)throw doc.errors[0];
 if(!yaml.isSeq(doc.contents))throw Error('Expected a Loader patch sequence');
 const id='cloud-native-workbench',name='file://'+appRoot+'/workspace/native-ui/index.mjs';
 const contains=node=>yaml.isMap(node)?node.get('id')===id||node.get('name')===name||node.items.some(p=>contains(p.value)):yaml.isSeq(node)&&node.items.some(contains);
 if(contains(doc.contents))return text;
 doc.contents.items.push(doc.createNode({insert:[{id,name,config:{appsWorkspaceRoot}}]}));
 return String(doc);
}
module.exports={addNativeWorkbench};
if(require.main===module){
 const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
 const root=process.env.HARNESS_ROOT||'/data/harness',appRoot=path.join(root,'app');
 if(!fs.existsSync(path.join(__dirname,'client.js')))throw Error('Build the Native browser bundle before installation');
 const yaml=createRequire(path.join(root,'runtime/node_modules/@deepseek-ai/dsh/package.json'))('yaml');
 const file=path.join(root,'home/.dsh/profiles/web/cordis.patch.yml'),before=fs.readFileSync(file,'utf8');
 const after=addNativeWorkbench(before,yaml,{appRoot,appsWorkspaceRoot:process.env.HARNESS_APPS_WORKSPACE_ROOT||path.join(root,'workspaces')});
 if(after===before){console.log(JSON.stringify({alreadyInstalled:true}));process.exit(0);}
 const backup=path.join(root,'root-secrets/native-workbench-'+Date.now());fs.mkdirSync(backup,{mode:0o700,recursive:true});fs.writeFileSync(path.join(backup,'cordis.patch.yml'),before,{mode:0o600});
 const stat=fs.statSync(file),temporary=file+'.native-workbench.tmp';fs.writeFileSync(temporary,after,{mode:stat.mode&0o777});fs.chownSync(temporary,stat.uid,stat.gid);
 if(fs.readFileSync(file,'utf8')!==before){fs.unlinkSync(temporary);throw Error('Profile changed during installation; retry from the new profile');}
 fs.renameSync(temporary,file);
 console.log(JSON.stringify({installed:true,existingProfilePreserved:true,backupCreated:true}));
}
