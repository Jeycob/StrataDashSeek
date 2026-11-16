import path from 'node:path';

export const name = 'qwen-quality-gates';
export const inject = ['tools'];
const errorResult = (code, error) => ({ passed: false, complete: false, stale: false, code, error, checks: [] });

export async function executeVerification(ctx, args, execution, config = {}) {
  if (!['all','build','test','browser','acceptance'].includes(args.kind ?? 'all')) return errorResult('INVALID_KIND', 'Unknown verification kind.');
  const accessSessionId = execution.agent.session.id;
  const review = await ctx.waterfall('workspace-runtime/review', { sessionId:accessSessionId, execution }, () => undefined);
  if (!review?.root || !review.sourceHash || review.legacy === true) return errorResult('NO_MANAGED_PROJECT', 'Start an isolated managed project before verification.');
  const sessionId=review.sessionId??accessSessionId;
  const root = path.resolve(review.root), kind = args.kind ?? 'all';
  let result, report;
  try {
    // Workspace owns the exact guest toolchain and existing SDK lifetime. No
    // project-controlled command is ever executed by a host shell here.
    const value=await ctx.waterfall('workspace-runtime/verify-command',{kind,execution,projectRoot:root,sourceHash:review.sourceHash},()=>undefined);
    if(!value?.result)throw Error('PROJECT_RUNTIME_ISOLATION_UNAVAILABLE');
    result=value.result;
    if (execution.signal.aborted || result.aborted) throw execution.signal.reason ?? Error('Verification cancelled.');
    if(result.stdout?.truncated||typeof result.stdout?.text!=='string'||Buffer.byteLength(result.stdout.text)>1024*1024)throw Error('QUALITY_OUTPUT_INCOMPLETE');
    // CLI owns stdout. Project programs are captured in bounded project log files.
    report = JSON.parse(result.stdout.text.trim());
    if (!report || typeof report.passed !== 'boolean' || typeof report.complete !== 'boolean' || !Array.isArray(report.checks)) throw Error('Invalid quality runner response.');
  } catch (e) {
    if (execution.signal.aborted) throw e;
    report = errorResult('QUALITY_RUNNER_FAILED', e.message);
  }
  const after = await ctx.waterfall('workspace-runtime/review', { sessionId:accessSessionId, execution }, () => undefined);
  const stale = !after || after.root !== review.root || after.sourceHash !== review.sourceHash || report.stale;
  if (stale) { report.passed = false; report.complete = false; report.stale = true; report.code = 'STALE_SOURCE'; }
  if (result?.exitCode !== 0 || result?.timedOut) { report.passed = false; report.complete = false; }
  if (result?.timedOut) report.timedOut = true;
  const failed = report.checks.filter(c => !c.passed).flatMap(c => c.diagnostics ?? []);
  try { await ctx.serial('workspace-runtime/verification', {
    sessionId, kind, exitCode: report.passed ? 0 : 1,
    diagnostics: [report.code, report.error, ...failed].filter(Boolean).slice(0,12).join('; ').slice(0,1500),
    sourceHash: review.sourceHash,
    checksPassed: report.checks.reduce((n,c) => n + (c.checksPassed ?? 0), 0),
    checksTotal: Math.max(1, report.checks.reduce((n,c) => n + (c.checksTotal ?? 1), 0)),
    artifactPaths: report.checks.flatMap(c => c.artifactPaths ?? []).slice(0,32), signal: execution.signal,
  }); } catch (e) {
    if (execution.signal.aborted) throw e;
    return { ...report, passed: false, complete: false, sourceHash: review.sourceHash, code: e.code ?? 'VERIFICATION_NOT_ACCEPTED', error: e.message };
  }
  return { ...report, sourceHash: review.sourceHash };
}

export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'verify_project',
    description: 'Verify the current isolated project against .harness-quality.json. Installed guest contract and browser-plan schema: /opt/homeai/quality/README.md (read with project_exec). Declare build/test/browser/acceptance checks early, then verify a small working slice before expanding. Uses the same isolated executor as project_exec, real exit codes and real Chromium; rejects zero-test or stale success, saves evidence under .harness/quality/, and reports to the single workspace repair budget. A passing stage is not full completion: require complete:true for all required stages. Missing toolchain or browser is BLOCKED. This does not install dependencies or change model settings.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['all','build','test','browser','acceptance'] } }, additionalProperties: false },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'object', properties: { passed: { type: 'boolean' }, complete: { type: 'boolean' }, stale: { type: 'boolean' }, checks: { type: 'array', items: {} } }, required: ['passed','complete','stale','checks'], additionalProperties: true },
      render: (_args, report) => [{ type: 'text', text: JSON.stringify(report) }],
    },
    execute: (args, execution) => executeVerification(ctx, args, execution, config),
  });
}
