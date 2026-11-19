const copy = {
 en: { title:'Undo a task', help:'Review only the changes recorded for one request. Unrelated files and later edits are kept.', empty:'No recorded tasks yet. Only new requests with complete before/after snapshots can be undone.', task:'Task', review:'Review task changes', active:'Still working', unavailable:'Snapshot unavailable', preview:'Review task undo', writes:'Files to restore', deletes:'Files created by this task to remove', conflicts:'Later edits — will be kept', unsupported:'Files outside the snapshot limits — will be kept', already:'Already reverted', acknowledge:'Keep later edits and undo only the nonconflicting files', apply:'Undo these changes', cancel:'Cancel', done:'Task changes undone. Later and unrelated edits were preserved.', partial:'Safe task changes undone. Conflicting and unsupported files were kept.', error:'Task undo could not be confirmed. Refresh the preview before retrying.', loading:'Loading task history…' },
 cs: { title:'Vrátit změny úkolu', help:'Zkontroluj pouze změny zaznamenané pro jedno zadání. Nesouvisející soubory a pozdější úpravy zůstanou.', empty:'Zatím nejsou zaznamenané úkoly. Vrátit lze nová zadání s úplnou verzí před a po úpravách.', task:'Úkol', review:'Zkontrolovat změny úkolu', active:'Práce ještě běží', unavailable:'Uložená verze není dostupná', preview:'Kontrola vrácení úkolu', writes:'Soubory k obnovení', deletes:'Soubory vytvořené úkolem ke smazání', conflicts:'Pozdější úpravy — zůstanou zachované', unsupported:'Soubory mimo limity uložené verze — zůstanou', already:'Již vrácené změny', acknowledge:'Ponechat pozdější úpravy a vrátit pouze nekonfliktní soubory', apply:'Vrátit tyto změny', cancel:'Zrušit', done:'Změny úkolu vráceny. Pozdější a nesouvisející úpravy zůstaly zachované.', partial:'Bezpečné změny úkolu vráceny. Konfliktní a nepodporované soubory zůstaly.', error:'Vrácení změn není potvrzené. Před opakováním obnov náhled.', loading:'Načítám historii úkolů…' },
};
const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
export async function mountTaskUndo(host, { sessionId, api, language = 'en', valid = () => true, afterApply = () => {} }) {
 const t = key => (copy[language] ?? copy.en)[key], alive = () => valid() && host.isConnected;
 let busy = false;
 host.dataset.taskUndo = 'true'; host.append(node('h3',t('title')),node('p',t('help')));
 const content = node('div',t('loading')), status = node('p'); status.setAttribute('role','status'); host.append(content,status);
 const button = (text, action) => { const value=node('button',text);value.type='button';value.addEventListener('click',action);return value; };
 async function review(task) {
  if (busy || !alive()) return; busy=true; status.textContent='';
  try {
   const preview=await api({op:'task-undo-preview',sessionId,taskId:task.id});if(!alive())return;
   if(preview.task?.id!==task.id||!preview.taskUndo||typeof preview.sourceHash!=='string')throw Error(t('error'));
   const dialog=node('dialog');dialog.dataset.taskUndoPreview='true';dialog.style.maxWidth='min(42rem,90vw)';dialog.style.overflowWrap='anywhere';
   const title=node('h3',t('preview'));dialog.setAttribute('aria-label',t('preview'));dialog.append(title,node('p',t('help')));
   for(const [key,paths] of [['writes',preview.writes],['deletes',preview.deletes],['conflicts',preview.taskUndo.conflicts],['unsupported',preview.taskUndo.unsupported],['already',preview.taskUndo.alreadyReverted]])if(paths?.length){dialog.append(node('h4',t(key)+' ('+paths.length+')'));const list=node('ul');for(const path of paths)list.append(node('li',path));dialog.append(list);}
   const conflicts=preview.taskUndo.conflicts.length>0,ack=node('input');ack.type='checkbox';
   if(conflicts){const label=node('label');label.append(ack,document.createTextNode(t('acknowledge')));dialog.append(label);}
   const error=node('p');error.setAttribute('role','alert');dialog.append(error);
   const choice=await new Promise(resolve=>{
    const apply=button(t('apply'),()=>{if(alive()){dialog.close();resolve(true);}else{dialog.close();resolve(false);}}),cancel=button(t('cancel'),()=>{dialog.close();resolve(false);});
    const eligible=()=>{apply.disabled=!(preview.writes.length+preview.deletes.length)||preview.protectedFiles.length>0||conflicts&&!ack.checked;};eligible();ack.addEventListener('change',eligible);
    dialog.addEventListener('cancel',()=>resolve(false),{once:true});dialog.append(cancel,apply);document.body.append(dialog);dialog.showModal();cancel.focus();
   });dialog.remove();if(!choice||!alive())return;
   const result=await api({op:'task-undo-apply',sessionId,taskId:task.id,expectedSourceHash:preview.sourceHash,skipConflicts:conflicts&&ack.checked});if(!alive())return;
   if(result.restored!==true||result.recovery?.status!=='committed'||result.recovery?.pending)throw Error(t('error'));
   const message=t(result.preservedConflicts?.length||result.unsupported?.length?'partial':'done');status.textContent=message;await afterApply(message);
  }catch(error){if(alive())status.textContent=error.message||t('error');}finally{busy=false;}
 }
 try {
  const result=await api({op:'task-undo-list',sessionId});if(!alive())return;
  if(result.version!==1||!Array.isArray(result.tasks))throw Error(t('error'));content.replaceChildren();
  if(!result.tasks.length)content.append(node('p',t('empty')));
  for(const task of result.tasks){const row=node('div');row.className='wb-row';row.append(node('span',t('task')+' '+task.turn+' · '+new Date(task.startedAt).toLocaleString(language)));if(task.status==='ready')row.append(button(t('review'),()=>void review(task)));else row.append(node('span',t(task.status==='active'?'active':'unavailable')));content.append(row);}
 }catch(error){if(alive()){content.replaceChildren();status.textContent=error.message||t('error');}}
}
