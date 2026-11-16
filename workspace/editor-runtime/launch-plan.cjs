'use strict';
// A/Coordinator integration proposal. Returns argv only; does not execute Docker.
// Paths must be canonical root-owned registry records already checked in guest.
// 9p exports the parent to trusted guest root; the container gets ONE child.
// Guest firewall must reject project -> guest control/published sibling ports
// and cross-project forwarding. Docker --internal alone does not prove this.
const token=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
function launchPlan({id,imageDigest,guestPort,projectRoot,editorHome,uid,gid,verified}={}){
 if(!token(id))throw Error('INVALID_PROJECT_ID');
 if(!/^sha256:[a-f0-9]{64}$/.test(imageDigest||''))throw Error('IMMUTABLE_IMAGE_REQUIRED');
 if(!Number.isInteger(guestPort)||guestPort<1024||guestPort>65535)throw Error('INVALID_ASSIGNED_PORT');
 if(projectRoot!=='/srv/homeai/projects/'+id||editorHome!=='/srv/homeai/editor-state/'+id)throw Error('CANONICAL_PROJECT_PATH_REQUIRED');
 if(![uid,gid].every(n=>Number.isInteger(n)&&n>=1000&&n<=65534))throw Error('NONROOT_ID_REQUIRED');
 // The image UID/GID must match both bind roots. Do not chown an existing user
 // project during launch to force it to fit; resolve the image mapping first.
 for(const requirement of ['canonicalPaths','dedicatedProject','uidMapping','guestFirewall','internalNetwork','cgroupSwap','capacity'])if(verified?.[requirement]!==true)throw Error('UNVERIFIED_'+requirement);
 return{binary:'/usr/bin/docker',argv:['run','--detach','--pull=never','--name','homeai-editor-'+id,'--label','homeai.project='+id,'--label','homeai.component=editor',
  '--user',uid+':'+gid,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges=true','--init',
  '--pids-limit=128','--memory=1g','--memory-swap=1g','--cpus=2',
  '--network','homeai-project-'+id,'--publish','10.0.2.15:'+guestPort+':8080',
  '--mount','type=bind,src='+projectRoot+',dst=/workspace,bind-propagation=rprivate',
  '--mount','type=bind,src='+editorHome+',dst=/home/coder,bind-propagation=rprivate',
  '--tmpfs','/tmp:rw,nosuid,nodev,size=134217728,mode=1777',imageDigest],
  transport:{guestAddress:'10.0.2.15',guestPort,containerPort:8080,hostForwardBind:'127.0.0.1',brokerOnly:true},
  limits:{memoryMiB:1024,swapMiB:0,pids:128,cpus:2},
  acceptance:'NOT BUILT OR RUN. Requires actual container isolation, 9p watcher/draft/conflict proof, and controlled broker bridge.'};
}
module.exports={launchPlan};
