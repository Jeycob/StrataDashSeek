// Task-independent first-check guidance. This neither invents acceptance tests
// nor changes source, verification results, permissions or the repair budget.
export const FIRST_CHECK_AFTER_STEPS = 8;
export const STARTUP_CHECK_GUIDANCE = 'For code changes, declare .harness-quality.json early. Use verify_project to check the requested behavior through its real entry point. For a CLI or data task, run it on an example and check the result. For a UI, exercise the user flow in a browser with assertions and a screenshot.';
export const QUALITY_CONTRACT_EXAMPLE = {version:1,sources:['index.html','server.mjs','tests'],requiredKinds:['test','browser'],checks:[{id:'unit',kind:'test',command:['node','--test','tests/core.test.mjs']},{id:'ui',kind:'browser',plan:'.harness-browser.json',timeoutMs:120000,server:{command:['node','server.mjs']}}]};
export const BROWSER_PLAN_EXAMPLE = {version:1,baseURL:'http://127.0.0.1:${PORT}',viewports:[{name:'desktop',width:1280,height:720}],flows:[{name:'main',steps:[{action:'goto',path:'/'},{action:'expect',selector:'h1',minCount:1},{action:'checkpoint',name:'main'}]}]};
export const FIRST_CHECK_GUIDANCE = '[Harness: verify a small working slice]\n'
  + 'Run the smallest check that exercises the requested behavior. For a CLI or data task, check its actual output on a known input. For a UI, test a user flow, including failure and persistence where relevant. These examples show a web project:\n'
  + '.harness-quality.json: '+JSON.stringify(QUALITY_CONTRACT_EXAMPLE)+'\n'
  + '.harness-browser.json: '+JSON.stringify(BROWSER_PLAN_EXAMPLE)+'\n'
  + 'Create referenced files first. sources lists only existing app/test files or directories; package.json is not required for single HTML. Required kinds and assertions must cover the task. Commands are direct argv; use actual installed tools. IDs/names match ^[a-z][a-z0-9_-]{0,63}$. Viewports have only name,width,height (integer width 320–2560, height 240–2160). Actions: goto,click,fill,press,expect,checkpoint; no waitMs. timeoutMs is at most 120000. Replace the example h1 assertion with meaningful application behavior. Use the declared owned server on the assigned PORT. Write screenshots/logs/test output under .harness/quality/, outside sources; keep app/test code in sources. Use verify_project; preserve real failures and cleanup before assertions. Do not weaken assertions. Before delivery verify runnable entrypoints and the requested behavior, including negative authentication and locale checks where relevant.';
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
  diagnostics.set('STAGE_BUDGET_WARNING', `[Harness: stage budget approaching]\n${limit - budget.steps} steps remain in stage ${stage} (${budget.steps}/${limit}). Complete the next real verification milestone before expanding scope. Only source-bound verify_project renews a managed stage; raw shell checks retain their actual results but cannot prove before/after source identity. Automatic checks use the project contract; failures get a bounded repair window and never renew total task steps. Read /data/harness/app/quality/README.md for schemas. Verify required UI/API behavior; a build or unit subset is not full completion. Do not repeat unchanged checks, raise limits, weaken assertions or claim unverified success. Preserve current files and runnable entrypoints.`);
  manager.pendingDiagnostics.set(agent.id, diagnostics); record.stageBudgetWarningStage = stage;
  return true;
}
