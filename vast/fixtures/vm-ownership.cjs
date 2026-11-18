'use strict';
// Actual controller evaluated with fake filesystem, sockets and owned child events only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {hostExecutionBinding}=require('./execution-binding.cjs');
const source=fs.readFileSync(path.join(__dirname,'../apps-vm.cjs'),'utf8');
function fixture({record=null,readError=false,symlink=false,expireClose=false,enabled=true,savedState,failAbsenceSave=false,execution=hostExecutionBinding(),cgroupVersion='2',engine}={}){
 const root='/data/harness/docker-worker',events=[],manifest={version:1,vcpus:1,memoryMiB:2048,diskBytes:3*1024**3,volumeId:'a'.repeat(32)},manifestBytes=Buffer.from(JSON.stringify(manifest)),manifestSha256=crypto.createHash('sha256').update(manifestBytes).digest('hex');
 let pidRecord=record,pidError=readError,child,closeTimer;const snapshots=[];
 const fakeFS={
  constants:fs.constants,
  existsSync:file=>file==='/inert/state/vm.json'&&savedState!==undefined,
  lstatSync(file){if(file!==root+'/qemu.pid')throw Error('Unexpected lstat');if(pidError)throw Object.assign(Error('inert denied'),{code:'EACCES'});if(pidRecord===null)throw Object.assign(Error('absent'),{code:'ENOENT'});return{isFile:()=>!symlink,isSymbolicLink:()=>symlink,uid:1001,gid:1001,nlink:1,mode:0o100600,size:Buffer.byteLength(pidRecord),dev:1,ino:7,mtimeMs:1,ctimeMs:1};},
  openSync(file){if(file===root+'/qemu.pid')return 30;if(file===root+'/qemu.log'){events.push('log');return 31;}throw Error('Unexpected open');},
  fstatSync(fd){assert.equal(fd,30);return this.lstatSync(root+'/qemu.pid');},
  readSync(fd,buffer,offset,length){assert.equal(fd,30);const data=Buffer.from(pidRecord);data.copy(buffer,offset,0,length);return Math.min(length,data.length);},
  closeSync(){},
  readFileSync(file){if(file===root+'/manifest.json')return manifestBytes;if(file==='/inert/state/vm.json')return JSON.stringify(savedState);if(file===root+'/qemu.pid'){if(pidError)throw Object.assign(Error('inert denied'),{code:'EACCES'});if(pidRecord===null)throw Object.assign(Error('absent'),{code:'ENOENT'});return pidRecord;}if(file.startsWith('/proc/')){events.push('proc-read');return ['untrusted-program','stratadashseek-docker','file='+root+'/volume.raw,format=raw,if=virtio,cache=writeback'].join('\0');}throw Error('Unexpected read');},
  unlinkSync(){events.push('unlink');},statfsSync:()=>({bavail:16*1024**3,bsize:1})
 };
 const deps={'node:fs':fakeFS,'node:path':path.posix,'node:crypto':crypto,'node:child_process':{spawn(){events.push('spawn');child=new EventEmitter();Object.assign(child,{pid:731,exitCode:null,signalCode:null});pidRecord='731\n';return child;}},'node:net':{createConnection(){throw Error('REAL_SOCKET_FORBIDDEN');}},'./apps-engine.cjs':{LABEL:'io.stratadashseek.apps'},'../mobile/private-json.cjs':{atomicJson(file,value){events.push('save');if(failAbsenceSave&&value.workerProcess?.state==='absent')throw Error('SYNTHETIC_ABSENCE_SAVE_FAILED');snapshots.push(structuredClone(value));}},'./apps-worker-profile.cjs':require('../apps-worker-profile.cjs'),'./apps-worker-growth-policy.cjs':{inspectWorkerCapacity:()=>({allowed:true,phase:'legacy',diskBytes:manifest.diskBytes,manifestSha256})},'./apps-overlay-probe.cjs':{},'./apps-project-vm.cjs':{closeExports(){}},'./apps-execution-mode.cjs':require('../apps-execution-mode.cjs')};
 const context={module:{exports:{}},require:name=>{assert(Object.hasOwn(deps,name),'Unexpected dependency '+name);return deps[name];},process:{getuid:()=>1001,getgid:()=>1001,pid:700},Buffer,Date,structuredClone,setTimeout(fn,ms){if(ms===60000){if(expireClose){queueMicrotask(fn);return 1;}closeTimer=setTimeout(fn,ms);return closeTimer;}return setTimeout(fn,Math.min(ms,1));},clearTimeout(id){clearTimeout(id);}};
 vm.runInNewContext(source,context,{filename:'INERT_APPS_VM_SOURCE',timeout:1000});
 const worker=new context.module.exports.DockerVM({enabled,stateDir:'/inert/state',vm:{enabled,root},portCount:0,projectRuntime:{enabled:false}},engine??{available:async()=>{},json:async()=>({Labels:['io.stratadashseek.worker='+manifest.volumeId],CgroupVersion:cgroupVersion,Driver:'vfs'}),list:async()=>[]},execution);
 worker.connectSerial=async()=>{events.push('serial');worker.serial={destroyed:false,destroy(){this.destroyed=true;},write(command){events.push(command.includes('poweroff')?'poweroff':'serial-write');}};worker.scriptSent=true;worker.buffer='HARNESS_READY_'+worker.nonce+'\nHARNESS_BOOT_EXIT_'+worker.nonce+'=0\n';};
 worker.diskFree=async()=>{events.push('disk');return 1;};
 return{worker,events,snapshots,get child(){return child;},setRecord:value=>{pidRecord=value;},setReadError:value=>{pidError=value;},exit(){child.exitCode=0;child.emit('exit',0,null);},close(){child.emit('close',0,null);clearTimeout(closeTimer);}};
}
module.exports={fixture};
