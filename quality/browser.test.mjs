// Requires prepared Playwright/Chromium. Missing browser is a failed test, never a mock pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyBrowser} from './browser.mjs';
import {verifyProject} from './core.mjs';

function shop(bug) {
  return `<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{font:18px system-ui;margin:24px;max-width:900px}button{padding:12px}button:focus{outline:3px solid blue}.product{width:${bug==='overflow'?'2000px':'100%'}}svg{width:120px;height:80px}</style>
  <h1>Papírna – ověřovací příklad</h1><article class="product"><h2>Sešit</h2>${bug==='images'?'':'<svg role="img" aria-label="Sešit" viewBox="0 0 120 80"><rect width="120" height="80" fill="#95b5a1"/></svg>'}<p>120 Kč</p><button id="add">Přidat</button></article>
  <p id="total">Košík je prázdný</p><script>document.querySelector('#add').onclick=()=>{document.querySelector('#total').textContent='Celkem: ${bug==='nan'?'NaN':'120'} Kč'};${bug==='console'?"console.error('fixture rendering failure')":''}</script></html>`;
}

// Disposable loopback fixture: verifies quality/Chromium diagnostics, not HOST
// producer custody. The separate pinned-SDK suite covers owned job lifetime.
test('real Chromium retains refused assigned-port cause before readiness and after server shutdown', {timeout:90000}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quality-readiness-'));
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>Ready fixture</h1>');});
  const listen=port=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const close=()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await listen(0);const port=server.address().port;await close();
  t.after(async()=>{if(server.listening)await close();await fs.rm(root,{recursive:true,force:true});});
  await fs.writeFile(path.join(root,'plan.json'),JSON.stringify({version:1,baseURL:'http://127.0.0.1:${PORT}',viewports:[{name:'desktop',width:800,height:600}],flows:[{name:'start',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',textIncludes:'Ready fixture'},{action:'checkpoint',name:'ready'}]}]}));
  await fs.writeFile(path.join(root,'.harness-quality.json'),JSON.stringify({version:1,sources:['plan.json'],requiredKinds:['browser'],checks:[{id:'ui',kind:'browser',plan:'plan.json',timeoutMs:20000}]}));
  const env={...process.env,PORT:String(port),HARNESS_QUALITY_ALLOWED_PORTS:String(port)};
  const verify=()=>verifyProject({workspace:root,env});
  const refused=async()=>{
    const report=await verify(),raw=JSON.parse(await fs.readFile(path.join(root,'.harness/quality/ui-browser.json'),'utf8'));
    assert.equal(raw.engine,'chromium');assert.equal(raw.screenshots.length,0);assert.equal(raw.failed,1);
    assert(raw.results.some(r=>!r.passed&&r.detail?.includes('ERR_CONNECTION_REFUSED')),JSON.stringify(raw));
    assert.equal(report.complete,false);assert.equal(report.passed,false);
    assert(report.results[0].diagnostics.some(d=>d.includes('ERR_CONNECTION_REFUSED')),JSON.stringify(report));
    assert(report.results[0].diagnostics.includes('BROWSER_EVIDENCE_MISSING'));
    assert.equal(report.results[0].artifactPaths.filter(p=>p.endsWith('.png')).length,0);
    return report.runId;
  };
  const first=await refused();
  const contract=JSON.parse(await fs.readFile(path.join(root,'.harness-quality.json'),'utf8'));
  const ownedContract=structuredClone(contract);ownedContract.checks[0].server={command:['node','fixture-server.mjs']};
  await fs.writeFile(path.join(root,'.harness-quality.json'),JSON.stringify(ownedContract));
  let stopped=false;
  // Local driver fixture seam only; actual SDK channel/custody has separate
  // inert-kernel tests and still requires Root's real Linux qualification.
  const ready=await verifyProject({workspace:root,env,serverControl:{deadline:Date.now()+25000,async start(request){assert.equal(request.checkId,'ui');await listen(port);},async stop(id){assert.equal(id,'ui');await close();stopped=true;}}});
  assert.equal(ready.complete,true,JSON.stringify(ready));assert.equal(stopped,true);assert.equal(server.listening,false);
  const shots=ready.results[0].artifactPaths.filter(p=>p.endsWith('.png'));assert.equal(shots.length,1);
  assert.equal((await fs.readFile(path.join(root,shots[0]))).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  await fs.writeFile(path.join(root,'.harness-quality.json'),JSON.stringify(contract));
  const last=await refused();assert.notEqual(last,first);assert.notEqual(last,ready.runId);
});

test('real Chromium distinguishes working shop from four known UI regressions', {timeout:90000}, async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quality-browser-'));
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(shop(new URL(req.url,'http://localhost').searchParams.get('bug')));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
  const baseURL=`http://127.0.0.1:${server.address().port}`;
  for(const bug of ['fixed','nan','images','overflow','console']) {
    const steps=[{action:'goto',path:`/?bug=${bug}`},{action:'click',selector:'#add'},
      {action:'expect',selector:'#total',textIncludes:'Celkem:'},
      {action:'expect',selector:'#add',focused:true},
      {action:'checkpoint',name:'checkout',imageContainers:['.product']}];
    const plan={version:1,baseURL,viewports:[{name:'desktop',width:1440,height:900},{name:'mobile',width:390,height:844}],flows:[{name:'checkout',steps}]};
    await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan));
    const r=await verifyBrowser({workspace:root,planPath:'plan.json',outputPath:`.harness/quality/${bug}.json`,runId:bug,env:{...process.env,HARNESS_QUALITY_ALLOWED_PORTS:String(server.address().port)}});
    if(bug==='fixed') {assert.equal(r.failed,0,JSON.stringify(r.results.filter(x=>!x.passed)));assert.ok(r.passed>=12);}
    else {const expected={nan:'INVALID_VISIBLE_TEXT',images:'MISSING_OR_BROKEN_IMAGES',overflow:'HORIZONTAL_OVERFLOW',console:'BROWSER_ERRORS'}[bug];assert.equal(r.results.filter(x=>!x.passed && x.code===expected).length,2,JSON.stringify(r));}
    assert.equal(r.screenshots.length,2);
    for(const shot of r.screenshots) {const png=await fs.readFile(path.join(root,shot.path));assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),shot.width);assert.equal(png.readUInt32BE(20),shot.height);}
  }
  // Also exercise the actual CLI driver's nonce, artifact and source-hash path.
  const plan=JSON.parse(await fs.readFile(path.join(root,'plan.json'),'utf8'));
  plan.flows[0].steps[0].path='/?bug=fixed';
  await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan));
  await fs.writeFile(path.join(root,'.harness-quality.json'),JSON.stringify({version:1,sources:['plan.json'],requiredKinds:['browser'],checks:[{id:'ui',kind:'browser',plan:'plan.json',timeoutMs:20000}]}));
  const env={...process.env,HARNESS_QUALITY_ALLOWED_PORTS:String(server.address().port)};
  const result=await verifyProject({workspace:root,env});
  assert.equal(result.complete,true,JSON.stringify(result));assert.equal(result.stale,false);
  assert.equal(result.results[0].artifactPaths.filter(p=>p.endsWith('.png')).length,2);
  const fullBrowser=await fs.readFile(path.join(root,'.harness/quality/ui-browser.json'));
  const targeted=await verifyProject({workspace:root,checkId:'ui',env});
  assert.equal(targeted.passed,true,JSON.stringify(targeted));
  assert.equal(targeted.complete,false);
  const evidence=targeted.results[0].artifactPaths.find(file=>file.endsWith('-browser.json'));
  assert.match(evidence,new RegExp(targeted.runId+'/ui-browser.json$'));
  assert.equal(JSON.parse(await fs.readFile(path.join(root,evidence),'utf8')).runId,targeted.runId);
  assert(targeted.results[0].artifactPaths.some(file=>file.includes(targeted.runId)&&file.endsWith('.png')));
  assert.deepEqual(await fs.readFile(path.join(root,'.harness/quality/ui-browser.json')),fullBrowser);
});
