'use strict';
(()=>{
 const I=window.HarnessI18n,C=window.HarnessCopy;if(!I||!C)return;
 const observed=new WeakMap();let scheduled=false,nativeObserver,nativeDocument;
 const nativePairs={'New Session':'Nová konverzace','New session':'Nová konverzace','More':'Další','Plugins':'Doplňky','Automation tasks':'Automatické úlohy','Settings':'Nastavení','Workspace files':'Soubory projektu','Search':'Hledat','Cancel':'Zrušit','Close':'Zavřít','Delete':'Smazat','Archive':'Archivovat','Rename':'Přejmenovat','Send':'Odeslat','Stop':'Zastavit'};
 function nativeLabels(){const doc=document.getElementById('harness')?.contentDocument;if(!doc?.body)return;
  if(doc!==nativeDocument){nativeObserver?.disconnect();nativeDocument=doc;nativeObserver=new MutationObserver(schedule);nativeObserver.observe(doc.body,{subtree:true,childList:true,characterData:true});}
  for(const button of doc.querySelectorAll('button,[role="menuitem"]')){const walker=doc.createTreeWalker(button,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){const previous=observed.get(n),original=previous&&previous.last===n.nodeValue?previous.original:n.nodeValue,trimmed=original.trim(),label=I.language==='cs'?(nativePairs[trimmed]||trimmed):C.translate(trimmed,'en'),last=original.replace(trimmed,label);observed.set(n,{original,last});if(n.nodeValue!==last)n.nodeValue=last;}}
 }
 function apply(){scheduled=false;const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=walker.nextNode())){if(n.parentElement?.closest('script,style,textarea,pre,code,#workspace-workbench,.apps-project h4,.apps-project p:first-of-type,#apps-containers td:first-child,[data-no-translate]'))continue;
   const previous=observed.get(n),original=previous&&previous.last===n.nodeValue?previous.original:n.nodeValue,last=C.translate(original,I.language);
   observed.set(n,{original,last});if(n.nodeValue!==last)n.nodeValue=last;
  }nativeLabels();
 }
 const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(apply);}};
 new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true});document.getElementById('harness')?.addEventListener('load',schedule);window.addEventListener('harness-language-change',schedule);apply();
})();
