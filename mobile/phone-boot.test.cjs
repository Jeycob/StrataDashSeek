'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('queued capacity is visible and overlapping phone opens share bounded wake retries',async()=>{
 let now=100000,health=0,wakes=0;const labels=[],status={set textContent(text){labels.push(text);}},header={hidden:true},window={};
 const fetch=async(url)=>{if(url==='/phone/health')return Response.json({ready:++health>=5});if(url==='/phone/config.json')return Response.json({wakeUrl:'https://wake.example.com/'});if(url==='/phone/api/wake-config')return Response.json({key:'fixture',wakeUrl:'https://wake.example.com/'});assert.equal(url,'https://wake.example.com/api/wake');wakes++;return Response.json(wakes===1?{ok:false,queued:true,retryAfterSeconds:15}:{ok:true,queued:false},{status:wakes===1?202:200});};
 class Clock extends Date{static now(){return now;}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'phone-boot.js'),'utf8'),{window,document:{hidden:false,getElementById:id=>id==='status'?status:header},localStorage:{getItem:()=> 'fixture',setItem(){}},fetch,URL,Date:Clock,AbortSignal,Math,setTimeout:fn=>{now+=10000;Promise.resolve().then(fn);}});
 await Promise.all([window.harnessPrepare(),window.harnessPrepare()]);assert.equal(window.harnessBackendReady,true);assert.equal(wakes,2);assert(labels.includes('capacityWait'));
});
test('rejected phone wake never claims backend readiness',async()=>{
 const window={},status={textContent:''};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'phone-boot.js'),'utf8'),{window,document:{hidden:false,getElementById:id=>id==='status'?status:{}},localStorage:{getItem:()=> 'fixture'},fetch:async url=>url==='/phone/config.json'?Response.json({wakeUrl:'https://wake.example.com/'}):new Response('',{status:503}),URL,Date,AbortSignal,Math,setTimeout});await window.harnessPrepare();assert.equal(window.harnessBackendReady,false);assert.equal(status.textContent,'wakeFailed');
});
