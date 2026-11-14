import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'qwen-quality-gates';
export const inject = ['tools', 'shell', 'shellEnv'];
const DIR = path.dirname(fileURLToPath(import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const errorResult = (code, error) => ({ passed: false, complete: false, stale: false, code, error, checks: [] });

export async function executeVerification(ctx, args, execution, config = {}) {
  if (!['all','build','test','browser','acceptance'].includes(args.kind ?? 'all')) return errorResult('INVALID_KIND', 'Unknown verification kind.');
  const sessionId = execution.agent.session.id;
  const review = await ctx.waterfall('workspace-runtime/review', { sessionId }, () => undefined);
  if (!review?.root || !review.sourceHash) return errorResult('NO_MANAGED_PROJECT', 'Start an isolated managed project before verification.');
  if (ctx.shell.sandboxMode === undefined) return errorResult('NO_PROJECT_SANDBOX', 'A filesystem-confining shell is required.');
  const root = path.resolve(review.root), kind = args.kind ?? 'all';
  const runner = config.runnerPath ?? path.join(DIR, 'cli.mjs');
  const node = config.nodePath ?? '/data/harness/node/bin/node';
  const wrapper = config.wrapperPath ?? '/data/harness/app/development/project-run.cjs';
  if (![runner,node,wrapper].every(p => path.isAbsolute(p))) return errorResult('INVALID_RUNTIME_CONFIG', 'Runtime paths must be absolute.');
  const command = 'exec ' + [node, wrapper, '--', node, runner, 'verify', '--workspace', root, '--kind', kind].map(quote).join(' ');
  const values = { ...ctx.shellEnv.collect(execution), HARNESS_QUALITY_ALLOWED_PORTS: (review.ports ?? []).join(',') };
  let result, report;
  try {
    const spec = ctx.shell.resolve({ command, workdir: root, timeoutMs: 120000, dshEnv: values, signal: execution.signal, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root } });
    result = await (await ctx.shell.execute(spec)).result();
    if (execution.signal.aborted || result.aborted) throw execution.signal.reason ?? Error('Verification cancelled.');
    // CLI owns stdout. Project programs are captured in bounded project log files.
    report = JSON.parse(result.stdout.text.trim());
    if (!report || typeof report.passed !== 'boolean' || typeof report.complete !== 'boolean' || !Array.isArray(report.checks)) throw Error('Invalid quality runner response.');
  } catch (e) {
    if (execution.signal.aborted) throw e;
    report = errorResult('QUALITY_RUNNER_FAILED', e.message);
  }
  const after = await ctx.waterfall('workspace-runtime/review', { sessionId }, () => undefined);
  const stale = !after || after.root !== review.root || after.sourceHash !== review.sourceHash || report.stale;
  if (stale) { report.passed = false; report.complete = false; report.stale = true; report.code = 'STALE_SOURCE'; }
  if (result?.exitCode !== 0 || result?.timedOut) { report.passed = false; report.complete = false; }
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
    description: 'Verify the current isolated project against .harness-quality.json. Declare build/test/browser/acceptance checks early, then verify a small working slice before expanding. Uses real exit codes and real Chromium, rejects zero-test or stale success, saves compact evidence under .harness/quality/, and reports to the single workspace repair budget. A passing stage is not full completion: require complete:true for all required stages. Missing browser is BLOCKED, never a simulated pass. This does not install dependencies or change model settings.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['all','build','test','browser','acceptance'] } }, additionalProperties: false },
    isConcurrencySafe: false,
    output: {
      schema: { type: 'object', properties: { passed: { type: 'boolean' }, complete: { type: 'boolean' }, stale: { type: 'boolean' }, checks: { type: 'array', items: {} } }, required: ['passed','complete','stale','checks'], additionalProperties: true },
      render: (_args, report) => [{ type: 'text', text: JSON.stringify(report) }],
    },
    execute: (args, execution) => executeVerification(ctx, args, execution, config),
  });
}
