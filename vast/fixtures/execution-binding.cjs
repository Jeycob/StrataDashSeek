'use strict';
// Explicit trusted synthetic composition only; production never imports this.
const crypto=require('node:crypto'),{canonical,validateProjection}=require('../project-execution-mode.cjs');
function executionBindingFixture(mode){
 const policy={version:1,contract:'project-execution-v1',mode,policyEpoch:crypto.randomUUID(),activationSourceCommit:'a'.repeat(40)};
 let current=validateProjection({...policy,policySha256:crypto.createHash('sha256').update(canonical(policy)).digest('hex'),sourceCommit:'b'.repeat(40),launchId:crypto.randomUUID()}),error;
 const binding=Object.freeze({snapshot:current,assertUnchanged(){if(error)throw error;return current;}});
 return{binding,change(patch={}){current={...current,...patch};},fail(value=Object.assign(Error('PROJECT_EXECUTION_BINDING_CHANGED'),{code:'PROJECT_EXECUTION_BINDING_CHANGED'})){error=value;}};
}
module.exports={executionBindingFixture,hostExecutionBinding:()=>executionBindingFixture('host-compat').binding,isolatedExecutionBinding:()=>executionBindingFixture('isolated-guest').binding};
