import path from 'node:path';
import { relativeFile, WorkbenchError } from './policy.mjs';

async function presentedPath(ctx, sessionId, query, signal) {
  const seq = Number(query.get('seq')), index = Number(query.get('index'));
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId ?? '') ||
      [...query.keys()].sort().join(',') !== 'index,seq,sessionId' ||
      String(seq) !== query.get('seq') || String(index) !== query.get('index') ||
      !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(index) || index < 0) {
    throw new WorkbenchError('INVALID_DELIVERY', 'Invalid presented file coordinates.', 400);
  }
  const { target, session } = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal);
  const files = target.type === 'deliverables/presented' && target.seq === seq ? target.data?.files : null;
  const file = session.id === sessionId && Array.isArray(files) ? files[index] : null;
  if (typeof file?.path !== 'string' || !file.path.trim()) {
    throw new WorkbenchError('DELIVERY_NOT_FOUND', 'Presented file not found in this conversation.', 404);
  }
  if (path.isAbsolute(file.path)) return file.path;
  if (typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd)) {
    throw new WorkbenchError('DELIVERY_NOT_FOUND', 'The presented file location is unavailable.', 404);
  }
  return path.join(session.cwd, relativeFile(file.path));
}

export async function workspaceDownload(ctx, manager, request) {
  const query = new URL(request.url).searchParams, id = query.get('sessionId');
  const presented = query.has('seq') || query.has('index');
  const file = presented ? await presentedPath(ctx, id, query, request.signal) : query.get('path');
  const value = await manager.files(id, 'download', { path: file }, request.signal, { presented });
  return new Response(value.bytes, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.name),
    'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff',
  } });
}
