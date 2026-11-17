'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {decodeLogChannels}=require('./apps-engine.cjs');
const frame=(channel,text)=>{const b=Buffer.from(text),h=Buffer.alloc(8);h[0]=channel;h.writeUInt32BE(b.length,4);return Buffer.concat([h,b]);};
test('non-TTY stream framing retains JSON stdout exactly and separates stderr without timestamps',()=>{
 const output=decodeLogChannels(Buffer.concat([frame(1,'{"value":'),frame(2,'diagnostic\n'),frame(1,'true}\n')]));
 assert.equal(JSON.parse(output.stdout).value,true);assert.equal(output.stderr,'diagnostic\n');assert.throws(()=>decodeLogChannels(Buffer.from('rawTTY')));assert.throws(()=>decodeLogChannels(frame(1,'x').subarray(0,8)));
});
test('runtime output API flags bounded channels and stays inside the Apps response budget',t=>{
 const {AppsManager}=require('./apps-manager.cjs'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-runtime-logs-')),job={id:'a'.repeat(16),action:'project-executor'};
 t.after(()=>{const real=fs.realpathSync(directory);assert.equal(path.dirname(real),fs.realpathSync(os.tmpdir()));assert(path.basename(real).startsWith('homeai-runtime-logs-'));fs.rmSync(real,{recursive:true,force:true});});
 const manager={cfg:{stateDir:directory},store:{jobs:[job]},jobLog:AppsManager.prototype.jobLog};
 AppsManager.prototype.replaceJobLog.call(manager,job,{stdout:'\u0001'.repeat(200000),stderr:'\u0002'.repeat(100000)});
 const output=AppsManager.prototype.jobOutput.call(manager,job.id);assert(output.truncated.stdout&&output.truncated.stderr);assert(Buffer.byteLength(JSON.stringify(output))<2*1024*1024);
 assert.equal(output.stdout.length,128*1024);assert.equal(output.stderr.length,32*1024);
});
