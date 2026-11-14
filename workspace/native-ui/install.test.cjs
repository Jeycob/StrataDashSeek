'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createRequire}=require('node:module'),path=require('node:path');
const {addNativeWorkbench}=require('./install.cjs');
test('Native activation preserves all existing profile settings and is idempotent',()=>{
 const yaml=process.env.HOMEAI_RUNTIME?createRequire(path.join(process.env.HOMEAI_RUNTIME,'package.json'))('yaml'):require('yaml');
 const before='# retain operator comments\n- id: existing\n  config:\n    prefix: existing instructions\n    model: unchanged\n- insert:\n    - id: cloud-workspace-runtime\n      name: file:///data/harness/app/workspace/plugin.mjs\n';
 const after=addNativeWorkbench(before,yaml),rows=yaml.parse(after);
 assert.deepEqual(rows.slice(0,-1),yaml.parse(before));assert.match(after,/# retain operator comments/);
 assert.equal(rows.at(-1).insert[0].id,'cloud-native-workbench');assert.equal(rows.at(-1).insert[0].config.appsWorkspaceRoot,'/data/harness/workspaces');
 assert.equal(addNativeWorkbench(after,yaml),after);assert.throws(()=>addNativeWorkbench('invalid: mapping',yaml),/patch sequence/);
});
