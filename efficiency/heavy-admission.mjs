// Shared root-scoped checks called directly by the scheduler, never a second
// tools/execute listener or a second queue. Registration order cannot bypass
// reconciliation before the existing FairGate.acquire.
import {requireProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
const roots = new WeakMap();
const key = ctx => ctx.root ?? ctx;
const unavailable = () => Object.assign(Error('WORKSPACE_HEAVY_ADMISSION_UNAVAILABLE'), { code: 'WORKSPACE_HEAVY_ADMISSION_UNAVAILABLE' });
export function registerWorkspaceHeavyAdmission(ctx, check, { name = 'workspace-runtime' } = {}) {
  if (typeof check !== 'function' || typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw unavailable();
  const root = key(ctx);
  let slots = roots.get(root);
  if (!slots) { slots = new Map(); roots.set(root, slots); }
  if (slots.get(name)?.check) throw Error('WORKSPACE_HEAVY_ADMISSION_ALREADY_REGISTERED');
  const entry = { check }; slots.set(name, entry);
  return () => {
    // Keep a required closed slot across unload: otherwise orphaned receipts
    // could become invisible before a replacement workspace plugin loads.
    if (slots.get(name) === entry) entry.check = null;
  };
}
export async function checkWorkspaceHeavyAdmission(ctx, execution) {
  execution.signal.throwIfAborted();
  const mode=requireProjectExecutionMode(ctx);
  await mode.beforeHeavy(execution);
  mode.assertTool(execution);
  const slots = roots.get(key(ctx));
  if (!slots) return; // Standalone efficiency composition has no workspace.
  for (const [name, entry] of slots) {
    if (!entry.check) throw unavailable();
    await entry.check(execution);
    execution.signal.throwIfAborted();
    mode.assertTool(execution);
    if (slots.get(name) !== entry || !entry.check) throw unavailable();
  }
  mode.assertTool(execution);
}
