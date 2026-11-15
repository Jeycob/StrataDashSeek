import uiCopy from '../shared/ui-copy.cjs';
import {devicePortal} from './device-page.mjs';
export const client='const UI_COPY='+JSON.stringify(uiCopy.pairs)+';\n'+String.raw`
const $=id=>document.getElementById(id);
const t=text=>{if(document.documentElement.lang==='cs')return text;for(const [cs,en]of Object.entries(UI_COPY).sort((a,b)=>b[0].length-a[0].length))text=text.split(cs).join(en);return text;};
$('language').value=document.documentElement.lang;$('language').onchange=()=>{const url=new URL(location.href);url.searchParams.set('lang',$('language').value);location.assign(url);};
let launching=false;
const manageDevices=new URLSearchParams(location.search).get('devices')==='1';
const deviceView=(${devicePortal.toString()})({document,api});
const appPort=new URLSearchParams(location.search).get('appPort');
const statusPath='status'+(appPort!==null?'?appPort='+encodeURIComponent(appPort):'');
let statusTag,statusValue;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function visible(){while(document.hidden)await new Promise(resolve=>{const show=()=>{if(!document.hidden){document.removeEventListener('visibilitychange',show);resolve();}};document.addEventListener('visibilitychange',show);});}
async function api(path,body){
 const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:statusTag?{'If-None-Match':statusTag}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),cache:'no-store'});
 if(!body&&r.status===304&&statusValue)return statusValue;
 const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error||'Chyba spojení'),{status:r.status,code:d.code,retryAfterSeconds:Number(r.headers.get('retry-after'))||30});
 if(!body){statusTag=r.headers.get('etag');statusValue=d;}return d;
}
function imageReady(url){return new Promise(resolve=>{const img=new Image();const timer=setTimeout(()=>resolve(false),4000);img.onload=()=>{clearTimeout(timer);resolve(true);};img.onerror=()=>{clearTimeout(timer);resolve(false);};img.src=new URL('/phone/icon.png?ready='+Date.now(),url).href;});}
async function launch(){
 if(launching)return;launching=true;
 $('login').hidden=true;$('control').hidden=false;$('wake').disabled=true;$('open').hidden=true;
 try{
  await visible();$('status').textContent=t('Připravuji Harness…');let wake=await api('wake',{}),lastWake=Date.now();const deadline=Date.now()+360000;let attempt=0;
  while(Date.now()<deadline){
   await visible();if(Date.now()>=deadline)break;
   let state;try{state=await api(statusPath);if(wake.queued&&Date.now()-lastWake>=1000*(wake.retryAfterSeconds||15)){if(document.hidden)continue;wake=await api('wake',{});lastWake=Date.now();}}catch(error){if([429,503].includes(error.status)){await pause(1000*error.retryAfterSeconds);continue;}throw error;}$('open').href=state.applicationUrl||state.harnessUrl;
   $('status').textContent=t(wake.queued?'Čekám na volnou kapacitu původního serveru.':state.status==='running'?(state.applicationUrl?'Připravuji připojení k aplikaci…':'Čekám na bezpečné připojení k Harnessu…'):'Probouzím server…');
   if(!document.hidden&&state.status==='running'&&await imageReady(state.harnessUrl)){location.replace(state.applicationUrl||state.harnessUrl);return;}
   await pause(Math.min(15000,2000*Math.pow(1.6,attempt++))+Math.random()*500);
  }
  throw Error(wake.queued?'Vast zatím nemá volnou kapacitu původního serveru. Data zůstávají uložená. Zkus to později.':'Připojení trvá déle. Zkontroluj Tailscale a zkus pokračovat odkazem.');
 }catch(e){$('message').textContent=t(e.message);$('open').hidden=!$('open').href;}
 finally{launching=false;$('wake').disabled=false;}
}
$('login').onsubmit=async e=>{e.preventDefault();try{await api('login',{key:$('key').value});$('key').value='';if(manageDevices)await deviceView.load();else await launch();}catch(e){$('message').textContent=e.message;}};
$('wake').onclick=launch;
(async()=>{
 const setup=new URLSearchParams(location.hash.slice(1)).get('setup');if(setup)history.replaceState(null,'',location.pathname);
 try{await visible();if(setup)await api('login',{key:setup});else if(!manageDevices)await api(statusPath);if(manageDevices)await deviceView.load();else await launch();}
 catch(e){$('login').hidden=false;$('message').textContent=t(setup?e.message:'Pro první propojení použij svůj soukromý QR.');}
})();
`;
