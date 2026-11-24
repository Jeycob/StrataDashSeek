'use strict';

// Embedded inside the pinned workspace browser factory. Each SDK service
// instance owns its observer, including across workspace panel remounts.
function createVisibleTitleReader(sessions, page, Observer) {
  const ids = new WeakMap();
  const visible = new Set();
  const attempted = new Set();
  const active = new Set();
  let observer, stopList, scheduled = false, disposed = false;

  function schedule() {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(drain);
  }

  function drain() {
    scheduled = false;
    const list = sessions.list.getSnapshot();
    if (disposed || page.hidden || list.phase !== 'ready') return;
    for (const element of visible) {
      if (active.size >= 2) break;
      const id = ids.get(element);
      const row = list.byId[id];
      if (!row || row.blank || !row.titleNeedsRefresh || attempted.has(id) || active.has(id)) continue;
      attempted.add(id);
      active.add(id);
      // The Sessions service checks the current authenticated owner, list
      // membership, and consumes one passive exact read per generation.
      void Promise.resolve().then(() => {
        if (!disposed && !page.hidden && visible.has(element)) return sessions.refreshVisibleTitle(id);
        attempted.delete(id);
      }).catch(() => {}).finally(() => {
        active.delete(id);
        schedule();
      });
    }
  }

  function onList() {
    const list = sessions.list.getSnapshot();
    if (list.phase !== 'ready') attempted.clear();
    else for (const id of attempted) {
      if (!Object.hasOwn(list.byId, id)) attempted.delete(id);
    }
    schedule();
  }

  function watch(element, id) {
    if (disposed || !element || typeof Observer !== 'function') return;
    if (!observer) {
      observer = new Observer(entries => {
        for (const item of entries) {
          if (item.isIntersecting && item.intersectionRatio > 0 && ids.has(item.target)) visible.add(item.target);
          else visible.delete(item.target);
        }
        schedule();
      });
      stopList = sessions.list.subscribe(onList);
      page.addEventListener('visibilitychange', schedule);
    }
    ids.set(element, id);
    observer.observe(element);
    return () => {
      observer.unobserve(element);
      visible.delete(element);
      ids.delete(element);
    };
  }

  function dispose() {
    disposed = true;
    observer?.disconnect();
    stopList?.();
    page.removeEventListener('visibilitychange', schedule);
    visible.clear();
    attempted.clear();
  }
  return { watch, dispose };
}

function transform(source) {
  function replaceOnce(before, after) {
    const at = source.indexOf(before);
    if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw Error('Unsupported Native workspace title hook');
    source = source.slice(0, at) + after + source.slice(at + before.length);
  }
  const begin = 'function apply(ctx){const sessions=ctx.get(`sessions`);';
  replaceOnce(begin, `
const VisibleTitleContext = react.createContext(null);
${createVisibleTitleReader}
${begin}
const titleReader = createVisibleTitleReader(sessions, document, globalThis.IntersectionObserver);
ctx.effect(() => () => titleReader.dispose(), 'workspace: visible title reads');
function WorkspaceWithTitleReader(props) {
  return react.createElement(VisibleTitleContext.Provider, {value: titleReader}, react.createElement(WorkspaceBrowser, props));
}
`);
  // Observe the actual SDK-owned row, respecting panel clipping. The scoped
  // session access hook also releases observation when access is revoked.
  const row = 'const marquee=useTitleMarquee(titleRef);';
  replaceOnce(row, `${row}
const titleReader = react.useContext(VisibleTitleContext);
const mayReadTitle = useSessionAccess(node.id, 'session/projections');
react.useEffect(() => {
  if (titleReader && !row.blank && mayReadTitle) return titleReader.watch(rowRef.current, node.id);
}, [titleReader, row.blank, mayReadTitle, node.id]);
`);
  replaceOnce('locale:NS},WorkspaceBrowser));', 'locale:NS},WorkspaceWithTitleReader));');
  return source;
}

module.exports = { transform, createVisibleTitleReader };
