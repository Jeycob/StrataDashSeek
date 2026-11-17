'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const path=require('node:path'),sdkEntry=process.env.HARNESS_NATIVE_CLI||path.join(process.env.HOMEAI_RUNTIME||'/data/harness/runtime','node_modules/@deepseek-ai/dsh/package.json');
const yaml=createRequire(path.resolve(sdkEntry))('yaml'),{addWorkspaceRuntime}=require('./install.cjs');
test('profile activation preserves unrelated configuration and is idempotent',()=>{
 const before='- id: existing\n  config:\n    apiKey: preserve-fixture\n    prefix: "Existing [Focused local coding defaults] instruction"\n';
 const after=addWorkspaceRuntime(before,yaml),rows=yaml.parseDocument(after).toJSON();
 assert.equal(rows[0].config.apiKey,'preserve-fixture');assert.match(rows[0].config.prefix,/Managed application deployment/u);
 assert.equal(rows.length,6);assert.equal(addWorkspaceRuntime(after,yaml),after);
 assert.equal(rows.find(row=>row.id==='subprocess').disabled,true);
 assert.equal(rows.flatMap(row=>row.insert??[]).filter(row=>row.id==='cloud-owned-range-subprocess').length,1);
 assert.equal(rows.at(-1).insert[0].id,'cloud-quality-gates');
});
test('provider substitution refuses unknown or duplicate subprocess overrides',()=>{
 for(const before of ['- id: subprocess\n  name: other-provider\n','- id: subprocess\n  name: other-provider\n- id: subprocess\n  name: other-provider\n'])assert.throws(()=>addWorkspaceRuntime(before,yaml),/SUBPROCESS_PROVIDER/);
});
test('actual pinned SDK patch composition disables stock and mounts exactly one app-owned provider',()=>{
 const installed=createRequire(path.resolve(sdkEntry)),{composeEntries,loadOverlayPatches}=installed('@deepseek-ai/dsh-app-boot'),base=path.resolve(path.dirname(installed.resolve('@deepseek-ai/dsh/package.json')),'../dsh-base/cordis.patch.yml');
 const output=composeEntries([loadOverlayPatches('fixture',base),yaml.parse(addWorkspaceRuntime('[]',yaml))],message=>assert.fail(message));
 assert.equal(output.find(row=>row.id==='subprocess').disabled,true);const replacement=output.filter(row=>row.id==='cloud-owned-range-subprocess');assert.equal(replacement.length,1);assert.equal(replacement[0].name,'file:///data/harness/app/workspace/owned-range-subprocess.mjs');assert.notEqual(replacement[0].disabled,true);
});
