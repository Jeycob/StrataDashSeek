import http from 'node:http';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {searchNotes,updateNote} from './core.mjs';
const dataPath = fileURLToPath(new URL('./notes.json',import.meta.url));
let notes = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath,'utf8')) : [
 {id:'seed-1',title:'Žlutý kůň',body:'Příliš žluťoučký kůň',version:1},
 {id:'seed-2',title:'Nákup',body:'Mléko a čaj',version:1}
];
const persist=()=>writeFileSync(dataPath,JSON.stringify(notes));
const respond=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(data===undefined?'':JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');
  const pathname=url.pathname;
  if(req.method==='GET' && ['/','/app.js','/core.mjs'].includes(pathname)){
   res.setHeader('Content-Type',pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');
   res.end(readFileSync(new URL(pathname==='/'?'./index.html':`.${pathname}`,import.meta.url)));return;
  }
  if(req.method==='GET'&&pathname==='/health')return respond(res,200,{ok:true});
  if(req.method==='GET'&&pathname==='/api/notes')return respond(res,200,{items:searchNotes(notes,url.searchParams.get('q')||'')});
  const match=pathname.match(/^\/api\/notes\/([^/]+)$/);
  if(match&&req.method==='GET')return respond(res,notes.some(x=>x.id===match[1])?200:404,notes.find(x=>x.id===match[1])||{error:'not_found'});
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw Error('payload_limit');}
  let body;try{body=raw?JSON.parse(raw):{};}catch{return respond(res,400,{error:'invalid_json'});}
  if(req.method==='POST'&&pathname==='/api/notes'){
   if(typeof body.title!=='string'||!body.title.trim()||typeof body.body!=='string')return respond(res,400,{error:'invalid_note'});
   const note={id:randomUUID(),title:body.title,body:body.body,version:1};notes.push(note);persist();return respond(res,201,note);
  }
  if(match){
   const note=notes.find(x=>x.id===match[1]);if(!note)return respond(res,404,{error:'not_found'});
   if(req.method==='DELETE'){notes=notes.filter(x=>x.id!==note.id);persist();return respond(res,204);}
   if(req.method==='PATCH'){
    if(typeof body.title!=='string'||!body.title.trim()||typeof body.body!=='string')return respond(res,400,{error:'invalid_note'});
    await new Promise(resolve=>setTimeout(resolve,Math.min(1000,Math.max(0,Number(body.delayMs)||0))));
    const updated=updateNote(note,body);persist();return respond(res,200,updated);
   }
  }
  return respond(res,404,{error:'not_found'});
 }catch{return respond(res,500,{error:'server_error'});}
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`notes listening ${server.address().port}`));
