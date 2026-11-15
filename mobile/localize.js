'use strict';
// Translate only explicitly keyed shell controls. Native UI copy belongs to
// its public locale registry; project names, messages and file text stay intact.
(()=>{
 const apply=()=>window.HarnessI18n?.apply(document);
 window.addEventListener('harness-language-change',apply);apply();
})();
