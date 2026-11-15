function failure(status, code) {
  return Object.assign(new Error(code), {status, code});
}

// Count bytes while reading; neither Content-Length nor decoded string length
// is an authority for an authentication request's memory allowance.
export async function boundedJSON(request, {maxBytes = 1024, timeoutMs = 5000} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid request limits');
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    throw failure(413, 'BODY_TOO_LARGE');
  }
  const reader = request.body?.getReader();
  if (!reader) throw failure(400, 'INVALID_JSON');
  let timer, rejectWait, abort, complete = false;
  const interrupted = new Promise((_, reject) => { rejectWait = reject; });
  timer = setTimeout(() => rejectWait(failure(408, 'BODY_TIMEOUT')), timeoutMs);
  abort = () => rejectWait(failure(408, 'BODY_ABORTED'));
  request.signal?.addEventListener('abort', abort, {once: true});
  if (request.signal?.aborted) abort();
  try {
    const chunks = []; let size = 0;
    while (true) {
      const {value, done} = await Promise.race([reader.read(), interrupted]);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw failure(400, 'INVALID_BODY');
      size += value.byteLength;
      if (size > maxBytes) throw failure(413, 'BODY_TOO_LARGE');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
    catch { throw failure(400, 'INVALID_JSON'); }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    // A malicious producer's cancel hook may never settle. Do not await it.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
