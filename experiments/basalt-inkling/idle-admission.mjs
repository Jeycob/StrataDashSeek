// The rc.2 transport calls dispatchRpc/openWireStream dynamically for every frame,
// including frames arriving on sockets which predate the drain.
const reads = new Set(['session/list', 'session/state', 'session/projections', 'session/page',
  'session/modelCatalog', 'workspace/list', 'terminal/list']);
const streams = new Set(['session/follow', 'session/control', 'session/observeEvent', 'session/observeState',
  'session/observeProjections', 'terminal/watch', '$events']);

export function passiveHttp(method, url) {
  const pathname = (url ?? '').split('?', 1)[0];
  if (method === 'POST') return pathname.startsWith('/api/') && reads.has(pathname.slice(5));
  if (method !== 'GET' && method !== 'HEAD') return false;
  return url === '/' || pathname === '/phone/health' || pathname === '/favicon.ico' ||
    pathname.startsWith('/assets/') || pathname.startsWith('/public/');
}

export function installAdmission(ctx, ingress) {
  if (!ingress || !ingress.intact() || ingress.initialized) throw Error('Native idle preload unavailable');
  const restorers = [];
  const intact = [];
  const patched = new WeakMap();
  let complete = true;
  function wrap(target, name, handler) {
    let holder = target;
    while (holder && holder !== Object.prototype && !Object.hasOwn(holder, name)) holder = Object.getPrototypeOf(holder);
    if (!holder || holder === Object.prototype) throw Error('Native SDK admission contract unavailable');
    const own = Object.getOwnPropertyDescriptor(holder, name);
    const original = own.value;
    if (typeof original !== 'function') throw Error('Native SDK method unavailable');
    if (!patched.has(holder)) patched.set(holder, new Set());
    if (patched.get(holder).has(name)) return;
    function wrapped(...args) { return handler(() => original.apply(this, args), args); }
    Object.defineProperty(holder, name, { ...own, value: wrapped });
    patched.get(holder).add(name);
    intact.push(() => Object.getOwnPropertyDescriptor(holder, name)?.value === wrapped);
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(holder, name)?.value === wrapped) Object.defineProperty(holder, name, own);
    });
  }
  function enter(work) {
    if (!ingress.accepting) throw Error('Native is preparing to sleep');
    if (work) ingress.revision++;
    ingress.inFlight++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      ingress.inFlight--;
      if (work) ingress.revision++;
    };
  }
  function call(next, work = true) {
    const end = enter(work);
    try {
      const value = next();
      if (value && typeof value.then === 'function') return Promise.resolve(value).finally(end);
      end();
      return value;
    } catch (error) { end(); throw error; }
  }
  async function stream(next, endpoint, payload) {
    const passive = streams.has(endpoint);
    const end = enter(!passive || (endpoint === 'session/follow' && payload?.args?.request?.activate === true));
    try {
      const source = await next();
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw Error('Unknown Native stream');
      // Even a passive follow may defer activation to the first iteration. Keep
      // opening it visible until the first publication; never consume a frame here.
      const iterator = source[Symbol.asyncIterator]();
      return {
        [Symbol.asyncIterator]() { return this; },
        async next(...args) {
          try { const item = await iterator.next(...args); if (passive || item.done) end(); return item; }
          catch (error) { end(); throw error; }
        },
        async return(...args) {
          try { return iterator.return ? await iterator.return(...args) : { done: true }; }
          finally { end(); }
        },
        async throw(error) {
          try { if (iterator.throw) return await iterator.throw(error); throw error; }
          finally { end(); }
        },
      };
    } catch (error) { end(); throw error; }
  }
  try {
    const gateway = ctx.typertGateway;
    wrap(gateway, 'dispatchRpc', async (next, [endpoint]) => {
      if (!ingress.accepting) return { ok: false, error: { code: 'gateway/service-unavailable', message: 'Native is preparing to sleep' } };
      return call(next, !reads.has(endpoint));
    });
    wrap(gateway, 'openWireStream', (next, [endpoint, payload]) => stream(next, endpoint, payload));
    wrap(gateway, 'invoke', (next, [req]) => call(next, !reads.has(req?.namespace + '/' + req?.method)));
    wrap(gateway, 'stream', (next, [req]) => stream(next, req?.namespace + '/' + req?.method, { args: req?.args }));
    for (const key of ['create', 'resume']) wrap(ctx.agents, key, next => call(next));
    wrap(ctx.jobs, 'start', next => call(next));
    wrap(ctx.tools, 'execute', next => call(next));
    // Internal timers enter the same synchronous SDK flow even without a remote RPC.
    // The existing event/revision observer covers later inbox and turn publication.
    const attached = new WeakSet();
    function attach(agent) {
      if (attached.has(agent)) return;
      for (const key of ['send', 'followup', 'steer', 'inject', 'runMaintenance']) {
        wrap(agent, key, next => call(next));
      }
      attached.add(agent);
    }
    for (const agent of ctx.agents.list()) attach(agent);
    ctx.on('agent/created', ({ agent }) => {
      try { attach(agent); }
      catch { complete = false; }
    }, { global: true, prepend: true });
  } catch (error) {
    for (const undo of restorers.reverse()) undo();
    ingress.accepting = true;
    ingress.initialized = true;
    throw error;
  }
  ingress.initialized = true;
  ingress.accepting = true;
  const admission = {
    close() {
      if (!ingress.accepting || !admission.healthy()) return false;
      ingress.accepting = false;
      if (ingress.inFlight) { ingress.accepting = true; return false; }
      return true;
    },
    reopen() { ingress.accepting = true; },
    healthy() { return complete && ingress.intact() && intact.every(check => check()); },
    open() { return ingress.accepting; },
    busy() {
      const pending = ctx.typertGateway.getPendingRemoteEvents();
      return ingress.inFlight !== 0 || !Array.isArray(pending) || pending.length !== 0;
    },
    revision() { return ingress.revision; },
  };
  ctx.effect(() => () => {
    complete = false;
    ingress.accepting = true;
    for (const undo of restorers.reverse()) undo();
  });
  return admission;
}
