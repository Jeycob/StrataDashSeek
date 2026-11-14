'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const home=false,root=path.resolve(process.argv[3]),cwd=path.join(root,'csv-agent');
const {call:rawCall,login}=require('./homeai-migrate-admin.cjs');let cookie;async function call(m,d){cookie ||= await login();return rawCall(m,d,cookie);}
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function main(){
 fs.mkdirSync(root,{recursive:true});
 const running=(await call('session/list',{})).items.filter(x=>x.running);if(running.length)throw Error('Existing Harness task active; no benchmark started');
 const tests=['test/public.test.mjs','test/edge-cases.test.mjs'];const initialHashes=Object.fromEntries(tests.map(f=>[f,hash(path.join(cwd,f))]));
 const task=`Repair the existing expense CSV implementation, preserving its public API and all current tests. Do not replace the whole implementation or add dependencies.
Independent review found two classes of real bug:
1. A final comma at EOF silently loses the extra empty column, accepting an invalid six-column row/header.
2. Safe overall cents do not imply safe category/month subtotals: positive and negative amounts can cancel globally while a subtotal overflows and loses cents.
Four regression cases are in test/edge-cases.test.mjs. Fix the underlying boundaries, not just the examples. Reject unsafe intermediate totals with TypeError, preserving the existing safe-integer contract. Keep valid quoted fields, CRLF/LF, BOM, refunds and duplicate behavior. Run every existing/new test and verify the existing CLI output on data/expenses.csv.
Use the smallest coherent patch. Do not change tests. No helper modules, package installation, unrelated formatting or permanent diagnostic scripts are needed. Work only in this directory. Do not spawn subagents or request a permission escalation.
Environment: ${home?'Windows PowerShell':'Linux bash'}. Node executable: ${process.execPath}. Run Node with --test-isolation=none --test test/public.test.mjs test/edge-cases.test.mjs. After real tests finish, summarize changed files and observed results briefly in English.`;
 fs.writeFileSync(path.join(root,'task.txt'),task);
 const {sessionId}=await call('session/create',{cwd:cwd.replaceAll('\\','/')});
 await call('session/rename',{sessionId,title:'Home versus Vast benchmark CSV 20261113'});
 await call('session/selectModel',{sessionId,provider:home?'strata1':'strata-vast',model:home?'iq3_s':'strata',reasoningEffort:'medium'});
 const started=Date.now();await call('session/prompt',{sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:task}]});
 fs.writeFileSync(path.join(root,'agent-session.json'),JSON.stringify({sessionId,started,backend:home?'home':'vast'}));console.log(JSON.stringify({event:'agent-started',sessionId}));
 let projection,completed=false;for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,5000));projection=await call('session/projections',{sessionId});fs.writeFileSync(path.join(root,'agent-projection.json'),JSON.stringify(projection));const item=(await call('session/list',{})).items.find(x=>x.sessionId===sessionId);if(i%6===0)console.log(JSON.stringify({event:'agent-progress',seconds:(Date.now()-started)/1000,running:item?.running,stats:projection.values.sessionStats}));if(item&&!item.running){completed=true;break}}
 if(!completed){await call('session/cancel',{sessionId});throw Error('Bounded 15-minute benchmark timed out; own session cancelled')}
 const page=await call('session/page',{address:{kind:'session',sessionId},throughSeq:projection.asOfSeq,maxMessages:500});fs.writeFileSync(path.join(root,'agent-trace.json'),JSON.stringify(page,null,2));
 const events=page.records.filter(x=>x.type==='event').map(x=>x.event),t0=events.find(x=>x.type==='turn/start'),t1=events.find(x=>x.type==='turn/end');
 let testExit,testOutput;try{testOutput=cp.execFileSync(process.execPath,['--test-isolation=none','--test',...tests],{cwd,encoding:'utf8',timeout:30000});testExit=0}catch(e){testExit=e.status;testOutput=(e.stdout||'')+(e.stderr||'')}
 fs.writeFileSync(path.join(root,'independent-tests.txt'),testOutput);
 const finalHashes=Object.fromEntries(tests.map(f=>[f,hash(path.join(cwd,f))]));
 const report={backend:home?'home':'vast',sessionId,started:new Date(started).toISOString(),completed,wallSeconds:t0&&t1?(t1.time-t0.time)/1000:(Date.now()-started)/1000,turnEnd:t1?.data,stats:projection.values.sessionStats,usage:projection.values.tokenUsage,toolCalls:events.filter(x=>x.type==='tool/call').length,toolErrors:events.filter(x=>x.type==='tool/result'&&x.data.message?.isError).length,testExit,initialHashes,finalHashes,testsUnchanged:JSON.stringify(initialHashes)===JSON.stringify(finalHashes),pageHasMore:page.hasMore};
 fs.writeFileSync(path.join(root,'agent-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.stack);fs.writeFileSync(path.join(root,'agent-error.txt'),e.stack);process.exitCode=1});

