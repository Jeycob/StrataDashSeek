// Native also composes abort signals. Older Safari must have these helpers
// before any of our panes creates a Native session or starts a request.
if(typeof AbortSignal.any!=='function')AbortSignal.any=iterable=>{
 const signals=Array.from(iterable);
 const controller=new AbortController(),subscriptions=[];
 const cleanup=()=>{for(const [signal,listener]of subscriptions)signal.removeEventListener('abort',listener);subscriptions.length=0;};
 const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
 for(const signal of signals)aborted.call(signal);
 for(const signal of signals)if(signal.aborted){controller.abort(signal.reason);return controller.signal;}
 for(const signal of signals){const listener=()=>{controller.abort(signal.reason);cleanup();};subscriptions.push([signal,listener]);signal.addEventListener('abort',listener,{once:true});}
 return controller.signal;
};
if(typeof AbortSignal.timeout!=='function')AbortSignal.timeout=milliseconds=>{
 if(!Number.isSafeInteger(milliseconds)||milliseconds<0)throw new RangeError('Invalid timeout');
 const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('The operation timed out','TimeoutError')),Math.min(milliseconds,2147483647));return controller.signal;
};
const inject=['slots','sidebarRightTabs','sidebarRight','uiWorkspace','locale'];
const h=React.createElement;
const copy={en:{docker:'Applications and Docker',workspaces:'Workspace defaults',notifications:'Notifications',newDocker:'Prepare Docker from this project',noRoot:'Open a conversation with a project inside the application workspace.',outsideRoot:'This project is outside the application workspace. Choose a project from the configured workspace.',preparing:'Preparing…',language:'Language',files:'Workspace files',filesHelp:'Browse, edit, upload and delete files in this conversation’s isolated project.',dockerHelp:'Containers, logs and releases. Reading status does not wake Docker.',openPhone:'Open the installed Harness app to configure iPhone notifications.',workspace:'Workspace',noWorkspace:'Create a workspace first.',ready:'Docker project prepared.'},cs:{docker:'Aplikace a Docker',workspaces:'Výchozí nastavení projektů',notifications:'Oznámení',newDocker:'Připravit Docker z tohoto projektu',noRoot:'Otevři konverzaci s projektem ve složce aplikací.',outsideRoot:'Projekt je mimo složku aplikací. Vyber projekt v nastaveném pracovním prostoru.',preparing:'Připravuji…',language:'Jazyk',files:'Soubory projektu',filesHelp:'Procházení, úpravy, nahrávání a mazání souborů odděleného projektu této konverzace.',dockerHelp:'Kontejnery, logy a vydání. Čtení stavu Docker neprobouzí.',openPhone:'Pro nastavení oznámení na iPhonu otevři nainstalovanou aplikaci Harness.',workspace:'Pracovní prostor',noWorkspace:'Nejprve vytvoř pracovní prostor.',ready:'Docker projektu je připravený.'}};
const text=key=>copy[window.HarnessI18n.language][key]||copy.en[key]||key;
Object.assign(copy.en,{general:'General',advanced:'Advanced runtime status',interfaceLanguage:'Interface language',generalHelp:'Applies to this browser and its installed app. Workspace task language is configured separately.',workspaceHelp:'Defaults for new conversations in the selected workspace. Existing conversations keep explicit model choices.',runtimeHelp:'Observed server state. Signing requirements, installed capacity and protected paths are read-only.',noRuntime:'Runtime status has not been observed.',updates:'Updates',disabled:'Disabled',verifiedSignature:'Signature verified',unverifiedSignature:'Signature has not been verified yet',lastObserved:'Last observed',sourceCommit:'Applied source commit'});
Object.assign(copy.cs,{general:'Obecné',advanced:'Pokročilé: stav prostředí',interfaceLanguage:'Jazyk rozhraní',generalHelp:'Platí pro tento prohlížeč a jeho nainstalovanou aplikaci. Jazyk úloh pracovního prostoru se nastavuje zvlášť.',workspaceHelp:'Výchozí hodnoty nových konverzací ve vybraném pracovním prostoru. Ruční volba modelu v existující konverzaci zůstává zachovaná.',runtimeHelp:'Pozorovaný stav serveru. Požadavky na podpis, instalovaná kapacita a chráněné cesty jsou pouze ke čtení.',noRuntime:'Stav prostředí zatím není ověřený.',updates:'Aktualizace',disabled:'Vypnuto',verifiedSignature:'Podpis ověřen',unverifiedSignature:'Podpis zatím není ověřený',lastObserved:'Poslední pozorování',sourceCommit:'Použitý commit zdrojů'});
copy.en.bootstrapUpgrade='A protected bootstrap upgrade requires an operator. The verified source release can remain active.';
copy.cs.bootstrapUpgrade='Chráněný spouštěč vyžaduje aktualizaci správcem. Ověřené vydání zdrojů může dál běžet.';
Object.assign(copy.en,{notifications:'Devices and notifications',devices:'Devices and automatic wake',devicesHelp:'Revocation removes automatic wake permission. It does not cancel server jobs or revoke the separate Harness login.',devicesRefresh:'Refresh devices',deviceRevoke:'Revoke automatic wake',deviceConfirm:'Confirm revocation',deviceCancel:'Cancel',deviceConfirmHelp:'Revoke automatic wake for this device?',deviceRevoked:'Wake access revoked',deviceActive:'Wake access active',deviceExpired:'Wake credential expired',deviceExpires:'Expires',deviceEmpty:'No devices registered.',deviceFailed:'Device operation was not confirmed. Refresh the list before retrying.',deviceRevokedSaved:'Wake revocation was stored.',deviceOwner:'Open owner wake portal',deviceClaim:'Apply approved reconnection',deviceClaimHelp:'Approve this device in the owner portal first, then return here. Reconnection requires this device’s existing Harness pairing.',deviceClaimed:'This device can wake the server again.',deviceScope:'Permissions: status and wake only'});
Object.assign(copy.cs,{notifications:'Zařízení a oznámení',devices:'Zařízení a automatické probouzení',devicesHelp:'Odebrání ruší oprávnění automaticky probouzet server. Neruší běžící úlohy ani samostatné přihlášení do Harnessu.',devicesRefresh:'Obnovit seznam zařízení',deviceRevoke:'Odebrat automatické probouzení',deviceConfirm:'Potvrdit odebrání',deviceCancel:'Zrušit',deviceConfirmHelp:'Odebrat tomuto zařízení automatické probouzení?',deviceRevoked:'Probouzení odebráno',deviceActive:'Probouzení povoleno',deviceExpired:'Platnost přístupu k probouzení skončila',deviceExpires:'Platnost do',deviceEmpty:'Zatím nejsou registrovaná zařízení.',deviceFailed:'Operace se zařízením není potvrzená. Než ji zopakuješ, obnov seznam.',deviceRevokedSaved:'Odebrání probouzení bylo uložené.',deviceOwner:'Otevřít portál vlastníka budíčku',deviceClaim:'Převzít schválené připojení',deviceClaimHelp:'Nejprve toto zařízení schval v portálu vlastníka a vrať se sem. Obnova vyžaduje existující propojení tohoto zařízení s Harnessem.',deviceClaimed:'Toto zařízení může znovu probouzet server.',deviceScope:'Oprávnění: pouze stav a probuzení'});
Object.assign(copy.en,{changesSinceGit:'Changes from Git base',newlineChanged:'The final newline changed.',changes:'Changes',changesHelp:'Follow changed files and their diffs as the model works.',live:'Live',idle:'Idle',refresh:'Refresh',loadingChanges:'Loading changes…',noChanges:'No file changes yet.',selectChange:'Choose a file to compare.',changesSinceProject:'Changes since project start',changesSinceTracking:'Changes since tracking started',partialChanges:'Some files could not be included in this comparison.',changedFiles:'Changed files',added:'Added',modified:'Modified',deleted:'Deleted',binary:'Binary file — no text diff.',oversized:'This file is too large for a text diff.',coarse:'The comparison timed out; whole-file replacements are shown.',truncatedDiff:'Only the first part of this comparison is shown.',diffEmpty:'No text differences.',diffLoading:'Loading comparison…',changesError:'Could not refresh changes.',oldLine:'Before',newLine:'After',fileChanges:'Changed files',comparison:'File comparison'});
Object.assign(copy.cs,{changesSinceGit:'Změny oproti Git základu',newlineChanged:'Změnil se koncový znak nového řádku.',changes:'Změny',changesHelp:'Sleduj upravené soubory a jejich rozdíly během práce modelu.',live:'Průběžně',idle:'Nečinný',refresh:'Obnovit',loadingChanges:'Načítám změny…',noChanges:'Zatím nejsou žádné změny souborů.',selectChange:'Vyber soubor k porovnání.',changesSinceProject:'Změny od začátku projektu',changesSinceTracking:'Změny od zapnutí sledování',partialChanges:'Některé soubory nejsou součástí tohoto porovnání.',changedFiles:'Změněné soubory',added:'Přidáno',modified:'Upraveno',deleted:'Smazáno',binary:'Binární soubor — bez textového porovnání.',oversized:'Soubor je příliš velký pro textové porovnání.',coarse:'Porovnání překročilo časový limit; zobrazuje se nahrazení celých souborů.',truncatedDiff:'Zobrazuje se pouze první část porovnání.',diffEmpty:'Žádné textové rozdíly.',diffLoading:'Načítám porovnání…',changesError:'Změny se nepodařilo obnovit.',oldLine:'Před',newLine:'Po',fileChanges:'Změněné soubory',comparison:'Porovnání souboru'});

// Read-only transport: one visible poll includes both the list and selected diff.
function useLiveChanges(sessionId,visible){
 const [value,setValue]=React.useState({summary:null,selected:'',diff:null,error:'',loading:true});
 const snapshot=React.useRef(value),commands=React.useRef({});snapshot.current=value;
 React.useEffect(()=>{
  let disposed=false,timer,controller,ticket=0,running=snapshot.current.summary?.running;
  const active=()=>visible&&!document.hidden&&!disposed;
  const stop=()=>{clearTimeout(timer);controller?.abort();};
  const schedule=()=>{if(active())timer=setTimeout(()=>void run('list'),running?2000:15000);};
  async function run(operation){
   if(!active()||!sessionId)return;
   clearTimeout(timer);controller?.abort();controller=new AbortController();const current=++ticket;
   const selected=snapshot.current.selected,args={};
   if(selected)args.path=selected;
   if(operation==='list'&&snapshot.current.summary?.revision)args.revision=snapshot.current.summary.revision;
   if(operation==='list'&&snapshot.current.diff?.revision)args.diffRevision=snapshot.current.diff.revision;
   try{
    const result=await nativeJSON('/api/workbench',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'changes',sessionId,operation,args}),signal:controller.signal});
    if(!active()||current!==ticket)return;
    if(operation==='list'){
     if(result.version!==1||result.sessionId!==sessionId||(!result.unchanged&&!Array.isArray(result.files)))throw Error('Invalid changes response.');
     running=result.running;
     setValue(previous=>{
      const {diff,diffUnchanged,...summary}=result,files=result.unchanged?(previous.summary?.files||[]):result.files;
      const keep=(!previous.selected||files.some(file=>file.path===previous.selected))&&!(Object.hasOwn(result,'diff')&&diff===null);
      return {...previous,loading:false,error:'',summary:{...previous.summary,...summary,files},selected:keep?previous.selected:'',diff:keep?(diffUnchanged?previous.diff:diff||previous.diff):null};
     });
    }else{
     if(result.version!==1||result.path!==selected)throw Error('Invalid diff response.');
     setValue(previous=>previous.selected===selected?{...previous,diff:result,error:'',loading:false}:previous);
    }
   }catch(error){if(!disposed&&current===ticket&&!controller.signal.aborted)setValue(previous=>({...previous,loading:false,error:error.message}));}
   finally{if(!disposed&&current===ticket)schedule();}
  }
  commands.current={refresh:()=>void run('list'),select(path){
   if(!snapshot.current.summary?.files?.some(file=>file.path===path))return;
   snapshot.current={...snapshot.current,selected:path,diff:null};setValue(snapshot.current);void run('diff');
  }};
  const change=()=>{stop();if(active())void run('list');};
  document.addEventListener('visibilitychange',change);if(active())void run('list');
  return()=>{disposed=true;++ticket;stop();document.removeEventListener('visibilitychange',change);commands.current={};};
 },[sessionId,visible]);
 const select=React.useCallback(path=>commands.current.select?.(path),[]),refresh=React.useCallback(()=>commands.current.refresh?.(),[]);
 return {...value,select,refresh};
}

function ChangeDiff({diff,selected}){
 if(!selected)return h('p',{className:'hc-empty'},text('selectChange'));
 if(!diff)return h('p',{className:'hc-empty',role:'status'},text('diffLoading'));
 const notices=[];
 if(diff.kind!=='text')return h('div',null,h('h3',{className:'hc-diff-title'},selected),h('p',{className:'hc-empty'},text(diff.kind==='binary'?'binary':'oversized')));
 if(diff.coarse)notices.push(h('p',{key:'coarse',className:'hc-notice'},text('coarse')));
 const newlineChanged=typeof diff.beforeNewline==='boolean'&&typeof diff.afterNewline==='boolean'&&diff.beforeNewline!==diff.afterNewline;
 if(newlineChanged)notices.push(h('p',{key:'newline',className:'hc-notice'},text('newlineChanged')));
 const rows=[];let count=0,cut=false;
 for(const [index,hunk]of (diff.hunks||[]).entries()){
  if(count>=5000){cut=true;break;}
  rows.push(h('tr',{key:'h'+index,className:'hc-hunk'},h('td',{colSpan:3},'@@ -'+hunk.oldStart+','+hunk.oldLines+' +'+hunk.newStart+','+hunk.newLines+' @@')));
  let old=hunk.oldStart,next=hunk.newStart;
  for(const [lineIndex,line]of (hunk.lines||[]).entries()){
   if(count++>=5000){cut=true;break;}
   const kind=line[0],oldNumber=kind==='+'||kind==='\\'?'':old++,newNumber=kind==='-'||kind==='\\'?'':next++;
   rows.push(h('tr',{key:index+':'+lineIndex,className:kind==='+'?'hc-add':kind==='-'?'hc-delete':'hc-context'},h('td',{className:'hc-line','aria-label':text('oldLine')},oldNumber),h('td',{className:'hc-line','aria-label':text('newLine')},newNumber),h('td',{className:'hc-code'},line)));
  }
 }
 if(cut||diff.truncated)notices.push(h('p',{key:'truncated',className:'hc-notice'},text('truncatedDiff')));
 return h('div',null,h('h3',{className:'hc-diff-title'},selected),...notices,rows.length?h('table',{className:'hc-diff-table','aria-label':text('comparison')},h('tbody',null,...rows)):!newlineChanged&&h('p',{className:'hc-empty'},text('diffEmpty')));
}

function ChangesSession(props){
 const {tab}=props.useTabInfo();useLanguage();
 const changes=useLiveChanges(props.sessionId,tab.visible),summary=changes.summary;
 React.useEffect(()=>tab.actions.bindCommands({refresh:changes.refresh}),[tab.actions,changes.refresh]);
 const files=summary?.files||[],baseline=summary?.baseline?.label==='project-start'?'changesSinceProject':'changesSinceTracking';
 const baselineText=summary?.baseline?.kind==='git-base'?text('changesSinceGit')+(summary.baseline.commit?' · '+String(summary.baseline.commit).slice(0,12):''):text(baseline);
 return h('section',{className:'harness-native-surface harness-native-changes','data-harness-changes-session':props.sessionId},
  h('header',null,h('h2',null,text('changes')),h('span',{className:'hc-state','data-running':Boolean(summary?.running)},h('span',{className:'hc-dot','aria-hidden':true}),text(summary?.running?'live':'idle')),h('button',{type:'button',className:'harness-native-action',onClick:changes.refresh},text('refresh'))),
  h('p',{className:'hc-meta'},summary?baselineText+' · '+text('changedFiles')+': '+(summary.total??files.length):text(changes.loading?'loadingChanges':changes.error?'changesError':'noChanges')),
  changes.error&&h('p',{role:'alert',className:'hc-notice'},text('changesError')+' '+changes.error),
  summary?.partial&&h('p',{className:'hc-notice'},text('partialChanges')),
  ...(summary?.warnings||[]).slice(0,8).map((warning,index)=>h('p',{key:'warning'+index,className:'hc-notice'},String(warning).slice(0,500))),
  files.length?h('div',{className:'hc-body'},h('nav',{className:'hc-list','aria-label':text('fileChanges')},...files.map(file=>h('button',{type:'button',key:file.path,className:'hc-file','data-change-path':file.path,'aria-pressed':changes.selected===file.path,onClick:()=>changes.select(file.path)},h('span',{className:'hc-path'},file.path),h('span',{className:'hc-counts'},h('span',null,text(file.status)),file.added!==null&&file.added!==undefined&&h('span',{className:'hc-plus'},'+'+file.added),file.deleted!==null&&file.deleted!==undefined&&h('span',{className:'hc-minus'},'−'+file.deleted))))),h('div',{className:'hc-diff'},h(ChangeDiff,{diff:changes.diff,selected:changes.selected}))):!(changes.error&&!summary)&&h('p',{className:'hc-empty',role:'status'},text(changes.loading?'loadingChanges':'noChanges')));
}
function Changes(props){return h('div',{className:'harness-model-pane'},h(ConversationModel,{sessionId:props.sessionId,key:props.sessionId}),h('div',{className:'harness-model-pane-content'},h(ExecutionPane,{...props,Host:ChangesSession,changes:true,key:props.sessionId})));}
// Safari versions without AbortSignal.any/timeout use the same explicit
// controller lifetime as every other browser. Timers/listeners always detach.
async function nativeJSON(url,options={},timeoutMs=15000){
 const controller=new AbortController(),abort=()=>controller.abort(),signal=options.signal;
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,timeoutMs);
 try{const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal}),result=await response.json();if(controller.signal.aborted)throw new DOMException('Request cancelled or timed out','AbortError');if(!response.ok)throw Object.assign(Error(result.error||'HTTP '+response.status),{code:result.code});return result;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
async function state(){return nativeJSON('/api/workbench');}
Object.assign(copy.en,{conversationModel:'Model for this conversation',workspaceModel:'Workspace default',modelScope:'This control changes only this conversation.',modelUsed:'Last request used',modelPending:'Saving model…',modelLoading:'Loading models…',modelUnconfirmed:'Model selection is not confirmed.',modelRetry:'Refresh models',modelUnavailable:'This saved model is unavailable. Choose an available model to continue.',modelDefaultUnavailable:'The workspace default is unavailable.',modelEffort:'Reasoning level',modelEffortDefault:'Model default',modelCatalogPartial:'Some model providers could not be loaded.'});
Object.assign(copy.cs,{conversationModel:'Model této konverzace',workspaceModel:'Výchozí model prostoru',modelScope:'Tato volba mění pouze tuto konverzaci.',modelUsed:'Poslední požadavek použil',modelPending:'Ukládám model…',modelLoading:'Načítám modely…',modelUnconfirmed:'Výběr modelu není potvrzený.',modelRetry:'Obnovit modely',modelUnavailable:'Uložený model není dostupný. Pro pokračování vyber dostupný model.',modelDefaultUnavailable:'Výchozí model prostoru není dostupný.',modelEffort:'Úroveň uvažování',modelEffortDefault:'Výchozí hodnota modelu',modelCatalogPartial:'Některé poskytovatele modelů se nepodařilo načíst.'});
async function modelJSON(url,options){return nativeJSON(url,options);}
function ConversationModel({sessionId}){
 useLanguage();const [value,setValue]=React.useState(null),[error,setError]=React.useState(null),[pending,setPending]=React.useState(null),active=React.useRef(null);
 const currentOwner=active.current,owns=owner=>owner?.active===true&&active.current===owner&&owner.sessionId===sessionId;
 // A render can receive new props before effect cleanup. Never render or write
 // using the preceding session's catalog, defaults, effort or error state.
 const current=owns(currentOwner)&&value?.owner===currentOwner&&value.data?.sessionId===sessionId?value.data:null;
 const busy=owns(currentOwner)&&pending?.owner===currentOwner,writing=busy&&pending.kind==='write';
 const currentError=owns(currentOwner)&&error?.owner===currentOwner?error.message:'';
 const load=React.useCallback(async(owner=active.current)=>{
  if(!owner?.active||active.current!==owner||owner.sessionId!==sessionId||owner.write)return;
  owner.read?.abort();const controller=new AbortController(),ticket=++owner.epoch;owner.read=controller;
  const accepts=()=>owner.active&&active.current===owner&&owner.sessionId===sessionId&&ticket===owner.epoch;
  setValue(null);setError(null);setPending({owner,ticket,kind:'read'});
  try{const result=await modelJSON('/api/workbench/models?sessionId='+encodeURIComponent(owner.sessionId),{signal:controller.signal});if(!accepts())return;if(result.version!==1||result.sessionId!==owner.sessionId||!Array.isArray(result.groups))throw Error('Invalid model response');setValue({owner,data:result});}
  catch(e){if(accepts())setError({owner,message:e.name==='AbortError'?text('modelUnconfirmed'):e.message});}
  finally{if(owner.read===controller)owner.read=null;if(accepts())setPending(old=>old?.owner===owner&&old.ticket===ticket?null:old);}
 },[sessionId]);
 React.useEffect(()=>{
  const owner={sessionId,active:true,epoch:0,read:null,write:null};active.current=owner;void load(owner);
  return()=>{owner.active=false;++owner.epoch;owner.read?.abort();owner.write?.abort();if(active.current===owner)active.current=null;};
 },[sessionId,load]);
 const select=async selection=>{
  const owner=active.current;if(!owns(owner)||owner.write||owner.read||!current||value.owner!==owner)return;
  const controller=new AbortController(),ticket=++owner.epoch;owner.write=controller;
  const accepts=()=>owner.active&&active.current===owner&&owner.sessionId===sessionId&&ticket===owner.epoch;
  setPending({owner,ticket,kind:'write'});setError(null);
  try{const result=await modelJSON('/api/workbench/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:owner.sessionId,selection}),signal:controller.signal});if(!accepts())return;if(result.version!==1||result.sessionId!==owner.sessionId)throw Error('Invalid model response');setValue(old=>old?.owner===owner?{owner,data:{...old.data,...result}}:old);}
  catch(e){if(accepts()){setValue(null);setError({owner,message:e.name==='AbortError'?text('modelUnconfirmed'):e.message});}}
  finally{if(owner.write===controller)owner.write=null;if(accepts())setPending(old=>old?.owner===owner&&old.ticket===ticket?null:old);}
 };
 const selection=current?.selection,selected=current?(current.source==='workspace'?'workspace':selection?JSON.stringify({provider:selection.provider,model:selection.model}):'workspace'):'',groups=current?.groups||[];
 const model=groups.find(group=>group.id===selection?.provider)?.models.find(model=>model.id===selection?.model),known=groups.some(group=>group.models.some(model=>JSON.stringify({provider:group.id,model:model.id})===selected));
 return h('section',{className:'harness-conversation-model','data-model-session':sessionId},h('label',null,text('conversationModel'),h('select',{value:selected,onChange:event=>{if(event.target.value)void select(event.target.value==='workspace'?null:JSON.parse(event.target.value));},disabled:busy||!current,'aria-label':text('conversationModel')},!current?h('option',{value:''},text(currentError?'modelUnconfirmed':'modelLoading')):h('option',{value:'workspace'},text('workspaceModel')),selected&&selected!=='workspace'&&!known&&h('option',{value:selected,disabled:true},selection.provider+' / '+selection.model),...groups.map(group=>h('optgroup',{key:group.id,label:group.name},...group.models.map(model=>h('option',{key:model.id,value:JSON.stringify({provider:group.id,model:model.id})},model.name)))))),current?.source==='session'&&model?.reasoning&&h('label',null,text('modelEffort'),h('select',{'aria-label':text('modelEffort'),value:selection.reasoningEffort??'',disabled:busy||!current,onChange:event=>void select({provider:selection.provider,model:selection.model,...(event.target.value?{reasoningEffort:event.target.value}:{})})},h('option',{value:''},text('modelEffortDefault')),...model.reasoning.efforts.map(effort=>h('option',{key:effort.id,value:effort.id},effort.name)))),h('small',null,text('modelScope')),writing&&h('p',{role:'status'},text('modelPending')),busy&&!writing&&h('p',{role:'status'},text('modelLoading')),current?.lastUsed&&h('small',null,text('modelUsed')+': '+current.lastUsed.provider+' / '+current.lastUsed.model),current?.selectionError&&h('p',{role:'alert'},text('modelUnavailable')),current?.workspaceDefaultError&&h('p',{role:'alert'},text('modelDefaultUnavailable')),current?.failures?.length>0&&h('p',{role:'status'},text('modelCatalogPartial')),currentError&&h('p',{role:'alert'},currentError),h('button',{type:'button',onClick:()=>void load(),disabled:busy},text('modelRetry')));
}
Object.assign(copy.en,{editor:'Code editor',editorHelp:'Code OSS through code-server. Live project files and Git changes for this conversation.',editorOpen:'Open code-server',editorLoading:'Opening editor…',editorUnavailable:'The code-server editor is unavailable. Your project files remain on the server.',editorRetry:'Reconnect editor',editorClose:'Close editor',editorCloseHelp:'Save or resolve unsaved files in the editor before closing. Close this editor now?',editorLimit:'Three editors are retained to protect drafts. Close a saved editor before opening another.',editorDrafts:'Unsaved buffers stay in this editor when you switch conversations. Resolve save conflicts in code-server.',editorExpired:'Editor access has expired. Save your draft locally before reconnecting.',editorMobile:'A separate tab provides more room. Save drafts before switching editor windows.',editorNewTab:'Open editor in a new tab',editorStarting:'The editor is starting. Retry shortly.',editorReadOnly:'This editor is read-only.',editorChanges:'Review Git changes in the code editor.',editorEntry:'Open code editor',executionLoading:'Checking project access…',executionUnavailable:'Project access could not be confirmed. Retry before opening project files.',executionRetry:'Retry project access'});
Object.assign(copy.cs,{editor:'Editor kódu',editorHelp:'Code OSS přes code-server. Živé soubory projektu a Git změny této konverzace.',editorOpen:'Otevřít code-server',editorLoading:'Otevírám editor…',editorUnavailable:'Editor code-server není dostupný. Soubory projektu zůstávají na serveru.',editorRetry:'Znovu připojit editor',editorClose:'Zavřít editor',editorCloseHelp:'Před zavřením ulož nebo vyřeš rozepsané soubory v editoru. Zavřít tento editor?',editorLimit:'Tři editory zůstávají otevřené kvůli draftům. Před dalším otevřením zavři uložený editor.',editorDrafts:'Při přepnutí konverzace zůstávají rozepsané soubory v tomto editoru. Konflikty ukládání vyřeš v code-serveru.',editorExpired:'Platnost připojení editoru skončila. Před opětovným připojením si ulož draft lokálně.',editorMobile:'Samostatná karta nabízí více místa. Před přechodem mezi okny editoru ulož drafty.',editorNewTab:'Otevřít editor v nové kartě',editorStarting:'Editor se spouští. Za chvíli zkus připojení znovu.',editorReadOnly:'Tento editor umožňuje pouze čtení.',editorChanges:'Git změny zkontroluj v editoru kódu.',editorEntry:'Otevřít editor kódu',executionLoading:'Ověřuji přístup k projektu…',executionUnavailable:'Přístup k projektu se nepodařilo ověřit. Před otevřením souborů zkus připojení znovu.',executionRetry:'Znovu ověřit přístup'});

// This observation only selects a view. Server-bound execution mode remains
// authoritative for every operation; Apps availability never selects a backend.
let executionView={mode:null,loading:true},executionRequest=null,executionPoll,executionExpiry,executionEpoch=0;
const executionObservers=new Set();
const executionActive=()=>!document.hidden&&[...executionObservers].some(row=>row.active);
function publishExecution(value){executionView=value;for(const row of executionObservers)row.notify(value);}
function stopExecutionRequest(){++executionEpoch;executionRequest?.controller.abort();executionRequest=null;clearTimeout(executionPoll);}
function scheduleExecution(){clearTimeout(executionPoll);if(executionActive())executionPoll=setTimeout(()=>void refreshExecution(),15000);}
function refreshExecution(){
 if(executionRequest)return executionRequest.promise;
 const controller=new AbortController(),ticket=++executionEpoch;
 if(!executionView.mode)publishExecution({mode:null,loading:true});
 const promise=(async()=>{
  try{
   const value=await nativeJSON('/api/workbench/execution',{signal:controller.signal});
   if(controller.signal.aborted||ticket!==executionEpoch)return executionView;
   if(value.version!==1||value.available!==true||!['host-compat','isolated-guest'].includes(value.mode))throw Error('Unconfirmed execution mode');
   publishExecution({mode:value.mode,loading:false});clearTimeout(executionExpiry);
   executionExpiry=setTimeout(()=>publishExecution({mode:null,loading:false}),30000);
  }catch(error){if(!controller.signal.aborted&&ticket===executionEpoch){clearTimeout(executionExpiry);publishExecution({mode:null,loading:false});}}
  finally{if(ticket===executionEpoch){executionRequest=null;scheduleExecution();}}
  return executionView;
 })();
 executionRequest={controller,promise};return promise;
}
function executionVisibility(){if(document.hidden)stopExecutionRequest();else if(executionActive())void refreshExecution();}
function executionOffline(){stopExecutionRequest();clearTimeout(executionExpiry);publishExecution({mode:null,loading:false});}
function executionOnline(){if(executionActive())void refreshExecution();}
function useExecutionMode(active){
 const [value,setValue]=React.useState(executionView),subscription=React.useRef(null);
 if(!subscription.current)subscription.current={active:false,notify:setValue};
 React.useEffect(()=>{
  const row=subscription.current,first=executionObservers.size===0;executionObservers.add(row);setValue(executionView);
  if(first){document.addEventListener('visibilitychange',executionVisibility);window.addEventListener('offline',executionOffline);window.addEventListener('online',executionOnline);}
  return()=>{executionObservers.delete(row);if(!executionObservers.size){stopExecutionRequest();document.removeEventListener('visibilitychange',executionVisibility);window.removeEventListener('offline',executionOffline);window.removeEventListener('online',executionOnline);}else scheduleExecution();};
 },[]);
 React.useEffect(()=>{subscription.current.active=active;if(executionActive())void refreshExecution();else{clearTimeout(executionPoll);if(executionRequest)stopExecutionRequest();}},[active]);
 return {...value,refresh:refreshExecution};
}
function ExecutionPane(props){
 useLanguage();const info=props.useTabInfo?.(),execution=useExecutionMode(info?.tab.visible!==false);
 if(execution.mode==='host-compat')return h(props.Host,props);
 if(execution.mode==='isolated-guest')return props.changes?h('section',{className:'harness-native-surface harness-execution-state','data-code-changes-entry':props.sessionId},h('p',null,text('editorChanges')),h('button',{type:'button',className:'harness-native-action',onClick:()=>void window.HarnessNativeUI?.openFiles(props.sessionId)},text('editorEntry'))):h(EditorSession,{...props,key:props.sessionId});
 return h('section',{className:'harness-native-surface harness-execution-state','data-execution-unavailable':props.sessionId},h('p',{role:execution.loading?'status':'alert'},text(execution.loading?'executionLoading':'executionUnavailable')),h('button',{type:'button',className:'harness-native-action',disabled:execution.loading,onClick:()=>void execution.refresh()},text('executionRetry')));
}

// Park the real browsing context rather than evicting unknown dirty buffers.
const editorFrames=new Map();
function parkEditor(entry){entry.frame.style.display='none';}
function EditorSession({sessionId,useTabInfo}){
 useLanguage();const host=React.useRef(null),epoch=React.useRef(0),pending=React.useRef(null),[entry,setEntry]=React.useState(()=>editorFrames.get(sessionId)||null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[confirm,setConfirm]=React.useState(false),[online,setOnline]=React.useState(navigator.onLine);
 const info=useTabInfo?.(),visible=info?.tab.visible!==false,[now,setNow]=React.useState(Date.now());
 React.useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
 React.useEffect(()=>{const online=()=>setOnline(navigator.onLine);window.addEventListener('online',online);window.addEventListener('offline',online);return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',online);};},[]);
 React.useEffect(()=>{
  if(!entry)return;const position=()=>{const rect=host.current?.getBoundingClientRect(),shown=visible&&!document.hidden&&rect&&rect.width>0&&rect.height>0;Object.assign(entry.frame.style,shown?{display:'block',position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',zIndex:'40'}:{display:'none'});};
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(position):null;if(host.current)observer?.observe(host.current);
  window.addEventListener('resize',position);window.addEventListener('scroll',position,true);document.addEventListener('visibilitychange',position);position();
  return()=>{observer?.disconnect();window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);document.removeEventListener('visibilitychange',position);parkEditor(entry);};
 },[entry,sessionId,visible]);
 React.useEffect(()=>{if(!visible){++epoch.current;pending.current?.abort();pending.current=null;setBusy(false);}return()=>{++epoch.current;pending.current?.abort();pending.current=null;};},[sessionId,visible]);
 async function open(reconnect=false){
  if(!sessionId||pending.current)return;if(!entry&&editorFrames.size>=3){setError(text('editorLimit'));return;}
  if(reconnect&&entry&&!window.confirm(text('editorCloseHelp')))return;
  const ticket=++epoch.current,controller=new AbortController();pending.current=controller;setBusy(true);setError('');
  try{
   const execution=await refreshExecution();if(controller.signal.aborted||ticket!==epoch.current)return;if(execution.mode!=='isolated-guest')throw Error(text('executionUnavailable'));
   const result=await nativeJSON('/api/workbench/editor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'open',sessionId}),signal:controller.signal},30000);
   if(ticket!==epoch.current)return;if(result.version!==1||result.sessionId!==sessionId)throw Error('Invalid editor response');
   if(result.state!=='ready'){setError(text(result.state==='starting'?'editorStarting':'editorUnavailable')+(result.code?' ('+result.code+')':''));return;}
   const url=new URL(result.url,location.href);
   if(url.protocol!=='https:'||url.origin===location.origin||url.username||url.password||url.search)throw Error('Editor requires a separate secure origin');
   if([...editorFrames].some(([id,e])=>id!==sessionId&&e.origin===url.origin))throw Error('Editor origin is already assigned to another conversation');
   const frame=document.createElement('iframe');frame.title='Code OSS · '+sessionId;frame.referrerPolicy='no-referrer';frame.setAttribute('allow','clipboard-read; clipboard-write');frame.src=url.href;frame.className='harness-code-frame';frame.style.display='none';document.body.append(frame);
   const next={frame,origin:url.origin,launchURL:url.origin+'/',expiresAt:result.expiresAt,readOnly:result.readOnly===true};const previous=editorFrames.get(sessionId);editorFrames.set(sessionId,next);setEntry(next);previous?.frame.remove();
  }catch(e){if(ticket===epoch.current&&!controller.signal.aborted)setError(e.name==='AbortError'?text('editorUnavailable'):e.message);}finally{if(pending.current===controller)pending.current=null;if(ticket===epoch.current)setBusy(false);}
 }
 async function close(){
  if(pending.current)return;const current=entry,ticket=++epoch.current,controller=new AbortController();pending.current=controller;setBusy(true);setError('');
  try{const result=await nativeJSON('/api/workbench/editor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'close',sessionId}),signal:controller.signal});if(ticket!==epoch.current)return;if(result.version!==1||result.sessionId!==sessionId||result.state!=='closed')throw Error('Invalid editor response');if(editorFrames.get(sessionId)===current){editorFrames.delete(sessionId);current.frame.remove();setEntry(null);}setConfirm(false);}catch(e){if(ticket===epoch.current&&!controller.signal.aborted)setError(e.message);}finally{if(pending.current===controller)pending.current=null;if(ticket===epoch.current)setBusy(false);}
 }
 return h('section',{className:'harness-native-surface harness-code-editor','data-editor-session':sessionId},h('header',null,h('h3',null,'Code OSS · code-server'),h('button',{type:'button',disabled:busy||!online,onClick:()=>void open(Boolean(entry))},text(busy?'editorLoading':entry?'editorRetry':'editorOpen')),entry&&h('button',{type:'button',disabled:busy,onClick:()=>setConfirm(true)},text('editorClose'))),h('p',{className:'hc-meta'},text('editorDrafts')),entry&&h('p',{className:'hc-meta'},text('editorMobile')+' ',h('a',{href:entry.launchURL,target:'_blank',rel:'noopener noreferrer'},text('editorNewTab'))),entry?.readOnly&&h('p',{role:'status'},text('editorReadOnly')),entry?.expiresAt<=now&&h('p',{role:'status'},text('editorExpired')),!online&&h('p',{role:'status'},text('editorUnavailable')),error&&h('p',{role:'alert'},error),confirm&&h('div',{role:'group'},h('p',null,text('editorCloseHelp')),h('button',{type:'button',onClick:()=>void close(),disabled:busy},text('editorClose')),h('button',{type:'button',onClick:()=>setConfirm(false)},text('deviceCancel'))),h('div',{ref:host,className:'harness-code-host',hidden:!visible}));
}
function relativeProject(root,base){
 if(typeof root!=='string'||typeof base!=='string')return null;
 base=base.replace(/\/+$/,'');
 if(!root.startsWith(base+'/'))return null;
 const relative=root.slice(base.length+1);
 return relative&&!relative.split('/').some(p=>!p||p==='.'||p==='..')?relative:null;
}
function useLanguage(){const [language,set]=React.useState(window.HarnessI18n.language);React.useEffect(()=>{const change=()=>set(window.HarnessI18n.language);window.addEventListener('harness-language-change',change);return()=>window.removeEventListener('harness-language-change',change);},[]);return language;}

const turnUsageCopy = {
 en: {title:'Turn usage', elapsed:'Elapsed time', input:'Uncached input', read:'Cache read', write:'Cache write', output:'Output tokens', missing:'Unavailable'},
 cs: {title:'Spotřeba za tah', elapsed:'Doba běhu', input:'Necachovaný vstup', read:'Čtení cache', write:'Zápis cache', output:'Výstupní tokeny', missing:'Nedostupné'},
};
const isUsageCount = value => Number.isSafeInteger(value) && value >= 0;

function formatTurnDuration(milliseconds, locale) {
 const seconds = Math.round(milliseconds / 100) / 10;
 const hours = Math.floor(seconds / 3600);
 const minutes = Math.floor(seconds / 60) % 60;
 const format = (value, unit) => new Intl.NumberFormat(locale, {
  style:'unit', unit, unitDisplay:'short', maximumFractionDigits:1,
 }).format(value);
 return [
  hours > 0 && format(hours, 'hour'),
  (hours > 0 || minutes > 0) && format(minutes, 'minute'),
  format(seconds % 60, 'second'),
 ].filter(Boolean).join(' ');
}

function CompletedTurnUsage({ turn }) {
 const labels = turnUsageCopy[useLanguage()] ?? turnUsageCopy.en;
 const locale = window.HarnessI18n.locale;
 const start = turn.start?.time;
 const end = turn.end?.time;
 const elapsed = isUsageCount(start) && isUsageCount(end) && end >= start
  ? formatTurnDuration(end - start, locale)
  : labels.missing;
 const usage = turn.data.get('turn-tail')?.tokenUsage;
 const tokens = value => isUsageCount(value)
  ? new Intl.NumberFormat(locale).format(value)
  : labels.missing;
 const rows = [
  [labels.elapsed, elapsed],
  [labels.input, tokens(usage?.uncachedInputTokens)],
  [labels.read, tokens(usage?.cacheReadTokens)],
  [labels.write, tokens(usage?.cacheWriteTokens)],
  [labels.output, tokens(usage?.outputTokens)],
 ];
 return h('dl', {className:'harness-turn-usage', 'aria-label':labels.title},
  rows.map(([label, value]) => h('div', {key:label}, h('dt', null, label), h('dd', null, value))));
}

function apply(ctx,config={}){
 installModelAvailability(ctx);
 installResponseModel(ctx);
 registerRunActivity(ctx);
 registerPreviewResults(ctx);
 ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
  name:'conversation.chat.turnTail', id:'harness.turn-usage', order:100,
 }, CompletedTurnUsage)), 'native-workbench: completed turn usage');
 const ROOT=config.appsWorkspaceRoot||'/data/harness/workspaces';
 const views=new Set();
 const ownsCzech=!ctx.locale.getSnapshot().locales.some(row=>row.id==='cs');
 if(ownsCzech){
  ctx.effect(()=>ctx.locale.addLanguage({id:'cs',label:'Čeština',fallback:'en'}),'native-workbench: Czech language');
  ctx.effect(()=>ctx.locale.register('common','cs',{ok:'OK',cancel:'Zrušit',close:'Zavřít',copy:'Kopírovat',copied:'Zkopírováno',retry:'Zkusit znovu',loading:'Načítám…',submit:'Odeslat',next:'Další',previous:'Předchozí',skip:'Přeskočit',delete:'Smazat',edit:'Upravit',save:'Uložit',search:'Hledat',more:'Další',back:'Zpět',unknown:'Neznámý stav',none:'Žádné','workspace.defaultName':'Výchozí pracovní prostor'}),'native-workbench: Czech common dictionary');
  ctx.effect(()=>ctx.locale.register('settings.locale','cs',{'language.title':'Jazyk'}),'native-workbench: Czech language row');
  ctx.effect(()=>ctx.locale.register('settings','cs',{'general.nav':'Obecné',trigger:'Nastavení','shortcut.open':'Otevřít nastavení'}),'native-workbench: Czech settings dictionary');
 }
 ctx.effect(()=>{
  const incoming=()=>{const language=ctx.locale.getSnapshot().active;if((language==='en'||language==='cs')&&window.HarnessI18n.language!==language)window.HarnessI18n.setLanguage(language);};
  const outgoing=()=>{if(ctx.locale.getSnapshot().active!==window.HarnessI18n.language)ctx.locale.setLocale(window.HarnessI18n.language);};
  const stop=ctx.locale.subscribe(incoming);window.addEventListener('harness-language-change',outgoing);incoming();return()=>{stop();window.removeEventListener('harness-language-change',outgoing);};
 },'native-workbench: Native locale synchronization');
 ctx.effect(()=>{
  const previous=window.HarnessNativeTheme,style=document.createElement('style');
  style.dataset.plugin='@stratadashseek/native-workbench';style.dataset.pluginCss='native-workbench/theme.css';
  const nonce=document.querySelector('style[nonce],script[nonce]')?.nonce;if(nonce)style.nonce=nonce;
  style.textContent=window.HARNESS_NATIVE_THEME_CSS||'';document.head.append(style);
  // Adapt only our legacy sheets. No Native selectors or document-wide palette edits.
  window.HarnessNativeTheme={css(css,scopeId){
   const colors={'#f6f9fc':'bg-base','#172a32':'label-primary','#17243b':'label-primary','#536c75':'label-secondary','#64777e':'label-secondary','#bccad3':'border-l3','#dce5e9':'border-l3','#c5cfdf':'border-l3','#aebbd1':'border-l3','#235dd7':'state-business-primary','#176b59':'state-business-primary','#a52222':'file-diff-deleted-marker','#12202c':'bg-layer-1','#deedf4':'label-primary'};
   for(const [color,token]of Object.entries(colors))css=css.replace(new RegExp(color+'(?![0-9a-f])','gi'),'var(--dsw-alias-'+token+','+color+')');
   css=css.replace(/:\s*white(?=[;}])/g,':var(--dsw-alias-bg-layer-1,white)').replace(/font:15px(?:\/1\.5)? system-ui/g,'font:var(--dsh-content-font-size,14px)/1.5 var(--dsw-font-family,system-ui)').replace(/min-height:40px/g,'min-height:32px').replace(/ui-monospace,monospace/g,'var(--ds-font-family-code,ui-monospace)');
   if(scopeId&&typeof CSSStyleSheet==='function'){
    const sheet=new CSSStyleSheet();sheet.replaceSync(css);const scope='#'+CSS.escape(scopeId);
    const scoped=rules=>[...rules].map(rule=>{
     if(rule.selectorText){const selectors=rule.selectorText.split(',').map(selector=>selector.includes(scope)?selector:scope+' '+selector);return selectors.join(',')+'{'+rule.style.cssText+'}';}
     if(rule.cssRules)return rule.cssText.slice(0,rule.cssText.indexOf('{'))+'{'+scoped(rule.cssRules)+'}';
     return rule.cssText;
    }).join('\n');css=scoped(sheet.cssRules);
   }
   return css;
  }};
  return()=>{style.remove();if(previous)window.HarnessNativeTheme=previous;else delete window.HarnessNativeTheme;};
 },'native-workbench: scoped Native theme');
 ctx.effect(()=>{if(window.parent===window)return;let parent;try{parent=window.parent;if(!parent.HarnessI18n)return;}catch{return;}const outward=()=>{if(parent.HarnessI18n.language!==window.HarnessI18n.language)parent.HarnessI18n.setLanguage(window.HarnessI18n.language);},inward=()=>{if(window.HarnessI18n.language!==parent.HarnessI18n.language)window.HarnessI18n.setLanguage(parent.HarnessI18n.language);};window.addEventListener('harness-language-change',outward);parent.addEventListener('harness-language-change',inward);inward();return()=>{window.removeEventListener('harness-language-change',outward);parent.removeEventListener('harness-language-change',inward);};},'native-workbench: phone language');
 function Mounted({kind,sessionId,workspaceId,section,useTabInfo}){
  const ref=React.useRef(null),view=React.useRef(null),info=useTabInfo?.(),visible=React.useRef(true);
  visible.current=info?info.tab.visible:true;
  React.useEffect(()=>{const host=ref.current;
   const instance=kind==='apps'?window.HarnessApps.mount(host,{settings:section==='settings',scope:section==='settings'?'global':'project',sessionId,workspaceId,visible:()=>visible.current}):window.HarnessWorkbench.mount(host,{sessionId,workspaceId,section,instanceId:info?.tab.id});
   view.current=instance;views.add(instance);
   return()=>{views.delete(instance);instance.destroy();view.current=null;};
  },[kind,sessionId,workspaceId,section]);
  React.useEffect(()=>{if(visible.current)void view.current?.refresh();},[info?.tab.visible]);
  React.useEffect(()=>{if(info?.tab.visible)view.current?.notifyChange?.();},[info?.tab.navigation.revision]);
  React.useEffect(()=>info?.tab.actions.bindCommands({refresh:()=>{void view.current?.reload?.();}}),[info?.tab.actions]);
  return h('div',{ref,className:'harness-native-surface',style:{height:'100%',minHeight:240,minWidth:0,overflow:'auto'},'data-harness-native-view':kind});
 }
 function Files(props){return h('div',{className:'harness-model-pane'},h(ConversationModel,{sessionId:props.sessionId,key:props.sessionId}),h('div',{className:'harness-model-pane-content'},h(ExecutionPane,{...props,Host:Mounted,kind:'files',section:'files'})));}
 function Docker(props){
  const info=props.useTabInfo(),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false);useLanguage();
  const view=React.useRef(null),host=React.useRef(null),visible=React.useRef(info.tab.visible);visible.current=info.tab.visible;
  React.useEffect(()=>{const instance=window.HarnessApps.mount(host.current,{sessionId:props.sessionId,visible:()=>visible.current});view.current=instance;views.add(instance);return()=>{views.delete(instance);instance.destroy();};},[props.sessionId]);
  React.useEffect(()=>{if(info.tab.visible)void view.current?.refresh();},[info.tab.visible]);
  async function prepare(){setBusy(true);setMessage('');try{const s=await state(),relative=relativeProject(s.projects?.[props.sessionId]?.root,ROOT);if(!relative)throw Error(text('outsideRoot'));const ok=await view.current.useProject(relative);if(ok)setMessage(text('ready'));}catch(e){setMessage(e.message);}finally{setBusy(false);}}
  return h('div',{className:'harness-native-surface',style:{height:'100%',overflow:'auto',minWidth:0}},h('div',{className:'harness-native-docker-prepare'},h('button',{className:'harness-native-action',onClick:prepare,disabled:busy||!props.sessionId},text(busy?'preparing':'newDocker')),message&&h('p',{role:'status'},message)),h('div',{ref:host}));
 }
 function WorkspaceSettings(){
  const [rows,setRows]=React.useState([]),[id,setId]=React.useState(window.HarnessNativeWorkspaceSelection||''),[error,setError]=React.useState('');useLanguage();
  React.useEffect(()=>{let active=true;state().then(s=>{if(active){setRows(s.workspaces);setId(old=>old||s.workspaces[0]?.id||'');}}).catch(e=>{if(active)setError(e.message);});const select=()=>setId(window.HarnessNativeWorkspaceSelection||'');window.addEventListener('harness-workspace-settings',select);return()=>{active=false;window.removeEventListener('harness-workspace-settings',select);};},[]);
  return h('section',{className:'harness-native-surface harness-native-settings','data-harness-settings-group':'workspace'},h('label',null,text('workspace'),h('select',{value:id,onChange:e=>setId(e.target.value)},...rows.map(w=>h('option',{key:w.id,value:w.id},w.title)))),h('p',{className:'hc-meta'},text('workspaceHelp')),error&&h('p',{role:'alert'},error),id?h(Mounted,{kind:'files',section:'settings',workspaceId:id,key:id}):h('p',null,text('noWorkspace')));
 }
 function RuntimeSettings(){
  const [value,setValue]=React.useState(null),[error,setError]=React.useState('');const language=useLanguage();
  React.useEffect(()=>{let active=true;state().then(s=>{if(active)setValue(s.update||{});}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  const commit=typeof value?.appliedCommit==='string'?value.appliedCommit:null;
  const CurrentHealth=window.HarnessSettingsHealth.component(React);
  return h('section',{className:'harness-native-surface harness-native-settings','data-harness-settings-group':'advanced'},h(CurrentHealth,{language}),h('p',null,text('runtimeHelp')),error&&h('p',{role:'alert'},error),value?.bootstrapUpgradeRequired===true&&h('p',{role:'status','data-bootstrap-upgrade-required':true},text('bootstrapUpgrade')),!value?h('p',null,text('noRuntime')):h('dl',{'data-harness-update-status':true},h('dt',null,text('updates')),h('dd',null,value.enabled?String(value.phase||'unknown'):text('disabled')),h('dt',null,text('sourceCommit')),h('dd',null,commit||'—'),h('dt',null,text('verifiedSignature')),h('dd',null,text(value.signatureVerified?'verifiedSignature':'unverifiedSignature')),h('dt',null,text('lastObserved')),h('dd',null,value.checkedAt?String(value.checkedAt):'—'),value.error&&h('dd',{role:'alert'},String(value.error).slice(0,500))));
 }
 function Notifications(){
  const ref=React.useRef(null);useLanguage();
  React.useEffect(()=>{try{return window.parent.HarnessPhoneSettings?.mount(ref.current);}catch{}},[]);
  let bridge=false;try{bridge=Boolean(window.parent.HarnessPhoneSettings);}catch{}
  return h('section',{className:'harness-native-surface'},h('div',{ref},!bridge&&h('p',null,text('openPhone'))),h(Devices));
 }
 function Devices(){
  useLanguage();const [rows,setRows]=React.useState(null),[owner,setOwner]=React.useState(''),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[confirmation,setConfirmation]=React.useState(null);
  const active=React.useRef(false),requests=React.useRef(new Set()),generation=React.useRef(0),pendingAction=React.useRef(false);
  let credentials=null;try{credentials=window.parent.HarnessWakeCredentials||null;}catch{}const identity=credentials?.identity?.()||{};
  const request=React.useCallback(async(route,data)=>{
   const controller=new AbortController();requests.current.add(controller);const timer=setTimeout(()=>controller.abort(),10000);
   try{const response=await fetch('/phone/api/'+route,{method:data?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined}),result=await response.json();if(!active.current||controller.signal.aborted)throw new DOMException('View closed','AbortError');if(!response.ok)throw Object.assign(Error('Device operation failed'),{code:/^[A-Z0-9_]{1,80}$/.test(result.code||'')?result.code:'DEVICE_REQUEST_FAILED'});return result;}
   finally{clearTimeout(timer);requests.current.delete(controller);}
  },[]);
  const load=React.useCallback(async()=>{
   const ticket=++generation.current;
   try{const data=await request('devices');if(!active.current||ticket!==generation.current)return;if(data.version!==2||!Array.isArray(data.devices)||data.devices.length>50)throw Error('Invalid device list');
    setRows(data.devices.map(row=>{if(typeof row.deviceId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(row.deviceId))throw Error('Invalid device identity');return{deviceId:row.deviceId,name:typeof row.name==='string'?row.name.slice(0,80):row.deviceId,createdAt:row.createdAt,expiresAt:row.expiresAt,revokedAt:row.revokedAt};}));
    let url=null;try{url=new URL(data.ownerUrl);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.pathname!=='/'||url.searchParams.get('devices')!=='1'||[...url.searchParams.keys()].some(key=>key!=='devices'))url=null;}catch{}setOwner(url?.href||'');setError('');
   }catch(error){if(active.current&&ticket===generation.current&&error.name!=='AbortError')setError(error.code||'DEVICE_REQUEST_FAILED');}
  },[request]);
  React.useEffect(()=>{active.current=true;void load();return()=>{active.current=false;++generation.current;for(const controller of requests.current)controller.abort();};},[load]);
  async function revoke(device){
   if(pendingAction.current)return;pendingAction.current=true;setBusy(true);setError('');setNotice('');
   try{const result=await request('devices/revoke',{deviceId:device.deviceId});if(result.deviceId!==device.deviceId||!Number.isFinite(Number(result.revokedAt))||Number(result.revokedAt)<=0)throw Error('Unconfirmed revocation');
    if(credentials?.identity?.().deviceId===device.deviceId)credentials.clear();setRows(previous=>previous?.map(row=>row.deviceId===device.deviceId?{...row,revokedAt:result.revokedAt}:row));setConfirmation(null);setNotice('deviceRevokedSaved');await load();
   }catch(error){if(active.current&&error.name!=='AbortError')setError(error.code||'DEVICE_REQUEST_FAILED');}
   finally{pendingAction.current=false;if(active.current)setBusy(false);}
  }
  async function claim(){
   if(pendingAction.current||!credentials?.claimReenrollment)return;pendingAction.current=true;setBusy(true);setError('');setNotice('');
   try{await credentials.claimReenrollment();if(!active.current)return;setNotice('deviceClaimed');await load();try{void window.parent.harnessPrepare?.({retry:true});}catch{}}
   catch(error){if(active.current)setError(error.code||'DEVICE_REQUEST_FAILED');}finally{pendingAction.current=false;if(active.current)setBusy(false);}
  }
  return h('section',{className:'harness-native-devices','data-harness-settings-group':'devices'},h('h3',null,text('devices')),h('p',null,text('devicesHelp')),h('button',{type:'button',className:'harness-native-action',disabled:busy,onClick:()=>void load()},text('devicesRefresh')),error&&h('p',{role:'alert'},text('deviceFailed')+' '+error),notice&&h('p',{role:'status'},text(notice)),
   ...(rows||[]).map(device=>h('article',{key:device.deviceId,className:'harness-device-card','data-device-id':device.deviceId},h('h4',null,device.name),h('p',null,device.deviceId),h('p',null,text(device.revokedAt?'deviceRevoked':Number(device.expiresAt)<=Date.now()?'deviceExpired':'deviceActive')),h('p',null,text('deviceExpires')+': '+(Number.isFinite(Number(device.expiresAt))?new Date(Number(device.expiresAt)).toLocaleString(window.HarnessI18n.locale):'—')),h('p',null,text('deviceScope')),
    !device.revokedAt&&(confirmation===device.deviceId?h('div',{role:'group','aria-label':text('deviceConfirmHelp')},h('p',null,text('deviceConfirmHelp')),h('button',{type:'button',className:'harness-native-action',disabled:busy,onClick:()=>void revoke(device)},text('deviceConfirm')),h('button',{type:'button',className:'harness-native-action',disabled:busy,autoFocus:true,onClick:()=>setConfirmation(null)},text('deviceCancel'))):h('button',{type:'button',className:'harness-native-action',disabled:busy,onClick:()=>setConfirmation(device.deviceId)},text('deviceRevoke'))))),
   rows?.length===0&&h('p',null,text('deviceEmpty')),identity.revoked&&h('div',null,h('p',null,text('deviceClaimHelp')),h('button',{type:'button',className:'harness-native-action',disabled:busy,onClick:()=>void claim()},text('deviceClaim'))),owner&&h('p',null,h('a',{href:owner,target:'_blank',rel:'noopener noreferrer'},text('deviceOwner'))));
 }
 const register=(definition,Component)=>{
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:definition.id,inject:sessionId=>({sessionId})},Component)),'native-workbench: '+definition.kind);
  function LocalizedTitle(){useLanguage();useExecutionMode(false);return h('span',null,definition.title());}
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:definition.id},LocalizedTitle)),'native-workbench: '+definition.kind+' title');
 };
 const files={id:'stratadashseek/workspace-files',kind:'files',keepMounted:true,title:()=>text(executionView.mode==='isolated-guest'?'editor':'files'),guide:[{id:'workspace',commandId:'workspace.files',order:10,title:()=>text(executionView.mode==='isolated-guest'?'editor':'files'),description:()=>text(executionView.mode==='isolated-guest'?'editorHelp':'filesHelp')}]};
 const changes={id:'stratadashseek/changes',kind:'harness-changes',keepMounted:true,title:()=>text('changes'),guide:[{id:'changes',order:15,title:()=>text('changes'),description:()=>text('changesHelp')}]};
 const docker={id:'stratadashseek/docker',kind:'harness-docker',keepMounted:true,title:()=>text('docker'),guide:[{id:'docker',order:20,title:()=>text('docker'),description:()=>text('dockerHelp')}]};
 // A compatibility switch also lets integration tests exercise the original
 // Native explorer against the server's effective-root resolver.
 if(config.enhancedFiles!==false){ctx.effect(()=>ctx.sidebarRightTabs.register(files),'native-workbench: files type');register(files,Files);
  // In rc.2 the preview's standard folder button toggles a separate legacy
  // navigator Factory instead of opening kind=files. Route that exact control
  // through the product's pane/session target API to the same corrected browser.
  // Deliberately do not intercept generic folder buttons or infer IDs from DOM.
  ctx.effect(()=>{const folder=e=>{const element=e.target instanceof Element?e.target:null;if(!element?.closest('[data-files-navigator-toggle]'))return;const target=ctx.sidebarRight.commandTarget(element);if(!target)return;e.preventDefault();e.stopImmediatePropagation();ctx.sidebarRight.openTabFromTarget('files',target);};document.addEventListener('click',folder,true);return()=>document.removeEventListener('click',folder,true);},'native-workbench: preview folder compatibility');
 }
 ctx.effect(()=>ctx.sidebarRightTabs.register(docker),'native-workbench: Docker type');register(docker,Docker);
 ctx.effect(()=>ctx.sidebarRightTabs.register(changes),'native-workbench: Changes type');register(changes,Changes);
 // Registered guide definitions use the original SDK EntryBox, like Workspace files.
 let sections=[];
 const registerSettings=()=>{for(const dispose of sections)dispose();sections=[['harness-workspaces','workspaces',WorkspaceSettings],['harness-deployment','docker',()=>h(Mounted,{kind:'apps',section:'settings'})],['harness-notifications','notifications',Notifications],['harness-runtime','advanced',RuntimeSettings]].map(([id,label,Component],index)=>ctx.slots.register({name:'settings.section',id,order:210+index*10,label:()=>text(label)},Component));};
 ctx.effect(()=>ctx.slots.inject('settings.section',()=>{registerSettings();return()=>{for(const dispose of sections)dispose();sections=[];};}),'native-workbench: unified settings');
 // Pinned rc.2 compatibility adapter: the registered settings shell publishes a
 // root Store handle whose create() intentionally returns its existing instance.
 // No second launcher, replacement AccountMenu or alternate settings store.
 function openSettings(section){const shell=ctx.slots.entriesOfSlot('sidebar.settings')[0],actions=shell?.store?.create?.()?.actions;if(typeof actions?.openSection!=='function'||typeof actions?.open!=='function')return false;if(section)actions.openSection(section);else actions.open();return true;}
 let navigation=0;
 const openPanel=async(kind,sessionId)=>{const ticket=++navigation;if(sessionId)ctx.uiWorkspace.openSession(sessionId);const until=Date.now()+5000;while(Date.now()<until&&ticket===navigation){const mounted=ctx.sidebarRight.mounted.getSnapshot();if(mounted&&(!sessionId||mounted===sessionId)){try{ctx.sidebarRight.openTab(kind);return true;}catch(e){if(!String(e.message).includes('no session surface'))throw e;}}await new Promise(resolve=>setTimeout(resolve,50));}return false;};
 ctx.effect(()=>{const api={openSettings,openDocker:sessionId=>openPanel('harness-docker',sessionId),openFiles:sessionId=>openPanel('files',sessionId),openChanges:sessionId=>openPanel('harness-changes',sessionId)};window.HarnessNativeUI=api;try{window.parent.HarnessNativeUI=api;}catch{}return()=>{if(window.HarnessNativeUI===api)delete window.HarnessNativeUI;try{if(window.parent.HarnessNativeUI===api)delete window.parent.HarnessNativeUI;}catch{}};},'native-workbench: settings bridge');
 ctx.inject(['contextMenus'],c=>c.effect(()=>c.contextMenus.register({id:'harness.workspace-settings',target:'workspace',order:120,resolve:({workspaceId})=>[{id:'settings',label:text('workspaces'),run:()=>{window.HarnessNativeWorkspaceSelection=workspaceId;window.dispatchEvent(new Event('harness-workspace-settings'));window.HarnessNativeUI?.openSettings('harness-workspaces');}}]}),'native-workbench: workspace menu'));
 ctx.effect(()=>()=>{for(const view of views)view.destroy();views.clear();},'native-workbench: cleanup');
}
