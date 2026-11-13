'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function openHarness(cfg,{fetchImpl=fetch,ssh=cp.execFileSync,now=Date.now,pause=delay}={}){
 const origin=new URL(cfg.wakeUrl).origin,key=fs.readFileSync(cfg.keyFile,'utf8').trim();
 let cookie='';
 async function api(route,body){const response=await fetchImpl(origin+'/api/'+route,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Budicek: HTTP '+response.status);const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return response.json();}
 await api('login',{key});await api('wake',{});
 const deadline=now()+(cfg.timeoutSeconds||240)*1000;let status,ready=false;
 while(now()<deadline){
  status=await api('status');
  if(status.status==='running'){
   const target=new URL(status.harnessUrl);
   if(target.protocol!=='https:'||!target.hostname.endsWith('.ts.net'))throw Error('Neocekavana adresa Harnessu');
   try{const response=await fetchImpl(new URL('/phone/health',target),{signal:AbortSignal.timeout(4000)});if(response.ok&&(await response.json()).ready===true){ready=true;break;}}catch{}
  }
  await pause(2000);
 }
 if(!ready)throw Error('Server se nepodarilo pripravit v casovem limitu.');
 const target=new URL(status.harnessUrl),connection=status.ssh;
 if(!connection||typeof connection.host!=='string'||!/^[a-zA-Z0-9.-]+$/.test(connection.host)||!Number.isInteger(Number(connection.port))||Number(connection.port)<1||Number(connection.port)>65535)throw Error('Chybi platne SSH spojeni');
 const log=ssh(cfg.sshExecutable||'ssh.exe',['-i',cfg.sshKeyFile,'-o','UserKnownHostsFile='+cfg.knownHostsFile,'-o','BatchMode=yes','-o','ConnectTimeout=10','-p',String(connection.port),'root@'+connection.host,'tail -n 40 /data/harness/logs/harness.log'],{encoding:'utf8',timeout:20000,maxBuffer:65536,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const matches=[...log.matchAll(/https:\/\/[^\s]+\?token=[^\s]+/g)];if(!matches.length)throw Error('Prihlasovaci odkaz Harnessu zatim neni pripraveny.');
 const entry=new URL(matches.at(-1)[0]);if(entry.origin!==target.origin||entry.pathname!=='/'||!entry.searchParams.get('token'))throw Error('Neocekavana prihlasovaci adresa');
 // This official launch-token exchange uses Harness's existing owner login.
 // The launch token stays in this private process output; never log it.
 const phoneEntry=new URL('/phone/entry',entry);phoneEntry.searchParams.set('token',entry.searchParams.get('token'));return phoneEntry.href;
}
module.exports={openHarness};
if(require.main===module){const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));openHarness(cfg).then(url=>process.stdout.write(url)).catch(()=>{console.error('Automaticke otevreni Harnessu selhalo. Zkontroluj Tailscale a dostupnost serveru.');process.exitCode=1;});}
