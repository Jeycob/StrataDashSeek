'use strict';
// Trusted, generation-scoped UNIX capability. No TCP listener, TLS termination,
// credentials, redirects, project filesystem access or arbitrary destination
// ports. DNS is resolved once and the exact checked IPv4 is passed to connect.
const net = require('node:net'), dns = require('node:dns/promises'), fs = require('node:fs');
const SOCKET = '/run/homeai-egress/proxy.sock';
const limits = Object.freeze({ connections: 32, headerBytes: 8192, connectMs: 5000, idleMs: 30000, lifetimeMs: 600000, bytes: 256 * 1024 * 1024 });
function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number), value = ((octets[0]*16777216)+(octets[1]*65536)+(octets[2]*256)+octets[3]) >>> 0;
  const ranges = [[0,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc0586300,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]];
  return !ranges.some(([base,bits]) => (value >>> (32-bits)) === (base >>> (32-bits)));
}
function authority(header) {
  if (!Buffer.isBuffer(header) || header.length > limits.headerBytes || header.some(byte => byte !== 13 && byte !== 10 && (byte < 32 || byte > 126))) throw Error('EGRESS_REQUEST_REFUSED');
  const lines = header.toString('ascii').split('\r\n'), match = /^CONNECT ([A-Za-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(lines.shift());
  if (!match || lines.at(-1) !== '' || lines.at(-2) !== '' || lines.slice(0,-2).some(line => !/^[A-Za-z0-9-]+: [\x20-\x7e]*$/.test(line) || /^Proxy-Authorization:/i.test(line))) throw Error('EGRESS_REQUEST_REFUSED');
  const hostname = match[1].toLowerCase(), labels = hostname.split('.');
  // No numeric, octal, hex, IPv6, mapped IPv6, zone-id or encoded authorities.
  if (hostname.length > 253 || labels.length < 2 || !/[a-z]/.test(hostname) || net.isIP(hostname) || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || ['localhost','local','internal','invalid','test','example'].includes(labels.at(-1)) || /^0x[0-9a-f]+(?:\.|$)/.test(hostname)) throw Error('EGRESS_REQUEST_REFUSED');
  return hostname;
}
async function resolvePublic(hostname, lookup = dns.lookup) {
  const addresses = await lookup(hostname,{family:4,all:true,verbatim:true});
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 16 || addresses.some(item => item?.family !== 4 || !publicIPv4(item.address))) throw Error('EGRESS_DESTINATION_REFUSED');
  return addresses[0].address;
}
function createProxy({ lookup = dns.lookup, connect = options => net.createConnection(options), policy = limits } = {}) {
  const active = new Set(); let closing = false, resolving = 0, transferred = 0, closeTask;
  function close() {
    if (closeTask) return closeTask;
    closing = true; for (const entry of [...active]) entry.finish();
    return closeTask = new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));
  }
  const server = net.createServer({allowHalfOpen:true,highWaterMark:65536}, client => {
    if (closing || active.size >= policy.connections) { client.destroy(); return; }
    const entry={client,upstream:null};active.add(entry);let header=Buffer.alloc(0),admitted=false,tunneled=false,settled=false,total=0;
    const finish=()=>{if(settled)return;settled=true;clearTimeout(connectTimer);clearTimeout(lifetime);client.destroy();entry.upstream?.destroy();active.delete(entry);};
    entry.finish=finish;
    const count=chunk=>{total+=chunk.length;transferred+=chunk.length;if(total>policy.bytes||transferred>policy.bytes)void close();};
    const lifetime=setTimeout(finish,policy.lifetimeMs);lifetime.unref();
    const connectTimer=setTimeout(finish,policy.connectMs);connectTimer.unref();
    client.setTimeout(policy.idleMs,finish);client.on('error',finish);client.on('close',finish);
    client.on('data',count);
    const refuse=()=>{if(!client.destroyed)client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');finish();};
    const receive=async chunk=>{
      if(admitted||settled)return;
      header=Buffer.concat([header,chunk]);const end=header.indexOf('\r\n\r\n');
      if(end<0){if(header.length>policy.headerBytes)refuse();return;}
      if(end+4>policy.headerBytes){refuse();return;}
      admitted=true;client.removeListener('data',receive);
      const queue=extra=>{header=Buffer.concat([header,extra]);if(header.length-end-4>65536)finish();};
      client.on('data',queue);client.once('end',()=>{if(!tunneled)finish();});
      try {
        const hostname=authority(header.subarray(0,end+4));
        if(resolving>=policy.connections)throw Error('EGRESS_RESOLVER_BUSY');
        let address;resolving++;try{address=await resolvePublic(hostname,lookup);}finally{resolving--;}
        if(settled||client.destroyed)return;
        const upstream=entry.upstream=connect({host:address,port:443,family:4,allowHalfOpen:true,highWaterMark:65536});
        upstream.setTimeout(policy.idleMs,finish);upstream.on('error',finish);upstream.on('close',()=>{if(!upstream.readableEnded||!upstream.writableFinished)finish();});upstream.on('data',count);
        upstream.once('connect',()=>{
          if(settled||client.destroyed){finish();return;}
          client.pause();client.removeListener('data',queue);tunneled=true;
          clearTimeout(connectTimer);client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const pending=header.subarray(end+4);header=Buffer.alloc(0);
          // Preserve every TLS byte, including a ClientHello coalesced with the
          // CONNECT header. No proxy headers are sent to the target server.
          if(pending.length)upstream.write(pending);
          client.pipe(upstream);upstream.pipe(client);client.resume();
        });
      } catch { refuse(); }
    };
    client.on('data',receive);
  });
  return { server, get activeConnections(){return active.size;}, get pendingResolutions(){return resolving;}, get transferredBytes(){return transferred;}, close };
}
async function main() {
  if(process.argv.length!==2||process.getuid?.()<1000)throw Error('EGRESS_CONFIGURATION_REFUSED');
  const parent='/run/homeai-egress',info=fs.lstatSync(parent);
  if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(parent)!==parent||info.uid!==process.getuid()||info.mode&0o077)throw Error('EGRESS_SOCKET_DIRECTORY_REFUSED');
  const proxy=createProxy();await new Promise((resolve,reject)=>{proxy.server.once('error',reject);proxy.server.listen(SOCKET,resolve);});fs.chmodSync(SOCKET,0o600);
  const deadline=setTimeout(()=>void proxy.close(),limits.lifetimeMs);deadline.unref();
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearTimeout(deadline);void proxy.close();});
}
if(require.main===module)main().catch(()=>{process.stderr.write('EGRESS_UNAVAILABLE\n');process.exitCode=1;});
module.exports={createProxy,authority,publicIPv4,resolvePublic,limits};
