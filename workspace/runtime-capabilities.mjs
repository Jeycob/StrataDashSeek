import fsPromises from 'node:fs/promises';
import path from 'node:path';

const MIB = 1024 ** 2;
const FILES = ['Dockerfile', '.dockerignore', '.harness-app.json', 'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const ID = /^[a-f0-9]{16}$/;
export const runtimeCapabilitiesFallback = '[Managed application deployment] Before deployment call runtime_capabilities for the current project. For a user preview, use project_apps with operation verify_deploy: it builds or reuses cache and requires application plus browser checks. Build completion alone is not a verified release. Declare dataPolicy.kind=stateless or a bounded SQLite volume/database/mountPath in .harness-app.json. Container root filesystems are read-only; use /tmp for disposable writes. SQLite additive SQL migrations must be declared and tested on a shadow copy; tests are never promoted as customer data. recovery_required means stop and inspect retained reports, never delete journals, resume old writers or retry the same cutover. Review and reuse existing Dockerfile, .dockerignore, application manifest and Compose files; scaffolding is only needed for missing files. Use typed project_apps operations register, verify_deploy, status, job_status and job_log. Native supplies project identity and controller credentials; the guest must not call a host Apps CLI. Vast uses an on-demand managed QEMU Docker VM: asleep is configured, not missing Docker. verify_deploy wakes it automatically after host capacity checks; cold VM startup can take minutes. Do not issue duplicate wake/build operations while a job is queued/running. State reads never wake it. Never attach a host Docker socket or install your own Docker daemon. Respect host and guest disk reserves; waking the VM cannot fix a host capacity deficit. Safe temporary cleanup is automatic; never lower guards, delete models/application data or rent a server to bypass a failure. A queued operation or HTTP response is not proof of a completed build, application test or visual test. Keep the original SDK and Apps job IDs. SDK monitor cancellation does not cancel Apps; unknown admission holds the heavy permit until exact settlement. Ordinary project_apps status or the next heavy check reconciles inactive monitors without another submission. Wait for a final job status and test the exact deployed image before reporting a working preview URL. Free-space samples before and after an operation measure net retained usage, not its peak; report peak usage as unknown unless separately measured. MANAGED_RESOURCE_* means the environment or saved requested policy is unproven or unsupported: keep deployment unverified, inspect resourceDiagnostic, and use a supported managed worker or operator reconciliation. Do not repair application code or rebuild an image solely for SwapLimit=false, lower guards, or replay an unknown start. Do not infer that no better deployment strategy exists from a single failed strategy.';

const inside = (root, dir) => dir !== root && dir.startsWith(root + path.sep);
const deepFreeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };
const safeTime = value => Number.isFinite(value) && value >= 0 ? value : null;
const pickEnum = (value, allowed) => allowed.includes(value) ? value : 'unknown';
const jobStates = ['queued', 'running', 'passed', 'failed', 'interrupted', 'recovery_required'];
const actions = ['verify', 'build', 'deploy', 'check', 'compose', 'export', 'rollback', 'remote-verify', 'remote-preflight', 'resource-export'];
function workerProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const bounded = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max ? n : null;
  const drivers = ['vfs', 'overlay2', 'overlayfs', 'btrfs', 'zfs', 'devicemapper', 'fuse-overlayfs'];
  const driver = value => drivers.includes(value) ? value : null;
  const observed = driver(value.observedStorageDriver), at = safeTime(value.storageObservedAt);
  return { vcpus: bounded(value.vcpus, 256), memoryMiB: bounded(value.memoryMiB, 1024 * 1024), diskBytes: bounded(value.diskBytes, Number.MAX_SAFE_INTEGER),
    acceleration: ['tcg', 'kvm'].includes(value.acceleration) ? value.acceleration : null,
    configuredStorageDriver: driver(value.configuredStorageDriver), observedStorageDriver: observed,
    storageObservedAt: observed ? at : null, observedInRunningBoot: Boolean(observed && at && value.observedInRunningBoot === true),
    configuredLayerCopies: value.configuredStorageDriver === 'vfs' ? 'full-parent-directory' : 'unknown', peakBuildBytesKnown: false };
}

/** Only the server supplies canonicalProjectDirectory, never tool arguments.
 * readAppsState({signal}) MUST be side-effect-free (e.g. Apps GET /state), not
 * ensure/ready/wake. No shell, subprocess, network client or Apps mutation is
 * provided by this module. capacityPath is trusted server configuration.
 */
export function createRuntimeCapabilities({ workspaceRoot, capacityPath = '/data/harness/state/applications', minFreeBytes = 2 * 1024 ** 3, readAppsState, fs = fsPromises, now = Date.now, ttlMs = 5000, stateTimeoutMs = 2000, maxEntries = 128 } = {}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) throw new TypeError('An absolute server workspace root is required');
  if (typeof capacityPath !== 'string' || !path.isAbsolute(capacityPath)) throw new TypeError('An absolute capacity path is required');
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0 || !Number.isSafeInteger(minFreeBytes + 512 * MIB)) throw new TypeError('Invalid disk reserve');
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 60000 || !Number.isFinite(stateTimeoutMs) || stateTimeoutMs <= 0 || stateTimeoutMs > 30000 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024) throw new TypeError('Invalid cache limits');
  if (readAppsState !== undefined && typeof readAppsState !== 'function') throw new TypeError('readAppsState must be a read-only function');
  const cache = new Map(), inflight = new Map();
  const keyFor = dir => typeof dir === 'string' && path.isAbsolute(dir) && inside(path.resolve(workspaceRoot), dir) && path.resolve(dir) === dir ? dir : null;
  const cached = key => { const entry = cache.get(key), age = entry ? now() - entry.sampledAt : -1; return entry && age >= 0 && age < ttlMs ? entry : null; };
  async function appsState() {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => readAppsState({ signal: controller.signal })), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('State timeout')); }, stateTimeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  async function collect(directory) {
    const sampledAt = now(), timestamp = new Date(sampledAt).toISOString();
    const root = await fs.realpath(workspaceRoot), canonical = await fs.realpath(directory);
    if (canonical !== directory || !inside(root, canonical) || !(await fs.stat(canonical)).isDirectory()) throw new Error('A canonical server-owned project directory is required');
    const relative = path.relative(root, canonical), existingFiles = [], unavailableFiles = [];
    for (const name of FILES) {
      try {
        const stat = await fs.lstat(path.join(canonical, name));
        if (stat.isFile() && !stat.isSymbolicLink()) existingFiles.push(name); else unavailableFiles.push(name);
      } catch (error) { if (error?.code !== 'ENOENT') unavailableFiles.push(name); }
    }
    let capacity = { scope: 'host-only', known: false, freeBytes: null, minFreeBytes, verifyRequiredBytes: minFreeBytes + 512 * MIB, canBuild: false, canVerify: false };
    try {
      const stat = await fs.statfs(capacityPath, { bigint: true }), blocks = BigInt(stat.bavail), blockSize = BigInt(stat.bsize), bytes = blocks * blockSize;
      if (blocks >= 0n && blockSize > 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER)) { const freeBytes = Number(bytes); capacity = { ...capacity, known: true, freeBytes, canBuild: freeBytes >= minFreeBytes, canVerify: freeBytes >= capacity.verifyRequiredBytes }; }
    } catch { /* Unknown is never permission to bypass reserves. */ }
    let apps = { configured: false, state: 'configured', observed: false, busy: false, reason: 'state-reader-not-configured', project: null, jobs: [], containers: [], workerFreeBytes: null };
    if (readAppsState) {
      try {
        const state = await appsState();
        if (!state || typeof state !== 'object' || typeof state.enabled !== 'boolean') throw new Error('Invalid state');
        const entries = Array.isArray(state.projects) ? state.projects : Object.values(state.projects || {});
        // Compare full normalized paths, never basenames or a model-supplied id.
        const matches = entries.filter(p => {
          if (!p || typeof p.path !== 'string' || path.isAbsolute(p.path) || p.path.split(/[\\/]/).includes('..') || !ID.test(p.id || '')) return false;
          return path.resolve(root, p.path) === canonical;
        });
        const own = matches.length === 1 ? matches[0] : null, ownId = own?.id;
        const phase = state.worker?.phase;
        let status = 'configured';
        if (state.enabled) {
          if (['starting', 'restoring', 'recovering', 'saving'].includes(phase)) status = 'starting';
          else if (phase === 'asleep') status = 'asleep';
          else if (state.available === true && (!state.worker || phase === 'ready')) status = 'ready';
          else status = 'unreachable';
        }
        apps = {
          configured: state.enabled, state: status, observed: true, busy: Boolean(state.busy), recoveryRequired: state.deploymentRecovery?.required === true,
          reason: !state.enabled ? 'disabled' : matches.length > 1 ? 'ambiguous-project-registration' : !own ? 'project-not-registered' : null,
          project: own ? { id: ownId, registered: true, built: typeof own.imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(own.imageId), deployed: typeof own.containerId === 'string' && /^[a-f0-9]{64}$/.test(own.containerId) } : null,
          jobs: own ? (Array.isArray(state.jobs) ? state.jobs : []).filter(j => j?.projectId === ownId && ID.test(j.id || '')).slice(-8).map(j => ({ id: j.id, action: pickEnum(j.action, actions), status: pickEnum(j.status, jobStates), startedAt: safeTime(j.startedAt), endedAt: safeTime(j.endedAt) })) : [],
          containers: own ? (Array.isArray(state.containers) ? state.containers : []).filter(c => c?.projectId === ownId && /^[a-f0-9]{64}$/.test(c.id || '')).slice(-16).map(c => ({ id: c.id, state: pickEnum(c.state, ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'sleeping']) })) : [],
          workerFreeBytes: Number.isSafeInteger(state.worker?.freeBytes) && state.worker.freeBytes >= 0 ? state.worker.freeBytes : null,
          workerFreeInodes: Number.isSafeInteger(state.worker?.freeInodes) && state.worker.freeInodes >= 0 ? state.worker.freeInodes : null,
          workerDiskCheckedAt: safeTime(state.worker?.diskCheckedAt),
          workerProfile: workerProfile(state.worker?.profile),
        };
      } catch { apps = { ...apps, state: 'unreachable', reason: 'state-read-failed' }; }
    }
    const recipe = (operation, jobId) => ({ tool: 'project_apps', arguments: { operation, ...(jobId ? { jobId } : {}) } });
    const recipes = { register: recipe('register'), status: recipe('status'), ...(apps.project && !apps.recoveryRequired ? { verify_deploy: recipe('verify_deploy') } : {}) };
    const jobTracking = { source: 'existing-apps-registry', pollIntervalMs: 5000, repeatSubmission: false, waitDeadlineMs: 300000,
      jobs: apps.jobs.map(job => ({ id: job.id, status: recipe('job_status', job.id), logs: recipe('job_log', job.id) })),
      completion: 'Require job.passed=true and job.workSettled=true from the original job_status receipt. A wait deadline or unknown outcome stays unverified; inspect logs and recovery state instead of submitting again. The global recent-job window is incomplete; absence never proves non-admission.' };
    const verificationRecipes = { documentation: '/opt/homeai/quality/README.md', contract: '.harness-quality.json', browserPlan: '.harness-browser.json', artifacts: '.harness/quality/',
      test: { tool: 'verify_project', arguments: { kind: 'test' } }, browser: { tool: 'verify_project', arguments: { kind: 'browser' } }, all: { tool: 'verify_project', arguments: { kind: 'all' } },
      completion: 'Use real project assertions and a running owned server on its assigned port. Browser flows require a visible expectation and screenshot checkpoint. Require passed=true, complete=true and stale=false for all required kinds; a screenshot or build alone is insufficient.' };
    if(apps.recoveryRequired)capacity={...capacity,canBuild:false,canVerify:false};
    return deepFreeze({ version: 2, timestamp, sampledAt, ttlMs, project: { relativePath: relative }, existingFiles, unavailableFiles, capacity, apps, recipes, jobTracking, verificationRecipes, guidance: { reuseExistingFiles: true, managedDockerOnly: true, httpIsNotApplicationVerification: true, workerDiskRequiredBytes: 512 * MIB, capacityIsAdvisory: true, finalImageSizeIsNotPeakBuildUsage: true, driverChangesRequireDataPreservationPlan: true, enforceCapacityAgainAtExecution: true, stateReadHasNoWake: true, resourceAdmissionFailureRequiresSupportedWorkerOrOperator: true, unknownStartsMustNotBeReplayed: true } });
  }
  function snapshot(canonicalProjectDirectory) {
    const key = keyFor(canonicalProjectDirectory);
    if (!key) return Promise.reject(new Error('A canonical server-owned project directory is required'));
    const hit = cached(key); if (hit) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= maxEntries) return Promise.reject(new Error('Capability read limit reached'));
    const pending = collect(key).then(result => { cache.delete(key); cache.set(key, result); while (cache.size > maxEntries) cache.delete(cache.keys().next().value); return result; }).finally(() => inflight.delete(key));
    inflight.set(key, pending); return pending;
  }
  // Never performs I/O or refreshes stale entries from a context callback.
  function renderContext(canonicalProjectDirectory) {
    const key = keyFor(canonicalProjectDirectory), entry = key && cached(key);
    if (!entry) return runtimeCapabilitiesFallback;
    return runtimeCapabilitiesFallback + '\n[Read-only capability snapshot; call runtime_capabilities to refresh before deployment]\n' + JSON.stringify(entry);
  }
  return Object.freeze({ snapshot, renderContext });
}
