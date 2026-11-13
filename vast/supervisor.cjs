'use strict';
const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process');
const R='/data/harness',cfg=JSON.parse(fs.readFileSync(R+'/config.json','utf8'));
fs.mkdirSync(R+'/state',{recursive:true});
const uid=Number(cp.execFileSync('id',['-u','harness']).toString()),gid=Number(cp.execFileSync('id',['-g','harness']).toString());
fs.chownSync(R+'/state',uid,gid);
const children=new Map();let closing=false;
const env={...process.env,HOME:R+'/home',DSH_HOME:R+'/home/.dsh',PATH:R+'/node/bin:/usr/local/bin:/usr/bin:/bin',STRATA_GATEWAY_KEY:'local-strata'};
delete env.VAST_API_KEY;delete env.CLOUDFLARE_API_TOKEN;
function save(){fs.writeFileSync(R+'/state/services.json',JSON.stringify({pids:[...children.values()].map(p=>p.pid)}),{mode:0o644});}
function launch(name,exe,args,asRoot=false){
 const out=fs.openSync(R+'/logs/'+name+'.log','a',0o600);
 if(!asRoot)fs.fchownSync(out,uid,gid);
 const child=cp.spawn(exe,args,{cwd:R+'/workspaces',env,uid:asRoot?0:uid,gid:asRoot?0:gid,stdio:['ignore',out,out]});fs.closeSync(out);
 children.set(name,child);save();child.on('error',e=>console.log(name+': '+e.message));child.on('exit',(code)=>{children.delete(name);save();if(!closing){console.log(name+' exited '+code);setTimeout(()=>launch(name,exe,args,asRoot),3000);}});return child;
}
function portOpen(port){return new Promise(resolve=>{const q=http.get('http://127.0.0.1:'+port+'/health',r=>{r.resume();resolve(true)});q.on('error',()=>resolve(false));q.setTimeout(2000,()=>{q.destroy();resolve(false)});});}
(async()=>{
 if(!await portOpen(8080))launch('strata','bash',['/data/start-strata.sh'],true);
 let tailscaleAlive=false;try{cp.execFileSync('tailscale',['--socket='+R+'/tailscaled.sock','status','--json'],{stdio:'pipe',timeout:4000});tailscaleAlive=true;}catch{}
 if(!tailscaleAlive){try{fs.unlinkSync(R+'/tailscaled.sock')}catch{}launch('tailscaled','/usr/sbin/tailscaled',['--tun=userspace-networking','--statedir='+R+'/root-secrets/tailscale','--state='+R+'/root-secrets/tailscaled.state','--socket='+R+'/tailscaled.sock'],true);}
 launch('model-proxy',R+'/node/bin/node',[R+'/app/vast/model-proxy.cjs']);
 launch('harness',R+'/node/bin/node',[R+'/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js','web','--no-open','--port','3090','--public-url','https://'+cfg.publicHost+'/','--trusted-host',cfg.publicHost]);
 launch('push',R+'/node/bin/node',[R+'/app/mobile/webpush-server.cjs',R+'/push-config.json']);
 launch('proxy',R+'/node/bin/node',[R+'/app/mobile/https-proxy.cjs',R+'/config.json']);
 launch('push-watcher',R+'/venv/bin/python',[R+'/app/mobile/watch-harness-notifications.py','--session-root',R+'/home/.dsh/sessions','--key-file',R+'/secrets/webpush-internal.key']);
 launch('telemetry',R+'/node/bin/node',[R+'/app/vast/telemetry.cjs'],true);
 launch('idle-guard',R+'/venv/bin/python',[R+'/app/vast/idle-guard.py'],true);
 const serving=setInterval(()=>{const p=cp.spawn('tailscale',['--socket='+R+'/tailscaled.sock','serve','--bg','http://127.0.0.1:3081'],{stdio:'ignore'});p.on('exit',code=>{if(code===0)clearInterval(serving)});},3000);serving.unref();
})();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing=true;for(const child of children.values())child.kill('SIGTERM');setTimeout(()=>process.exit(),2000);});
