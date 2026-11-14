import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managedFileScope, registryReader } from './native-files.mjs';

test('Native live and cold session roots use their own isolated projects', async () => {
  const first = path.join(os.tmpdir(), 'project-one'), second = path.join(os.tmpdir(), 'project-two');
  const base = { resolve: async id => ['live', 'cold', 'legacy'].includes(id) ? { sessionId: id, workspaceRoot: 'original-project' } : undefined };
  let reads = 0;
  const resolve = managedFileScope(base, async () => { reads++; return { sessions: { live: { root: first }, cold: { root: second } }, trash: {} }; });
  assert.deepEqual(await resolve('live'), { sessionId: 'live', workspaceRoot: first });
  assert.deepEqual(await resolve('cold'), { sessionId: 'cold', workspaceRoot: second });
  assert.equal((await resolve('live')).workspaceRoot, first);
  assert.equal((await resolve('legacy')).workspaceRoot, 'original-project');
  const before = reads; assert.equal(await resolve('missing'), undefined); assert.equal(reads, before);
});

test('unknown, trashed and malformed project roots cannot borrow another project', async () => {
  const base = { resolve: async id => ({ sessionId: id, workspaceRoot: 'original' }) };
  const resolve = managedFileScope(base, async () => ({ sessions: { bad: { root: '../other' } }, trash: { deleted: {} } }));
  assert.equal(await resolve('deleted'), undefined);
  await assert.rejects(resolve('bad'), /root is unavailable/);
  const broken = managedFileScope(base, async () => { throw Error('Registry not readable'); });
  await assert.rejects(broken('live'), /not readable/);
});

test('atomic registry replacements refresh cached roots; invalid registries fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-files-registry-'));
  t.after(async () => { if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'native-files-registry-')) await fs.rm(directory, { recursive: true, force: true }); });
  const file = path.join(directory, 'registry.json'), read = registryReader(file);
  assert.deepEqual((await read()).sessions, {});
  await fs.writeFile(file, JSON.stringify({ version: 1, sessions: { a: { root: '/first' } } }));
  assert.equal((await read()).sessions.a.root, '/first');
  await fs.writeFile(file + '.new', JSON.stringify({ version: 1, sessions: { a: { root: '/second' } } })); await fs.rename(file + '.new', file);
  assert.equal((await read()).sessions.a.root, '/second');
  await fs.writeFile(file, '{bad'); await assert.rejects(read());
  await fs.writeFile(file, JSON.stringify({ version: 1, sessions: [] })); await assert.rejects(read(), /Invalid/);
});
