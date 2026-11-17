import fs from 'node:fs/promises';
import path from 'node:path';

const ignored = new Set(['.git', 'node_modules', '.wrangler', '__pycache__', '.harness', '.agents', '.codex', 'work', 'outputs', 'secrets', 'root-secrets', 'state', 'deployments']);
const helpers = new Map([
  ['deployments/test-worker-network.py', 'Real packet fixture invoked only by the required worker-network-linux-check.cjs wrapper in a fresh root network namespace.'],
  ['development/test-command.cjs', 'Production Node test-argument utility; covered by its test file.'],
  ['workspace/native-ui/test-bundle.cjs', 'Source fixture builder; covered by browser suites.'],
  ['vast/apps-browser-check.cjs', 'Owned-release browser verification adapter; requires a project, plan and release ID.']
]);
const hostFixtures = new Map([
  ['workspace/code-server.browser.test.cjs', 'Actual code-server acceptance against an explicitly prepared local WSL fixture and HOMEAI_EDITOR_URL; independent runtime evidence remains separate from required portable Native panel fixtures.'],
  ['development/guest-capability-probe.cjs', 'Operator-only disposable QEMU guest using pinned installed boot artifacts after fresh host quiescence; plan tests run separately in CI.'],
  ...['guest-volume-census','guest-cache-diagnostic','guest-container-isolation-probe','project-share-probe','project-container-share-probe'].map(name=>['development/'+name+'.cjs','Operator-only bounded disposable guest acceptance using pinned boot artifacts; separate synthetic plan tests remain required in CI.']),
  ['deployments/apps-live-lifecycle-check.cjs', 'Explicit live demo lifecycle check reads the installed private worker key; operator-run acceptance only.'],
  ['deployments/apps-real-worker-check.cjs', 'Acceptance against an explicitly prepared dedicated Docker worker; no such host or credentials in CI.'],
  ['deployments/docker-worker-provision-check.cjs', 'Operator check of the installed Docker VM/engine; not a disposable unit fixture.'],
  ['vast/completion-guard-smoke.cjs', 'Legacy fixture requires an installed /data/harness profile and fixed local ports; never run against production from CI.'],
  ['workspace/reasoning-smoke.cjs', 'Legacy fixture requires installed host profiles; current-source unit/SDK checks are separate.']
]);
const linuxChecks = new Set(['development/guest-disk-grow-linux-check.cjs','deployments/worker-network-linux-check.cjs','vast/runtime-paths-linux-check.cjs', 'vast/startup-update-linux-check.cjs', 'workspace/process-lock-linux-check.mjs', 'workspace/checkpoint-restore-linux-check.mjs', 'mobile/runtime-readiness-native-check.cjs', 'vast/apps-context-linux-check.cjs','vast/runtime-lease-linux-check.cjs','vast/startup-hook-linux-check.cjs']);
const rootTests = new Set(['development/project-toolchain.test.cjs', 'mobile/runtime-readiness.test.cjs', 'vast/apps-data-linux-check.cjs', 'workspace/editor-transport.test.cjs']);
export function candidate(name) {
  if (hostFixtures.has(name.replaceAll('\\', '/'))) return true;
  const base = path.posix.basename(name);
  return /\.test\.(?:[cm]js|py)$|[-_](?:check|smoke)\.[cm]js$|^test[-_].+\.[cm]js$|^test[-_].+\.py$|[-_]tests\.py$/u.test(base);
}
export function classify(name) {
  name = name.replaceAll('\\', '/');
  if (name.startsWith('benchmarks/')) return {file: name, kind: 'historical', lane: 'outside-ci', required: false, reason: 'Historical challenge/dataset fixture, explicitly outside the production infrastructure gate.'};
  if (helpers.has(name)) return {file: name, kind: 'helper', lane: 'outside-ci', required: false, reason: helpers.get(name)};
  if (hostFixtures.has(name)) return {file: name, kind: 'existing-host-fixture', lane: 'outside-ci', required: false, outcome: 'unrunnable', reason: hostFixtures.get(name)};
  if (name === 'development/device-workerd-check.mjs') return {file: name, kind: 'workerd', lane: 'local-engine', required: true, timeoutMs: 120000};
  if (name === 'workspace/runtime-admission-native.test.cjs') return {file:name,kind:'node',lane:'portable',required:true,timeoutMs:180000,minTests:2};
  if (name === 'development/native-isolated-profile.test.mjs') return {file:name,kind:'node',lane:'portable',required:true,timeoutMs:120000,minTests:12};
  if (name === 'development/native-isolated-web.test.mjs') return {file:name,kind:'node',lane:'portable',required:true,timeoutMs:120000,minTests:1};
  if (name === 'development/shared-os-base/test_offline_apt.py') return {file:name,kind:'python',lane:'portable',required:true,timeoutMs:120000,minTests:4};
  if (name === 'development/project-execution-floor-root.test.cjs') return {file:name,kind:'node',lane:'linux-root',required:true,timeoutMs:120000,environment:{HARNESS_EXECUTION_FLOOR_ROOT_TEST:'1'},minTests:10};
  if (name === 'vast/startup-install-floor.test.cjs') return {file:name,kind:'node',lane:'linux-root',required:true,timeoutMs:120000,environment:{HARNESS_EXECUTION_FLOOR_ROOT_TEST:'1'},minTests:6};
  if (name === 'vast/runtime-recovery.test.cjs') return {file:name,kind:'node',lane:'linux-root',required:true,timeoutMs:120000,environment:{HARNESS_RUNTIME_RECOVERY_ROOT_TEST:'1'},minTests:12};
  if (name === 'workspace/runtime-admission.test.mjs') return {file:name,kind:'node',lane:'linux-root',required:true,timeoutMs:120000,environment:{HARNESS_RUNTIME_ADMISSION_ROOT_TEST:'1'},minTests:9};
  if (name === 'vast/runtime-admission-server.test.cjs') return {file:name,kind:'node',lane:'linux-root',required:true,timeoutMs:120000,environment:{HARNESS_RUNTIME_ADMISSION_SERVER_ROOT_TEST:'1'},minTests:6};
  if (name === 'vast/runtime-release-attestation.test.cjs') return {file:name,kind:'node',lane:'linux-root',required:true,timeoutMs:120000,environment:{HARNESS_RUNTIME_RELEASE_ROOT_TEST:'1'},minTests:3};
  if (linuxChecks.has(name) || rootTests.has(name)) return {file: name, kind: 'node', lane: 'linux-root', required: true, timeoutMs: 120000};
  if (name.endsWith('.py')) return {file: name, kind: 'python', lane: 'linux-root', required: true, timeoutMs: 90000};
  if (/\.test\.[cm]js$/u.test(name)) return {file: name, kind: 'node', lane: 'portable', required: true, timeoutMs: 180000};
  return {file: name, kind: 'unclassified', lane: 'unclassified', required: true, reason: 'A new checker needs explicit review before CI executes it.'};
}
export async function inventory(root, {sourceFiles} = {}) {
  const entries = [], excludedRoots = [...ignored].sort(); let visited = 0;
  if(sourceFiles){
    for(const name of [...new Set(sourceFiles)].sort()){
      if(path.isAbsolute(name)||name.split(/[\\/]/u).includes('..'))throw Error('Invalid source inventory path');
      if(!candidate(name))continue;
      const info=await fs.lstat(path.join(root,name));
      entries.push(info.isFile()&&!info.isSymbolicLink()?classify(name):{file:name,kind:'unclassified',lane:'unclassified',required:true,reason:'A test source must be a regular file.'});
    }
    return{version:1,scope:'Git tracked and nonignored untracked source paths',entries,excludedRoots,unclassified:entries.filter(row=>row.kind==='unclassified').map(row=>row.file)};
  }
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      if (++visited > 100000) throw Error('Test discovery limit exceeded');
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {if (candidate(name)) entries.push({file: name, kind: 'unclassified', lane: 'unclassified', required: true, reason: 'Test discovery does not follow links.'}); continue;}
      if (entry.isDirectory()) {if (!ignored.has(entry.name)) await walk(name);}
      else if (entry.isFile() && candidate(name)) entries.push(classify(name));
    }
  }
  await walk(''); entries.sort((a, b) => a.file.localeCompare(b.file));
  return {version: 1, entries, excludedRoots, unclassified: entries.filter(row => row.kind === 'unclassified').map(row => row.file)};
}
