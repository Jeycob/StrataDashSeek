// The session's current saved preview appears beside its latest terminal reply.
const previewResultCopy = {
 en: {
  title: 'Application result', open: 'Open preview', reopen: 'Restore preview',
  download: 'Download file',
  pending: 'Opening preview…', waiting: 'Preview is not ready to reopen yet.',
  refresh: 'Refresh preview status', failed: 'Could not confirm the preview. Check its current status before trying again.',
  popup: 'Allow pop-ups for this site to open the preview.',
  selectionChanged: 'The preview changed. Open the current preview and select the element again.',
 },
 cs: {
  title: 'Výsledek aplikace', open: 'Otevřít náhled', reopen: 'Obnovit náhled',
  download: 'Stáhnout soubor',
  pending: 'Otevírám náhled…', waiting: 'Náhled zatím nelze obnovit.',
  refresh: 'Obnovit stav náhledu', failed: 'Náhled se nepodařilo potvrdit. Před dalším pokusem ověř stav.',
  popup: 'Pro otevření náhledu povol tomuto webu vyskakovací okna.',
  selectionChanged: 'Náhled se změnil. Otevři aktuální náhled a vyber prvek znovu.',
 },
};

function previewResultStatus(value) {
 const jobId = typeof value.jobId === 'string' && value.jobId.length <= 256 ? value.jobId : null;
 const expiresAt = Number.isSafeInteger(value.expiresAt) ? value.expiresAt : null;
 const ready = value.state === 'ready' && jobId && expiresAt > Date.now();
 const result = typeof value.result?.id === 'string' && /^[a-f0-9]{32}$/.test(value.result.id)
  ? { id: value.result.id, canReopen: value.result.canReopen === true }
  : null;
 const binding = ready && /^[a-f0-9]{32}$/.test(value.previewId ?? '') &&
  typeof value.generation === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.generation)
  ? {previewId:value.previewId,generation:value.generation,expiresAt}
  : null;
 return ready || result ? { ready, jobId, expiresAt, result, binding } : null;
}

async function requestPreviewResult(body, signal) {
 const timeout = AbortSignal.timeout(body.operation === 'status' ? 6000 : 25000);
 const response = await fetch('/api/workbench/preview', {
  method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
  signal: AbortSignal.any([signal, timeout]),
 });
 if (!response.ok) throw Error('PREVIEW_RESULT_REQUEST_FAILED');
 const value = await response.json();
 if (value?.version !== 1 || value.sessionId !== body.sessionId) throw Error('PREVIEW_RESULT_SESSION_CHANGED');
 return value;
}

function previewGrant(value) {
 if (value.state !== 'ready' || !Number.isSafeInteger(value.grantExpiresAt) || !Number.isSafeInteger(value.expiresAt) ||
     value.grantExpiresAt <= Date.now() || value.grantExpiresAt > value.expiresAt ||
     typeof value.url !== 'string') throw Error('PREVIEW_GRANT_UNCONFIRMED');
 const url = new URL(value.url);
 if (url.protocol !== 'https:' || url.origin === window.location.origin || url.username || url.password ||
     url.pathname !== '/__preview/bootstrap' || url.search || !/^#[a-zA-Z0-9_-]{43}$/.test(url.hash)) {
  throw Error('PREVIEW_GRANT_UNCONFIRMED');
 }
 return url.href;
}

function SavedPreviewResult({sessionId,inputActions,conversation}) {
 const labels = previewResultCopy[useLanguage()] ?? previewResultCopy.en;
 const [preview, setPreview] = React.useState(null);
 const [action, setAction] = React.useState(null);
 const [notice, setNotice] = React.useState(null);
 const state = React.useRef({active:false, pending:null, known:false, lastReopen:null}).current;

 const refresh = React.useCallback(async function () {
  if (!state.active || state.pending) return;
  const request = {kind:'status', controller:new AbortController()};
  state.pending = request;
  try {
   const value = await requestPreviewResult({operation:'status', sessionId}, request.controller.signal);
   if (state.pending !== request || !state.active) return;
   const current = previewResultStatus(value);
   state.known = current !== null;
   if (current?.result?.canReopen && current.result.id === state.lastReopen) state.lastReopen = null;
   if (current?.ready || current?.result?.canReopen) setNotice(previous => previous === 'failed' ? null : previous);
   setPreview(current);
  } catch {
   if (state.active && state.pending === request && state.known) {
    setPreview(previous => previous && {...previous, ready:false,
     result:previous.result && {...previous.result, canReopen:false}});
    setNotice('failed');
   }
  } finally {
   if (state.pending === request) state.pending = null;
  }
 }, [sessionId, state]);

 React.useLayoutEffect(() => {
  state.active = true;
  const onVisible = () => { if (!document.hidden) void refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  onVisible();
  return () => {
   state.active = false;
   state.pending?.controller.abort();
   state.pending?.popup?.close();
   state.pending = null;
   document.removeEventListener('visibilitychange', onVisible);
  };
 }, [refresh, state]);

 React.useEffect(() => {
  if (!preview?.ready) return;
  const timer = setTimeout(() => {
   setPreview(previous => previous === preview ? {...preview, ready:false} : previous);
   void refresh();
  }, Math.max(0, Math.min(2147483647, preview.expiresAt - Date.now())));
  return () => clearTimeout(timer);
 }, [preview, refresh]);

 const operation = preview?.ready && preview.expiresAt > Date.now()
  ? 'open'
  : preview?.result?.canReopen && preview.result.id !== state.lastReopen ? 'reopen' : null;

 async function openResult() {
  const resultId = preview.result?.id;
  if (!state.active || !operation || state.pending?.kind === 'open' ||
      (operation === 'reopen' && resultId === state.lastReopen)) return;
  // Open within the user gesture. No application URL is assigned until a
  // fresh server grant is verified for the same still-mounted session.
  const popup = window.open('', '_blank');
  if (!popup) { setNotice('popup'); return; }
  popup.opener = null;
  state.pending?.controller.abort();
  const request = {kind:'open', controller:new AbortController(), popup};
  state.pending = request;
  setAction(operation);
  setNotice(null);
  if (operation === 'reopen') state.lastReopen = resultId;
  const body = operation === 'open'
   ? {operation, sessionId, jobId:preview.jobId}
   : {operation, sessionId, resultId};
  try {
   const result = await requestPreviewResult(body, request.controller.signal);
   if (!state.active || state.pending !== request || popup.closed) { popup.close(); return; }
   popup.location.replace(previewGrant(result));
  } catch {
   popup.close();
   if (state.active && state.pending === request) setNotice('failed');
  } finally {
   if (state.active && state.pending === request) {
    state.pending = null;
    setAction(null);
    setPreview(previous => previous?.ready ? {...previous, ready:false} : previous);
    void refresh();
   }
  }
 }

 function selectionChanged(value) {
  if (state.pending?.kind === 'status') {
   state.pending.controller.abort();
   state.pending = null;
  }
  const current = previewResultStatus(value);
  state.known = current !== null;
  setPreview(current);
  setNotice('selectionChanged');
 }

 if (!preview) return notice === 'selectionChanged' ? h('p',{role:'status'},labels.selectionChanged) : null;
 return h('section', {'aria-label':labels.title, 'data-harness-preview-result':sessionId},
  operation
   ? h('button', {type:'button', className:'harness-native-action', disabled:action !== null,
    onClick:() => void openResult()}, labels[operation])
   : h('button', {type:'button', className:'harness-native-action', disabled:action !== null,
    onClick:() => void refresh()}, labels.refresh),
  action || notice || !operation
   ? h('span', {role:'status', style:{display:'block'}}, labels[action ? 'pending' : notice ?? 'waiting'])
   : null,
  operation === 'open' && action === null && preview.binding && inputActions && conversation
   ? h(PreviewElementSelection,{
    key:preview.binding.previewId+':'+preview.binding.generation, sessionId, binding:preview.binding, inputActions, conversation,
    onPreviewChanged:selectionChanged, onSelectionStart:() => setNotice(previous => previous === 'selectionChanged' ? null : previous),
   }) : null);
}

function CurrentPreviewResult({sessionId, turn, useChat, inputActions, conversation}) {
 const latest = useChat(snapshot => snapshot.timeline.turnOrder.at(-1));
 if (turn.turn !== latest || !turn.end) return null;
 return h(SavedPreviewResult, {key:sessionId, sessionId,inputActions,conversation});
}

function PresentedFileDownload({actionUrl}) {
 const labels = previewResultCopy[useLanguage()] ?? previewResultCopy.en;
 const prefix = 'api/present.open?';
 if (!actionUrl.startsWith(prefix)) return null;
 const coordinates = new URLSearchParams(actionUrl.slice(prefix.length));
 return h('a', {className:'harness-native-action', href:'/api/workbench/download?'+coordinates, download:''}, labels.download);
}

const archiveFilesCopy = {
 en:{title:'Archived files',close:'Close',parent:'Parent folder',loading:'Loading archived files…',
  empty:'No retained files in this folder.',unavailable:'The archived folder is unavailable.',
  download:'Download',missing:'This file is no longer available.'},
 cs:{title:'Soubory z archivu',close:'Zavřít',parent:'Nadřazená složka',loading:'Načítám soubory z archivu…',
  empty:'V této složce nejsou žádné zachované soubory.',unavailable:'Archivovaná složka není dostupná.',
  download:'Stáhnout',missing:'Tento soubor už není dostupný.'},
};

function ArchivedFilesDialog({session,close}) {
 const labels=archiveFilesCopy[useLanguage()]??archiveFilesCopy.en;
 const heading=React.useId(), dialog=React.useRef(null), downloadRequest=React.useRef(null);
 const [folder,setFolder]=React.useState(''), [listing,setListing]=React.useState(null);
 const [busy,setBusy]=React.useState(false), [missing,setMissing]=React.useState(false);
 React.useEffect(()=>{
  const element=dialog.current;
  element.showModal();
  return ()=>{
   downloadRequest.current?.abort();
   element.close();
  };
 },[]);
 React.useEffect(()=>{
  const controller=new AbortController();
  void (async()=>{
   try {
    const response=await fetch('/api/workbench',{
     method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
     headers:{'Content-Type':'application/json'},signal:controller.signal,
     body:JSON.stringify({op:'file',sessionId:session.sessionId,operation:'list',args:{path:folder}}),
    });
    if (!response.ok) throw Error('ARCHIVED_FOLDER_UNAVAILABLE');
    const result=await response.json();
    if (!Array.isArray(result?.entries)) throw Error('ARCHIVED_FOLDER_UNAVAILABLE');
    const entries=result.entries.filter(entry=>entry&&typeof entry.name==='string'&&entry.name&&
     !['.','..'].includes(entry.name)&&!/[\\/]/.test(entry.name)&&!entry.symlink);
    if (!controller.signal.aborted) setListing({folder,entries});
   } catch {
    if (!controller.signal.aborted) setListing({folder,entries:null});
   }
  })();
  return ()=>controller.abort();
 },[session.sessionId,folder]);
 const pathFor=name=>folder?folder+'/'+name:name;
 function go(next) {
  setMissing(false);
  setListing(null);
  setFolder(next);
 }
 async function download(name) {
  if (downloadRequest.current) return;
  const controller=new AbortController();
  downloadRequest.current=controller;
  setBusy(true);
  setMissing(false);
  try {
   const query=new URLSearchParams({sessionId:session.sessionId,path:pathFor(name)});
   const response=await fetch('/api/workbench/download?'+query,{
    credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
   });
   if (!response.ok) throw Error('ARCHIVED_FILE_UNAVAILABLE');
   const blob=await response.blob();
   controller.signal.throwIfAborted();
   const url=URL.createObjectURL(blob);
   const link=document.createElement('a');
   link.href=url;
   link.download=name;
   document.body.append(link);
   link.click();
   link.remove();
   setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch {
   if (!controller.signal.aborted) setMissing(true);
  } finally {
   downloadRequest.current=null;
   if (!controller.signal.aborted) setBusy(false);
  }
 }
 const entries=listing?.folder===folder?listing.entries:undefined;
 const action=(label,onClick,disabled=false)=>h('button',{type:'button',className:'harness-native-action',onClick,disabled},label);
 return h('dialog',{ref:dialog,'aria-labelledby':heading,onCancel:event=>{event.preventDefault();close();},
  style:{width:'min(32rem, calc(100vw - 2rem))',maxHeight:'min(80vh, 36rem)',overflow:'auto',
   color:'inherit',background:'var(--app-background, Canvas)',border:'1px solid currentColor',borderRadius:8}},
  h('h2',{id:heading},labels.title),
  h('p',{style:{overflowWrap:'anywhere'}},session.displayTitle,' ',h('code',null,session.sessionId)),
  folder&&h('p',null,action(labels.parent,()=>go(folder.split('/').slice(0,-1).join('/')),busy),' ',h('code',null,folder)),
  entries===undefined?h('p',{role:'status'},labels.loading):
   entries===null?h('p',{role:'status'},labels.unavailable):
   entries.length===0?h('p',{role:'status'},labels.empty):
   h('ul',null,entries.map(entry=>h('li',{key:entry.name},
    entry.directory?action(entry.name,()=>go(pathFor(entry.name)),busy):
     action(labels.download+' '+entry.name,()=>void download(entry.name),busy)))),
  missing&&h('p',{role:'alert'},labels.missing),
  action(labels.close,close));
}

function registerArchivedFiles(ctx) {
 ctx.inject(['workspaces','contextMenus'],scope=>{
  let selected=null;
  const listeners=new Set();
  const set=value=>{selected=value;for(const listener of listeners)listener();};
  const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
  const snapshot=()=>selected;
  const archived=sessionId=>scope.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId);
  scope.effect(()=>scope.contextMenus.register({
   id:'harness.archived-files',target:'session',order:500,
   observe:()=>[scope.workspaces.list],
   resolve:target=>archived(target.sessionId)?[{
    id:'harness.archived-files',label:(archiveFilesCopy[window.HarnessI18n.language]??archiveFilesCopy.en).title,
    run:()=>{if(archived(target.sessionId))set({sessionId:target.sessionId,displayTitle:target.displayTitle});},
   }]:[],
  }),'native-workbench: archived files menu');
  scope.effect(()=>scope.slots.inject('shell.overlay',()=>scope.slots.register({
   name:'shell.overlay',id:'harness.archived-files',
  },function ArchiveOverlay(){
   const session=React.useSyncExternalStore(subscribe,snapshot);
   return session?h(ArchivedFilesDialog,{key:session.sessionId,session,close:()=>set(null)}):null;
  })),'native-workbench: archived files dialog');
 });
}

function registerPreviewResults(ctx) {
 registerArchivedFiles(ctx);
 ctx.effect(() => ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register({
  name:'deliverables.file.actions', id:'harness.presented-download',
 }, PresentedFileDownload)), 'native-workbench: presented file download');
 ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
  name:'conversation.chat.turnTail', id:'harness.application-result', order:70,
  inject:()=>({conversation:ctx.conversation}),
 }, CurrentPreviewResult)), 'native-workbench: application result');
}
