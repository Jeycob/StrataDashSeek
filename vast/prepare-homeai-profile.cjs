'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const POLICY={headroomTokens:12288,maxTokens:8192,thresholdRatio:.8,retainTokens:8192,compactionRetries:1,maxOverflowRetries:1};
const ADVICE=fs.readFileSync(path.join(__dirname,'homeai-guidance.txt'),'utf8').trim();
function migrate(profileText,presetTexts,yaml){
 const doc=yaml.parseDocument(profileText);if(doc.errors.length)throw doc.errors[0];const rows=doc.contents.items;
 function row(id,defaults={}){let node=rows.find(x=>x.get?.('id')===id);if(!node){node=doc.createNode({id,...defaults});rows.push(node);}return node;}
 const llm=row('llm-pi-ai').get('config');if(!llm)throw Error('Missing provider configuration');
 const provider=llm.get('providers')?.get('strata-vast');if(!provider)throw Error('Missing strata-vast provider');
 provider.set('reasoning','medium');provider.set('retryPolicy',doc.createNode({mode:'normal',maxRetries:2}));
 provider.set('compat',doc.createNode({supportsDeveloperRole:false,maxTokensField:'max_tokens'}));
 provider.set('thinkingBudgets',doc.createNode({minimal:512,low:2048,medium:4096,high:8192}));
 for(const model of provider.get('models').items){if(model.get('id')==='strata'){model.set('name','Qwen3.8 Flash Next IQ3_S 128K');model.set('contextWindow',131072);model.set('maxTokens',32768);model.set('input',doc.createNode(['text','image']));model.set('compat',doc.createNode({maxTokensField:'max_tokens',supportsReasoningEffort:true,thinkingFormat:'chat-template',supportsThinkingTokenBudget:true,thinkingTokenBudgetField:'thinking_budget_tokens',chatTemplateKwargs:{enable_thinking:{$var:'thinking.enabled'},reasoning_effort:{$var:'thinking.effort',omitWhenOff:true}}}));}}
 row('agent-default-model').set('config',doc.createNode({provider:'strata-vast',model:'strata',reasoningEffort:'medium'}));
 row('session-title-llm').set('disabled',true);
 row('ui-chat').set('config',doc.createNode({transcriptView:'detailed',performanceUsage:'detailed',collapseTiming:'next-input'}));
 row('agent-loop').set('config',doc.createNode({maxParallelToolCalls:1}));
 row('subagent').set('config',doc.createNode({maxActiveSubagents:1,maxDepth:1}));
 row('ui-theme').set('config',doc.createNode({preference:'system'}));
 const queueId='cloud-homeai-turn-queue-v1';
 if(!rows.some(x=>x.get?.('id')===queueId||x.get?.('insert')?.items?.some(child=>child.get?.('id')===queueId)))rows.push(doc.createNode({insert:[{id:queueId,name:'file:///data/harness/app/vast/turn-queue/plugin.mjs',config:{providers:['strata-vast'],maxTokens:32768,statusPath:'/data/harness/state/turn-queue.json',compactionMaxTokens:8192}}]}));
 const recoveryId='cloud-homeai-request-recovery';if(!rows.some(x=>x.get?.('insert')?.items?.some(child=>child.get?.('id')===recoveryId)))rows.push(doc.createNode({insert:[{id:recoveryId,name:'file:///data/harness/app/vast/homeai-reliability.mjs',config:{providers:['strata-vast']}}]}));
 const changed=[];
 function walk(node,visit){if(yaml.isMap(node)){visit(node);for(const pair of node.items)walk(pair.value,visit);}else if(yaml.isSeq(node))for(const child of node.items)walk(child,visit);}
 for(const [name,text] of Object.entries(presetTexts)){
  const source=yaml.parseDocument(text),base=source.getIn([0,'insert',0]);if(source.errors.length||!base)throw Error('Invalid preset '+name);
  const id=base.get('id');let override=rows.find(x=>x.get?.('id')===id);if(!override){override=base.clone();rows.push(override);}
  let policies=0,personas=0;walk(override,node=>{if(node.get('id')==='compaction-basic'){node.set('config',doc.createNode(POLICY));policies++;}if(node.get('id')==='persona'){const cfg=node.get('config');if(cfg){const prefix=cfg.get('prefix')||'';if(!prefix.includes(ADVICE))cfg.set('prefix',prefix+'\n\n'+ADVICE);personas++;}}});
  if(policies!==1)throw Error('Expected exactly one compaction policy for '+name);changed.push({name,policies,personas});
 }
 return {text:String(doc),changed};
}
module.exports={migrate,POLICY,ADVICE};
if(require.main===module){const root=process.argv[2]||'/data/harness',runtime=process.argv[3]||path.join(root,'runtime'),requireInstalled=createRequire(path.join(runtime,'node_modules/@deepseek-ai/dsh/package.json')),yaml=requireInstalled('yaml'),file=path.join(root,'home/.dsh/profiles/web/cordis.patch.yml');const presetTexts=Object.fromEntries(['standard','minimal','cordis','ptc'].map(n=>[n,fs.readFileSync(path.join(runtime,'node_modules/@deepseek-ai/dsh-web-app/presets/'+n+'.patch.yml'),'utf8')]));const result=migrate(fs.readFileSync(file,'utf8'),presetTexts,yaml);fs.writeFileSync(file,result.text);console.log(JSON.stringify({presets:result.changed,outputTokens:32768,reasoningMedium:4096,compaction:POLICY}));}
