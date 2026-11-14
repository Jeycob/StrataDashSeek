import fs from 'node:fs/promises';
import path from 'node:path';

export const name = 'isolated-native-files';
export const inject = ['typert', 'workspaceFiles'];

export function registryReader(file, maxBytes = 8 * 1024 * 1024) {
  let stamp, cached, pending;
  return async () => {
    const info = await fs.stat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return { sessions: {}, trash: {} };
    if (!info.isFile() || info.size > maxBytes) throw Error('Invalid managed project registry');
    const next = [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    if (next === stamp && cached) return cached;
    if (pending?.stamp === next) return pending.value;
    const value = fs.readFile(file, 'utf8').then(JSON.parse).then(data => {
      if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw Error('Invalid managed project registry');
      stamp = next;
      cached = data;
      return data;
    });
    pending = { stamp: next, value };
    try { return await value; }
    finally { if (pending?.value === value) pending = undefined; }
  };
}

export function managedFileScope(base, readRegistry) {
  return async sessionId => {
    // Keep the Native provider's session existence rules. Gateway authorization
    // remains attached to the original resource: 'session' declaration.
    const scope = await base.resolve(sessionId);
    if (!scope) return undefined;
    const data = await readRegistry();
    if (Object.hasOwn(data.trash ?? {}, sessionId)) return undefined;
    const record = Object.hasOwn(data.sessions, sessionId) ? data.sessions[sessionId] : undefined;
    if (!record) return scope;
    if (typeof record.root !== 'string' || !path.isAbsolute(record.root)) throw Error('Managed project root is unavailable');
    return { ...scope, workspaceRoot: record.root };
  };
}

export async function apply(ctx, config = {}) {
  const base = ctx.typert.lookups.get('workspaceFileScope');
  if (!base) throw Error('The Native workspace file scope is unavailable');
  const readRegistry = registryReader(config.registryFile ?? '/data/harness/state/workbench/registry.json');
  // Official composition override: preserve the provider's wire schema,
  // authorization resource, file service and its containment/watch semantics.
  ctx.typert.lookups.configure('workspaceFileScope', managedFileScope(base, readRegistry));
}
