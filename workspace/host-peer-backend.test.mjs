import test from 'node:test';
import assert from 'node:assert/strict';
import {pinRealLandlock} from './fixtures/host-peer-backend.mjs';
test('fixture probes the exact real-method seam before pinning only Landlock',()=>{
 for(const verdict of['full','partial']){const calls=[],original=['bwrap','landlock'],internals={chain:original},probeRunner=runner=>{calls.push(runner);assert.equal(internals.chain,original);return verdict;},sandbox={internals,probeRunner};assert.equal(pinRealLandlock(sandbox),verdict);assert.deepEqual(calls,['landlock']);assert.deepEqual(internals.chain,['landlock']);assert.equal(sandbox.probeRunner,probeRunner);assert.deepEqual(Object.keys(internals),['chain']);}
});
test('unavailable, unexpected, thrown or async probe cannot pin a fallback',()=>{
 for(const verdict of['unusable',undefined,'bwrap',Promise.resolve('full')]){const original=['bwrap','landlock'],sandbox={internals:{chain:original},probeRunner:()=>verdict};assert.throws(()=>pinRealLandlock(sandbox),{code:'PEER_FIXTURE_LANDLOCK_UNAVAILABLE'});assert.equal(sandbox.internals.chain,original);}
 const original=['bwrap'],sandbox={internals:{chain:original},probeRunner(){throw Error('native probe failure');}};assert.throws(()=>pinRealLandlock(sandbox),/native probe failure/);assert.equal(sandbox.internals.chain,original);
});
test('an already selected backend or missing SDK method refuses before probe or mutation',()=>{
 for(const selectedRunner of[{runner:'bwrap'},{runner:'landlock'},'unavailable']){const sandbox={internals:{},selectedRunner,probeRunner(){assert.fail('must not probe a cached backend');}};assert.throws(()=>pinRealLandlock(sandbox),{code:'PEER_FIXTURE_FRESH_BACKEND_REQUIRED'});assert.deepEqual(sandbox.internals,{});}
 for(const sandbox of[undefined,{}, {internals:{}}])assert.throws(()=>pinRealLandlock(sandbox),{code:'PEER_FIXTURE_FRESH_BACKEND_REQUIRED'});
});
