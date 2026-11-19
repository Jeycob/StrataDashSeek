const el=id=>document.getElementById(id);
let current=null;
async function api(path,options={}){const response=await fetch(`./api/${path}`,{...options,headers:{'Content-Type':'application/json'}});const value=response.status===204?null:await response.json();if(!response.ok)throw Object.assign(Error(value?.error||response.status),{status:response.status,value});return value;}
function show(note){current=note;el('title').value=note.title;el('body').value=note.body;}
async function list(){const {items}=await api(`notes?q=${encodeURIComponent(el('search').value)}`);el('list').replaceChildren();for(const note of items){const li=document.createElement('li'),button=document.createElement('button');button.textContent=note.title;button.onclick=()=>{show(note);el('status').textContent='';};li.append(button);el('list').append(li);}if(!current&&items[0])show(items[0]);}
el('search').oninput=()=>list();
el('new').onclick=async()=>{show(await api('notes',{method:'POST',body:JSON.stringify({title:'Nová',body:''})}));await list();};
el('delete').onclick=async()=>{if(!current)return;await api(`notes/${current.id}`,{method:'DELETE'});current=null;await list();};
el('save').onclick=async()=>{if(!current)return;el('status').textContent='Ukládání…';try{const saved=await api(`notes/${current.id}`,{method:'PATCH',body:JSON.stringify({title:el('title').value,body:el('body').value,baseVersion:current.version,delayMs:500})});show(saved);el('status').textContent='Uloženo';await list();}catch(error){el('status').textContent=`Chyba: ${error.message}`;}};
await list();
