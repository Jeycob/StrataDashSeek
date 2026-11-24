// Installed before the Native browser modules. Each tab keeps at most two small
// ciphertexts. The decryption key is only supplied to a verified owner.
(() => {
  const expected = globalThis.__HOMEAI_CHAT_CACHE_SCOPE__;
  if (typeof expected !== 'string' || !/^[a-f0-9]{32}$/.test(expected)) return;

  const limits = { titles: 96 * 1024, previews: 192 * 1024 };
  const pending = new Map();
  let currentGeneration, confirmation, approved;
  let key;
  addEventListener('pagehide', () => {
    currentGeneration = confirmation = approved = key = undefined;
    pending.clear();
  });

  async function scope(generation) {
    if (generation === null || generation === undefined) return null;
    if (confirmation && currentGeneration === generation) return confirmation;
    currentGeneration = generation;
    approved = null;
    const request = (async () => {
      try {
        const response = await fetch('/api/workbench/chat-cache-scope', {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return null;
        const payload = await response.json();
        if (payload.id !== expected || !/^[a-f0-9]{32}$/.test(payload.scope)) return null;
        if (currentGeneration !== generation) return null;
        approved = payload.scope;
        return approved;
      } catch {
        return null;
      }
    })();
    confirmation = request;
    return request;
  }

  function storageKey(name) { return 'homeai.chat-cache.v1.' + name; }
  function allowed(value, name) {
    return typeof value === 'string' && value === approved && Object.hasOwn(limits, name);
  }
  function aesKey() {
    const bytes = Uint8Array.from(approved.match(/../g), byte => parseInt(byte, 16));
    return key ??= crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  function encode(bytes) {
    let chars = '';
    for (let i = 0; i < bytes.length; i += 8192) chars += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(chars);
  }
  function params(iv, name) {
    return { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(storageKey(name)) };
  }
  async function read(value, name) {
    if (!allowed(value, name)) return null;
    try {
      const entry = sessionStorage.getItem(storageKey(name));
      if (!entry || entry.length > Math.ceil((limits[name] + 28) / 3) * 4) return null;
      const bytes = Uint8Array.from(atob(entry), char => char.charCodeAt(0));
      if (bytes.length < 28) return null;
      const decoded = await crypto.subtle.decrypt(params(bytes.subarray(0, 12), name), await aesKey(), bytes.subarray(12));
      return allowed(value, name) ? JSON.parse(new TextDecoder().decode(decoded)) : null;
    } catch { return null; }
  }
  async function write(value, name, data) {
    if (!allowed(value, name)) return;
    const latest = Symbol();
    pending.set(name, latest);
    try {
      const plain = new TextEncoder().encode(JSON.stringify(data));
      if (plain.length > limits[name]) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(params(iv, name), await aesKey(), plain);
      if (!allowed(value, name) || pending.get(name) !== latest) return;
      const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
      bytes.set(iv);
      bytes.set(new Uint8Array(ciphertext), iv.length);
      sessionStorage.setItem(storageKey(name), encode(bytes));
    } catch { /* Optional tab storage or WebCrypto can be unavailable. */ }
  }
  function clear(value, name) {
    if (!allowed(value, name)) return;
    pending.delete(name);
    try { sessionStorage.removeItem(storageKey(name)); } catch { /* Storage disabled. */ }
  }
  globalThis.__HOMEAI_CHAT_CACHE_ACCESS__ = Object.freeze({ scope, read, write, clear });
})();
