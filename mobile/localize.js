'use strict';
(()=>{
 const I=window.HarnessI18n,C=window.HarnessCopy;if(!I||!C)return;
 const observed=new WeakMap();let scheduled=false;
 function apply(){scheduled=false;const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=walker.nextNode())){if(n.parentElement?.closest('script,style,textarea,pre,code,#workspace-workbench,[data-no-translate]'))continue;
   const previous=observed.get(n),original=previous&&previous.last===n.nodeValue?previous.original:n.nodeValue,last=C.translate(original,I.language);
   observed.set(n,{original,last});if(n.nodeValue!==last)n.nodeValue=last;
  }
 }
 const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(apply);}};
 new MutationObserver(schedule).observe(document.body,{subtree:true,childList:true,characterData:true});window.addEventListener('harness-language-change',schedule);apply();
})();
