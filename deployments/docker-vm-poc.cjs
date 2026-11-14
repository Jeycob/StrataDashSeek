'use strict';
// Bounded capability test. It does not change Harness, Strata or host namespaces.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {createRequire} = require('node:module');
const ROOT = '/data/harness/workspaces/docker-capability-lab';
const LIMIT = 1024 * 1024 * 1024;
const BASE = 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/';

function usage() {
  if (!fs.existsSync(ROOT)) return 0;
  let size = 0;
  function visit(dir) { for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) size += fs.statSync(file).size;
    else throw Error('Unexpected symlink or special file in the test directory');
  }}
  visit(ROOT);
  return size;
}

async function download(url, file, max) {
  if (!url.startsWith(BASE) || !path.resolve(file).startsWith(ROOT + '/')) throw Error('Invalid artifact location');
  const response = await fetch(url, {signal:AbortSignal.timeout(120000)});
  if (!response.ok) throw Error('Download failed: ' + response.status);
  if (Number(response.headers.get('content-length')) > max) throw Error('Artifact is too large');
  const fd = fs.openSync(file, 'wx');
  let length = 0;
  try { for await (const chunk of response.body) {
    length += chunk.length;
    if (length > max || usage() + chunk.length > LIMIT) throw Error('Test disk budget exceeded');
    fs.writeSync(fd, chunk);
  }} finally { fs.closeSync(fd); }
}

function extractBoot(iso) {
  const data = fs.readFileSync(iso);
  const pvd = 16 * 2048;
  if (data.toString('ascii', pvd + 1, pvd + 6) !== 'CD001') throw Error('Not an ISO9660 image');
  function record(offset) {
    const length = data[offset];
    if (!length) return null;
    const nameLength = data[offset + 32];
    let name = data.toString('utf8', offset + 33, offset + 33 + nameLength).replace(/;\d+$/, '').replace(/\.$/, '').toLowerCase();
    let cursor = offset + 33 + nameLength;
    if (cursor % 2) cursor++;
    while (cursor + 4 <= offset + length) {
      const sig = data.toString('ascii', cursor, cursor + 2), n = data[cursor + 2];
      if (n < 4 || cursor + n > offset + length) break;
      if (sig === 'NM' && !(data[cursor + 4] & 6)) name = data.toString('utf8', cursor + 5, cursor + n);
      cursor += n;
    }
    return {length, name, start:data.readUInt32LE(offset + 2) * 2048, size:data.readUInt32LE(offset + 10), directory:!!(data[offset + 25] & 2)};
  }
  function children(dir) {
    const out = [];
    for (let pos = dir.start; pos < dir.start + dir.size;) {
      const r = record(pos);
      if (!r) { pos = Math.floor(pos / 2048 + 1) * 2048; continue; }
      out.push(r); pos += r.length;
    }
    return out;
  }
  const boot = children(record(pvd + 156)).find(r => r.name === 'boot');
  if (!boot) throw Error('No boot directory');
  const files = children(boot);
  for (const name of ['vmlinuz-virt', 'initramfs-virt']) {
    const entry = files.find(r => r.name === name);
    if (!entry || entry.directory || entry.size > 128 * 1024 * 1024 || entry.start + entry.size > data.length) throw Error('Missing boot artifact: ' + name);
    fs.writeFileSync(path.join(ROOT, name), data.subarray(entry.start, entry.start + entry.size), {flag:'wx'});
  }
}

async function prepare() {
  if (fs.existsSync(ROOT)) throw Error('Test directory already exists; inspect it before reusing');
  const stat = fs.statfsSync('/data');
  if (stat.bavail * stat.bsize < 4 * 1024 ** 3) throw Error('Less than 4 GiB free; aborting');
  const yaml = createRequire('/data/harness/runtime/node_modules/@deepseek-ai/dsh/package.json')('yaml');
  const r = await fetch(BASE + 'latest-releases.yaml', {signal:AbortSignal.timeout(20000)});
  if (!r.ok) throw Error('Cannot read the official release manifest');
  const rows = yaml.parse(await r.text());
  const release = rows.find(x => /alpine-virt-.*-x86_64\.iso$/.test(x.iso || ''));
  if (!release || !/^[a-f0-9]{64}$/i.test(release.sha256 || '')) throw Error('No checksummed virtual image in release manifest');
  fs.mkdirSync(ROOT, {mode:0o700});
  const iso = path.join(ROOT, 'alpine.iso');
  await download(BASE + release.iso, iso, 256 * 1024 * 1024);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(iso)).digest('hex');
  if (sha !== release.sha256.toLowerCase()) throw Error('Image checksum mismatch');
  extractBoot(iso);
  fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify({release,sha256:sha,preparedAt:new Date().toISOString(),limits:{vcpus:1,memoryMiB:2048,testDataBytes:LIMIT}}, null, 2));
  const uid = Number(cp.execFileSync('id', ['-u','harness'], {encoding:'utf8'}).trim());
  const gid = Number(cp.execFileSync('id', ['-g','harness'], {encoding:'utf8'}).trim());
  for (const file of fs.readdirSync(ROOT)) fs.chownSync(path.join(ROOT,file), uid,gid);
  fs.chownSync(ROOT,uid,gid);
  console.log(JSON.stringify({prepared:true,release:release.iso,sha256:sha,testBytes:usage()}));
}

function run() {
  if (process.getuid() === 0) throw Error('Run the VM as the unprivileged harness user');
  if (usage() > LIMIT) throw Error('Test disk budget exceeded');
  const args = ['-accel','tcg,thread=single','-smp','1','-m','2048','-cpu','max',
    '-display','none','-serial','stdio','-monitor','none','-no-reboot',
    '-kernel',ROOT+'/vmlinuz-virt','-initrd',ROOT+'/initramfs-virt','-cdrom',ROOT+'/alpine.iso',
    '-append','console=ttyS0 alpine_dev=cdrom:iso9660 modules=loop,squashfs,sd-mod,usb-storage quiet',
    '-netdev','user,id=net0,hostfwd=tcp:127.0.0.1:18088-:8080,hostfwd=tcp:127.0.0.1:19075-:2375,hostfwd=tcp:127.0.0.1:18080-:18080','-device','virtio-net-pci,netdev=net0'];
  const child = cp.spawn('nice',['-n','19','qemu-system-x86_64',...args],{cwd:ROOT,stdio:'inherit'});
  const timer = setTimeout(()=>child.kill('SIGTERM'),15*60*1000);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill('SIGTERM'));
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code || 0;});
}

if (process.argv[2] === 'prepare') prepare().catch(e=>{console.error(e.message);process.exitCode=1;});
else if (process.argv[2] === 'run') run();
else { console.error('Usage: docker-vm-poc.cjs prepare|run'); process.exitCode=2; }
