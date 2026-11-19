const previewSelectionCopy = {
 en: {
  start:'Select an element', heading:'Select an element from the preview snapshot',
  loading:'Rendering the preview…', image:'Preview snapshot. Tap an element to select it.',
  route:'Application path', show:'Show page', up:'Show previous section', down:'Show next section',
  noElements:'No selectable elements in this section.',
  routeHelp:'Use a path such as /catalog/details.',
  choose:'Choose an element', empty:'Select an element', crop:'Selected element screenshot',
  attach:'Add to next message', cancel:'Close selection',
  confirming:'Checking the current preview…',
  unconfirmed:'Could not confirm the preview. Select the element again.',
  failure:'Could not capture this preview. Check that the preview is open and try again.',
  draft:'The draft changed before the selection could be attached. Try again.',
 },
 cs: {
  start:'Vybrat prvek', heading:'Vyber prvek ze snímku náhledu',
  loading:'Vykresluji náhled…', image:'Snímek náhledu. Klepnutím vyber prvek.',
  route:'Cesta v aplikaci', show:'Zobrazit stránku', up:'Zobrazit předchozí část', down:'Zobrazit další část',
  noElements:'V této části nejsou prvky k výběru.',
  routeHelp:'Zadej cestu, například /catalog/details.',
  choose:'Výběr prvku', empty:'Vyber prvek', crop:'Výřez vybraného prvku',
  attach:'Přidat k příští zprávě', cancel:'Zavřít výběr',
  confirming:'Ověřuji aktuální náhled…',
  unconfirmed:'Náhled se nepodařilo ověřit. Vyber prvek znovu.',
  failure:'Náhled se nepodařilo zachytit. Ověř, že stále běží, a zkus to znovu.',
  draft:'Rozepsaná zpráva se změnila dřív, než se podařilo přidat výběr. Zkus to znovu.',
 },
};

function imageBlob(image) {
 if (!image || typeof image.png !== 'string' || image.png.length > 1_400_000 ||
     !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 960 ||
     !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 720 ||
     !Array.isArray(image.regions) || image.regions.length > 120) {
  throw Error('PREVIEW_SNAPSHOT_INVALID');
 }
 const bytes = Uint8Array.from(atob(image.png), char => char.charCodeAt(0));
 if (bytes.length < 24 || bytes.length > 1024 * 1024 ||
     ![137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte) ||
     new DataView(bytes.buffer).getUint32(16) !== image.width ||
     new DataView(bytes.buffer).getUint32(20) !== image.height) throw Error('PREVIEW_SNAPSHOT_INVALID');
 if (!image.regions.every(region => typeof region.selector === 'string' && /^[A-Za-z0-9_#> :()-]{1,256}$/.test(region.selector) &&
     ['x','y','width','height'].every(key => Number.isSafeInteger(region[key])) &&
     region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
     region.x+region.width <= image.width && region.y+region.height <= image.height)) throw Error('PREVIEW_SNAPSHOT_INVALID');
 return new Blob([bytes], {type:'image/png'});
}

function cropPreviewElement(image, region) {
 const canvas = document.createElement('canvas');
 const scale = Math.min(1, 512 / Math.max(region.width, region.height));
 canvas.width = Math.max(1, Math.floor(region.width*scale));
 canvas.height = Math.max(1, Math.floor(region.height*scale));
 const painter = canvas.getContext('2d');
 if (!painter) return Promise.reject(Error('PREVIEW_CROP_UNAVAILABLE'));
 painter.drawImage(image,region.x,region.y,region.width,region.height,0,0,canvas.width,canvas.height);
 return new Promise((resolve,reject) => canvas.toBlob(blob => {
  if (blob && blob.size <= 1024 * 1024) resolve(blob);
  else reject(Error('PREVIEW_CROP_UNAVAILABLE'));
 },'image/png'));
}

function PreviewElementSelection({sessionId, binding, inputActions, conversation, onPreviewChanged, onSelectionStart}) {
 const labels = previewSelectionCopy[useLanguage()] ?? previewSelectionCopy.en;
 const [open,setOpen] = React.useState(false);
 const [capture,setCapture] = React.useState(null);
 const [chosen,setChosen] = React.useState(null);
 const [message,setMessage] = React.useState(null);
 const [loading,setLoading] = React.useState(false);
 const [confirming,setConfirming] = React.useState(false);
 const [routeDraft,setRouteDraft] = React.useState('/');
 const state = React.useRef({request:null, revision:0, snapshotUrl:null, cropUrl:null, position:{route:'/',scrollY:0}}).current;
 const image = React.useRef(null);

 const clear = React.useCallback(() => {
  state.request?.abort();
  state.request = null;
  ++state.revision;
  if (state.snapshotUrl) URL.revokeObjectURL(state.snapshotUrl);
  if (state.cropUrl) URL.revokeObjectURL(state.cropUrl);
  state.snapshotUrl = null;
  state.cropUrl = null;
 }, [state]);
 React.useLayoutEffect(() => clear, [clear]);

 async function show(event, {route,scrollY}) {
  if (!event.nativeEvent.isTrusted || state.request || binding.expiresAt <= Date.now()) return;
  onSelectionStart();
  clear();
  const request = new AbortController();
  state.request = request;
  setOpen(true);
  setLoading(true);
  setMessage(null);
  setCapture(null);
  setChosen(null);
  try {
   const result = await requestPreviewResult({
    operation:'snapshot', sessionId, previewId:binding.previewId, generation:binding.generation,
    layout:window.innerWidth < 640 ? 'mobile' : 'desktop', route, scrollY,
   }, request.signal);
   if (state.request !== request || Date.now() >= binding.expiresAt) return;
   if (result.previewId !== binding.previewId || result.generation !== binding.generation) throw Error('PREVIEW_BINDING_CHANGED');
   const {width,height,regions,route:renderedRoute,scrollY:actualY,maxScrollY,scrollStep} = result.image;
   if (renderedRoute !== route || !Number.isSafeInteger(actualY) || !Number.isSafeInteger(maxScrollY) ||
       !Number.isSafeInteger(scrollStep) || actualY < 0 || actualY > maxScrollY ||
       maxScrollY > 20000 || scrollStep < 1 || scrollStep > 1000) throw Error('PREVIEW_POSITION_CHANGED');
   state.snapshotUrl = URL.createObjectURL(imageBlob(result.image));
   state.position = {route,scrollY:actualY};
   setRouteDraft(route);
   setCapture({width,height,regions,route,scrollY:actualY,maxScrollY,scrollStep,url:state.snapshotUrl});
  } catch {
   if (state.request === request) setMessage('failure');
  } finally {
   if (state.request === request) {state.request = null;setLoading(false);}
  }
 }

 async function choose(index) {
  const rendered = image.current;
  const region = capture?.regions[index];
  if (state.request || !rendered || !region || !rendered.complete || !rendered.naturalWidth) return;
  const revision = ++state.revision;
  if (state.cropUrl) URL.revokeObjectURL(state.cropUrl);
  state.cropUrl = null;
  setChosen(null);
  setMessage(null);
  try {
   const blob = await cropPreviewElement(rendered, region);
   if (state.revision !== revision || Date.now() >= binding.expiresAt) return;
   state.cropUrl = URL.createObjectURL(blob);
   setChosen({index, region, blob, revision, url:state.cropUrl});
  } catch {
   if (state.revision === revision) setMessage('failure');
  }
 }

 function chooseFromImage(event) {
  if (!event.nativeEvent.isTrusted) return;
  const box = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX-box.left) * capture.width / box.width;
  const y = (event.clientY-box.top) * capture.height / box.height;
  let smallest = Infinity, index;
  capture.regions.forEach((region,i) => {
   const area = region.width * region.height;
   if (x >= region.x && x < region.x+region.width && y >= region.y && y < region.y+region.height && area <= smallest) {
    smallest = area;
    index = i;
   }
  });
  if (index !== undefined) void choose(index);
 }

 async function attach(event) {
  if (!event.nativeEvent.isTrusted || state.request || !chosen ||
      chosen.revision !== state.revision || Date.now() >= binding.expiresAt) return;
  const request = new AbortController();
  state.request = request;
  setConfirming(true);
  let current;
  try {
   current = await requestPreviewResult({operation:'status', sessionId}, request.signal);
  } catch {
   // Discard an unverified crop. The next user action starts with a new capture.
  }
  if (state.request !== request) return;
  state.request = null;
  setConfirming(false);
  if (current?.state !== 'ready' || current.previewId !== binding.previewId ||
      current.generation !== binding.generation || current.expiresAt !== binding.expiresAt ||
      Date.now() >= binding.expiresAt) {
   clear();
   setCapture(null);
   setChosen(null);
   setMessage('unconfirmed');
   if (current) onPreviewChanged(current);
   return;
  }
  const file = new File([chosen.blob],'preview-element.png',{type:'image/png'});
  const [draft] = conversation.createDrafts(sessionId,[file],false);
  if (!draft) { setMessage('draft'); return; }
  if (!inputActions.addAttachments([draft.id])) {
   conversation.releaseDraftAttachment(draft.id);
   setMessage('draft');
   return;
  }
  const [width,height] = [capture.width,capture.height];
  const details = 'Selected application element (preview snapshot): `'+chosen.region.selector+
   '` on `'+capture.route+'` at '+width+' × '+height+' px, scroll Y '+capture.scrollY+
   ' CSS px. See the attached crop.';
  if (!inputActions.insertQuote(details)) {
   inputActions.removeAttachment(draft.id);
   conversation.releaseDraftAttachment(draft.id);
   setMessage('draft');
   return;
  }
  clear();
  setOpen(false);
  setCapture(null);
  setChosen(null);
 }

 const button = (label, onClick, disabled=false) => h('button',{
  type:'button', className:'harness-native-action', onClick, disabled,
 },label);
 if (!open) return button(labels.start,event=>void show(event,state.position));
 return h('section', {'aria-label':labels.heading, 'data-preview-element-picker':sessionId},
  h('p',null,labels.heading),
  h('label',null,labels.route,' ',h('input',{
   type:'text', value:routeDraft, placeholder:'/catalog/details', maxLength:512,
   spellCheck:false, autoCapitalize:'none', disabled:loading || confirming, onChange:event=>setRouteDraft(event.target.value),
  })),
  button(labels.show,event=>void show(event,{route:routeDraft.trim(),scrollY:0}),loading || confirming || !routeDraft.trim().startsWith('/')),
  h('small',{style:{display:'block'}},labels.routeHelp),
  capture && h('p',{style:{display:'flex',flexWrap:'wrap',gap:'4px'}},
   button(labels.up,event=>void show(event,{route:capture.route,scrollY:Math.max(0,capture.scrollY-capture.scrollStep)}),confirming || capture.scrollY===0),
   button(labels.down,event=>void show(event,{route:capture.route,scrollY:Math.min(capture.maxScrollY,capture.scrollY+capture.scrollStep)}),confirming || capture.scrollY===capture.maxScrollY),
  ),
  (loading || confirming) && h('p',{role:'status'},labels[loading ? 'loading' : 'confirming']),
  capture && h('img',{
   src:capture.url, ref:image, alt:labels.image, onClick:chooseFromImage,
   'data-preview-route':capture.route, 'data-preview-scroll-y':capture.scrollY,
   style:{display:'block',width:'100%',maxWidth:capture.width+'px',height:'auto',cursor:'crosshair'},
  }),
  capture?.regions.length === 0 && h('p',{role:'status'},labels.noElements),
  capture && capture.regions.length > 0 && h('label',null,labels.choose,
   h('select',{value:chosen?.index ?? '', disabled:confirming, onChange:event => {
    if (event.nativeEvent.isTrusted && event.target.value !== '') void choose(Number(event.target.value));
   },style:{display:'block',maxWidth:'100%'}},
   h('option',{value:'',disabled:true},labels.empty),
   capture.regions.map((region,index)=>h('option',{key:index,value:index},region.selector)))),
  chosen && h('figure', {style:{margin:'8px 0'}},
   h('img',{src:chosen.url, alt:labels.crop,style:{display:'block',maxWidth:'100%',height:'auto'}}),
   h('figcaption',null,h('code',null,chosen.region.selector))),
  message && h('p',{role:'status'},labels[message]),
  chosen && button(labels.attach,event=>void attach(event),confirming),
  button(labels.cancel,()=>{clear();setOpen(false);setLoading(false);setConfirming(false);setCapture(null);setChosen(null);}),
 );
}
