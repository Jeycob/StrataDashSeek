// Task-independent first-check guidance. This neither invents acceptance tests
// nor changes source, verification results, permissions or the repair budget.
export const FIRST_CHECK_AFTER_STEPS = 8;
export const FIRST_CHECK_GUIDANCE = '[Harness: verify a small working slice]\nApplication code has changed without a completed functional check. Before expanding the implementation or polishing the interface, verify one small useful behavior end to end: action or request, validation, persistence where applicable, and response. Cover its success and one failure using isolated test data. For a stateful app or UI, isolated calculation tests do not prove its main user-facing path. Declare an authentic small check with the installed .harness-quality.json format and use verify_project. A syntax check or successful build alone does not establish functional correctness. Before delivery, verify the documented install/seed/start/test entrypoints and provide runnable instructions. Where authentication is requested, test malformed proofs of different byte lengths and require controlled rejection without a server error. Where localized sorting is requested, retain independent locale-aware expectations including accents instead of matching database defaults. Read current files and installed signatures before edits or unfamiliar calls. Register resource cleanup before assertions and give I/O requests deadlines. Preserve real failures; do not weaken assertions or force test processes to exit.';
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

export function needsStageBudgetWarning(record, budget, limit) {
  if (record.legacy || budget.blocked || !Number.isSafeInteger(limit) || limit < 1) return false;
  const stage = budget.stage ?? 1, remaining = limit - budget.steps;
  const previous = record.stageBudgetWarningInspection;
  return remaining >= 0 && remaining <= Math.min(10, Math.ceil(limit / 5))
    && record.stageBudgetWarningStage !== stage
    && !(previous?.stage === stage && budget.steps < previous.step + 4);
}

// An advisory before the existing hard stop. It neither extends the stage nor
// changes a verification result, checkpoint, permission or application file.
export async function warnStageBudget(manager, agent, record, budget, limit, signal, accessSession = agent.session) {
  if (!needsStageBudgetWarning(record, budget, limit)) return false;
  signal?.throwIfAborted();
  try { if (manager.ctx.sandboxPolicy?.resolve({ session: accessSession }).mode === 'read-only') return false; }
  catch { return false; } // Optional guidance must not fail the actual task.
  const stage = budget.stage ?? 1;
  record.stageBudgetWarningInspection = { stage, step: budget.steps };
  let summary;
  try { summary = await manager.changes.list(agent.id, record, { signal }); }
  catch (error) { signal?.throwIfAborted(); manager.ctx.logger?.warn('Stage-budget guidance unavailable: ' + (error.code ?? 'CHANGES_UNAVAILABLE')); return false; }
  signal?.throwIfAborted();
  if (budget.blocked || budget.stage !== undefined && budget.stage !== stage || record.stageBudgetWarningStage === stage || !changedApplicationCode(summary.files)) return false;
  const diagnostics = manager.pendingDiagnostics.get(agent.id) ?? new Map();
  if (diagnostics.size >= 4) return false; // Preserve pending failure diagnostics.
  diagnostics.set('STAGE_BUDGET_WARNING', `[Harness: stage budget approaching]\n${limit - budget.steps} steps remain in stage ${stage} (${budget.steps}/${limit}). Stop expanding scope and complete the next declared verification milestone with real results. Read /data/harness/app/quality/README.md directly for verify_project and browser-plan schemas. Verify the project's required behavior, including its UI/API path when applicable; a build or isolated unit subset is not evidence for other required stages. Inspect pending browser requests and release only owned resources. Do not rerun unrelated passing checks to reset the budget, raise the limit, suppress failures or claim unverified success. Preserve a truthful delivery report and runnable entrypoints.`);
  manager.pendingDiagnostics.set(agent.id, diagnostics); record.stageBudgetWarningStage = stage;
  return true;
}
