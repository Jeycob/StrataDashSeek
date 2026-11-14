'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {inside,excluded}=require('./apps-project.cjs');
async function directory(relative,cfg){
 if(typeof relative!=='string'||!relative||relative.length>300||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||excluded(p)))throw Error('Use a workspace-relative project path');
 const root=await fs.realpath(cfg.workspaceRoot),dir=await fs.realpath(path.join(root,relative));if(!inside(root,dir)||root===dir)throw Error('Project is outside the workspace');return dir;
}
async function text(dir,name){try{const p=path.join(dir,name),s=await fs.lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size>1024*1024)throw Error('Invalid project file: '+name);return await fs.readFile(p,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function plan(relative,cfg){
 const dir=await directory(relative,cfg),names=await fs.readdir(dir),pkg=await text(dir,'package.json'),requirements=await text(dir,'requirements.txt'),pyproject=await text(dir,'pyproject.toml'),cs=names.filter(n=>/\.csproj$/i.test(n));
 const candidates=[pkg&&'node',(requirements!==null||pyproject!==null)&&'python',cs.length&&'dotnet'].filter(Boolean);if(candidates.length!==1)throw Error('Choose a single Node, Python or .NET application folder');
 const runtime=candidates[0],manifest={version:1,name:path.basename(dir),port:8080,healthPath:'/',memoryMiB:512,cpus:1},warnings=[],extraFiles={};let dockerfile;
 if(runtime==='node'){
  const p=JSON.parse(pkg),scripts=p.scripts||{},lock=names.includes('package-lock.json');
  const viteStatic=!scripts.start&&/\bvite\s+build\b/.test(scripts.build||'')&&!/--ssr\b/.test(scripts.build);
  if(!scripts.start&&!viteStatic)throw Error('Add a package.json start script or a static Vite build script before packaging');
  const install=lock?'npm ci':'npm install';if(!lock)warnings.push('Add package-lock.json for repeatable dependency resolution.');
  dockerfile=`# syntax=docker/dockerfile:1\nFROM node:24-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN ${install}\n${scripts.test?'RUN npm test\n':''}${scripts.build?'RUN npm run build\n':''}RUN npm prune --omit=dev\nFROM node:24-alpine\nWORKDIR /app\nENV NODE_ENV=production PORT=8080 HOST=0.0.0.0\nCOPY --from=build --chown=node:node /app /app\nUSER node\nEXPOSE 8080\nCMD ["npm","start"]\n`;
  if(viteStatic){dockerfile=`# syntax=docker/dockerfile:1\nFROM node:24-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN ${install}\n${scripts.test?'RUN npm test\n':''}RUN npm run build\nFROM nginxinc/nginx-unprivileged:alpine\nCOPY --from=build /app/dist /usr/share/nginx/html\nCOPY .harness-nginx.conf /etc/nginx/conf.d/default.conf\nEXPOSE 8080\n`;extraFiles['.harness-nginx.conf']='server {\n  listen 8080;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n';warnings.push('Static Vite output is assumed to be dist/; review custom build.outDir settings.');manifest.memoryMiB=256;}
  if(!scripts.test)warnings.push('No npm test script: verified deployment will require a real testCommand.');
 }else if(runtime==='python'){
  const entry=names.includes('main.py')?'main.py':names.includes('app.py')?'app.py':null;if(!entry)throw Error('Python packaging needs main.py or app.py; otherwise supply your Dockerfile');
  const pySource=await text(dir,entry),deps=(requirements||'')+'\n'+(pyproject||'');let command=['python',entry];if(/\buvicorn\b/.test(deps)&&/\bapp\s*=\s*FastAPI\s*\(/.test(pySource))command=['python','-m','uvicorn',entry.slice(0,-3)+':app','--host','0.0.0.0','--port','8080'];else if(/\bgunicorn\b/.test(deps)&&/\bapp\s*=\s*Flask\s*\(/.test(pySource))command=['python','-m','gunicorn','--bind','0.0.0.0:8080',entry.slice(0,-3)+':app'];
  dockerfile=`# syntax=docker/dockerfile:1\nFROM python:3.13-slim\nWORKDIR /app\nENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080 HOST=0.0.0.0\nCOPY . .\nRUN python -m pip install --no-cache-dir ${requirements!==null?'-r requirements.txt':'.'}\nRUN useradd --uid 10001 --create-home app\nUSER app\nEXPOSE 8080\nCMD ${JSON.stringify(command)}\n`;warnings.push('Confirm the Python entrypoint listens on 0.0.0.0:8080; declare a real testCommand.');
 }else{
  if(cs.length!==1)throw Error('Select a folder with one .csproj');const xml=await text(dir,cs[0]),version=xml.match(/<TargetFramework>net(\d+)\.\d+<\/TargetFramework>/)?.[1];if(!['8','9','10'].includes(version))throw Error('Supported automatic .NET targets: net8.0, net9.0, net10.0');
  const assembly=xml.match(/<AssemblyName>([^<]+)<\/AssemblyName>/)?.[1]||cs[0].slice(0,-7);if(!/^[\w.-]+$/.test(assembly)||!/^[-\w.]+\.csproj$/.test(cs[0]))throw Error('Unsupported assembly/project filename');
  dockerfile=`# syntax=docker/dockerfile:1\nFROM mcr.microsoft.com/dotnet/sdk:${version}.0 AS build\nWORKDIR /src\nCOPY . .\nRUN dotnet publish ${cs[0]} -c Release -o /out --no-self-contained\nFROM mcr.microsoft.com/dotnet/aspnet:${version}.0\nWORKDIR /app\nENV ASPNETCORE_HTTP_PORTS=8080\nCOPY --from=build /out .\nUSER app\nEXPOSE 8080\nENTRYPOINT ["dotnet","${assembly}.dll"]\n`;warnings.push('Declare a testCommand that exercises the deployed application.');
 }
 const files={'Dockerfile':dockerfile,'.dockerignore':'.git\n.env*\n**/.env*\n**/secrets\n**/.secrets\n**/*.key\n**/*.pem\n**/.npmrc\nnode_modules\n.venv\n**/bin\n**/obj\n.harness\n.harness-quality\n','.harness-app.json':JSON.stringify(manifest,null,2)+'\n',...extraFiles};
 const existing=[];for(const name of Object.keys(files))if(await text(dir,name)!==null)existing.push(name);
 return{runtime,path:relative,warnings,existing,files};
}
async function scaffold(relative,cfg){const p=await plan(relative,cfg);if(p.existing.length)throw Error('Files already exist; nothing overwritten: '+p.existing.join(', '));const dir=await directory(relative,cfg),created=[];try{for(const[name,value]of Object.entries(p.files)){await fs.writeFile(path.join(dir,name),value,{flag:'wx',mode:0o644});created.push(name);}}catch(e){for(const n of created)try{if(await text(dir,n)===p.files[n])await fs.unlink(path.join(dir,n));}catch{}throw e;}return p;}
module.exports={directory,plan,scaffold};
