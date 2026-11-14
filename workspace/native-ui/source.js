const inject=['slots','sidebarRightTabs','sidebarRight','uiWorkspace'];
const h=React.createElement;
const copy={en:{docker:'Applications and Docker',workspaces:'Workspace defaults',notifications:'Notifications',newDocker:'Prepare Docker from this project',noRoot:'Open a conversation with a project inside the application workspace.',outsideRoot:'This project is outside the application workspace. Choose a project from the configured workspace.',preparing:'Preparing…',language:'Language',files:'Workspace files',filesHelp:'Browse, edit, upload and delete files in this conversation’s isolated project.',dockerHelp:'Containers, logs and releases. Reading status does not wake Docker.',openPhone:'Open the installed Harness app to configure iPhone notifications.',workspace:'Workspace',noWorkspace:'Create a workspace first.',ready:'Docker project prepared.'},cs:{docker:'Aplikace a Docker',workspaces:'Výchozí nastavení projektů',notifications:'Oznámení',newDocker:'Připravit Docker z tohoto projektu',noRoot:'Otevři konverzaci s projektem ve složce aplikací.',outsideRoot:'Projekt je mimo složku aplikací. Vyber projekt v nastaveném pracovním prostoru.',preparing:'Připravuji…',language:'Jazyk',files:'Soubory projektu',filesHelp:'Procházení, úpravy, nahrávání a mazání souborů odděleného projektu této konverzace.',dockerHelp:'Kontejnery, logy a vydání. Čtení stavu Docker neprobouzí.',openPhone:'Pro nastavení oznámení na iPhonu otevři nainstalovanou aplikaci Harness.',workspace:'Pracovní prostor',noWorkspace:'Nejprve vytvoř pracovní prostor.',ready:'Docker projektu je připravený.'}};
const text=key=>copy[window.HarnessI18n.language][key]||copy.en[key]||key;
async function state(){const r=await fetch('/api/workbench',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();}
function relativeProject(root,base){
 if(typeof root!=='string'||typeof base!=='string')return null;
 base=base.replace(/\/+$/,'');
 if(!root.startsWith(base+'/'))return null;
 const relative=root.slice(base.length+1);
 return relative&&!relative.split('/').some(p=>!p||p==='.'||p==='..')?relative:null;
}
function useLanguage(){const [language,set]=React.useState(window.HarnessI18n.language);React.useEffect(()=>{const change=()=>set(window.HarnessI18n.language);window.addEventListener('harness-language-change',change);return()=>window.removeEventListener('harness-language-change',change);},[]);return language;}
function translateView(root){const originals=new WeakMap();const apply=()=>{const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while((n=walk.nextNode())){if(n.parentElement?.closest('pre,code,textarea,[data-no-translate],.apps-project h4,.apps-project p:first-of-type'))continue;const prior=originals.get(n),original=prior?.last===n.nodeValue?prior.original:n.nodeValue,last=window.HarnessCopy.translate(original,window.HarnessI18n.language);originals.set(n,{original,last});if(n.nodeValue!==last)n.nodeValue=last;}};let pending=false;const schedule=()=>{if(!pending){pending=true;queueMicrotask(()=>{pending=false;if(root.isConnected)apply();});}};const observer=new MutationObserver(schedule);observer.observe(root,{childList:true,subtree:true,characterData:true});window.addEventListener('harness-language-change',schedule);apply();return()=>{observer.disconnect();window.removeEventListener('harness-language-change',schedule);};}
function apply(ctx,config={}){
 const ROOT=config.appsWorkspaceRoot||'/data/harness/workspaces';
 const views=new Set();
 function Mounted({kind,sessionId,workspaceId,section,useTabInfo}){
  const ref=React.useRef(null),view=React.useRef(null),info=useTabInfo?.(),visible=React.useRef(true);
  visible.current=info?info.tab.visible:true;
  React.useEffect(()=>{const host=ref.current;
   const instance=kind==='apps'?window.HarnessApps.mount(host,{settings:section==='settings',visible:()=>visible.current}):window.HarnessWorkbench.mount(host,{sessionId,workspaceId,section,instanceId:info?.tab.id});
   view.current=instance;views.add(instance);const stop=translateView(host);
   return()=>{stop();views.delete(instance);instance.destroy();view.current=null;};
  },[kind,sessionId,workspaceId,section]);
  React.useEffect(()=>{if(visible.current)void view.current?.refresh();},[info?.tab.visible]);
  return h('div',{ref,style:{height:'100%',minHeight:240,minWidth:0,overflow:'auto'},'data-harness-native-view':kind});
 }
 function Files(props){return h(Mounted,{...props,kind:'files',section:'files'});}
 function DockerGuide(props){
  const {tab}=props.useTabInfo(),[summary,setSummary]=React.useState(null);useLanguage();
  React.useEffect(()=>{if(!tab.visible)return;let alive=true;const read=async()=>{if(document.hidden)return;try{const r=await fetch('/phone/api/apps/state',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(6000)});if(r.ok&&alive)setSummary(await r.json());}catch{}};void read();const timer=setInterval(read,15000);return()=>{alive=false;clearInterval(timer);};},[tab.visible]);
  return h('section',{style:{padding:16,border:'1px solid #ccd6de',borderRadius:12}},h('strong',null,text('docker')),h('p',null,text('dockerHelp')),summary&&h('ul',null,...(summary.containers||[]).filter(c=>c.state==='running').slice(0,4).map(c=>h('li',{key:c.id},c.name))),h('button',{onClick:()=>tab.actions.openTab('harness-docker'),style:{padding:10,cursor:'pointer'}},text('docker')));
 }
 function Docker(props){
  const info=props.useTabInfo(),[message,setMessage]=React.useState(''),[busy,setBusy]=React.useState(false);useLanguage();
  const view=React.useRef(null),host=React.useRef(null),visible=React.useRef(info.tab.visible);visible.current=info.tab.visible;
  React.useEffect(()=>{const instance=window.HarnessApps.mount(host.current,{visible:()=>visible.current});view.current=instance;views.add(instance);const stop=translateView(host.current);return()=>{stop();views.delete(instance);instance.destroy();};},[props.sessionId]);
  React.useEffect(()=>{if(info.tab.visible)void view.current?.refresh();},[info.tab.visible]);
  async function prepare(){setBusy(true);setMessage('');try{const s=await state(),relative=relativeProject(s.projects?.[props.sessionId]?.root,ROOT);if(!relative)throw Error(text('outsideRoot'));const ok=await view.current.useProject(relative);if(ok)setMessage(text('ready'));}catch(e){setMessage(e.message);}finally{setBusy(false);}}
  return h('div',{style:{height:'100%',overflow:'auto',minWidth:0}},h('div',{style:{padding:'12px 16px'}},h('button',{onClick:prepare,disabled:busy||!props.sessionId,style:{padding:10,cursor:'pointer',width:'100%',whiteSpace:'normal',border:'1px solid #c5cfdf',borderRadius:9,background:'white'}},text(busy?'preparing':'newDocker')),message&&h('p',{role:'status'},message)),h('div',{ref:host}));
 }
 function WorkspaceSettings(){
  const [rows,setRows]=React.useState([]),[id,setId]=React.useState(window.HarnessNativeWorkspaceSelection||''),[error,setError]=React.useState('');useLanguage();
  React.useEffect(()=>{let active=true;state().then(s=>{if(active){setRows(s.workspaces);setId(old=>old||s.workspaces[0]?.id||'');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  return h('section',null,h('label',null,text('language'),' ',h('select',{value:window.HarnessI18n.language,onChange:e=>window.HarnessI18n.setLanguage(e.target.value)},h('option',{value:'en'},'English'),h('option',{value:'cs'},'Čeština'))),h('p',null,text('workspace'),' ',h('select',{value:id,onChange:e=>setId(e.target.value)},...rows.map(w=>h('option',{key:w.id,value:w.id},w.title)))),error&&h('p',{role:'alert'},error),id?h(Mounted,{kind:'files',section:'settings',workspaceId:id,key:id}):h('p',null,text('noWorkspace')));
 }
 function Notifications(){
  const ref=React.useRef(null);useLanguage();
  React.useEffect(()=>{try{return window.parent.HarnessPhoneSettings?.mount(ref.current);}catch{}},[]);
  let bridge=false;try{bridge=Boolean(window.parent.HarnessPhoneSettings);}catch{}
  return h('section',{ref},!bridge&&h('p',null,text('openPhone')));
 }
 const register=(definition,Component)=>ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:definition.id,inject:sessionId=>({sessionId})},Component)),'native-workbench: '+definition.kind);
 const files={id:'stratadashseek/workspace-files',kind:'files',keepMounted:true,title:()=>text('files'),guide:[{id:'workspace',commandId:'workspace.files',order:10,title:()=>text('files'),description:()=>text('filesHelp')}]};
 const docker={id:'stratadashseek/docker',kind:'harness-docker',keepMounted:true,title:()=>text('docker'),guide:[{id:'docker',order:20,title:()=>text('docker'),description:()=>text('dockerHelp')}]};
 ctx.effect(()=>ctx.sidebarRightTabs.register(files),'native-workbench: files type');register(files,Files);
 ctx.effect(()=>ctx.sidebarRightTabs.register(docker),'native-workbench: Docker type');register(docker,Docker);
 ctx.effect(()=>ctx.slots.inject('sidebar.right.tab.guide.entry',()=>ctx.slots.register({name:'sidebar.right.tab.guide.entry',key:docker.id},DockerGuide)),'native-workbench: Docker overview');
 let sections=[];
 const registerSettings=()=>{for(const dispose of sections)dispose();sections=[['harness-workspaces','workspaces',WorkspaceSettings],['harness-deployment','docker',()=>h(Mounted,{kind:'apps',section:'settings'})],['harness-notifications','notifications',Notifications]].map(([id,label,Component],index)=>ctx.slots.register({name:'settings.section',id,order:210+index*10,label:text(label)},Component));};
 ctx.effect(()=>ctx.slots.inject('settings.section',()=>{registerSettings();window.addEventListener('harness-language-change',registerSettings);return()=>{window.removeEventListener('harness-language-change',registerSettings);for(const dispose of sections)dispose();sections=[];};}),'native-workbench: unified settings');
 // Pinned rc.2 compatibility adapter: the registered settings shell publishes a
 // root Store handle whose create() intentionally returns its existing instance.
 // No second launcher, replacement AccountMenu or alternate settings store.
 function openSettings(section){const shell=ctx.slots.entriesOfSlot('sidebar.settings')[0],actions=shell?.store?.create?.()?.actions;if(typeof actions?.openSection!=='function'||typeof actions?.open!=='function')return false;if(section)actions.openSection(section);else actions.open();return true;}
 let navigation=0;
 const openPanel=async(kind,sessionId)=>{const ticket=++navigation;if(sessionId)ctx.uiWorkspace.openSession(sessionId);const until=Date.now()+5000;while(Date.now()<until&&ticket===navigation){const mounted=ctx.sidebarRight.mounted.getSnapshot();if(mounted&&(!sessionId||mounted===sessionId)){try{ctx.sidebarRight.openTab(kind);return true;}catch(e){if(!String(e.message).includes('no session surface'))throw e;}}await new Promise(resolve=>setTimeout(resolve,50));}return false;};
 ctx.effect(()=>{const api={openSettings,openDocker:sessionId=>openPanel('harness-docker',sessionId),openFiles:sessionId=>openPanel('files',sessionId)};window.HarnessNativeUI=api;try{window.parent.HarnessNativeUI=api;}catch{}return()=>{if(window.HarnessNativeUI===api)delete window.HarnessNativeUI;try{if(window.parent.HarnessNativeUI===api)delete window.parent.HarnessNativeUI;}catch{}};},'native-workbench: settings bridge');
 ctx.inject(['contextMenus'],c=>c.effect(()=>c.contextMenus.register({id:'harness.workspace-settings',target:'workspace',order:120,resolve:({workspaceId})=>[{id:'settings',label:text('workspaces'),run:()=>{window.HarnessNativeWorkspaceSelection=workspaceId;window.HarnessNativeUI?.openSettings('harness-workspaces');}}]}),'native-workbench: workspace menu'));
 ctx.effect(()=>()=>{for(const view of views)view.destroy();views.clear();},'native-workbench: cleanup');
}
