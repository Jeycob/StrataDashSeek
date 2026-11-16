'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const path=require('node:path'),sdkEntry=process.env.HARNESS_NATIVE_CLI||path.join(process.env.HOMEAI_RUNTIME||'/data/harness/runtime','node_modules/@deepseek-ai/dsh/package.json');
const yaml=createRequire(path.resolve(sdkEntry))('yaml'),{addWorkspaceRuntime}=require('./install.cjs');
test('profile activation preserves unrelated configuration and is idempotent',()=>{
 const before='- id: existing\n  config:\n    apiKey: preserve-fixture\n    prefix: "Existing [Focused local coding defaults] instruction"\n';
 const after=addWorkspaceRuntime(before,yaml),rows=yaml.parseDocument(after).toJSON();
 assert.equal(rows[0].config.apiKey,'preserve-fixture');assert.match(rows[0].config.prefix,/Managed application deployment/u);
 assert.equal(rows.length,4);assert.equal(addWorkspaceRuntime(after,yaml),after);
 assert.equal(rows.at(-1).insert[0].id,'cloud-quality-gates');
});
