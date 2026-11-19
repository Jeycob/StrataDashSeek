import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {validateCriteria,projectCriteria,finalizeCriteria,MAX_CRITERIA} from './criteria.mjs';
import {validateContract,verifyProject,compactReport} from './core.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex'), source = 'a'.repeat(64);
const check = id => ({id,kind:'test',command:[process.execPath,'--test','test.mjs']});
const contract = () => ({version:1,sources:['source.txt'],requiredKinds:['test'],checks:[check('move'),check('shoot')],criteria:[{id:'play',text:'The player can move and shoot.',checkIds:['move','shoot']}]});
const result = id => ({id,kind:'test',passed:true,exitCode:0,countsMeasured:true,checksPassed:1,checksTotal:1,logPath:'.harness/quality/'+id+'.log',artifactPaths:[]});
const report = c => ({sourceHash:source,initialSourceHash:source,contractHash:sha(c),stale:false,finishedAt:12345,results:c.checks.map(c=>result(c.id))});

test('absent metadata needs no migration; previous reports remain compactable without inventing criteria',()=>{
 const c=contract();delete c.criteria;assert.equal(validateContract(c),c);assert.deepEqual(projectCriteria(c,{},source),[]);
 const old={passed:true,complete:true,stale:false,sourceHash:source,results:[result('move')]};assert.deepEqual(compactReport(old).criteria,[]);
});
test('bounded short criteria require unique ids and unique references to declared checks',()=>{
 const c=contract();assert.equal(validateCriteria(c.criteria,c.checks),c.criteria);
 const bad=[[],Array.from({length:MAX_CRITERIA+1},(_,i)=>({id:'c'+i,text:'Goal',checkIds:['move']})),[{id:'play',text:'x'.repeat(241),checkIds:['move']}],[{id:'play',text:'two\nlines',checkIds:['move']}],[{id:'play',text:'Goal',checkIds:['move','move']}],[{id:'play',text:'Goal',checkIds:['absent']}],[{id:'play',text:'Goal',checkIds:['move'],command:['true']}],[c.criteria[0],c.criteria[0]]];
 for(const criteria of bad)assert.throws(()=>validateContract({...c,criteria}),e=>e.code==='INVALID_CRITERIA');
});
test('only eligible source-and-contract-bound measured results verify a criterion',()=>{
 const c=contract(),r=report(c),v=projectCriteria(c,r,source);assert.equal(v[0].state,'verified');assert.equal(v[0].observedAt,12345);assert.equal(v[0].checks.length,2);
 for(const mutate of [x=>delete x.initialSourceHash,x=>delete x.contractHash,x=>delete x.stale,x=>x.results[0].countsMeasured=false,x=>x.results[0].checksTotal=0,x=>x.results[0].exitCode=null,x=>x.results.push(result('move')),x=>x.results={filter:'not an array'}]){const copy=structuredClone(r);mutate(copy);assert.equal(projectCriteria(c,copy,source)[0].state,'unknown');}
 assert.equal(projectCriteria(c,r,undefined)[0].state,'unknown');
});
test('stale source or changed declarations supersede previous success; missing and failed checks stay distinct',()=>{
 const c=contract(),r=report(c);assert.equal(projectCriteria(c,{...r,stale:true},source)[0].state,'stale');
 assert.equal(projectCriteria(c,r,'b'.repeat(64))[0].state,'stale');
 const changed=structuredClone(c);changed.criteria[0].text='Changed requirement';assert.equal(projectCriteria(changed,r,source)[0].state,'stale');
 assert.equal(projectCriteria(c,{...r,results:[result('move')]},source)[0].state,'unknown');
 r.results[1]={...result('shoot'),passed:false,exitCode:1,checksPassed:0};const v=projectCriteria(c,r,source)[0];assert.equal(v.state,'failed');assert.equal(v.checks[0].state,'verified');assert.equal(v.checks[1].state,'failed');
});
test('the targeted check stays diagnostic even when it alone maps to a declared condition', () => {
 const c=contract();
 c.criteria.push({id:'movement',text:'The player can move.',checkIds:['move']});
 const r={...report(c),checkId:'move',results:[result('move')]};
 const compact=compactReport({...r,criteria:projectCriteria(c,r,source)});
 assert.deepEqual(compact.criteria.map(row=>row.state),['unknown','unknown']);
 compact.criteria[1].checks[0].state='verified';
 assert.deepEqual(finalizeCriteria(compact,{projectSourceHash:source,outcome:'current'}).map(row=>row.state),['unknown','unknown']);
 delete r.checkId;
 const kindReport=compactReport({...r,criteria:projectCriteria(c,r,source)});
 assert.deepEqual(finalizeCriteria(kindReport,{projectSourceHash:source,outcome:'current'}).map(row=>row.state),['unknown','verified']);
});
test('criterion evidence references existing check ids without duplicating logs, artifacts or raw diagnostics',()=>{
 const c=contract(),r=report(c);r.results[0].diagnostics=['Bearer SECRET'];r.results[0].logPath='/private/log';r.results[0].artifactPaths=['.harness/quality/evidence/shot.png','../escape','C:/secret','https://secret','x\\y'];
 const v=projectCriteria(c,r,source);assert.equal(v[0].checks[0].id,'move');assert.equal(v[0].checks[0].logPath,undefined);assert.equal(v[0].checks[0].artifactPaths,undefined);assert.doesNotMatch(JSON.stringify(v),/SECRET|escape|private|secret/);
});
test('actual existing runner persists and compacts criteria without adding a command or changing old completion rules',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'quality-criteria-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'source.txt'),'original source');await fs.writeFile(path.join(root,'test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('usable output',()=>assert.equal(2+2,4));\n");
 const c={version:1,sources:['source.txt','test.mjs'],requiredKinds:['test'],checks:[check('working')],criteria:[{id:'output',text:'The output passes its executable check.',checkIds:['working']}]};
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 await fs.writeFile(path.join(root,'.harness-quality.json'),JSON.stringify(c));const r=await verifyProject({workspace:root,kind:'all',env});
 assert.equal(r.passed,true,JSON.stringify(r.results));assert.equal(r.complete,true);assert.equal(r.results.length,1);assert.equal(r.criteria[0].state,'verified');assert.equal(r.criteria[0].sourceHash,r.sourceHash);assert.equal(r.criteria[0].observedAt,r.finishedAt);
 const stored=JSON.parse(await fs.readFile(path.join(root,'.harness/quality/latest.json'),'utf8'));assert.deepEqual(stored.criteria,r.criteria);assert.deepEqual(compactReport(r).criteria,r.criteria);
});
