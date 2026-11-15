'use strict';
const SHELL_CACHE='harness-static-shell-v11-device-context';
const SHELL_FILES=['/phone/ui-copy.js','/phone/localize.js','/phone/i18n.js','/phone/workbench.js','/phone/','/phone/app.js','/phone/boot.js','/phone/monitor.js','/phone/apps.js','/phone/config.json','/phone/icon.png'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(SHELL_CACHE);await cache.addAll(SHELL_FILES);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('harness-static-shell-')&&key!==SHELL_CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
 const pathname=url.pathname==='/phone/index.html'?'/phone/':url.pathname;
 if(!SHELL_FILES.includes(pathname))return; // Never cache APIs, credentials, iframe content or chat history.
 event.respondWith((async()=>{
  const cache=await caches.open(SHELL_CACHE),cached=await cache.match(pathname);
  // Keep the wake bootstrap immediately available offline. Fetch current UI code
  // when online so an installed phone does not hide newly deployed controls.
  if(cached&&['/phone/boot.js','/phone/config.json','/phone/icon.png'].includes(pathname)){event.waitUntil(fetch(event.request).then(response=>{if(response.ok)return cache.put(pathname,response);}).catch(()=>{}));return cached;}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
  try{const response=await fetch(event.request,{signal:controller.signal,cache:'no-store'});if(response.ok){await cache.put(pathname,response.clone());return response;}return cached||response;}
  catch(error){if(cached)return cached;throw error;}
  finally{clearTimeout(timer);}
 })());
});
function target(value){try{const u=new URL(value||'/phone/',self.location.origin);if(u.origin===self.location.origin||(u.protocol==='https:'&&(u.hostname.endsWith('.ts.net')||u.hostname.endsWith('.workers.dev'))))return u.href;}catch{}return self.location.origin+'/phone/';}
self.addEventListener('push',event=>{
 let data={title:'Harness',body:'Úloha potřebuje pozornost.',url:'/phone/'};
 try{if(event.data)data=Object.assign(data,event.data.json());}catch{}
 // Every received push must become a visible notification on Safari.
 event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/phone/icon.png',badge:'/phone/icon.png',tag:data.tag||'harness',data:{url:target(data.url)}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();event.waitUntil((async()=>{const destination=target(event.notification.data?.url);const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of windows){if(client.url===destination)return client.focus();}return self.clients.openWindow(destination);})());
});



