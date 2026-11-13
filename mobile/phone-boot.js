'use strict';
// Only the static launcher is cached. Chat history and authenticated API responses are not.
window.harnessBackendReady=false;
async function prepareBackend(){
 const status=document.getElementById('status');
 const tell=text=>{document.getElementById('setup-header').hidden=false;status.textContent=text;};
 let key=localStorage.getItem('harness.wake.key'),cfg;
 const config=async()=>cfg||(cfg=await fetch('/phone/config.json',{cache:'no-store'}).then(r=>r.json()));
 async function provision(){try{let response=await fetch('/phone/api/wake-config',{signal:AbortSignal.timeout(4000)});if(response.status===401){const login=await fetch('/phone/api/tailscale-login',{method:'POST',signal:AbortSignal.timeout(4000)});if(login.ok)response=await fetch('/phone/api/wake-config',{signal:AbortSignal.timeout(4000)});}if(response.ok){const data=await response.json();if(data.key){key=data.key;localStorage.setItem('harness.wake.key',key);}cfg={wakeUrl:data.wakeUrl};}}catch{}}
 window.harnessBackendReady=false;
 try{const health=await fetch('/phone/health',{signal:AbortSignal.timeout(2500),cache:'no-store'});if(health.ok&&(await health.json()).ready){window.harnessBackendReady=true;await provision();return;}}catch{}
 if(!key){tell('Pro první nastavení otevři Harness jednou při běžícím serveru.');return;}
 tell('Probouzím Harness…');
 try{
  const {wakeUrl}=await config();const origin=new URL(wakeUrl).origin;
  const response=await fetch(origin+'/api/wake',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Budíček nelze kontaktovat.');
  const deadline=Date.now()+240000;
  while(Date.now()<deadline){
   tell('Připojuji Harness. Tailscale musí být zapnutý…');
   try{const r=await fetch('/phone/health',{signal:AbortSignal.timeout(4000),cache:'no-store'});if(r.ok&&(await r.json()).ready){window.harnessBackendReady=true;await provision();return;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw Error('Připojení trvá déle. Zkontroluj Tailscale a otevři aplikaci znovu.');
 }catch(e){tell(e.message);}
};
let preparing=null;window.harnessPrepare=()=>preparing||(preparing=prepareBackend().finally(()=>{preparing=null;}));
