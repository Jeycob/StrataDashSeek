'use strict';
// Private in-process grants connect Native's locked authority snapshot to the
// existing managed resource journal. Request JSON can never mint a bind grant.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { LABEL } = require('./apps-engine.cjs');
const { readAcceptance } = require('./apps-project-egress.cjs');
const grants = new WeakMap(), activePolicies = new WeakMap();
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), { code, status: 409 });
const imageID = /^sha256:[a-f0-9]{64}$/, token = /^[a-f0-9]{32}$/;
function launchHash(config) { return hash({ Entrypoint: config.Entrypoint, Cmd: config.Cmd, WorkingDir: config.WorkingDir }); }
function environmentHash(...layers) { const env = new Map(); for (const layer of layers) { if (!Array.isArray(layer) || layer.length > 128) throw fail('PROJECT_RUNTIME_ENVIRONMENT_INVALID'); for (const value of layer) { if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value) || value.includes('\0')) throw fail('PROJECT_RUNTIME_ENVIRONMENT_INVALID'); env.set(value.slice(0, value.indexOf('=')), value); } } return hash([...env.values()].sort()); }
function bodyBinding(body) { return { Image: body.Image, User: body.User, Entrypoint: body.Entrypoint, Cmd: body.Cmd, Env: body.Env, WorkingDir: body.WorkingDir, HostConfig: body.HostConfig, role: body.Labels?.[LABEL + '.role'], project: body.Labels?.[LABEL + '.project'], generation: body.Labels?.[LABEL + '.generation'] }; }
function checkProof(manager, filesystem = fs) {
  const cfg = manager.cfg.projectRuntime, worker = manager.worker, proof = worker?.status?.().projectRuntimeIsolation;
  if (!cfg?.enabled || !worker || !proof?.verified || proof.version !== 1 || !Number.isInteger(proof.bootPid) || proof.bootPid !== worker.pid() || proof.guestProjectsRoot !== '/srv/homeai/projects' || !Number.isInteger(proof.uid) || proof.uid < 1000 || proof.uid > 65534 || !Number.isInteger(proof.gid) || proof.gid < 1000 || proof.gid > 65534) throw fail('PROJECT_RUNTIME_ISOLATION_UNAVAILABLE');
  const base = filesystem.realpathSync(cfg.projectsRoot), info = filesystem.lstatSync(base);
  if (!info.isDirectory() || info.isSymbolicLink() || proof.projectsRoot !== base || proof.hostDev !== info.dev || proof.hostIno !== info.ino || proof.uid !== cfg.uid || proof.gid !== cfg.gid) throw fail('PROJECT_RUNTIME_MAPPING_CHANGED');
  if (cfg.toolchain !== undefined) {
    const tools = proof.toolchain, configured = cfg.toolchain;
    if (!configured || !/^[a-f0-9]{64}$/.test(configured.manifestSha256 || '') || tools?.version !== 1 || tools.verified !== true || tools.bootPid !== proof.bootPid || tools.readOnly !== true || tools.guestRoot !== '/srv/homeai/toolchain' || tools.root !== configured.root || tools.manifestSha256 !== configured.manifestSha256) throw fail('PROJECT_RUNTIME_TOOLCHAIN_UNAVAILABLE');
    const directory = filesystem.lstatSync(configured.root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || filesystem.realpathSync(configured.root) !== configured.root || directory.uid !== 0 || directory.mode & 0o022 || directory.dev !== tools.hostDev || directory.ino !== tools.hostIno) throw fail('PROJECT_RUNTIME_TOOLCHAIN_CHANGED');
  }
  return { cfg, proof, base };
}
function runtimeRequest(manager, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['op', 'kind', 'sessionId', 'generation', 'token', 'command', 'stopToken'].includes(key)) || !['ensure', 'execute'].includes(input.op) || !['editor', 'executor', 'relay'].includes(input.kind) || !token.test(input.generation || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId || '') || !/^[A-Za-z0-9_-]{43}$/.test(input.stopToken || '')) throw fail('PROJECT_RUNTIME_REQUEST_INVALID');
  if (input.kind === 'executor' ? input.op !== 'execute' || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 65536 || input.command.includes('\0') : input.op !== 'ensure' || input.command !== undefined) throw fail('PROJECT_RUNTIME_REQUEST_INVALID');
  const authority = manager.archivedCleanup.authority(input.token), context = authority.runtimeContext;
  if (!context || context.version !== 1 || ['op', 'kind', 'sessionId', 'generation'].some(key => context[key] !== input[key]) || !path.isAbsolute(context.projectRoot || '') || typeof context.readOnly !== 'boolean' || authority.archivedIds.includes(input.sessionId) || !authority.sessions.some(s => s.id === input.sessionId && s.managed && s.root === context.projectRoot)) throw fail('PROJECT_RUNTIME_AUTHORITY_REQUIRED');
  return { authority, context };
}
function createRuntimePlan(manager, input, { guestPort, filesystem = fs, component } = {}) {
  const { authority, context } = runtimeRequest(manager, input);
  const { cfg, proof, base } = checkProof(manager, filesystem), root = filesystem.realpathSync(context.projectRoot), stat = filesystem.lstatSync(root);
  const egress = input.kind === 'executor' ? readAcceptance(manager,filesystem) : null;
  if (component !== undefined && !(component === 'relay' && input.kind === 'editor' && input.op === 'ensure') && !(component === 'egress' && input.kind === 'executor' && egress)) throw fail('PROJECT_RUNTIME_REQUEST_INVALID');
  const kind = component || input.kind;
  if (root !== context.projectRoot || path.dirname(root) !== base || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== proof.uid || stat.gid !== proof.gid || !/^[A-Za-z0-9_-]{1,128}$/.test(path.basename(root))) throw fail('PROJECT_RUNTIME_MAPPING_CHANGED');
  const git = path.join(root, '.git'), gitStat = filesystem.lstatSync(git);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || filesystem.realpathSync(git) !== git) throw fail('PROJECT_RUNTIME_GIT_SHARED');
  for (const relative of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) if (filesystem.existsSync(path.join(git, relative))) throw fail('PROJECT_RUNTIME_GIT_SHARED');
  if (!Array.isArray(context.ports) || context.ports.length !== 4 || new Set(context.ports).size !== 4 || context.ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw fail('PROJECT_RUNTIME_PORTS_INVALID');
  const image = cfg.images?.[kind]; if (!imageID.test(image || '')) throw fail('PROJECT_RUNTIME_IMAGE_UNAVAILABLE');
  const scopeId = hash(input.sessionId + '\0' + root).slice(0, 32), projectId = hash(root).slice(0, 16), guestRoot = '/srv/homeai/projects/' + path.basename(root), socketRoot = '/run/homeai-runtime/' + scopeId + '/' + input.generation;
  const mounts = [], user = proof.uid + ':' + proof.gid, isRelay = kind === 'relay', isEgress = kind === 'egress', supervisor = isRelay || isEgress, egressRoot = '/run/homeai-egress/' + scopeId + '/' + input.generation;
  if (!supervisor) mounts.push({ Type: 'bind', Source: guestRoot, Target: '/workspace', ReadOnly: context.readOnly, BindOptions: { Propagation: 'rprivate' } });
  if (kind === 'editor' || isRelay) mounts.push({ Type: 'bind', Source: socketRoot, Target: '/run/homeai-editor', ReadOnly: isRelay, BindOptions: { Propagation: 'rprivate' } });
  if (egress) mounts.push({Type:'bind',Source:egressRoot,Target:'/run/homeai-egress',ReadOnly:!isEgress,BindOptions:{Propagation:'rprivate'}});
  if (isRelay) mounts.push({ Type: 'bind', Source: '/srv/homeai/transport/' + scopeId + '/' + input.generation, Target: '/run/homeai-transport', ReadOnly: true, BindOptions: { Propagation: 'rprivate' } });
  if (kind === 'editor') mounts.push({ Type: 'bind', Source: '/var/lib/harness/editor-state/' + scopeId, Target: '/home/coder', ReadOnly: false, BindOptions: { Propagation: 'rprivate' } });
  if (cfg.toolchain) for (const name of supervisor?['code-server','homeai']:['code-server','homeai','dotnet','playwright','npm']) mounts.push({Type:'bind',Source:'/srv/homeai/toolchain/'+name,Target:'/opt/'+name,ReadOnly:true,BindOptions:{Propagation:'rprivate'}});
  if (isRelay && (!Number.isInteger(guestPort) || guestPort < 1024 || guestPort > 65535)) throw fail('PROJECT_RUNTIME_PORTS_INVALID');
  const memory = (supervisor ? 64 : kind === 'editor' ? 1024 : 512) * 1024 ** 2;
  const env = ['HOME=/home/coder', 'USER=coder', 'LANG=C.UTF-8', 'PATH=/opt/code-server/lib:/opt/code-server/bin:/opt/npm/bin:/opt/dotnet:/usr/bin:/bin'];
  if (cfg.toolchain) env.push('DOTNET_ROOT=/opt/dotnet','DOTNET_CLI_HOME=/home/coder','DOTNET_CLI_TELEMETRY_OPTOUT=1','DOTNET_NOLOGO=1','NPM_CONFIG_CACHE=/home/coder/.npm','NPM_CONFIG_PREFIX=/home/coder/.npm-global','HARNESS_PLAYWRIGHT_MODULE=/opt/playwright/node_modules/playwright','PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers','NODE_PATH=/opt/playwright/node_modules');
  if (!supervisor) env.push('PORT=' + context.ports[0], 'API_PORT=' + context.ports[1], 'TEST_PORT=' + context.ports[2], 'DATABASE_URL=file:/workspace/.harness/data/app.sqlite');
  const entry = isEgress ? ['/opt/code-server/lib/node','/opt/homeai/connect-proxy.cjs'] : isRelay ? ['/opt/code-server/lib/node', '/opt/homeai/socket-relay.cjs'] : kind === 'editor' ? ['/opt/code-server/bin/code-server'] : egress ? ['/opt/code-server/lib/node','/opt/homeai/egress-launch.cjs'] : ['/bin/bash', '-o', 'pipefail', '-c'];
  const cmd = isEgress ? [] : isRelay ? ['--port', String(guestPort)] : kind === 'editor' ? ['--config', '/etc/homeai/code-server.yaml', '--auth', 'none', '--socket', '/run/homeai-editor/code.sock', '--socket-mode', '0600', '--disable-proxy', '--disable-telemetry', '--disable-update-check', '--disable-file-cache', '--enable-remote-storage', '--user-data-dir', '/home/coder/user-data', '--extensions-dir', '/home/coder/extensions', '--vscode-option', 'file-watcher-polling=1000:/workspace', '/workspace'] : [input.command];
  const body = { Image: image, User: user, Entrypoint: entry, Cmd: cmd, Env: env, WorkingDir: supervisor ? '/' : '/workspace', Labels: { [LABEL]: 'managed', [LABEL + '.project']: projectId, [LABEL + '.role']: 'project-' + kind, [LABEL + '.generation']: input.generation }, HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, NetworkMode: supervisor ? 'host' : 'none', CgroupnsMode: 'private', Memory: memory, MemorySwap: memory, NanoCpus: supervisor ? 250000000 : 1000000000, PidsLimit: supervisor ? 64 : 128, Mounts: mounts, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=134217728,mode=1777', ...(kind === 'executor' ? { '/home/coder': 'rw,nosuid,nodev,size=67108864,mode=0700,uid=' + proof.uid + ',gid=' + proof.gid } : {}) } } };
  const grant = Object.freeze({});
  grants.set(grant, { manager, binding: hash(bodyBinding(body)), expiresAt: authority.expiresAt, authorityToken: input.token, contextHash: hash(context), root, sourceIdentity: [stat.dev, stat.ino, stat.uid, stat.gid], proof: structuredClone(proof), filesystem, egress, runtime: { version: 1, kind, scopeId, sessionId: input.sessionId, generation: input.generation, readOnly: context.readOnly, rootHash: hash(root), launchHash: launchHash(body),...(cfg.toolchain?{toolchainManifestSha256:cfg.toolchain.manifestSha256}:{}),...(egress?{egressProfile:egress.profile,egressEvidenceSha256:egress.evidenceSha256}:{}) } });
  return { body, grant, projectId, scopeId, guestRoot, socketRoot, user, guestPort, egress: Boolean(egress) };
}
function runtimePolicy(manager, body, grant) {
  const stored = grants.get(grant);
  if (!stored || stored.manager !== manager || stored.expiresAt <= Date.now() || stored.binding !== hash(bodyBinding(body))) throw fail('PROJECT_RUNTIME_BIND_GRANT_REQUIRED');
  checkStored(manager, stored);
  return { ...structuredClone(stored.runtime), binds: body.HostConfig.Mounts.map(m => ({ type: 'bind', target: m.Target, sourceHash: hash(m.Source), readOnly: m.ReadOnly, propagation: 'rprivate' })) };
}
function checkStored(manager, stored) {
  const { proof } = checkProof(manager, stored.filesystem), info = stored.filesystem.lstatSync(stored.root);
  if (JSON.stringify(proof) !== JSON.stringify(stored.proof) || stored.filesystem.realpathSync(stored.root) !== stored.root || !info.isDirectory() || info.isSymbolicLink() || JSON.stringify([info.dev, info.ino, info.uid, info.gid]) !== JSON.stringify(stored.sourceIdentity)) throw fail('PROJECT_RUNTIME_MAPPING_CHANGED');
  if (['executor','egress'].includes(stored.runtime.kind) && JSON.stringify(readAcceptance(manager,stored.filesystem)) !== JSON.stringify(stored.egress)) throw fail('PROJECT_RUNTIME_EGRESS_ACCEPTANCE_CHANGED');
  const authority = manager.archivedCleanup.authority(stored.authorityToken);
  if (!authority.runtimeContext || hash(authority.runtimeContext) !== stored.contextHash || authority.archivedIds.includes(stored.runtime.sessionId)) throw fail('PROJECT_RUNTIME_AUTHORITY_REQUIRED');
}
function registerRuntimePolicy(manager, policyHash, grant) { const stored = grants.get(grant); if (!stored || stored.manager !== manager) throw fail('PROJECT_RUNTIME_BIND_GRANT_REQUIRED'); let policies = activePolicies.get(manager); if (!policies) { policies = new Map(); activePolicies.set(manager, policies); } for (const [key, value] of policies) if (value.expiresAt <= Date.now()) policies.delete(key); if (policies.size >= 256) throw fail('PROJECT_RUNTIME_ADMISSION_LIMIT'); policies.set(policyHash, stored); }
function validateRuntimeStart(manager, value) { const stored = activePolicies.get(manager)?.get(value.policyHash); if (!stored || stored.expiresAt <= Date.now() || JSON.stringify(stored.runtime) !== JSON.stringify(Object.fromEntries(Object.entries(value.policy.projectRuntime).filter(([key]) => !['binds','environmentHash'].includes(key))))) throw fail('PROJECT_RUNTIME_FRESH_AUTHORITY_REQUIRED'); checkStored(manager, stored); }
module.exports = { createRuntimePlan, runtimeRequest, runtimePolicy, registerRuntimePolicy, validateRuntimeStart, pathHash: hash, launchHash, environmentHash };
