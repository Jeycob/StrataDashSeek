'use strict';
const byId=id=>document.getElementById(id);
let installationId=localStorage.getItem('harness.push.installation');
if(!installationId){installationId=crypto.randomUUID();localStorage.setItem('harness.push.installation',installationId);}
const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const ios=/iPhone|iPad|iPod/.test(navigator.userAgent);
let registration=null,state=null;
const supported='serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
function note(text){byId('message').textContent=text;}
async function api(route,data){const response=await fetch('/phone/api/'+route,{method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'Požadavek selhal.'),{status:response.status});return result;}
function keyBytes(text){return Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
let harnessMenuObserver=null;
function installNotificationMenu(){
 if(harnessMenuObserver)harnessMenuObserver.disconnect();
 const frame=byId('harness');let doc;try{doc=frame.contentDocument;}catch{return;}
 if(!doc||!doc.body)return;
 const addMenuItem=()=>{
  const trigger=doc.querySelector('button[aria-label="Account menu"][aria-expanded="true"],button[data-signed-out][aria-haspopup="menu"][aria-expanded="true"]');
  if(!trigger)return;
  const menus=Array.from(doc.querySelectorAll('[role="menu"]')).filter(menu=>menu.getClientRects().length);
  const anchor=trigger.parentElement.style.getPropertyValue('anchor-name').trim();
  const menu=menus.find(item=>anchor&&item.style.getPropertyValue('position-anchor').trim()===anchor)||(menus.length===1?menus[0]:null);
  if(!menu||menu.querySelector('[data-harness-push-menu]'))return;
  const template=menu.querySelector('button[role="menuitem"]');if(!template)return;
  const item=template.cloneNode(false);item.removeAttribute('id');item.removeAttribute('aria-keyshortcuts');item.removeAttribute('data-dsh-automatic-focus');item.dataset.harnessPushMenu='true';
  const label=doc.createElement('span');const originalLabel=template.querySelector('span[class*="itemLabel"]');
  if(originalLabel)label.className=originalLabel.className;else label.style.gridColumn='1 / -1';
  label.textContent='Oznámení na iPhonu';item.appendChild(label);
  item.onclick=event=>{event.preventDefault();event.stopPropagation();trigger.click();byId('settings').hidden=false;byId('close-settings').focus();};
  const wrapper=template.parentElement.cloneNode(false);wrapper.removeAttribute('id');wrapper.appendChild(item);template.parentElement.after(wrapper);
 };
 harnessMenuObserver=new MutationObserver(addMenuItem);
 harnessMenuObserver.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-expanded']});
 addMenuItem();
}
byId('harness').addEventListener('load',installNotificationMenu);
async function refresh(){
 try{
  state=await api('state?installationId='+encodeURIComponent(installationId));byId('pair').hidden=true;byId('harness').hidden=false;if(!byId('harness').getAttribute('src'))byId('harness').src='/';
  byId('status').textContent=(state.registered?'Oznámení zapnuta':'Oznámení vypnuta')+(state.watcherOnline?' · hlídání úloh běží':' · hlídání úloh se připojuje');
  byId('setup-header').hidden=true;
  byId('install-help').hidden=state.registered;
  document.body.classList.toggle('push-enabled',state.registered);
  byId('enable').disabled=!registration||!supported||(ios&&!standalone);byId('test').disabled=!state.registered;byId('disable').disabled=!state.registered;
 }catch(e){if(e.status===401){state=null;byId('pair').hidden=false;byId('harness').hidden=true;byId('setup-header').hidden=false;document.body.classList.remove('push-enabled');byId('settings').hidden=true;byId('status').textContent='Tento web je potřeba propojit s PC';}else byId('status').textContent='Připojení se obnovuje…';}
}
byId('settings-button').onclick=()=>{byId('settings').hidden=!byId('settings').hidden;};
byId('close-settings').onclick=()=>{byId('settings').hidden=true;};
document.addEventListener('keydown',e=>{if(e.key==='Escape')byId('settings').hidden=true;});
byId('pair-form').onsubmit=async e=>{e.preventDefault();try{await api('pair',{code:byId('pair-code').value.trim()});byId('pair-code').value='';byId('pair-message').textContent='';await refresh();byId('settings').hidden=false;note('Propojeno. Nyní můžeš zapnout oznámení.');}catch(err){byId('pair-message').textContent=err.message;}};
byId('enable').onclick=async()=>{
 // Permission request stays directly in the user's click. Never request on load.
 const permissionPromise=Notification.requestPermission();
 try{const permission=await permissionPromise;if(permission!=='granted')throw Error('Oznámení nebyla povolena.');registration=await navigator.serviceWorker.ready;let subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(state.vapidPublicKey)});await api('subscribe',{installationId,subscription:subscription.toJSON()});await refresh();note('Zapnuto. Stiskni Test za 5 sekund a zamkni telefon.');}catch(e){note(e.message);}
};
byId('test').onclick=async()=>{try{const result=await api('test',{installationId});note(result.message);}catch(e){note(e.message);}};
byId('disable').onclick=async()=>{try{await api('disable',{installationId});await refresh();note('Oznámení vypnuta.');}catch(e){note(e.message);}};
if(!supported)note('Tento prohlížeč nepodporuje Web Push. Na iPhonu otevři ikonu z plochy.');
else if(ios&&!standalone)note('Povolení oznámení bude dostupné po otevření ikony z plochy.');
if(supported)navigator.serviceWorker.register('/phone/sw.js',{scope:'/phone/'}).then(r=>{registration=r;return refresh();}).catch(()=>note('Registrace oznámení selhala. Obnov stránku.'));
if(new URL(location.href).searchParams.get('settings')==='1')byId('settings').hidden=false;
refresh();setInterval(refresh,15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
