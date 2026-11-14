// Connection already authenticates owner Peers and validates the physical
// Host/Origin. Preserve a second mutation fence using its forwarded Host,
// rather than the synthetic http://dsh.internal Fetch URL.
export function sameRequestOrigin(request) {
  try {
    const origin = new URL(request.headers.get('origin')), host = request.headers.get('host');
    if (!host || !['http:', 'https:'].includes(origin.protocol)) return false;
    return origin.host === new URL(origin.protocol + '//' + host).host;
  } catch { return false; }
}
export async function boundedJSON(request, limit = 6 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw Object.assign(Error('Request too large.'), { code: 'TOO_LARGE', status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
