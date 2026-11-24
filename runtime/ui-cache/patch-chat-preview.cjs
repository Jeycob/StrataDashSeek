'use strict';

// These functions are embedded inside the pinned SDK module factory by transform().
function createChatPreviewCache(ctx) {
  const access = globalThis.__HOMEAI_CHAT_CACHE_ACCESS__;
  const generation = ctx.get('connection').generation;
  const list = ctx.sessions.list;
  const entries = new Map();
  const listeners = new Set();
  const maxSessions = 16;
  const ttl = 12 * 60 * 60 * 1000;
  let scope = null;
  let memoryScope = null;
  let epoch = 0;
  let disposed = false;
  let suspended = false;
  let pendingWrite = Promise.resolve();

  function listed(id) {
    const state = list.getSnapshot();
    return state.phase === 'ready' && state.byId[id]?.blank === false && state.ids.includes(id);
  }

  function publish() {
    for (const listener of listeners) listener();
  }

  function persist() {
    const expected = scope;
    const values = [...entries.entries()];
    pendingWrite = pendingWrite.then(async () => {
      if (!expected || expected !== scope) return;
      if (values.length) await access.write(expected, 'previews', values);
      else await access.clear(expected, 'previews');
    }).catch(() => {});
  }

  function forget(id) {
    if (entries.delete(id)) {
      persist();
      publish();
    }
  }

  function valid(entry) {
    const age = Date.now() - entry?.time;
    return Number.isFinite(age) && age >= 0 && age < ttl && Array.isArray(entry.rows)
      && entry.rows.length > 0 && entry.rows.length <= 4
      && entry.rows.every(row => row && (row.role === 'user' || row.role === 'assistant')
        && typeof row.text === 'string' && row.text.length > 0 && row.text.length <= 240);
  }

  async function authorize() {
    const revision = ++epoch;
    const current = generation.getSnapshot();
    scope = null;
    publish();
    if (disposed || suspended || !current || !access) return;
    try {
      const verified = await access.scope(current);
      if (revision !== epoch) return;
      if (!verified || verified !== memoryScope) entries.clear();
      if (!verified) { memoryScope = null; return; }
      const saved = verified === memoryScope ? null : await access.read(verified, 'previews');
      if (revision !== epoch || generation.getSnapshot() !== current) return;
      if (Array.isArray(saved)) {
        for (const item of saved.slice(-maxSessions)) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [id, entry] = item;
          if (typeof id === 'string' && id.length <= 256 && valid(entry)) entries.set(id, entry);
        }
      }
      scope = verified;
      memoryScope = verified;
      prune();
    } catch {
      // Cache availability never determines whether the SDK opens a conversation.
    }
  }

  function prune() {
    if (!scope) return;
    const ready = list.getSnapshot().phase === 'ready';
    let changed = false;
    for (const [id, entry] of entries) {
      if (!valid(entry) || (ready && !listed(id))) {
        entries.delete(id);
        changed = true;
      }
    }
    if (changed) persist();
    publish();
  }

  function pageHide() {
    suspended = true;
    entries.clear();
    memoryScope = null;
    void authorize();
  }

  function pageShow(event) {
    if (event.persisted) {
      suspended = false;
      void authorize();
    }
  }

  ctx.effect(() => {
    const offGeneration = generation.subscribe(authorize);
    const offList = list.subscribe(prune);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    void authorize();
    return () => {
      disposed = true;
      entries.clear();
      memoryScope = null;
      offGeneration();
      offList();
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      void authorize();
      listeners.clear();
    };
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    scope: () => scope,
    read(id) {
      const entry = entries.get(id);
      return scope && entry && valid(entry) && listed(id) ? entry.rows : null;
    },
    remember(id, rows, expectedScope) {
      if (!expectedScope || scope !== expectedScope || !listed(id)) return;
      if (rows.length === 0) { forget(id); return; }
      const previous = entries.get(id);
      if (previous && previous.rows.length === rows.length && rows.every((row, index) =>
        row.text === previous.rows[index].text && row.role === previous.rows[index].role)) return;
      entries.delete(id);
      entries.set(id, {time: Date.now(), rows});
      if (entries.size > maxSessions) entries.delete(entries.keys().next().value);
      persist();
      publish();
    },
    forget,
  };
}

// Copy drawn prose only. The rendered user-text factory can replace a credential
// with a chip, so never read the raw source or a temporarily revealed secret.
function collectChatPreview(column) {
  const rows = [];
  const seen = new Set();
  const seats = column.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"], [data-chat-flow-kind="assistant-step"]');
  for (let index = seats.length - 1; index >= Math.max(0, seats.length - 64) && rows.length < 4; index--) {
    const seat = seats[index];
    const key = seat.dataset.chatNodeKey;
    if (seen.has(key) || seat.closest('[hidden], [aria-hidden="true"], [data-turn-process-hidden]')) continue;
    const assistant = seat.dataset.chatFlowKind === 'assistant-step';
    const candidates = assistant
      ? seat.querySelectorAll('[data-text-interaction-source] :is(p,li,h1,h2,h3,h4,h5,h6)')
      : seat.querySelectorAll('[data-message-bubble] > span:first-child');
    const pieces = [];
    let length = 0;
    for (const element of candidates) {
      if (pieces.length >= 3 || length >= 240) break;
      if (element.closest('[data-variant="think"], [data-chat-group-part="reasoning"], pre, table, details, [hidden], [aria-hidden="true"]')
        || element.querySelector('[data-secret],button,img,svg,pre,table,details,[hidden],[aria-hidden="true"]')
        || (!element.getClientRects().length && getComputedStyle(element).display !== 'contents')) continue;
      // Bound traversal even when one paragraph or one user turn contains a large log.
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = '';
      for (let count = 0, next; count < 32 && text.length < 240 && (next = walker.nextNode()); count++) {
        text += next.nodeValue.slice(0, 240 - text.length);
      }
      const part = text.trim().split(/\r?\n/u, 3).join('\n').trim();
      if (part) { pieces.push(part); length += part.length; }
    }
    const text = pieces.join('\n').split('\n', 3).join('\n').slice(0, 240);
    if (text) {
      rows.unshift({role: assistant ? 'assistant' : 'user', text});
      seen.add(key);
    }
  }
  return rows;
}

function useChatPreview(cache, id, state, unavailable, orderLength, columnRef) {
  const scope = react.useSyncExternalStore(cache.subscribe, cache.scope);
  const rows = react.useSyncExternalStore(cache.subscribe, () => cache.read(id));
  react.useLayoutEffect(() => {
    if (unavailable || state === 'error') { cache.forget(id); return; }
    const column = columnRef.current;
    if (!scope || state !== 'open' || !column) return;
    let timer;
    function capture() {
      timer = undefined;
      if (column.isConnected && !column.closest('[hidden]')) cache.remember(id, collectChatPreview(column), scope);
    }
    capture();
    const observer = new MutationObserver(() => {
      if (timer === undefined) timer = setTimeout(capture, 300);
    });
    observer.observe(column, {subtree: true, childList: true, characterData: true});
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [cache, scope, id, state, unavailable, columnRef]);
  return !unavailable && !orderLength && (state === 'cold' || state === 'loading') ? rows : null;
}

function DelayedHistoryHint({label}) {
  const [visible, setVisible] = react.useState(false);
  react.useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return visible ? react_jsx_runtime.jsx('div', {className: ChatView_module_css_default.hint, children: label}) : null;
}

function renderChatPreview(rows, loading) {
  const jsx = react_jsx_runtime.jsx;
  return jsx('div', {'data-homeai-chat-preview': '', children: [
    jsx('div', {className: ChatView_module_css_default.hint, children: loading}, 'loading'),
    ...rows.map((row, index) => jsx('p', {
      'data-preview-role': row.role,
      style: {whiteSpace: 'pre-line', overflowWrap: 'anywhere', textAlign: row.role === 'user' ? 'end' : 'start'},
      children: row.text,
    }, index)),
  ]});
}

function transform(source) {
  const additions = [createChatPreviewCache, collectChatPreview, useChatPreview, renderChatPreview, DelayedHistoryHint].join('\n');
  const edits = [
    ['function ChatView({useSession,', additions + '\nfunction ChatView({chatPreview,useAccess,useSession,'],
    ['const connectionState=ctx.get(`connection`).state;', 'const chatPreview=createChatPreviewCache(ctx);const connectionState=ctx.get(`connection`).state;'],
    ['chatScroll:{save:position=>', 'chatPreview,chatScroll:{save:position=>'],
    ['const interactionSurfaceRef=(0,react.useRef)(null);', 'const removed=useSession(s=>s.removed);const canFollow=useAccess("session/follow");const previewRows=useChatPreview(chatPreview,sessionId,openState,removed||canFollow!==true,order.length,scroll.columnRef);const interactionSurfaceRef=(0,react.useRef)(null);'],
    ['children:[openState===`loading`&&(0,react_jsx_runtime.jsx)(`div`,{className:ChatView_module_css_default.hint,children:t(`chat.loadingHistory`)})', 'children:[previewRows?renderChatPreview(previewRows,t(`chat.loadingHistory`)):openState===`loading`&&react_jsx_runtime.jsx(DelayedHistoryHint,{label:t(`chat.loadingHistory`)},sessionId)'],
  ];
  for (const [needle, replacement] of edits) {
    if (source.split(needle).length !== 2) throw Error('Pinned Native ChatView layout changed');
    source = source.replace(needle, () => replacement);
  }
  return source;
}

module.exports = {transform, createChatPreviewCache, collectChatPreview};
