import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBrowserServer,browserServerDeadlines,withBrowserServer} from './browser-server-contract.mjs';

test('optional browser server has one direct producer and no public custody or port authority',()=>{
  assert.equal(validateBrowserServer(undefined),undefined);
  const input={command:['node','server.mjs']},server=validateBrowserServer(input);
  input.command.push('changed');assert.deepEqual(server.command,['node','server.mjs']);
  assert(Object.isFrozen(server));assert(Object.isFrozen(server.command));assert.equal(server.readinessTimeoutMs,5000);
  for(const extra of [{port:21000},{url:'http://localhost:21000'},{pid:1},{root:'/tmp'},{executor:'root'},{env:{PORT:'1'}},{cwd:'..'},{timeoutMs:999999}])assert.throws(()=>validateBrowserServer({...input,...extra}),{code:'INVALID_BROWSER_SERVER'});
  for(const command of [[],[''],['node','bad\0arg'],['node',...Array(64).fill('a')]])assert.throws(()=>validateBrowserServer({command}),{code:'INVALID_BROWSER_SERVER'});
  assert.throws(()=>validateBrowserServer({command:['bash','-c','node server.mjs']}),{code:'SHELL_REFUSED'});
  for(const readinessTimeoutMs of [0,99,30001,Infinity,'100'])assert.throws(()=>validateBrowserServer({command:['node','server.mjs'],readinessTimeoutMs}),{code:'INVALID_BROWSER_SERVER'});
});

test('readiness and browser spend the same original absolute operation deadline',()=>{
  assert.deepEqual(browserServerDeadlines({startedAt:1000,timeoutMs:20000,operationDeadline:4000,readinessTimeoutMs:10000}),{deadline:4000,readinessDeadline:4000});
  assert.deepEqual(browserServerDeadlines({startedAt:1000,timeoutMs:20000,operationDeadline:50000,readinessTimeoutMs:1000}),{deadline:21000,readinessDeadline:2000});
  assert.deepEqual(browserServerDeadlines({startedAt:1000,timeoutMs:20000,operationDeadline:900,readinessTimeoutMs:1000}),{deadline:900,readinessDeadline:900});
});

test('expired readiness and preexisting Stop start no producer',async()=>{
  let starts=0;const input={server:{command:['node','server.mjs']},deadline:2000,readinessDeadline:1000,now:()=>1000,start(){starts++;},ready(){},verify(){}};
  await assert.rejects(withBrowserServer(input),{code:'BROWSER_SERVER_NOT_READY'});assert.equal(starts,0);
  const stop=new AbortController();stop.abort(Error('already stopped'));
  await assert.rejects(withBrowserServer({...input,signal:stop.signal}),/already stopped/);assert.equal(starts,0);
});

test('late readiness cannot acquire a new browser budget or enter verification',async()=>{
  let time=1000,verified=0,kills=0,finish;
  const done=new Promise(resolve=>{finish=resolve;});
  await assert.rejects(withBrowserServer({server:{command:['node','server.mjs']},deadline:3000,readinessDeadline:1500,now:()=>time,start:()=>({done,assertCurrent(){},terminate(){kills++;finish();}}),ready:async()=>{time=1501;},verify:async()=>{verified++;}}),{code:'BROWSER_SERVER_NOT_READY'});
  assert.equal(kills,1);assert.equal(verified,0);
});
