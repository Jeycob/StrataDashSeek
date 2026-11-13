'use strict';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
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
