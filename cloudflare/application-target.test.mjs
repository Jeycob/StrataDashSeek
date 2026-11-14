import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationTarget} from './application-target.mjs';
const env={APPLICATION_HOST:'100.122.37.80'};
test('application wake target uses only the private configured address and port pool',()=>{assert.equal(applicationTarget(env,null),null);assert.equal(applicationTarget(env,'18080'),'http://100.122.37.80:18080/');assert.equal(applicationTarget(env,'18087'),'http://100.122.37.80:18087/');for(const port of ['18079','18088','https://evil.example','18080/path','018080','NaN','2375'])assert.throws(()=>applicationTarget(env,port));});
test('public addresses, Harness DNS hostname and invalid private addresses are refused',()=>{for(const host of ['example.com','vast-harness.tail.example.ts.net','127.0.0.1','100.1.2.3','100.122.999.1','100.122.37.80@evil.example'])assert.throws(()=>applicationTarget({APPLICATION_HOST:host},'18080'));});
