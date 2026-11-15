// Task-independent first-check guidance. This neither invents acceptance tests
// nor changes source, verification results, permissions or the repair budget.
export const FIRST_CHECK_AFTER_STEPS = 8;
export const FIRST_CHECK_GUIDANCE = '[Harness: verify a small working slice]\nApplication code has changed without a completed functional check. Before expanding the implementation or polishing the interface, verify one small useful behavior end to end: action or request, validation, persistence where applicable, and response. Cover its success and one failure using isolated test data. Declare an authentic small check with the installed .harness-quality.json format and use verify_project. A syntax check or successful build alone does not establish functional correctness. Read current files and installed signatures before edits or unfamiliar calls. Register resource cleanup before assertions and give I/O requests deadlines. Preserve real failures; do not weaken assertions or force test processes to exit.';
const CODE = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements(?:\.[^/]+)?\.txt|Dockerfile|Cargo\.toml|go\.mod)$|\.(?:[cm]?[jt]sx?|py|cs|csproj|go|rs|java|html|vue|svelte|rb|php|sql|sh|c|h|cpp|hpp)$/iu;
const hasFunctionalCheck = budget => ['test', 'browser', 'acceptance', 'all'].some(kind => Object.hasOwn(budget.checks ?? {}, kind));

export function needsFirstCheck(record, budget) {
  return !record.legacy && !record.firstCheckGuided && !budget.blocked
    && budget.steps >= FIRST_CHECK_AFTER_STEPS && !hasFunctionalCheck(budget)
    && budget.steps >= (record.firstCheckInspectedAtStep ?? -4) + 4;
}
export function changedApplicationCode(files) {
  return Array.isArray(files) && files.some(file => typeof file.path === 'string' && CODE.test(file.path));
}

export async function guideFirstCheck(manager, agent, record, budget, signal) {
  if (!needsFirstCheck(record, budget)) return false;
  record.firstCheckInspectedAtStep = budget.steps;
  // Read the same bounded filesystem tracking used by Changes. It captures shell
  // writes too and avoids nudging an unchanged repository or a prose-only task.
  let summary;
  try { summary = await manager.changes.list(agent.id, record, { signal }); }
  catch (error) { signal?.throwIfAborted(); manager.ctx.logger?.warn('First-check guidance unavailable: ' + (error.code ?? 'CHANGES_UNAVAILABLE')); return false; }
  signal?.throwIfAborted();
  if (record.firstCheckGuided || budget.blocked || hasFunctionalCheck(budget) || !changedApplicationCode(summary.files)) return false;
  const diagnostics = manager.pendingDiagnostics.get(agent.id) ?? new Map();
  diagnostics.set('FIRST_FUNCTIONAL_CHECK', FIRST_CHECK_GUIDANCE);
  while (diagnostics.size > 4) diagnostics.delete(diagnostics.keys().next().value);
  manager.pendingDiagnostics.set(agent.id, diagnostics); record.firstCheckGuided = true;
  return true;
}
