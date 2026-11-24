// --import before the rc.2 web CLI opens its HTTP/1 loopback listener.
import { Server } from 'node:http';
import { passiveHttp } from './idle-admission.mjs';

const key = Symbol.for('stratadashseek.basalt.idle-ingress.v1');
if (process.env.BASALT_IDLE_BRIDGE === '1') {
  if (globalThis[key]) throw Error('Duplicate Native ingress preload');
  const state = { accepting: false, initialized: false, inFlight: 0, revision: 0 };
  const startup = performance.now();
  const original = Server.prototype.emit;
  function emit(event, ...args) {
    if (!['request', 'upgrade'].includes(event) || args[0]?.socket?.localPort !== 8787) {
      return original.call(this, event, ...args);
    }
    const [req, destination] = args;
    // A missing SDK dependency must disable automatic stopping without leaving
    // the ordinary web service permanently locked out. No hot attachment after this.
    if (!state.initialized && performance.now() - startup >= 60_000) {
      state.initialized = true;
      state.accepting = true;
    }
    if (!state.accepting) {
      if (event === 'upgrade') destination.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      else destination.writeHead(503, { 'Connection': 'close', 'Retry-After': '2' }).end();
      return true;
    }
    // Gateway owns /api RPCs; count the pre-dispatch part of all HTTP writes as well.
    // An aborted write might still be completing inside the handler. Permanently hold
    // this process generation if the response disappears without a normal finish.
    if (event === 'upgrade' && (req.url ?? '').split('?', 1)[0] !== '/api/remote.mux') {
      state.inFlight++;
      state.revision++;
      destination.once('close', () => { state.inFlight--; state.revision++; });
    }
    if (event === 'request') {
      state.inFlight++;
      const work = !passiveHttp(req.method, req.url);
      if (work) state.revision++;
      destination.once('finish', () => { state.inFlight--; if (work) state.revision++; });
      // Aborted static downloads release when the transport closes. An interrupted write is ambiguous.
      if (!work) {
        let settled = false;
        destination.prependOnceListener('finish', () => { settled = true; });
        destination.once('close', () => { if (!settled) state.inFlight--; });
      }
    }
    return original.call(this, event, ...args);
  }
  Object.defineProperty(globalThis, key, { value: state });
  Server.prototype.emit = emit;
  state.intact = () => Server.prototype.emit === emit;
}
