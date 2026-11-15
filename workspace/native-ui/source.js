const inject=['slots','sidebarRightTabs','sidebarRight','uiWorkspace'];
const h=React.createElement;
const copy={en:{docker:'Applications and Docker',workspaces:'Workspace defaults',notifications:'Notifications',newDocker:'Prepare Docker from this project',noRoot:'Open a conversation with a project inside the application workspace.',outsideRoot:'This project is outside the application workspace. Choose a project from the configured workspace.',preparing:'Preparing…',language:'Language',files:'Workspace files',filesHelp:'Browse, edit, upload and delete files in this conversation’s isolated project.',dockerHelp:'Containers, logs and releases. Reading status does not wake Docker.',openPhone:'Open the installed Harness app to configure iPhone notifications.',workspace:'Workspace',noWorkspace:'Create a workspace first.',ready:'Docker project prepared.'},cs:{docker:'Aplikace a Docker',workspaces:'Výchozí nastavení projektů',notifications:'Oznámení',newDocker:'Připravit Docker z tohoto projektu',noRoot:'Otevři konverzaci s projektem ve složce aplikací.',outsideRoot:'Projekt je mimo složku aplikací. Vyber projekt v nastaveném pracovním prostoru.',preparing:'Připravuji…',language:'Jazyk',files:'Soubory projektu',filesHelp:'Procházení, úpravy, nahrávání a mazání souborů odděleného projektu této konverzace.',dockerHelp:'Kontejnery, logy a vydání. Čtení stavu Docker neprobouzí.',openPhone:'Pro nastavení oznámení na iPhonu otevři nainstalovanou aplikaci Harness.',workspace:'Pracovní prostor',noWorkspace:'Nejprve vytvoř pracovní prostor.',ready:'Docker projektu je připravený.'}};
const text=key=>copy[window.HarnessI18n.language][key]||copy.en[key]||key;
Object.assign(copy.en,{general:'General',advanced:'Advanced runtime status',interfaceLanguage:'Interface language',generalHelp:'Applies to this browser and its installed app. Workspace task language is configured separately.',workspaceHelp:'Defaults for new conversations in the selected workspace. Existing conversations keep explicit model choices.',runtimeHelp:'Observed server state. Signing requirements, installed capacity and protected paths are read-only.',noRuntime:'Runtime status has not been observed.',updates:'Updates',disabled:'Disabled',verifiedSignature:'Signature verified',unverifiedSignature:'Signature has not been verified yet',lastObserved:'Last observed',sourceCommit:'Applied source commit'});
Object.assign(copy.cs,{general:'Obecné',advanced:'Pokročilé: stav prostředí',interfaceLanguage:'Jazyk rozhraní',generalHelp:'Platí pro tento prohlížeč a jeho nainstalovanou aplikaci. Jazyk úloh pracovního prostoru se nastavuje zvlášť.',workspaceHelp:'Výchozí hodnoty nových konverzací ve vybraném pracovním prostoru. Ruční volba modelu v existující konverzaci zůstává zachovaná.',runtimeHelp:'Pozorovaný stav serveru. Požadavky na podpis, instalovaná kapacita a chráněné cesty jsou pouze ke čtení.',noRuntime:'Stav prostředí zatím není ověřený.',updates:'Aktualizace',disabled:'Vypnuto',verifiedSignature:'Podpis ověřen',unverifiedSignature:'Podpis zatím není ověřený',lastObserved:'Poslední pozorování',sourceCommit:'Použitý commit zdrojů'});
copy.en.bootstrapUpgrade='A protected bootstrap upgrade requires an operator. The verified source release can remain active.';
copy.cs.bootstrapUpgrade='Chráněný spouštěč vyžaduje aktualizaci správcem. Ověřené vydání zdrojů může dál běžet.';
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
    const response=await fetch('/api/workbench',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'changes',sessionId,operation,args}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
    const result=await response.json();if(!response.ok)throw Error(result.error||'HTTP '+response.status);
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
function Changes(props){return h(ChangesSession,{...props,key:props.sessionId});}
async function state(){const r=await fetch('/api/workbench',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();}
function relativeProject(root,base){
 if(typeof root!=='string'||typeof base!=='string')return null;
 base=base.replace(/\/+$/,'');
 if(!root.startsWith(base+'/'))return null;
 const relative=root.slice(base.length+1);
 return relative&&!relative.split('/').some(p=>!p||p==='.'||p==='..')?relative:null;
}
function useLanguage(){const [language,set]=React.useState(window.HarnessI18n.language);React.useEffect(()=>{const change=()=>set(window.HarnessI18n.language);window.addEventListener('harness-language-change',change);return()=>window.removeEventListener('harness-language-change',change);},[]);return language;}
function translateView(root){const originals=new WeakMap();const apply=()=>{const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while((n=walk.nextNode())){if(n.parentElement?.closest('script,style,pre,code,textarea,.workspace-workbench,[data-no-translate],.apps-project h4,.apps-project p:first-of-type,td:first-child'))continue;const prior=originals.get(n),original=prior?.last===n.nodeValue?prior.original:n.nodeValue,last=window.HarnessCopy.translate(original,window.HarnessI18n.language);originals.set(n,{original,last});if(n.nodeValue!==last)n.nodeValue=last;}};let pending=false;const schedule=()=>{if(!pending){pending=true;queueMicrotask(()=>{pending=false;if(root.isConnected)apply();});}};const observer=new MutationObserver(schedule);observer.observe(root,{childList:true,subtree:true,characterData:true});window.addEventListener('harness-language-change',schedule);apply();return()=>{observer.disconnect();window.removeEventListener('harness-language-change',schedule);};}
function apply(ctx,config={}){
 const ROOT=config.appsWorkspaceRoot||'/data/harness/workspaces';
 const views=new Set();
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
   const instance=kind==='apps'?window.HarnessApps.mount(host,{settings:section==='settings',visible:()=>visible.current}):window.HarnessWorkbench.mount(host,{sessionId,workspaceId,section,instanceId:info?.tab.id});
   view.current=instance;views.add(instance);const stop=translateView(host);
   return()=>{stop();views.delete(instance);instance.destroy();view.current=null;};
  },[kind,sessionId,workspaceId,section]);
  React.useEffect(()=>{if(visible.current)void view.current?.refresh();},[info?.tab.visible]);
  React.useEffect(()=>{if(info?.tab.visible)view.current?.notifyChange?.();},[info?.tab.navigation.revision]);
  React.useEffect(()=>info?.tab.actions.bindCommands({refresh:()=>{void view.current?.reload?.();}}),[info?.tab.actions]);
  return h('div',{ref,className:'harness-native-surface',style:{height:'100%',minHeight:240,minWidth:0,overflow:'auto'},'data-harness-native-view':kind});
 }
 function Files(props){return h(Mounted,{...props,kind:'files',section:'files'});}
 function Docker(props){
  const info=props.useTabInfo(),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false);useLanguage();
  const view=React.useRef(null),host=React.useRef(null),visible=React.useRef(info.tab.visible);visible.current=info.tab.visible;
  React.useEffect(()=>{const instance=window.HarnessApps.mount(host.current,{visible:()=>visible.current});view.current=instance;views.add(instance);const stop=translateView(host.current);return()=>{stop();views.delete(instance);instance.destroy();};},[props.sessionId]);
  React.useEffect(()=>{if(info.tab.visible)void view.current?.refresh();},[info.tab.visible]);
  async function prepare(){setBusy(true);setMessage('');try{const s=await state(),relative=relativeProject(s.projects?.[props.sessionId]?.root,ROOT);if(!relative)throw Error(text('outsideRoot'));const ok=await view.current.useProject(relative);if(ok)setMessage(text('ready'));}catch(e){setMessage(e.message);}finally{setBusy(false);}}
  return h('div',{className:'harness-native-surface',style:{height:'100%',overflow:'auto',minWidth:0}},h('div',{className:'harness-native-docker-prepare'},h('button',{className:'harness-native-action',onClick:prepare,disabled:busy||!props.sessionId},text(busy?'preparing':'newDocker')),message&&h('p',{role:'status'},message)),h('div',{ref:host}));
 }
 function GeneralSettings(){
  useLanguage();return h('section',{className:'harness-native-surface harness-native-settings','data-harness-settings-group':'general'},h('label',{htmlFor:'harness-interface-language'},text('interfaceLanguage')),h('select',{id:'harness-interface-language',value:window.HarnessI18n.language,onChange:e=>window.HarnessI18n.setLanguage(e.target.value)},h('option',{value:'en'},'English'),h('option',{value:'cs'},'Čeština')),h('p',{className:'hc-meta'},text('generalHelp')));
 }
 function WorkspaceSettings(){
  const [rows,setRows]=React.useState([]),[id,setId]=React.useState(window.HarnessNativeWorkspaceSelection||''),[error,setError]=React.useState('');useLanguage();
  React.useEffect(()=>{let active=true;state().then(s=>{if(active){setRows(s.workspaces);setId(old=>old||s.workspaces[0]?.id||'');}}).catch(e=>{if(active)setError(e.message);});const select=()=>setId(window.HarnessNativeWorkspaceSelection||'');window.addEventListener('harness-workspace-settings',select);return()=>{active=false;window.removeEventListener('harness-workspace-settings',select);};},[]);
  return h('section',{className:'harness-native-surface harness-native-settings','data-harness-settings-group':'workspace'},h('label',null,text('workspace'),h('select',{value:id,onChange:e=>setId(e.target.value)},...rows.map(w=>h('option',{key:w.id,value:w.id},w.title)))),h('p',{className:'hc-meta'},text('workspaceHelp')),error&&h('p',{role:'alert'},error),id?h(Mounted,{kind:'files',section:'settings',workspaceId:id,key:id}):h('p',null,text('noWorkspace')));
 }
 function RuntimeSettings(){
  const [value,setValue]=React.useState(null),[error,setError]=React.useState('');useLanguage();
  React.useEffect(()=>{let active=true;state().then(s=>{if(active)setValue(s.update||{});}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  const commit=typeof value?.appliedCommit==='string'?value.appliedCommit:null;
  return h('section',{className:'harness-native-surface harness-native-settings','data-harness-settings-group':'advanced'},h('p',null,text('runtimeHelp')),error&&h('p',{role:'alert'},error),value?.bootstrapUpgradeRequired===true&&h('p',{role:'status','data-bootstrap-upgrade-required':true},text('bootstrapUpgrade')),!value?h('p',null,text('noRuntime')):h('dl',{'data-harness-update-status':true},h('dt',null,text('updates')),h('dd',null,value.enabled?String(value.phase||'unknown'):text('disabled')),h('dt',null,text('sourceCommit')),h('dd',null,commit||'—'),h('dt',null,text('verifiedSignature')),h('dd',null,text(value.signatureVerified?'verifiedSignature':'unverifiedSignature')),h('dt',null,text('lastObserved')),h('dd',null,value.checkedAt?String(value.checkedAt):'—'),value.error&&h('dd',{role:'alert'},String(value.error).slice(0,500))));
 }
 function Notifications(){
  const ref=React.useRef(null);useLanguage();
  React.useEffect(()=>{try{return window.parent.HarnessPhoneSettings?.mount(ref.current);}catch{}},[]);
  let bridge=false;try{bridge=Boolean(window.parent.HarnessPhoneSettings);}catch{}
  return h('section',{ref,className:'harness-native-surface'},!bridge&&h('p',null,text('openPhone')));
 }
 const register=(definition,Component)=>{
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:definition.id,inject:sessionId=>({sessionId})},Component)),'native-workbench: '+definition.kind);
  function LocalizedTitle(){useLanguage();return h('span',null,definition.title());}
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:definition.id},LocalizedTitle)),'native-workbench: '+definition.kind+' title');
 };
 const files={id:'stratadashseek/workspace-files',kind:'files',keepMounted:true,title:()=>text('files'),guide:[{id:'workspace',commandId:'workspace.files',order:10,title:()=>text('files'),description:()=>text('filesHelp')}]};
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
 const registerSettings=()=>{for(const dispose of sections)dispose();sections=[['harness-workspaces','workspaces',WorkspaceSettings],['harness-deployment','docker',()=>h(Mounted,{kind:'apps',section:'settings'})],['harness-notifications','notifications',Notifications],['harness-runtime','advanced',RuntimeSettings]].map(([id,label,Component],index)=>ctx.slots.register({name:'settings.section',id,order:210+index*10,label:text(label)},Component));};
 ctx.effect(()=>ctx.slots.inject('settings.general.item',()=>ctx.slots.register({name:'settings.general.item',id:'stratadashseek-language',order:5},GeneralSettings)),'native-workbench: General language preference');
 ctx.effect(()=>ctx.slots.inject('settings.section',()=>{registerSettings();window.addEventListener('harness-language-change',registerSettings);return()=>{window.removeEventListener('harness-language-change',registerSettings);for(const dispose of sections)dispose();sections=[];};}),'native-workbench: unified settings');
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
