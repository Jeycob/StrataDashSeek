import uiCopy from '../shared/ui-copy.cjs';
export const client='const UI_COPY='+JSON.stringify(uiCopy.pairs)+';\n'+String.raw`
const $=id=>document.getElementById(id);
const t=text=>{if(document.documentElement.lang==='cs')return text;for(const [cs,en]of Object.entries(UI_COPY).sort((a,b)=>b[0].length-a[0].length))text=text.split(cs).join(en);return text;};
$('language').value=document.documentElement.lang;$('language').onchange=()=>{const url=new URL(location.href);url.searchParams.set('lang',$('language').value);location.assign(url);};
let launching=false;
const appPort=new URLSearchParams(location.search).get('appPort');
const statusPath='status'+(appPort!==null?'?appPort='+encodeURIComponent(appPort):'');
async function api(path,body){
 const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error||'Chyba spojení'),{status:r.status});return d;
}
function imageReady(url){return new Promise(resolve=>{const img=new Image();const timer=setTimeout(()=>resolve(false),4000);img.onload=()=>{clearTimeout(timer);resolve(true);};img.onerror=()=>{clearTimeout(timer);resolve(false);};img.src=new URL('/phone/icon.png?ready='+Date.now(),url).href;});}
async function launch(){
 if(launching)return;launching=true;
 $('login').hidden=true;$('control').hidden=false;$('wake').disabled=true;$('open').hidden=true;
 try{
  $('status').textContent=t('Připravuji Harness…');await api('wake',{});const deadline=Date.now()+240000;let attempt=0;
  while(Date.now()<deadline){
   const state=await api(statusPath);$('open').href=state.applicationUrl||state.harnessUrl;
   $('status').textContent=t(state.status==='running'?(state.applicationUrl?'Připravuji připojení k aplikaci…':'Čekám na bezpečné připojení k Harnessu…'):'Probouzím server…');
   if(state.status==='running'&&await imageReady(state.harnessUrl)){location.replace(state.applicationUrl||state.harnessUrl);return;}
   await new Promise(r=>setTimeout(r,Math.min(5000,1000*Math.pow(1.3,attempt++))+Math.random()*250));
  }
  throw Error('Připojení trvá déle. Zkontroluj Tailscale a zkus pokračovat odkazem.');
 }catch(e){$('message').textContent=t(e.message);$('open').hidden=!$('open').href;}
 finally{launching=false;$('wake').disabled=false;}
}
$('login').onsubmit=async e=>{e.preventDefault();try{await api('login',{key:$('key').value});$('key').value='';await launch();}catch(e){$('message').textContent=e.message;}};
$('wake').onclick=launch;
(async()=>{
 const setup=new URLSearchParams(location.hash.slice(1)).get('setup');if(setup)history.replaceState(null,'',location.pathname);
 try{if(setup)await api('login',{key:setup});else await api(statusPath);await launch();}
 catch(e){$('login').hidden=false;$('message').textContent=t(setup?e.message:'Pro první propojení použij svůj soukromý QR.');}
})();
`;
