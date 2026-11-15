// Isolated real-process crash gate. Run explicitly with Linux Node and /tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sourceManifest, saveCheckpoint } from './storage.mjs';
import { recoverCheckpointRestore, checkpointRecoveryStatus } from './checkpoint-restore.mjs';
if (process.platform !== 'linux') throw Error('Run the real restore crash gate with Linux Node.');
const moduleURL = new URL('./checkpoint-restore.mjs', import.meta.url).href;
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-crash-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), checkpointRoot = path.join(base, 'checkpoints'), stateRoot = path.join(base, 'state');
  await fs.mkdir(path.join(root, 'nested/deep'), { recursive: true }); await fs.mkdir(checkpointRoot);
  await fs.writeFile(path.join(root, 'a'), 'original-a'); await fs.writeFile(path.join(root, 'b'), 'original-b'); await fs.writeFile(path.join(root, 'nested/deep/new'), 'original-new');
  const saved = await saveCheckpoint(root, path.join(checkpointRoot, 'best'), await sourceManifest(root), { minFreeBytes: 0 });
  await fs.writeFile(path.join(root, 'a'), 'working-a'); await fs.writeFile(path.join(root, 'b'), 'working-b'); await fs.rm(path.join(root, 'nested'), { recursive: true }); await fs.writeFile(path.join(root, 'extra'), 'working-extra');
  return { root, saved, stateRoot, checkpointRoot };
}
async function crash(f, phase, rollback = false) {
  const script = `import{restoreCheckpointTransaction}from${JSON.stringify(moduleURL)};
    const f=JSON.parse(process.argv[1]);await restoreCheckpointTransaction(f.root,f.saved,{stateRoot:f.stateRoot,checkpointRoot:f.checkpointRoot,minFreeBytes:0,onPhase:async p=>{
      if(${JSON.stringify(rollback)}&&p==='committed-file')throw Object.assign(Error('injected I/O fault'),{code:'ENOSPC'});
      if(p===${JSON.stringify(phase)})process.exit(86);
    }});process.exit(87);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 86, stderr);
}
for (const phase of ['validated', 'staged-file', 'staged', 'backup-created', 'prepared', 'committing', 'write-temp-synced', 'committed-file', 'before-complete']) {
  test(`real process exit at ${phase}: restart recovery preserves pre-restore work`, { timeout: 10000 }, async t => {
    const f = await fixture(t); await crash(f, phase);
    await recoverCheckpointRestore(f.root, f); await recoverCheckpointRestore(f.root, f);
    assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'working-a'); assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'working-b');
    assert.equal(await fs.readFile(path.join(f.root, 'extra'), 'utf8'), 'working-extra');
    await assert.rejects(fs.stat(path.join(f.root, 'nested')), { code: 'ENOENT' });
    assert.equal((await checkpointRecoveryStatus(f.stateRoot)).pending, false);
    assert.ok(!(await fs.readdir(f.root)).some(name => name.includes('.restore-')));
  });
}
for (const phase of ['rollback-temp-synced', 'rollback-file']) {
  test(`real process exit at ${phase}: rollback itself is restartable`, { timeout: 10000 }, async t => {
    const f = await fixture(t); await crash(f, phase, true); await recoverCheckpointRestore(f.root, f);
    assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'working-a'); assert.equal(await fs.readFile(path.join(f.root, 'b'), 'utf8'), 'working-b');
    assert.equal((await checkpointRecoveryStatus(f.stateRoot)).status, 'rolled-back');
  });
}
