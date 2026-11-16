'use strict';
// Real packet checks in an anonymous network namespace, never the host's rules.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {controlFirewall}=require('../vast/apps-vm.cjs');
if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('An isolated Linux root fixture is required');
test('the generated worker firewall isolates both bridges and old connections while retaining trusted traffic',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harness-firewall-'));
 try{
  const firewall=path.join(directory,'firewall.sh');fs.writeFileSync(firewall,'#!/bin/sh\nset -eu\n'+controlFirewall(),{mode:0o700});
  const tools=process.env.HARNESS_FIREWALL_TOOLS||'/usr/sbin',python=process.env.HARNESS_PYTHON||'python3';
  assert(path.isAbsolute(tools));assert(fs.statSync(path.join(tools,'iptables')).isFile(),'iptables prerequisite is missing');
  const result=cp.spawnSync('/usr/bin/unshare',['--net','--',python,path.join(__dirname,'test-worker-network.py'),firewall,tools],{encoding:'utf8',windowsHide:true,timeout:65000,killSignal:'SIGTERM',maxBuffer:65536});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);
  const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));
  for(const name of ['realLinuxFirewall','hostControlAllowed','containerControlDenied','composeControlDenied','hostLoopbackDenied','workerProcessLoopbackDenied','preexistingAppConnectionDenied','previewPreserved','dnsAndDhcpPreserved','idempotent','ipv6Disabled'])assert.equal(proof[name],true,name);
  assert.equal(proof.dockerRuntime,false,'This proves network isolation, not a running Docker daemon');
 }finally{
  const actual=fs.realpathSync(directory);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));assert(path.basename(actual).startsWith('harness-firewall-'));assert(!fs.lstatSync(directory).isSymbolicLink());fs.rmSync(actual,{recursive:true,force:true});
 }
});
