'use strict';
const crypto=require('node:crypto');
const fail=()=>Object.assign(Error('DEPLOYMENT_IMAGE_FOOTPRINT_UNKNOWN'),{code:'DEPLOYMENT_IMAGE_FOOTPRINT_UNKNOWN',status:409});
function scanScript(directory,nonce){
 if(!/^\/[a-zA-Z0-9_./-]+$/.test(directory)||directory.split('/').includes('..')||!/^[a-f0-9]{16}$/.test(nonce))throw fail();
 return `set -eu\nset -o pipefail\ntest -d '${directory}'\ntest ! -L '${directory}'\nkib=$(du -sk '${directory}' | awk '{print $1}')\ninodes=$(find '${directory}' -xdev -print0 | tr -cd '\\000' | wc -c)\nprintf 'HARNESS_FOOTPRINT_${nonce}=%s,%s\\n' "$kib" "$inodes"\n`;
}
async function imageFootprint(manager,image){
 const worker=manager.worker,status=worker?.status();if(!worker||status?.phase!=='ready'||status.controlIsolation?.verified!==true||!/^sha256:[a-f0-9]{64}$/.test(image?.Id||''))throw fail();
 const current=await manager.engine.json('GET','/images/'+image.Id+'/json');
 const directory=current?.GraphDriver?.Data?.SourceDir;
 if(current.Id!==image.Id||current.GraphDriver?.Name!=='vfs'||!/^\/var\/lib\/harness\/docker\/vfs\/dir\/[a-zA-Z0-9_-]{1,80}$/.test(directory||''))throw fail();
 if(!worker.serial||worker.serial.destroyed)await worker.connectSerial();
 const nonce=crypto.randomBytes(8).toString('hex'),script=Buffer.from(scanScript(directory,nonce)).toString('base64');
 worker.serial.write("if printf '%s' '"+script+"' | base64 -d | timeout -s KILL 12 sh; then printf 'HARNESS_FOOTPRINT_DONE_"+nonce+"=0\\n'; else printf 'HARNESS_FOOTPRINT_DONE_"+nonce+"=%s\\n' \"$?\"; fi\n");
 const deadline=Date.now()+15000;while(Date.now()<deadline){
  const done=worker.buffer.match(new RegExp('HARNESS_FOOTPRINT_DONE_'+nonce+'=(\\d+)'));
  if(done){const found=worker.buffer.match(new RegExp('HARNESS_FOOTPRINT_'+nonce+'=(\\d+),(\\d+)'));if(done[1]!=='0'||!found)throw fail();const allocatedBytes=Number(found[1])*1024,InodeCount=Number(found[2]);if(!Number.isSafeInteger(allocatedBytes)||allocatedBytes<1||!Number.isSafeInteger(InodeCount)||InodeCount<1)throw fail();return{...image,Size:Math.max(image.Size,allocatedBytes),InodeCount,footprintObservedAt:Date.now()};}
  await new Promise(resolve=>setTimeout(resolve,50));
 }throw fail();
}
module.exports={imageFootprint,scanScript};
