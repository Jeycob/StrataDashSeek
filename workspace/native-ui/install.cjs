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
