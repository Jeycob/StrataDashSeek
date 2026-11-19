import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {boundedJSON, sameRequestOrigin} from './http.mjs';
import {WorkbenchError} from './policy.mjs';

const {atomicJson} = createRequire(import.meta.url)('../mobile/private-json.cjs');
const MAX_ENTRIES = 5;
const MAX_TEXT_BYTES = 160;
const MAX_DOCUMENT_BYTES = 4096;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const requestKeys = {
  list: ['operation', 'workspaceId'],
  add: ['operation', 'workspaceId', 'revision', 'text'],
  update: ['operation', 'workspaceId', 'revision', 'id', 'text'],
  delete: ['operation', 'workspaceId', 'revision', 'id'],
};
const unavailable = () => new WorkbenchError('PROJECT_MEMORY_UNAVAILABLE', 'Project memory is unavailable.', 503);
const validText = value => typeof value === 'string' && value.length > 0 &&
  !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_TEXT_BYTES + 2;
const validId = value => typeof value === 'string' && UUID.test(value);
const privateMode = stat => process.platform === 'win32' || stat.uid === process.getuid() && !(stat.mode & 0o077);

export function installProjectMemory(ctx, manager) {
  const directory = path.join(manager.root, 'project-memory');
  const assertCurrent = () => manager.execution.assertUnchanged();
  const file = workspaceId => path.join(directory, createHash('sha256').update(workspaceId).digest('hex') + '.json');

  function checkDirectory() {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || !privateMode(stat) || fs.realpathSync(directory) !== directory) throw unavailable();
  }

  function read(workspaceId) {
    let fd;
    try {
      checkDirectory();
      fd = fs.openSync(file(workspaceId), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const stat = fs.fstatSync(fd), named = fs.lstatSync(file(workspaceId));
      if (!stat.isFile() || stat.nlink !== 1 || !privateMode(stat) || stat.size > MAX_DOCUMENT_BYTES ||
          named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) throw unavailable();
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const bytes = fs.readSync(fd, buffer, size, buffer.length - size, size);
        if (!bytes) break;
        size += bytes;
      }
      if (size !== stat.size) throw unavailable();
      const row = JSON.parse(buffer.subarray(0, size));
      if (row?.version !== 1 || row.workspaceId !== workspaceId || !validId(row.revision) ||
          !Array.isArray(row.entries) || row.entries.length > MAX_ENTRIES ||
          !row.entries.every(entry => validId(entry?.id) && validText(entry.text)) ||
          new Set(row.entries.map(entry => entry.id)).size !== row.entries.length) throw unavailable();
      return {version: 1, workspaceId, revision: row.revision, entries: row.entries.map(({id, text}) => ({id, text}))};
    } catch (error) {
      if (fd === undefined && error.code === 'ENOENT') return {version: 1, workspaceId, revision: null, entries: []};
      throw unavailable();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function operate(input) {
    assertCurrent();
    const {operation, workspaceId, revision, id} = input ?? {};
    const keys = Object.hasOwn(requestKeys, operation) ? requestKeys[operation] : null;
    if (!keys || Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key)) ||
        typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId))
      throw new WorkbenchError('PROJECT_MEMORY_INVALID', 'Invalid project memory request.', 400);
    if (!ctx.workspaceRegistry.get(workspaceId))
      throw new WorkbenchError('WORKSPACE_NOT_FOUND', 'Workspace not found.', 404);
    const current = read(workspaceId);
    if (operation === 'list') return current;
    if (revision !== current.revision)
      throw new WorkbenchError('PROJECT_MEMORY_STALE', 'Project memory changed. Refresh it and review your edit.', 409);
    const entries = current.entries;
    const index = validId(id) ? entries.findIndex(entry => entry.id === id) : -1;
    if (operation !== 'add' && index < 0)
      throw new WorkbenchError('PROJECT_MEMORY_ENTRY_NOT_FOUND', 'Decision not found in this workspace.', 404);
    if (operation === 'delete') {
      entries.splice(index, 1);
    } else {
      const value = typeof input.text === 'string' ? input.text.trim() : null;
      if (!validText(value))
        throw new WorkbenchError('PROJECT_MEMORY_TEXT_INVALID', 'Enter a short, single-line decision.', 400);
      if (operation === 'update') entries[index] = {id, text: value};
      else {
        if (entries.length >= MAX_ENTRIES)
          throw new WorkbenchError('PROJECT_MEMORY_FULL', 'This workspace already has five decisions.', 409);
        entries.push({id: randomUUID(), text: value});
      }
    }
    const next = {...current, revision: randomUUID(), entries};
    assertCurrent();
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    checkDirectory();
    atomicJson(file(workspaceId), next);
    return next;
  }

  const reply = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/workbench/project-memory', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (!sameRequestOrigin(request)) return reply({code: 'ORIGIN_REFUSED'}, 403);
      try {
        return reply(operate(await boundedJSON(request, MAX_DOCUMENT_BYTES)));
      } catch (error) {
        if (error instanceof WorkbenchError) return reply({code: error.code, error: error.message}, error.status);
        if (error instanceof SyntaxError) return reply({code: 'PROJECT_MEMORY_INVALID'}, 400);
        if (error.status === 413) return reply({code: 'TOO_LARGE'}, 413);
        return reply({code: 'PROJECT_MEMORY_UNAVAILABLE'}, 503);
      }
    },
  }));

  // A section is assembled for the request. SDK context contributions become
  // durable user-role snapshots, which would keep deleted or moved memory.
  ctx.systemPrompt.section({
    name: 'workspace-runtime:project-memory', order: 9900, interpolate: false,
    text(assembly) {
      try {
        assertCurrent();
        const agent = assembly.agent ?? ctx.agents.get(assembly.scope?.id);
        const id = agent?.session?.id;
        if (!id || ctx.agents.get(id) !== agent || ctx.workspaceRegistry.archivedSessionIds?.includes(id)) return '';
        const memberships = ctx.workspaceRegistry.list().filter(workspace => workspace.sessionIds.includes(id));
        if (memberships.length !== 1 || !WORKSPACE_ID.test(memberships[0].id)) return '';
        const {entries} = read(memberships[0].id);
        if (!entries.length) return '';
        return 'Confirmed decisions for this workspace (the current user request takes precedence):\n' +
          entries.map(entry => '- ' + JSON.stringify(entry.text)).join('\n');
      } catch {
        return '';
      }
    },
  });
}
