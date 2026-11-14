'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
async function doctor(options={}){
 const report={at:Date.now(),node:process.version,browser:{ok:false},dotnet:{available:false}},directory=options.directory||'/data/harness/state/development';fs.mkdirSync(directory,{recursive:true,mode:0o700});
 let browser;
 try{
  process.env.PLAYWRIGHT_BROWSERS_PATH='/data/harness/dev/browsers';
  const pw=require('/data/harness/dev/browser/node_modules/playwright');
  browser=await pw.chromium.launch({headless:true,args:['--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:640,height:360}}),errors=[],messages=[];page.on('console',m=>{messages.push(m.text());if(m.type()==='error')errors.push(m.text().slice(0,300));});page.on('pageerror',e=>errors.push(e.message.slice(0,300)));
  await page.setContent('<!doctype html><meta charset="utf-8"><style>body{background:#102737;color:#fff;font:24px system-ui;padding:32px}canvas{width:240px;height:100px}</style><h1>Browser preflight</h1><canvas id="c" width="240" height="100"></canvas><script>console.log("BROWSER_PREFLIGHT_OK")</script>');
  const webgl=await page.evaluate(()=>{const gl=document.getElementById('c').getContext('webgl2')||document.getElementById('c').getContext('webgl');if(!gl)return{available:false};gl.clearColor(.1,.2,.3,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);const ext=gl.getExtension('WEBGL_debug_renderer_info');return{available:true,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),pixel:Array.from(pixel)};});
  const screenshot=path.join(directory,'browser-preflight.png'),bytes=await page.screenshot({path:screenshot});
  report.browser={ok:errors.length===0&&messages.includes('BROWSER_PREFLIGHT_OK')&&webgl.available&&bytes.length>1000&&Math.abs(webgl.pixel[0]-26)<=1,version:browser.version(),playwright:require('/data/harness/dev/browser/node_modules/playwright/package.json').version,module:'/data/harness/dev/browser/node_modules/playwright',browsersPath:process.env.PLAYWRIGHT_BROWSERS_PATH,screenshot,screenshotBytes:bytes.length,consoleVerified:messages.includes('BROWSER_PREFLIGHT_OK'),consoleErrors:errors,webgl,softwareRendering:true};
 }catch(e){report.browser.error=e.message.slice(0,700);}finally{await browser?.close();}
 try{const v=cp.execFileSync('/data/harness/dev/dotnet/dotnet',['--version'],{encoding:'utf8',timeout:10000,env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:'1'}}).trim();report.dotnet={available:true,version:v,executable:'/data/harness/dev/dotnet/dotnet'};}catch(e){report.dotnet.error=String(e.code||e.message).slice(0,200);}
 if(options.output){const tmp=options.output+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2),{mode:0o600});fs.renameSync(tmp,options.output);}
 return report;
}
module.exports={doctor};
if(require.main===module){const i=process.argv.indexOf('--output');doctor({output:i>=0?process.argv[i+1]:'/data/harness/state/development.json'}).then(r=>{console.log(JSON.stringify(r));if(!r.browser.ok)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;});}
