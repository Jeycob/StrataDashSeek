'use strict';
(()=>{
 let serial=0;const drafts=new Map(),settingsDrafts=new Map(),settingsWrites=new Map();
 window.HarnessWorkbench={mount(host,options={}){
 const embedded=Boolean(host),prefix='workbench-'+(++serial)+'-',lifetime=new AbortController();
 const listen=(target,event,handler)=>target.addEventListener(event,handler,{signal:lifetime.signal});
 const I=window.HarnessI18n;if(!I)return;const t=I.t;
 const reviewCopy={en:{preview:'Review checkpoint restore',previewHelp:'Review the exact file changes. Applying uses this source version; a later edit invalidates this preview.',writes:'Files to write',deletes:'Files to delete',preserved:'Files kept unchanged',excluded:'Excluded files kept',protected:'Protected files block this restore',legacyOverlay:'Legacy checkpoint: only saved files can be restored; deletion inventory is incomplete.',apply:'Apply restore',cancel:'Cancel',restored:'Checkpoint restore verified.',uncertain:'Restore is not confirmed. Inspect recovery status before continuing.',recover:'Recover interrupted restore',recovered:'Interrupted restore rolled back. The requested checkpoint has not been applied.',recoveryPending:'An interrupted restore needs recovery. Do not start another restore.',conflicts:'Recovery conflicts',beforeRestore:'Version before the last restore',source:'Source version',staging:'Required staging space',pending:'Restore recovery status',readFailed:'Recovery status could not be verified.'},cs:{preview:'Kontrola obnovy uložené verze',previewHelp:'Zkontroluj přesné změny souborů. Obnova platí pro tuto verzi zdrojů; pozdější změna náhled zneplatní.',writes:'Soubory k zápisu',deletes:'Soubory ke smazání',preserved:'Soubory ponechané beze změny',excluded:'Vynechané soubory zůstanou',protected:'Chráněné soubory brání obnově',legacyOverlay:'Starší verze: obnovit lze pouze uložené soubory; přehled pro mazání není úplný.',apply:'Provést obnovu',cancel:'Zrušit',restored:'Obnova uložené verze ověřena.',uncertain:'Obnova není potvrzená. Než budeš pokračovat, ověř stav zotavení.',recover:'Zotavit přerušenou obnovu',recovered:'Přerušená obnova byla vrácena. Požadovaná verze nebyla aplikována.',recoveryPending:'Přerušená obnova vyžaduje zotavení. Nespouštěj další obnovu.',conflicts:'Konflikty zotavení',beforeRestore:'Verze před poslední obnovou',source:'Verze zdrojů',staging:'Potřebné místo pro přípravu',pending:'Stav zotavení obnovy',readFailed:'Stav zotavení se nepodařilo ověřit.'}};
 const rt=key=>reviewCopy[I.language]?.[key]||reviewCopy.en[key]||key;
 const settingsCopy={en:{inherited:'Server default',override:'Saved workspace value',draft:'Unsaved workspace value',taskLanguage:'Default task language',savedNewer:'Earlier settings saved. Newer edits remain unsaved.'},cs:{inherited:'Výchozí hodnota serveru',override:'Uložená hodnota pracovního prostoru',draft:'Neuložená hodnota pracovního prostoru',taskLanguage:'Výchozí jazyk úloh',savedNewer:'Předchozí nastavení uloženo. Novější změny zůstávají neuložené.'}},st=key=>settingsCopy[I.language]?.[key]||settingsCopy.en[key]||key;
 const editorText=key=>({en:{recheck:'Recheck saved file',saving:'Saving…',savedNewer:'Saved earlier revision. Newer edits remain unsaved.',renameHelp:'Rename moves the saved file. Your unsaved draft stays in the editor and can be saved at the new path.',renamePath:'New project path',cancel:'Cancel',renamePartial:'The destination was created but the original file was not removed. Your draft is retained.',renameUnknown:'The rename could not be fully confirmed. Your draft is retained; refresh before saving.',pending:'Wait for the current file operation to finish.',uncertain:'The previous save was interrupted. Your draft is retained; the server may already contain that saved revision.'},cs:{recheck:'Znovu ověřit uložený soubor',saving:'Ukládám…',savedNewer:'Předchozí verze byla uložena. Novější změny zůstávají neuložené.',renameHelp:'Přejmenování přesune uložený soubor. Rozepsané změny zůstanou v editoru a můžeš je uložit pod novým názvem.',renamePath:'Nová cesta v projektu',cancel:'Zrušit',renamePartial:'Cílový soubor vznikl, ale původní soubor nebyl odstraněn. Rozepsané změny zůstávají zachované.',renameUnknown:'Přejmenování se nepodařilo úplně potvrdit. Rozepsané změny zůstávají zachované; před uložením obnov stav.',pending:'Počkej na dokončení aktuální operace se souborem.',uncertain:'Předchozí ukládání bylo přerušeno. Rozepsané změny zůstávají zachované; server už může obsahovat ukládanou verzi.'}}[I.language==='cs'?'cs':'en'][key]);
 const dialog=document.createElement(embedded?'section':'dialog');dialog.id=prefix+'root';dialog.className='workspace-workbench';dialog.setAttribute('aria-labelledby',prefix+'wb-title');
 dialog.innerHTML='<header><h2 id="wb-title" data-i18n="workbench"></h2><label><span data-i18n="language"></span><select id="wb-language"><option value="en">EN</option><option value="cs">CZ</option></select></label><button id="wb-close" data-i18n="close"></button></header><nav id="wb-tabs"></nav><div class="wb-pickers"><label><span data-i18n="workspace"></span><select id="wb-workspace"></select></label><label><span data-i18n="session"></span><select id="wb-session"></select></label><button id="wb-refresh" data-i18n="refresh"></button></div><p id="wb-info" class="wb-muted"></p><p id="wb-error" role="alert"></p><p id="wb-message" role="status"></p><section id="wb-content"></section>';
 const style=document.createElement('style');style.textContent='#workspace-workbench{box-sizing:border-box;position:fixed;inset:0;margin:0;width:100%;height:100dvh;max-width:none;max-height:none;border:0;padding:24px max(16px,calc((100vw - 1240px)/2));padding-top:calc(20px + env(safe-area-inset-top));background:#f6f9fc;color:#172a32;font:15px/1.5 system-ui;overflow:auto}#workspace-workbench *{box-sizing:border-box}#workspace-workbench header{display:flex;align-items:center;gap:16px;border:0;padding:0;background:none}#workspace-workbench h2{flex:1;margin:0;font-size:25px}#workspace-workbench button,#workspace-workbench select,#workspace-workbench input,#workspace-workbench textarea{font:inherit;border:1px solid #bccad3;border-radius:8px;background:white;color:inherit;padding:8px 12px;min-height:40px;max-width:100%}#workspace-workbench button{cursor:pointer}#workspace-workbench button:disabled{opacity:.5;cursor:default}#workspace-workbench :focus-visible{outline:3px solid #235dd7;outline-offset:2px}#wb-tabs{display:flex;gap:6px;overflow-x:auto;margin:20px 0 16px;padding-bottom:4px}#wb-tabs button[aria-selected=true]{background:#176b59;color:white;border-color:#176b59}#wb-tabs button{white-space:nowrap}.wb-pickers{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.wb-pickers label{flex:1;min-width:180px}.wb-pickers span,#workspace-workbench label>span{display:block;font-size:13px;margin:0 0 5px;color:#536c75}.wb-pickers select{width:100%}#wb-error{color:#a52222;white-space:pre-wrap}#wb-message{color:#176b59}.wb-muted{font-size:13px;color:#536c75;overflow-wrap:anywhere}.wb-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.wb-files{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px}.wb-tree,.wb-card{background:#fff;border:1px solid #dce5e9;border-radius:12px;padding:16px}.wb-tree{max-height:60dvh;overflow:auto}.wb-tree button{display:block;width:100%;text-align:left;border:0!important;overflow-wrap:anywhere}.wb-editor{width:100%;min-height:45dvh;resize:vertical;font:13px/1.6 ui-monospace,monospace!important;white-space:pre;tab-size:2}.wb-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;background:white;border:1px solid #dce5e9;border-radius:12px;padding:20px}.wb-form input,.wb-form select{width:100%}.wb-row{display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:1px solid #dce5e9;padding:12px 0}.wb-row>span{overflow-wrap:anywhere;min-width:0}.wb-row button{flex:none}.wb-code{font:12px ui-monospace,monospace;overflow-wrap:anywhere}.wb-menu{position:fixed;z-index:700;background:white;color:#172a32;border:1px solid #bccad3;border-radius:9px;padding:6px;box-shadow:0 10px 30px #14233333}.wb-menu button{display:block;padding:10px;border:0;background:none;font:14px system-ui;cursor:pointer}@media(max-width:680px){#workspace-workbench{padding:16px;padding-top:calc(14px + env(safe-area-inset-top))}#workspace-workbench header{flex-wrap:wrap;gap:8px}#workspace-workbench h2{font-size:21px;min-width:180px}.wb-files{grid-template-columns:1fr}.wb-tree{max-height:24dvh}.wb-form{grid-template-columns:1fr}.wb-pickers label{min-width:140px}.wb-row{align-items:start;flex-wrap:wrap}}';style.textContent=style.textContent.replace(/#workspace-workbench/g,'#'+prefix+'root').replace(/#wb-([\w-]+)/g,'#'+prefix+'wb-$1');
 if(embedded){style.textContent+='#'+prefix+'root{position:relative;inset:auto;width:100%;height:100%;min-height:200px;padding:16px;overflow:auto}#'+prefix+'root>header,#'+prefix+'wb-tabs,#'+prefix+'root .wb-pickers{display:none}#'+prefix+'root .wb-files{grid-template-columns:1fr}#'+prefix+'root .wb-tree{max-height:28vh}';dialog.open=true;host.append(style,dialog);}else{document.head.append(style);document.body.append(dialog);}
 style.textContent+='#'+prefix+'root textarea.wb-editor{min-height:45dvh}';
 style.textContent+='#'+prefix+'root .wb-modal{width:min(520px,calc(100vw - 32px));border:1px solid var(--dsw-alias-border-l3,#bccad3);border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:inherit;padding:20px}#'+prefix+'root .wb-modal::backdrop{background:#172a3266}#'+prefix+'root .wb-modal label,#'+prefix+'root .wb-modal input{display:block;width:100%}#'+prefix+'root .wb-modal h3{margin-top:0}';
 dialog.innerHTML=dialog.innerHTML.replace(/id="([^"]+)"/g,(_,id)=>'id="'+prefix+id+'"');
 const el=id=>dialog.querySelector('#'+prefix+id),node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;},button=(label,fn)=>{const e=node('button',label);e.type='button';e.onclick=fn;return e;};
 let toolsMenu,toolsTitle;
 if(embedded&&options.section!=='settings'&&window.HarnessNativeTheme){toolsMenu=node('details');toolsMenu.className='wb-tools';toolsTitle=node('summary',t('workspaceTools'));const nav=el('wb-tabs');nav.before(toolsMenu);toolsMenu.append(toolsTitle,nav);}
 let state=null,catalog=null,sessionRows=[],tab=options.section||'files',selectedSession=options.sessionId||'',selectedWorkspace=options.workspaceId||'',directory='',file=null,dirty=false,loading=false,returnFocus=null,installedDocument=null,observer=null,menu=null;
 let editorBinding=null,renderRevision=0,fileNavigation=0,editorDialog=null;const requests=new Set();
 const alive=()=>!lifetime.signal.aborted;
 const identity=(sessionId,path)=>JSON.stringify([sessionId,path]);
 const documentDirty=doc=>Boolean(doc&&!doc.binary&&(doc.draftRevision!==doc.savedRevision||doc.draftText!==doc.savedText));
 const currentDocument=doc=>alive()&&file===doc&&selectedSession===doc.sessionId&&doc.identity===identity(selectedSession,doc.path)&&tab==='files';
 function documentState(data,sessionId){return{identity:identity(sessionId,data.path),sessionId,path:data.path,serverVersion:data.version??data.serverVersion,savedText:data.savedText??data.text??'',draftText:data.draftText??data.text??'',draftRevision:data.draftRevision??0,savedRevision:data.savedRevision??0,status:data.status??'clean',uncertainOperation:data.uncertainOperation,uncertainDestination:data.uncertainDestination,binary:Boolean(data.binary),pending:null};}
 const draftKey=options.sessionId&&(options.sessionId+':'+(options.instanceId||'default'));
 const candidates=[...drafts].filter(([,d])=>d.sessionId===options.sessionId),held=draftKey&&(drafts.has(draftKey)?[draftKey,drafts.get(draftKey)]:candidates.length===1?candidates[0]:null);const draft=held?.[1];if(draft&&tab==='files'){file=documentState(draft.file,options.sessionId);directory=draft.directory;dirty=documentDirty(file);drafts.delete(held[0]);}
 const frame=()=>document.getElementById('harness');const nativeDoc=()=>{try{return frame()?.contentDocument||document;}catch{return document;}};
 async function scopedFetch(url,init,timeoutMs){
  if(!alive())throw new DOMException('View closed.','AbortError');
  const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;requests.add(controller);lifetime.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;abort();},timeoutMs);
  try{const r=await fetch(url,{...init,signal:controller.signal}),value=await r.json();if(!alive()||controller.signal.aborted)throw new DOMException('View closed or timed out.','AbortError');return{r,value};}
  catch(e){if(timedOut&&alive())throw Object.assign(Error(I.language==='cs'?'Vypršel čas požadavku. Uložení změn není potvrzené.':'Request timed out. Pending changes have not been confirmed.'),{code:'REQUEST_TIMEOUT'});throw e;}
  finally{clearTimeout(timer);requests.delete(controller);lifetime.signal.removeEventListener('abort',abort);}
 }
 async function api(body){const{r,value:v}=await scopedFetch('/api/workbench',{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store'},30000);if(!r.ok)throw Object.assign(Error(v.error||t('failed')),{code:v.code});return v;}
 async function native(method,args){const{r,value:d}=await scopedFetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:method==='session/list'?{_request:args}:{request:args}}})},15000);if(!r.ok||!d.result?.ok)throw Error(t('failed'));return d.result.value;}
 function error(e){if(!alive()||e.name==='AbortError')return;const map={PROJECT_WRITER_HELD:'busy',SESSION_BUSY:'busy',READ_ONLY:'readonly',FS_STALE_VERSION:'stale',OUTSIDE_PROJECT:'invalidPath',INVALID_PATH:'invalidPath',SYMLINK_REFUSED:'invalidPath'};el('wb-error').textContent=map[e.code]?t(map[e.code]):t('failed')+': '+e.message;}
 async function action(fn){if(!alive())return;el('wb-error').textContent='';el('wb-message').textContent='';try{await fn();}catch(e){error(e);}}
 function selectedFromUI(){const row=nativeDoc().querySelector('[data-row-key^="session:"][aria-selected="true"]');return row?.dataset.rowKey.slice(8);}
 function pickers(){
  if(!state)return;
  const sessions=el('wb-session');sessions.replaceChildren(node('option',t('selectSession')));sessions.firstChild.value='';
  for(const s of sessionRows){if(state.trash[s.sessionId])continue;const o=node('option',typeof s.title==='string'&&s.title?s.title:s.sessionId);o.value=s.sessionId;sessions.append(o);}sessions.value=selectedSession;
  const workspaces=el('wb-workspace');workspaces.replaceChildren(node('option',t('selectWorkspace')));workspaces.firstChild.value='';for(const w of state.workspaces){const o=node('option',w.title);o.value=w.id;workspaces.append(o);}workspaces.value=selectedWorkspace;
  const p=state.projects[selectedSession];el('wb-info').textContent=p?((p.legacy?t('legacy'):t('isolated'))+' · '+p.root+(p.baseCommit?' · '+t('commit')+': '+p.baseCommit.slice(0,12):'')+(p.ports?' · '+t('ports')+': '+p.ports.join(', '):'')):'';
 }
 async function refresh(){if(loading||!alive())return;loading=true;try{const [s,rows,models]=await Promise.all([api(),native('session/list',{}),native('session/modelCatalog').catch(()=>null)]);if(!alive())return;state=s;catalog=models;sessionRows=rows.items||[];selectedSession=selectedSession||(embedded?'':selectedFromUI())||'';selectedWorkspace=selectedWorkspace||state.workspaces.find(w=>w.sessionIds.includes(selectedSession))?.id||(tab==='settings'?state.workspaces[0]?.id:'')||'';pickers();await render();if(!embedded)installNative();}catch(e){error(e);}finally{loading=false;}}
 function clearDocument(){fileNavigation++;renderRevision++;dirty=false;file=null;editorBinding=null;if(draftKey)drafts.delete(draftKey);}
 function discardChanges(){if(dirty&&!confirm(t('discard')))return false;clearDocument();return true;}
 async function readFile(path,sessionId=selectedSession){try{return await fileAPI('read',{path},sessionId);}catch(e){if(!['BINARY_FILE','TOO_LARGE'].includes(e.code))throw e;return {...await fileAPI('stat',{path},sessionId),binary:true};}}
 function tabs(){if(toolsTitle)toolsTitle.textContent=t('workspaceTools')+(tab==='files'?'':' · '+t(tab));el('wb-tabs').replaceChildren();for(const key of embedded?['files','review','environment','sessions','trash']:['files','settings','sessions','review','environment','trash']){const b=button(t(key),()=>{if(!discardChanges())return;tab=key;if(toolsMenu)toolsMenu.open=false;tabs();void action(render);});b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===key));el('wb-tabs').append(b);}}
 async function open(which='files',workspaceId){if(dirty&&!dialog.open&&!confirm(t('discard')))return;tab=which;selectedSession=selectedFromUI()||selectedSession;if(workspaceId)selectedWorkspace=workspaceId;returnFocus=nativeDoc().activeElement;I.apply(dialog.ownerDocument);el('wb-language').value=I.language;tabs();if(!dialog.open)dialog.showModal();await refresh();}
 if(!embedded)window.openHarnessWorkbench=open;
 async function fileAPI(operation,args,sessionId=selectedSession){return api({op:'file',sessionId,operation,args});}
 async function openFile(path){const sessionId=selectedSession,ticket=++fileNavigation;try{const data=await readFile(path,sessionId);if(!alive()||ticket!==fileNavigation||sessionId!==selectedSession||tab!=='files')return;file=documentState(data,sessionId);dirty=false;await renderFiles();}catch(e){if(ticket===fileNavigation&&sessionId===selectedSession)error(e);}}
 async function fillTree(tree){
  const requested=directory,sessionId=selectedSession,listing=await fileAPI('list',{path:requested},sessionId);if(requested!==directory||sessionId!==selectedSession||!alive())return;
  tree.replaceChildren(node('p',directory||'/'));
  if(directory)tree.append(button('← '+t('up'),()=>{if(!discardChanges())return;directory=directory.split('/').slice(0,-1).join('/');void action(renderFiles);}));
  for(const entry of listing.entries.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,I.locale))){const relative=(directory?directory+'/':'')+entry.name;const b=button((entry.directory?'▸ ':'')+entry.name,()=>{if(entry.symlink||sessionId!==selectedSession)return;void action(async()=>{if(!discardChanges())return;if(entry.directory){directory=relative;await renderFiles();}else await openFile(relative);});});b.disabled=entry.symlink;tree.append(b);}if(!listing.entries.length)tree.append(node('p',t('empty')));
 }
 async function reload(){if(!discardChanges())return;await refresh();}
 function paintDocument(doc,notice){
  if(!currentDocument(doc))return;dirty=documentDirty(doc);
  const binding=editorBinding;if(binding?.doc===doc&&binding.save.isConnected){binding.save.disabled=!dirty||Boolean(doc.pending)||!doc.serverVersion;binding.rename.disabled=Boolean(doc.pending)||!doc.serverVersion;binding.remove.disabled=Boolean(doc.pending)||!doc.serverVersion;if(binding.recheck)binding.recheck.hidden=Boolean(doc.serverVersion);binding.save.textContent=doc.pending==='save'?editorText('saving'):t('save');}
  if(notice)el('wb-message').textContent=notice;
 }
 async function saveDocument(doc){
  if(!currentDocument(doc)||doc.pending||!documentDirty(doc)||!doc.serverVersion)return false;
  const snapshot=Object.freeze({identity:doc.identity,sessionId:doc.sessionId,path:doc.path,version:doc.serverVersion,text:doc.draftText,revision:doc.draftRevision});
  doc.pending='save';doc.status='saving';el('wb-error').textContent='';paintDocument(doc,editorText('saving'));
  try{
   const result=await fileAPI('write',{path:snapshot.path,text:snapshot.text,version:snapshot.version},snapshot.sessionId);
   if(!currentDocument(doc)||doc.identity!==snapshot.identity)return false;
   if(typeof result.version!=='string'||!result.version)throw Error(editorText('uncertain'));
   doc.serverVersion=result.version;doc.savedText=snapshot.text;doc.savedRevision=snapshot.revision;doc.pending=null;
   dirty=documentDirty(doc);doc.status=dirty?'dirty':'clean';paintDocument(doc,dirty?editorText('savedNewer'):t('saved'));return true;
  }catch(e){if(currentDocument(doc)){doc.status=e.code==='FS_STALE_VERSION'?'conflict':e.code==='REQUEST_TIMEOUT'?'uncertain':'error';error(e);el('wb-message').textContent='';}return false;}
  finally{doc.pending=null;paintDocument(doc);}
 }
 function renameDialog(doc){
  if(editorDialog||!currentDocument(doc))return Promise.resolve(null);
  return new Promise(resolve=>{
   const modal=node('dialog'),form=node('form'),title=node('h3',t('rename')),help=node('p',editorText('renameHelp')),label=node('label',editorText('renamePath')),input=node('input'),actions=node('div'),previous=document.activeElement;
   modal.className='wb-modal';modal.dataset.workbenchDialog='rename';title.id=prefix+'rename-title';help.id=prefix+'rename-help';input.id=prefix+'rename-path';input.name='path';input.required=true;input.maxLength=1024;input.value=doc.path;label.htmlFor=input.id;
   modal.setAttribute('aria-labelledby',title.id);modal.setAttribute('aria-describedby',help.id);actions.className='wb-actions';let settled=false;
   const finish=value=>{if(settled)return;settled=true;lifetime.signal.removeEventListener('abort',abort);editorDialog=null;if(modal.open)modal.close();modal.remove();if(alive()&&previous?.isConnected)previous.focus();resolve(value);};
   const abort=()=>finish(null),cancel=button(editorText('cancel'),()=>finish(null)),submit=button(t('rename'));submit.type='submit';
   form.onsubmit=e=>{e.preventDefault();if(input.reportValidity())finish(input.value);};modal.addEventListener('cancel',e=>{e.preventDefault();finish(null);});modal.addEventListener('close',()=>finish(null));
   actions.append(submit,cancel);form.append(title,help,label,input,actions);modal.append(form);dialog.append(modal);editorDialog={cancel:()=>finish(null)};lifetime.signal.addEventListener('abort',abort,{once:true});modal.showModal();input.focus();input.select();
  });
 }
 async function renameDocument(doc){
  if(!currentDocument(doc)||doc.pending)return;if(doc.binary){error(Error(t('binaryRename')));return;}
  const name=await renameDialog(doc);if(!name||name===doc.path||!currentDocument(doc)||doc.pending)return;
  const snapshot={identity:doc.identity,sessionId:doc.sessionId,path:doc.path,version:doc.serverVersion};doc.pending='rename';doc.status='renaming';paintDocument(doc);el('wb-error').textContent='';
  try{
   const result=await fileAPI('rename',{path:snapshot.path,destination:name,version:snapshot.version},snapshot.sessionId);
   if(!currentDocument(doc)||doc.identity!==snapshot.identity)return;
   if(result.sourceDeleted!==true){doc.serverVersion=null;doc.status='uncertain';doc.uncertainOperation='rename';doc.uncertainDestination=name;throw Object.assign(Error(editorText(result.sourceDeleted===false?'renamePartial':'renameUnknown')),{code:'RENAME_UNCERTAIN'});}
   const version=result.destination?.version??result.version;
   // Moving the on-disk file never replaces draftText or its revision.
   doc.path=name;doc.identity=identity(doc.sessionId,name);doc.serverVersion=typeof version==='string'?version:null;
   if(!doc.serverVersion){doc.uncertainOperation='rename';doc.uncertainDestination=name;throw Object.assign(Error(editorText('renameUnknown')),{code:'RENAME_UNCERTAIN'});}
   doc.status=documentDirty(doc)?'dirty':'clean';doc.pending=null;await renderFiles();
  }catch(e){if(currentDocument(doc)){doc.status=e.code==='FS_STALE_VERSION'?'conflict':e.code==='RENAME_UNCERTAIN'?'uncertain':'error';error(e);if(doc.path!==snapshot.path)await renderFiles();}}
  finally{doc.pending=null;paintDocument(doc);}
 }
 async function recheckDocument(doc){
  if(!currentDocument(doc)||doc.pending)return;doc.pending='recheck';paintDocument(doc);
  try{
   let current;
   try{current=await readFile(doc.path,doc.sessionId);}catch(e){if(!['FS_NOT_FOUND','MISSING'].includes(e.code)||!doc.uncertainDestination)throw e;current=await readFile(doc.uncertainDestination,doc.sessionId);}
   if(!currentDocument(doc))return;
   if(current.binary||typeof current.version!=='string'||current.text!==doc.savedText)throw Object.assign(Error(t('stale')),{code:'FS_STALE_VERSION'});
   doc.path=current.path;doc.identity=identity(doc.sessionId,current.path);doc.serverVersion=current.version;doc.uncertainOperation=doc.uncertainDestination=undefined;doc.status=documentDirty(doc)?'dirty':'clean';doc.pending=null;el('wb-error').textContent='';await renderFiles();
  }catch(e){if(currentDocument(doc))error(e);}
  finally{doc.pending=null;paintDocument(doc);}
 }
 async function renderFiles(){
  if(!alive())return;const ticket=++renderRevision,sessionId=selectedSession,doc=file;editorBinding=null;
  const content=el('wb-content');content.replaceChildren();if(!selectedSession){content.append(node('p',t('noProject')));return;}
  const actions=node('div');actions.className='wb-actions';actions.append(button(t('refresh'),()=>void action(reload)));
  actions.append(button(t('newFile'),()=>void action(async()=>{const name=prompt(t('namePrompt'),directory?directory+'/':'');if(!name)return;await fileAPI('write',{path:name,text:''});await renderFiles();})),button(t('newFolder'),()=>void action(async()=>{const name=prompt(t('namePrompt'),directory?directory+'/':'');if(!name)return;await fileAPI('mkdir',{path:name});await renderFiles();})));
  const upload=node('input');upload.type='file';upload.hidden=true;upload.onchange=()=>void action(async()=>{for(const f of upload.files){if(f.size>4*1024*1024)throw Error('4 MiB upload limit');const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));await fileAPI('upload',{path:(directory?directory+'/':'')+f.name,base64:btoa(binary)});}await renderFiles();});actions.append(button(t('upload'),()=>upload.click()),upload);content.append(actions);
  const layout=node('div');layout.className='wb-files';const tree=node('div');tree.className='wb-tree';await fillTree(tree);if(!alive()||ticket!==renderRevision||sessionId!==selectedSession||file!==doc)return;options.onDirectoryChange?.(directory);
  const editor=node('div');if(doc){editor.append(node('p',doc.path));const text=node('textarea');text.className='wb-editor';text.setAttribute('aria-label',doc.path);text.spellcheck=false;text.value=doc.draftText;text.hidden=doc.binary;const controls=node('div');controls.className='wb-actions';
   const save=button(t('save'),()=>void saveDocument(doc)),rename=button(t('rename'),()=>void renameDocument(doc)),remove=button(t('remove'),()=>void action(async()=>{if(!currentDocument(doc)||doc.pending||!confirm(t('deleteFileConfirm')))return;await fileAPI('delete',{path:doc.path,version:doc.serverVersion},doc.sessionId);if(!currentDocument(doc))return;clearDocument();await renderFiles();}));
   save.hidden=doc.binary;save.disabled=!documentDirty(doc)||Boolean(doc.pending)||!doc.serverVersion;rename.disabled=remove.disabled=Boolean(doc.pending)||!doc.serverVersion;
   text.oninput=()=>{if(!currentDocument(doc))return;doc.draftText=text.value;doc.draftRevision++;doc.status=doc.pending==='save'?'saving':'dirty';paintDocument(doc);};
   const recheck=button(editorText('recheck'),()=>void recheckDocument(doc));recheck.hidden=Boolean(doc.serverVersion);editorBinding={doc,text,save,rename,remove,recheck};controls.append(save,button(t('download'),()=>{const a=node('a');a.href='/api/workbench/download?'+new URLSearchParams({sessionId:doc.sessionId,path:doc.path});a.download=doc.path.split('/').at(-1);a.click();}),rename,remove,recheck);editor.append(controls,text);if(doc.binary)editor.append(node('p',t('binaryFile')));if(doc.status==='uncertain')editor.append(node('p',editorText(doc.uncertainOperation==='rename'?'renameUnknown':'uncertain')));
  }else editor.append(node('p',t('open')));layout.append(tree,editor);content.append(layout);
 }
 function renderSettings(){
  const content=el('wb-content');content.replaceChildren();if(!selectedWorkspace){content.append(node('p',t('selectWorkspace')));return;}
  const workspaceId=selectedWorkspace,workspace=state.workspaces.find(w=>w.id===workspaceId),value={...state.defaults,...workspace?.settings,...settingsDrafts.get(workspaceId)},form=node('form');form.className='wb-form';
  const fields={provider:['text'],model:['text'],reasoningEffort:[['off','Off'],['low','Low'],['medium','Medium'],['high','High']],thinkingBudget:['number',128,8192],maxTokens:['number',256,32768],temperature:['number',0,2,.05],topP:['number',.01,1,.01],projectMode:[['auto',t('auto')],['fresh',t('fresh')],['worktree',t('worktree')],['continue',t('continue')]],baseCommit:['text'],maxStageSteps:['number',10,100],noProgressLimit:['number',1,3],environment:[['web',t('envWeb')],['dotnet',t('envDotnet')],['general',t('envGeneral')]],language:[['en','English'],['cs','Čeština']]};
  const labels={reasoningEffort:'effort',thinkingBudget:'budget',maxTokens:'output',maxStageSteps:'maxSteps',noProgressLimit:'noProgress'};
  form.oninput=event=>{settingsDrafts.set(workspaceId,Object.fromEntries(Object.keys(fields).map(key=>[key,form.elements[key].value])));const hint=event.target.closest('label')?.querySelector('[data-setting-source]');if(hint){hint.textContent=st('draft');hint.dataset.settingSource='draft';}};
  for(const [key,spec]of Object.entries(fields)){
   const label=node('label'),span=node('span',key==='language'?st('taskLanguage'):t(labels[key]||key));let input;
   if(Array.isArray(spec[0])){input=node('select');for(const [v,text]of spec){const o=node('option',text);o.value=v;input.append(o);}}
   else{input=node('input');input.type=spec[0];if(spec[0]==='number'){input.min=spec[1];input.max=spec[2];input.step=spec[3]||1;}}
   input.name=key;input.value=value[key]??'';
   const source=settingsDrafts.has(workspaceId)?'draft':Object.hasOwn(workspace?.settings||{},key)?'override':'inherited',hint=node('small',st(source));
   hint.dataset.settingSource=source;span.id=prefix+'setting-label-'+key;hint.id=prefix+'setting-source-'+key;input.setAttribute('aria-labelledby',span.id);input.setAttribute('aria-describedby',hint.id);label.append(span,input,hint);form.append(label);
  }
  const providers=node('datalist');providers.id=prefix+'wb-providers';for(const group of catalog?.groups||[]){const option=node('option',group.name||group.id);option.value=group.id;providers.append(option);}const models=node('datalist');models.id=prefix+'wb-models';form.elements.provider.setAttribute('list',providers.id);form.elements.model.setAttribute('list',models.id);
  const capabilities=()=>{models.replaceChildren();for(const model of catalog?.groups?.find(g=>g.id===form.elements.provider.value)?.models||[]){const option=node('option',model.name||model.id);option.value=model.id;models.append(option);}for(const key of ['thinkingBudget','maxTokens','temperature','topP'])form.elements[key].disabled=form.elements.provider.value!=='strata-vast';};form.elements.provider.onchange=capabilities;form.append(providers,models);capabilities();
  const save=button(t('save'),null);save.type='submit';save.disabled=settingsWrites.has(workspaceId);form.append(save);
  form.onsubmit=e=>{
   e.preventDefault();if(settingsWrites.has(workspaceId))return;const write=Symbol();settingsWrites.set(workspaceId,write);window.dispatchEvent(new CustomEvent('harness-workspace-write-change',{detail:workspaceId}));const snapshot=settingsDrafts.get(workspaceId);
   void action(async()=>{try{
    const settings={};for(const [k,spec]of Object.entries(fields)){const v=form.elements[k].value;if(k==='baseCommit'&&!v)continue;settings[k]=spec[0]==='number'?Number(v):v;}
    await api({op:'settings',workspaceId,settings});const newer=settingsDrafts.get(workspaceId)!==snapshot;if(!newer)settingsDrafts.delete(workspaceId);
    if(!alive()||selectedWorkspace!==workspaceId||tab!=='settings')return;await refresh();if(alive()&&selectedWorkspace===workspaceId&&tab==='settings')el('wb-message').textContent=newer?st('savedNewer'):t('saved');
   }catch(error){if(alive()&&selectedWorkspace===workspaceId&&tab==='settings')throw error;}
   finally{if(settingsWrites.get(workspaceId)===write)settingsWrites.delete(workspaceId);window.dispatchEvent(new CustomEvent('harness-workspace-write-change',{detail:workspaceId}));}});
  };
  content.append(form,node('p',t('settingsNote')));
 }
 function renderSessions(trash=false){const content=el('wb-content');content.replaceChildren(node('p',t('trashNote')));const rows=trash?Object.keys(state.trash).map(id=>sessionRows.find(s=>s.sessionId===id)||{sessionId:id}):sessionRows.filter(s=>!state.trash[s.sessionId]);for(const s of rows){const row=node('div');row.className='wb-row';row.append(node('span',(s.title||s.sessionId)+(state.running.includes(s.sessionId)?' · '+t('running'):'')));const b=button(t(trash?'restore':'moveTrash'),()=>void action(async()=>{if(!trash&&!confirm(t('trashConfirm')))return;await api({op:trash?'restore':'trash',sessionId:s.sessionId});await refresh();}));b.disabled=!trash&&state.running.includes(s.sessionId);row.append(b);content.append(row);}if(!rows.length)content.append(node('p',t('empty')));}
 async function checkpointRestore(sessionId,key,valid){
  const preview=await api({op:'checkpoint-preview',sessionId,key});if(!valid())return;
  if(preview.recoveryRequired||preview.recovery?.pending)throw Error(rt('recoveryPending'));
  if(preview.version!==2||!Array.isArray(preview.writes)||!Array.isArray(preview.deletes))throw Error(rt('uncertain'));
  const proceed=await new Promise(resolve=>{
   const modal=node('dialog'),title=node('h3',rt('preview')),help=node('p',rt('previewHelp')),actions=node('div'),prior=document.activeElement;
   modal.className='wb-modal';modal.dataset.workbenchDialog='checkpoint-preview';title.id=prefix+'restore-title';help.id=prefix+'restore-help';modal.setAttribute('aria-labelledby',title.id);modal.setAttribute('aria-describedby',help.id);modal.append(title,help);
   modal.append(node('p',rt('source')+': '+String(preview.sourceHash||'—')),node('p',rt('staging')+': '+(Number.isFinite(preview.requiredStagingBytes)?Math.ceil(preview.requiredStagingBytes/1048576)+' MiB':'—')));
   if(preview.legacyOverlayOnly||!preview.inventoryComplete)modal.append(node('p',rt('legacyOverlay')));
   for(const [label,items]of [['writes',preview.writes],['deletes',preview.deletes],['preserved',preview.preservedPaths||[]],['excluded',preview.preservedExclusions||[]],['protected',preview.protectedFiles||[]]]){
    const details=node('details'),summary=node('summary',rt(label)+' ('+items.length+')'),list=node('ul');details.open=['writes','deletes','protected'].includes(label)&&items.length>0;
    for(const item of items.slice(0,500))list.append(node('li',typeof item==='string'?item:item.path+' · '+item.reason));if(items.length>500)list.append(node('li','…'));details.append(summary,list);modal.append(details);
   }
   let settled=false;const finish=value=>{if(settled)return;settled=true;lifetime.signal.removeEventListener('abort',abort);if(modal.open)modal.close();modal.remove();if(alive()&&prior?.isConnected)prior.focus();resolve(value);},abort=()=>finish(false);
   const apply=button(rt('apply'),()=>finish(true)),cancel=button(rt('cancel'),()=>finish(false));apply.disabled=preview.canRestore!==true||!/^([a-f0-9]{64})$/i.test(preview.sourceHash||'')||(preview.protectedFiles||[]).length>0;
   actions.className='wb-actions';actions.append(apply,cancel);modal.append(actions);modal.addEventListener('cancel',e=>{e.preventDefault();finish(false);});modal.addEventListener('close',()=>finish(false));lifetime.signal.addEventListener('abort',abort,{once:true});dialog.append(modal);modal.showModal();cancel.focus();
  });
  if(!proceed||!valid())return;
  const result=await api({op:'checkpoint-restore',sessionId,key,expectedSourceHash:preview.sourceHash});if(!valid())return;
  if(result.restored!==true||result.recovery?.pending)throw Error(rt('uncertain'));
  await refresh();if(valid())el('wb-message').textContent=rt('restored');
 }
 function renderReview(){
  const content=el('wb-content');content.replaceChildren();const sessionId=selectedSession,p=state.projects[sessionId],b=p?.budget,revision=fileNavigation;
  const valid=()=>alive()&&tab==='review'&&selectedSession===sessionId&&revision===fileNavigation;
  if(!b){content.append(node('p',t('notRun')));return;}
  const card=node('div');card.className='wb-card';card.append(node('h3',b.blocked?t('paused'):t('checks')),node('p',t('stage')+': '+b.stage+' · '+t('steps')+': '+b.steps));if(b.blocked)card.append(node('p',b.blocked.code));
  let busy=false;const restore=key=>void action(async()=>{if(busy||!valid())return;busy=true;try{await checkpointRestore(sessionId,key,valid);}catch(error){if(valid())throw error;}finally{busy=false;}});
  for(const [key,c]of Object.entries(p.checkpoints||{})){const row=node('div');row.className='wb-row';row.append(node('span',t('best')+' · '+key+' · '+c.files+' '+t('filesCount')+' · '+new Date(c.at).toLocaleString(I.locale)),button(t('restoreBest'),()=>restore(key)));card.append(row);}
  const recovery=node('section');recovery.dataset.checkpointRecovery='true';recovery.append(node('p',rt('pending')+'…'));card.append(recovery);
  void api({op:'checkpoint-recovery',sessionId}).then(result=>{
   if(!valid()||!recovery.isConnected)return;const status=result.recovery||result;recovery.replaceChildren();
   if(status.pending){const warning=node('p',rt('recoveryPending'));warning.setAttribute('role','alert');recovery.append(warning);if(status.conflicts?.length)recovery.append(node('p',rt('conflicts')+': '+status.conflicts.join(', ')));
    recovery.append(button(rt('recover'),()=>void action(async()=>{if(busy||!valid())return;busy=true;try{const restored=await api({op:'checkpoint-recover',sessionId});if(!valid())return;const next=restored.recovery||restored;if(next.pending||next.status!=='rolled-back')throw Error(rt('uncertain'));await refresh();if(valid())el('wb-message').textContent=rt('recovered');}catch(error){if(valid())throw error;}finally{busy=false;}})));
   }
   if(status.beforeRestore)recovery.append(button(rt('beforeRestore'),()=>restore('beforeRestore')));
  }).catch(()=>{if(valid()&&recovery.isConnected){recovery.replaceChildren(node('p',rt('readFailed')));}});
  if(p.checkpointError)card.append(node('p',t('checkpointUnavailable')+': '+p.checkpointError));
  if(b.blocked){const label=node('label');label.append(node('span',t('strategy')));const strategy=node('textarea');strategy.rows=4;strategy.style.width='100%';strategy.placeholder=t('strategyHelp');label.append(strategy);card.append(label,button(t('resume'),()=>void action(async()=>{if(!valid())return;await api({op:'resume',sessionId,strategy:strategy.value});if(valid())await refresh();})));}
  content.append(card);
 }
 function renderEnvironment(){const content=el('wb-content');content.replaceChildren();const e=state.environment;if(!e){content.append(node('p',t('notRun')));return;}for(const [label,value]of [[t('browser'),e.browser?.ok?t('ready')+' · '+e.browser.version:t('unavailable')],[t('console'),e.browser?.consoleVerified&&!e.browser.consoleErrors?.length?t('passed'):t('unavailable')],[t('webgl'),e.browser?.webgl?.available?t('ready')+' · '+t('software'):t('unavailable')],[t('dotnet'),e.dotnet?.available?e.dotnet.version:t('unavailable')]]){const row=node('div');row.className='wb-row';row.append(node('strong',label),node('span',value));content.append(row);}}
 async function render(){if(tab==='files')return renderFiles();if(tab==='settings')return renderSettings();if(tab==='review')return renderReview();if(tab==='environment')return renderEnvironment();return renderSessions(tab==='trash');}
 function installNative(){const doc=nativeDoc();if(!doc?.body)return;if(installedDocument!==doc){observer?.disconnect();installedDocument=doc;doc.addEventListener('keydown',e=>{if(e.ctrlKey&&e.altKey&&e.key.toLowerCase()==='p'){e.preventDefault();e.stopImmediatePropagation();void open('files');}},true);observer=new MutationObserver(()=>{if(!installNative.scheduled){installNative.scheduled=true;requestAnimationFrame(()=>{installNative.scheduled=false;installNative();});}});observer.observe(doc.body,{subtree:true,childList:true});}
  for(const row of doc.querySelectorAll('[data-row-key^="workspace:"]')){if(row.querySelector('[data-workbench-settings]'))continue;const raw=row.dataset.rowKey.slice(10),w=state?.workspaces.find(w=>raw===w.id||raw.endsWith(w.id));if(!w)continue;const b=doc.createElement('button');b.type='button';b.textContent='…';b.dataset.workbenchSettings='true';b.setAttribute('aria-label',t('settings'));b.style.cssText='margin-left:auto;min-width:30px;border:0;background:transparent;color:inherit;font:20px system-ui;cursor:pointer';b.onclick=e=>{e.preventDefault();e.stopPropagation();menu?.remove();menu=document.createElement('div');menu.className='wb-menu';menu.setAttribute('role','menu');const rect=b.getBoundingClientRect(),offset=frame()?.getBoundingClientRect();menu.style.left=Math.min(innerWidth-230,Math.max(8,rect.left+(offset?.left||0)))+'px';menu.style.top=Math.min(innerHeight-100,rect.bottom+(offset?.top||0))+'px';menu.append(button(t('settings'),()=>{menu.remove();void open('settings',w.id);}));document.body.append(menu);};row.append(b);}
  for(const row of doc.querySelectorAll('[data-row-key^="session:"]'))row.hidden=Boolean(state?.trash[row.dataset.rowKey.slice(8)]);
  const trigger=doc.querySelector('button[aria-label="Account menu"][aria-expanded="true"],button[data-signed-out][aria-haspopup="menu"][aria-expanded="true"]');if(trigger){const menus=Array.from(doc.querySelectorAll('[role="menu"]')).filter(m=>m.getClientRects().length);for(const m of menus){if(m.querySelector('[data-workbench-menu]'))continue;const template=m.querySelector('button[role="menuitem"]');if(!template)continue;const item=template.cloneNode(false);item.dataset.workbenchMenu='true';item.removeAttribute('id');item.textContent=t('workbench');item.onclick=e=>{e.preventDefault();e.stopPropagation();trigger.click();void open('files');};m.append(item);}}
 }
 el('wb-close').onclick=()=>{if(!dirty||confirm(t('discard'))){dirty=false;file=null;dialog.close();}};dialog.addEventListener('cancel',e=>{if(dirty&&!confirm(t('discard')))e.preventDefault();});dialog.addEventListener('close',()=>{dirty=false;file=null;returnFocus?.focus();});
 el('wb-language').value=I.language;el('wb-language').onchange=()=>I.setLanguage(el('wb-language').value);listen(window,'harness-language-change',()=>{I.apply(document);tabs();pickers();if(state&&!dirty)void action(render);});
 listen(window,'harness-workspace-write-change',event=>{if(tab==='settings'&&event.detail===selectedWorkspace){const save=el('wb-content').querySelector('form button[type=submit]');if(save)save.disabled=settingsWrites.has(selectedWorkspace);}});
 el('wb-refresh').onclick=()=>void action(async()=>{if(!discardChanges())return;file=null;await refresh();});
 el('wb-session').onchange=()=>{if(!discardChanges()){el('wb-session').value=selectedSession;return;}selectedSession=el('wb-session').value;selectedWorkspace=state.workspaces.find(w=>w.sessionIds.includes(selectedSession))?.id||selectedWorkspace;directory='';pickers();void action(render);};
 el('wb-workspace').onchange=()=>{if(!discardChanges()){el('wb-workspace').value=selectedWorkspace;return;}selectedWorkspace=el('wb-workspace').value;void action(render);};
 if(!embedded){listen(frame()||window,'load',()=>{void refresh();});listen(document,'click',e=>{if(menu&&!menu.contains(e.target)&&!e.target.closest('[data-workbench-settings]'))menu.remove();});}
 if(embedded&&options.section!=='settings'){style.textContent+='#'+prefix+'wb-tabs{display:flex;margin:0 0 10px}#'+prefix+'wb-tabs button{font-size:12px;padding:6px 8px}';tabs();}
 if(embedded&&window.HarnessNativeTheme){dialog.classList.add('harness-native-surface');style.textContent=window.HarnessNativeTheme.css(style.textContent,dialog.id);}
 I.apply(dialog.ownerDocument);void refresh();
 const beforeUnload=e=>{if(dirty){e.preventDefault();e.returnValue='';}};listen(window,'beforeunload',beforeUnload);
 return{element:dialog,refresh,reload,notifyChange(){const tree=dialog.querySelector('.wb-tree');if(tab==='files'&&tree)void action(async()=>{await fillTree(tree);if(alive()&&file)el('wb-message').textContent=t('filesChanged');});},get dirty(){return dirty;},canClose:discardChanges,destroy(){if(draftKey&&dirty&&file)drafts.set(draftKey,{file:{...file,pending:null,status:file.pending?'uncertain':file.status},directory,sessionId:options.sessionId});else if(draftKey)drafts.delete(draftKey);fileNavigation++;renderRevision++;lifetime.abort();for(const controller of requests)controller.abort();editorDialog?.cancel();observer?.disconnect();menu?.remove();dialog.remove();style.remove();}};
 }};
 if(!window.HARNESS_NATIVE_WORKBENCH)window.HarnessWorkbench.mount();
})();
