import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {requireProjectExecutionMode} from '../workspace/execution-mode-service.mjs';
import {changedSourcePaths,sourceChangeDiagnostic} from '../workspace/storage.mjs';
import {CHECK_ID_PATTERN, validCheckId} from './core.mjs';
import {finalizeCriteria} from './criteria.mjs';

export const name = 'qwen-quality-gates';
export const inject = ['tools', 'shell', 'shellEnv', 'projectExecutionMode'];
const DIR = path.dirname(fileURLToPath(import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const errorResult = (code, error) => ({ passed: false, complete: false, stale: false, code, error, checks: [] });

export async function executeVerification(ctx, args, execution, config = {}) {
  const mode=requireProjectExecutionMode(ctx),check=()=>{execution.signal.throwIfAborted();mode.assertTool(execution);};
  check();
  if (!['all','build','test','browser','acceptance'].includes(args.kind ?? 'all')) return errorResult('INVALID_KIND', 'Unknown verification kind.');
  const checkId = args.checkId;
  const targeted = checkId !== undefined;
  if (targeted && !validCheckId(checkId)) return errorResult('INVALID_CHECK_ID', 'Use an existing ID from the quality contract.');
  const target = targeted ? {checkId} : {};
  const accessSessionId = execution.agent.session.id;
  const review = await ctx.waterfall('workspace-runtime/review', { sessionId:accessSessionId,execution,includeSourceSnapshot:true }, () => undefined);
  check();
  if (!review?.root || !review.sourceHash || review.legacy === true) return errorResult('NO_MANAGED_PROJECT', 'Start an isolated managed project before verification.');
  const sessionId=review.sessionId??accessSessionId;
  const root = path.resolve(review.root), kind = args.kind ?? 'all';
  let result, report,serverChannel;
  try {
    if(mode.snapshot.mode==='isolated-guest'){
      check();
      const value=await ctx.waterfall('workspace-runtime/verify-command',{kind,...target,execution,projectRoot:root,sourceHash:review.sourceHash},()=>undefined);
      check();
      if(!value?.result)throw Object.assign(Error('PROJECT_RUNTIME_ISOLATION_UNAVAILABLE'),{code:'PROJECT_RUNTIME_ISOLATION_UNAVAILABLE'});
      result=value.result;
    }else{
      if (ctx.shell.sandboxMode === undefined) return errorResult('NO_PROJECT_SANDBOX', 'A filesystem-confining shell is required.');
      const runner = config.runnerPath ?? path.join(DIR, 'cli.mjs');
      const node = config.nodePath ?? '/data/harness/node/bin/node';
      const wrapper = config.wrapperPath ?? '/data/harness/app/development/project-run.cjs';
      if (![runner,node,wrapper].every(p => path.isAbsolute(p))) return errorResult('INVALID_RUNTIME_CONFIG', 'Runtime paths must be absolute.');
      const selector = targeted ? ['--check-id', checkId] : [];
      const command = 'exec ' + [node, wrapper, '--', node, runner, 'verify', '--workspace', root, '--kind', kind, ...selector].map(quote).join(' ');
      // Preserve the current host executor only under explicit host-compat.
      const values = ctx.shellEnv.collect(execution);
      const spec = ctx.shell.resolve({ command, workdir: root, timeoutMs: 120000, dshEnv: values, signal: execution.signal, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root } });
      let candidate;
      try{candidate=await ctx.waterfall('workspace-runtime/browser-server-channel',{execution,projectRoot:root,sourceHash:review.sourceHash,kind,...target,deadline:Date.now()+110000},()=>undefined);}
      catch(error){if(error.code!=='BROWSER_SERVER_CHANNEL_UNAVAILABLE')throw error;}
      if(candidate?.envelope&&typeof candidate.attach==='function'&&typeof candidate.close==='function'){
        serverChannel=candidate;spec.stdin=JSON.stringify(candidate.envelope);spec.env={...spec.env,HARNESS_QUALITY_SERVER_CHANNEL:'1'};
      }
      check();
      // Once started, await actual quiescence even if policy changes while
      // execute/result is pending; do not abandon an owned process handle.
      const process=await ctx.shell.execute(spec),owned=serverChannel?serverChannel.attach(process):process,outcome=process.result();
      void outcome.catch(()=>{});
      // Private trusted event only: the controller can retain this exact owned
      // verifier range for bounded cleanup. No model/HTTP handle or PID input.
      try {
        if(execution.callId?.startsWith('automatic-review-'))await ctx.serial('workspace-runtime/verification-process',{execution,projectRoot:root,sourceHash:review.sourceHash,process:owned});
        result=await outcome;
        if(serverChannel)await owned.done;
      }catch(error){
        if(typeof owned.kill==='function')owned.kill();
        if(owned.done)await owned.done;
        // Always observe the foreground projection, including hook failure.
        await outcome.catch(()=>{});throw error;
      }
      check();
    }
    if (execution.signal.aborted || result.aborted) throw execution.signal.reason ?? Error('Verification cancelled.');
    if(result.stdout?.truncated||typeof result.stdout?.text!=='string'||Buffer.byteLength(result.stdout.text)>1024*1024)throw Error('QUALITY_OUTPUT_INCOMPLETE');
    // CLI owns stdout. Project programs are captured in bounded project log files.
    report = JSON.parse(result.stdout.text.trim());
    if (!report || typeof report.passed !== 'boolean' || typeof report.complete !== 'boolean' || !Array.isArray(report.checks)) throw Error('Invalid quality runner response.');
    if (targeted && !(report.passed === false && report.checks.length === 0 && !report.reportPath)) {
      if (report.checkId !== checkId || report.complete !== false || report.checks.length !== 1 ||
          report.checks[0]?.id !== checkId || typeof report.runId !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(report.runId) ||
          report.reportPath !== '.harness/quality/targeted/' + report.runId + '/report.json')
        throw Error('Invalid targeted quality runner response.');
    }
  } catch (e) {
    if (execution.signal.aborted) throw e;
    check();
    report = errorResult('QUALITY_RUNNER_FAILED', e.message);
  }finally{await serverChannel?.close();}
  const after = await ctx.waterfall('workspace-runtime/review', { sessionId:accessSessionId,execution,includeSourceSnapshot:true }, () => undefined);
  check();
  const runnerPassed = report.passed;
  const runnerConfirmed = result?.exitCode === (runnerPassed ? 0 : 1) && !result?.timedOut && !result?.aborted;
  const stale = !after || after.root !== review.root || after.sourceHash !== review.sourceHash || report.stale;
  if (stale) {
    report.passed = false; report.complete = false; report.stale = true; report.code = 'STALE_SOURCE';
    const sourceChanges = changedSourcePaths(review.sourceSnapshot,after?.sourceSnapshot);
    if (sourceChanges !== undefined) report.sourceChanges = sourceChanges;
    report.error = sourceChangeDiagnostic(sourceChanges);
  }
  if (result?.exitCode !== 0 || result?.timedOut) { report.passed = false; report.complete = false; }
  if (result?.timedOut) report.timedOut = true;
  if (typeof report.sourceHash === 'string') report.runnerSourceHash = report.sourceHash;
  report.criteria = finalizeCriteria(report, {projectSourceHash:review.sourceHash, outcome:stale?'stale':runnerConfirmed&&!targeted?'current':'unknown'});
  if (targeted) return { ...report, checkId, complete: false, criteriaConfirmed:false, sourceHash: review.sourceHash };
  const failed = report.checks.filter(c => !c.passed).flatMap(c => c.diagnostics ?? []);
  try { check();await ctx.serial('workspace-runtime/verification', {
    sessionId, kind, exitCode: report.passed ? 0 : 1,
    diagnostics: [report.code, report.error, ...failed].filter(Boolean).slice(0,12).join('; ').slice(0,1500),
    sourceHash: review.sourceHash,
    sourceSnapshot: review.sourceSnapshot,
    checksPassed: report.checks.reduce((n,c) => n + (c.checksPassed ?? 0), 0),
    checksTotal: Math.max(1, report.checks.reduce((n,c) => n + (c.checksTotal ?? 1), 0)),
    artifactPaths: report.checks.flatMap(c => c.artifactPaths ?? []).slice(0,32), signal: execution.signal,
    verificationCallId:execution.callId,
    criteriaReport:{sourceHash:report.sourceHash,runnerSourceHash:report.runnerSourceHash,contractHash:report.contractHash,stale:report.stale,checks:report.checks,criteria:report.criteria},
  });check(); } catch (e) {
    if (execution.signal.aborted) throw e;
    check();
    return { ...report, passed: false, complete: false, criteriaConfirmed:false, criteria:finalizeCriteria(report,{projectSourceHash:review.sourceHash,outcome:e.code==='STALE_VERIFICATION'?'stale':'unknown'}), sourceHash: review.sourceHash, code: e.code ?? 'VERIFICATION_NOT_ACCEPTED', error: e.message,
      ...(e.code === 'STALE_VERIFICATION' ? {stale:true} : {}),
      ...(e.sourceChanges ? {sourceChanges:e.sourceChanges} : {}) };
  }
  return { ...report, criteriaConfirmed:runnerConfirmed&&!stale, sourceHash: review.sourceHash };
}

export function apply(ctx, config = {}) {
  const mode=requireProjectExecutionMode(ctx);
  ctx.tools.register({
    name: 'verify_project',
    description: mode.snapshot.mode==='isolated-guest'?'Verify the current project through its isolated guest executor against .harness-quality.json. Guest contract documentation is /opt/homeai/quality/README.md. Requires the trusted workspace verifier; unavailable integration fails closed. Uses real exit codes and Chromium, rejects zero-test or stale success and reports to the workspace repair budget. Require complete:true for all required stages. This does not install dependencies or change model settings.':'Verify the current isolated project against .harness-quality.json. Installed contract and browser-plan schema: /data/harness/app/quality/README.md. Read that file directly before declaring checks or browser plans. Declare build/test/browser/acceptance checks early, then verify a small working slice before expanding. Uses real exit codes and real Chromium, rejects zero-test or stale success, saves compact evidence under .harness/quality/, and reports to the single workspace repair budget. A passing stage is not full completion: require complete:true for all required stages. Missing browser is BLOCKED, never a simulated pass. This does not install dependencies or change model settings.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['all','build','test','browser','acceptance'] },
      checkId: { type: 'string', pattern: CHECK_ID_PATTERN, description: 'After fixing a failure, use its returned retry.checkId to run only that existing contract check. This never completes a kind or the final verification.' },
    }, additionalProperties: false },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'object', properties: { passed: { type: 'boolean' }, complete: { type: 'boolean' }, stale: { type: 'boolean' }, checks: { type: 'array', items: {} } }, required: ['passed','complete','stale','checks'], additionalProperties: true },
      render: (_args, report) => [{ type: 'text', text: JSON.stringify(report) }],
    },
    execute: (args, execution) => executeVerification(ctx, args, execution, config),
  });
}
