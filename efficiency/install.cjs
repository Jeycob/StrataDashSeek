'use strict';
// Semantic YAML patch; unrelated profile rows and provider credentials are preserved.
const ID='cloud-qwen-efficiency-v1',LEGACY='cloud-homeai-turn-queue-v1';
function installEfficiency(text,yaml,config={}){
 if(config.schedule===false)throw Error('Observe-only mode must retain the legacy scheduler in an isolated fixture; this installer activates request scheduling.');
 const doc=yaml.parseDocument(text);if(doc.errors.length)throw doc.errors[0];
 const rows=doc.contents?.items;if(!Array.isArray(rows))throw Error('Expected a Cordis patch sequence');
 const queues=[],installed=[];
 function visit(node){if(yaml.isMap(node)){if(node.get('id')===LEGACY)queues.push(node);if(node.get('id')===ID)installed.push(node);for(const p of node.items)visit(p.value);}else if(yaml.isSeq(node))for(const n of node.items)visit(n);}
 visit(doc.contents);if(queues.length>1||installed.length>1)throw Error('Ambiguous scheduler entries');
 const settings={providers:['strata-vast'],schedule:true,maxHeavyTools:1,statusPath:'/data/harness/state/turn-queue.json',...config};
 if(queues.length){const old=queues[0];if(old.get('name')!=='file:///data/harness/app/vast/turn-queue/plugin.mjs')throw Error('Legacy scheduler has an unexpected implementation');
   if(installed.length)throw Error('Both schedulers are present; resolve the profile before activation');
   old.set('id',ID);old.set('name','file:///data/harness/app/efficiency/plugin.mjs');old.set('config',doc.createNode(settings));
 }else if(installed.length){installed[0].set('config',doc.createNode(settings));}
 else rows.push(doc.createNode({insert:[{id:ID,name:'file:///data/harness/app/efficiency/plugin.mjs',config:settings}]}));
 return String(doc);
}
module.exports={installEfficiency};
