const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const runtime=process.env.HOMEAI_RUNTIME||'/data/harness/runtime',r=createRequire(path.join(runtime,'node_modules/@deepseek-ai/dsh/package.json')),yaml=r('yaml');
const {migrate,POLICY,ADVICE}=require('./prepare-homeai-profile.cjs');
test('all shipped web presets receive HomeAI policy without losing JS tags or cloud settings',()=>{
 const source=fs.readFileSync(path.join(__dirname,'provider.patch.example.yml'),'utf8')+'\n- id: cloud-test-preserved\n  config:\n    marker: keep-me\n';
 const presets=Object.fromEntries(['standard','minimal','cordis','ptc'].map(n=>[n,fs.readFileSync(path.join(runtime,'node_modules/@deepseek-ai/dsh-web-app/presets/'+n+'.patch.yml'),'utf8')]));
 const output=migrate(source,presets,yaml);assert.equal(output.changed.length,4);assert.match(output.text,/!!js/);
 const d=yaml.parseDocument(output.text),rows=d.contents.items,find=id=>rows.find(n=>n.get?.('id')===id);
 const config=find('llm-pi-ai').get('config'),p=config.get('providers').get('strata-vast');assert.equal(p.getIn(['thinkingBudgets','medium']),4096);assert.equal(config.has('thinkingBudgets'),false);assert.equal(p.getIn(['models',0,'maxTokens']),32768);assert.equal(p.getIn(['retryPolicy','maxRetries']),2);assert.equal(find('cloud-test-preserved').getIn(['config','marker']),'keep-me');assert.equal(find('session-title-llm').get('disabled'),true);
 for(const name of Object.keys(presets)){const row=find('preset-'+name),plugins=row.getIn(['config','plugins']);const compaction=plugins.items.find(x=>x.get?.('id')==='compaction');assert.deepEqual(compaction.getIn(['config',0,'config']).toJSON(),POLICY);assert.ok(plugins.items.find(x=>x.get?.('id')==='persona').getIn(['config','prefix']).includes(ADVICE));}
 const twice=migrate(output.text,presets,yaml).text;assert.equal(twice,output.text);
});
