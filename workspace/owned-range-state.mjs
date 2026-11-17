// In-process provenance only, never a config/SDK-service capability assertion.
const providers=new WeakSet();
export const registerOwnedRangeProvider=provider=>providers.add(provider);
export const hasOwnedRangeProvider=provider=>!!provider&&providers.has(provider[Symbol.for('cordis.original')]??provider);
