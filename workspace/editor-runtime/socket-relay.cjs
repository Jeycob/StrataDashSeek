'use strict';
// Trusted transport only. Run in the relay's separate restricted mount namespace.
// The untrusted editor has network=none and owns only its private socket directory.
// HTTP authentication, cookies and origin policy belong to the root broker.
const net = require('node:net');
const HOST = '10.0.2.15';
const SOCKET = '/run/homeai-editor/code.sock';
const LIMITS = Object.freeze({connections:32, connectMs:5000, idleMs:120000,
  lifetimeMs:3600000, bytes:256*1024*1024, highWaterMark:64*1024, shutdownMs:5000});

function validPort(port) { return Number.isInteger(port) && port >= 1024 && port <= 65535; }
function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--port' || !/^\d{4,5}$/.test(argv[1]) || !validPort(Number(argv[1]))) {
    throw Error('RELAY_ARGUMENT_INVALID');
  }
  return Number(argv[1]);
}

// Dependency injection is for local transport/clock tests. The CLI always uses
// the frozen policy and Node's network API; no env/request can select a target.
async function startRelay(port, {network=net, limits=LIMITS}={}) {
  if (!validPort(port)) throw Error('RELAY_PORT_INVALID');
  const connections = new Set();
  let stopping=false, serverClosed=false, shutdownTimer, finishClosed;
  let closeReason='closed';
  const closed = new Promise(resolve => { finishClosed=resolve; });
  function finish() {
    if (serverClosed && connections.size === 0) {
      clearTimeout(shutdownTimer);
      finishClosed({reason:closeReason});
    }
  }
  function accept(client) {
    if (stopping || connections.size >= limits.connections) { client.destroy(); return; }
    client.pause();
    client.setNoDelay(true);
    let upstream, connectTimer, idleTimer, lifeTimer;
    let transferred=0, failed=false, clientClosed=false, upstreamClosed=false;
    const state = {destroy};
    connections.add(state);
    function destroy() {
      if (failed) return;
      failed=true;
      clearTimeout(connectTimer); clearTimeout(idleTimer); clearTimeout(lifeTimer);
      client.destroy();
      if (upstream) upstream.destroy();
      else { upstreamClosed=true; release(); }
    }
    function release() {
      if (clientClosed && upstreamClosed) {
        clearTimeout(connectTimer); clearTimeout(idleTimer); clearTimeout(lifeTimer);
        connections.delete(state);
        finish();
      }
    }
    function activity() {
      clearTimeout(idleTimer);
      idleTimer=setTimeout(destroy, limits.idleMs);
      idleTimer.unref();
    }
    function pump(source, target) {
      source.on('data', chunk => {
        if (failed) return;
        transferred += chunk.length;
        if (transferred > limits.bytes) { destroy(); return; }
        activity();
        // At most the stream high-water mark plus an incoming chunk is queued;
        // no application buffer or unbounded per-connection accumulation.
        if (!target.write(chunk)) source.pause();
      });
      target.on('drain', () => { if (!failed) source.resume(); });
      source.on('end', () => { if (!failed) target.end(); });
    }
    client.on('error', destroy);
    client.on('close', () => {
      clientClosed=true;
      if (!client.readableEnded || !client.writableFinished) destroy();
      release();
    });
    connectTimer=setTimeout(destroy, limits.connectMs); connectTimer.unref();
    lifeTimer=setTimeout(destroy, limits.lifetimeMs); lifeTimer.unref();
    try {
      upstream=network.createConnection({path:SOCKET, allowHalfOpen:true, highWaterMark:limits.highWaterMark});
      upstream.pause();
      upstream.on('error', destroy);
      upstream.on('close', () => {
        upstreamClosed=true;
        if (!upstream.readableEnded || !upstream.writableFinished) destroy();
        release();
      });
      upstream.once('connect', () => {
        clearTimeout(connectTimer);
        if (failed) return;
        pump(client, upstream); pump(upstream, client);
        activity();
        client.resume(); upstream.resume();
      });
    } catch {
      upstreamClosed=true;
      destroy();
    }
  }
  const server=network.createServer({allowHalfOpen:true, pauseOnConnect:true, highWaterMark:limits.highWaterMark}, accept);
  function stop(immediate=false) {
    if (stopping) return closed;
    stopping=true;
    server.close(() => { serverClosed=true; finish(); });
    if (connections.size) {
      if (immediate) for (const connection of connections) connection.destroy();
      else {
        shutdownTimer=setTimeout(() => { for (const connection of connections) connection.destroy(); }, limits.shutdownMs);
        shutdownTimer.unref();
      }
    }
    return closed;
  }
  server.on('error', () => { closeReason='listener-failed'; stop(true); });
  await new Promise((resolve,reject) => {
    const rejectListen=() => reject(Error('RELAY_LISTEN_FAILED'));
    server.once('error', rejectListen);
    server.listen({host:HOST, port, backlog:32, exclusive:true}, () => {
      server.off('error', rejectListen);
      resolve();
    });
  });
  return {close:() => stop(), closed, address:() => server.address(), activeConnections:() => connections.size};
}

async function main(argv=process.argv.slice(2)) {
  let relay;
  try { relay=await startRelay(parseArguments(argv)); }
  catch { process.stderr.write('RELAY_START_FAILED\n'); return 1; }
  const stop=() => { void relay.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const result=await relay.closed;
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  if (result.reason !== 'closed') { process.stderr.write('RELAY_LISTENER_FAILED\n'); return 1; }
  return 0;
}
module.exports={startRelay, parseArguments, HOST, SOCKET, LIMITS};
if (require.main === module) main().then(code => { process.exitCode=code; }, () => {
  process.stderr.write('RELAY_FAILED\n'); process.exitCode=1;
});
