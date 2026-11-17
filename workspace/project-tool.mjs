import path from 'node:path';
import fs from 'node:fs/promises';
import { WorkbenchError, within } from './policy.mjs';
import { normalizeVerificationCommand, nodeTestCommandRecipe } from './tool-recovery.mjs';
import { createProjectProcessStarter, projectBackgroundSchema, projectJobLifetime, renderProjectBackground } from './project-process.mjs';
import {bindProjectExecution} from './execution-mode.mjs';
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
export const projectCommandParameters = { type: 'object', properties: { command: { type: 'string', description: 'Run verification as a single direct foreground command, or use verify_project. Output is already bounded by Harness; do not add grep/head/tail pipes, log redirections, status echoes or force-exit just to shorten it. Read retained diagnostics separately when needed.' }, description: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number', description: 'Foreground deadline (default 60000ms, maximum 120000ms); for explicit background execution, lifetime (default 300000ms, maximum 600000ms).' }, run_in_background: { type: 'boolean', description: 'Explicitly start an owned, confined background job. Collect with job_output; stop with job_kill. Maximum lifetime is ten minutes. No automatic timeout promotion.' } }, required: ['command', 'description'], additionalProperties: false };

// Both model-facing command names enter the same bounded, confining executor.
export function createProjectCommandRunner(ctx, manager, config = {}, binding = manager.execution ?? ctx.projectExecutionMode) {
  const mode=bindProjectExecution(binding),check=()=>{if(mode.assertUnchanged().mode!=='host-compat')throw new WorkbenchError('PROJECT_EXECUTION_MODE_MISMATCH','The host executor requires explicit host compatibility.');};check();
  const processes = createProjectProcessStarter(ctx, {...config.processTimers,assertActive:check});
  async function prepare(args, execution) {
    check();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(projectCommandParameters.properties, key))) throw new WorkbenchError('INVALID_COMMAND', 'Only command, description, workdir, timeoutMs and run_in_background are supported for managed commands.', 400);
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 65536 || typeof args.description !== 'string' || !args.description.trim()) throw new WorkbenchError('INVALID_COMMAND', 'A bounded command and description are required.', 400);
    if (args.workdir !== undefined && typeof args.workdir !== 'string' || args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) || args.run_in_background !== undefined && typeof args.run_in_background !== 'boolean') throw new WorkbenchError('INVALID_COMMAND', 'Invalid command directory, timeout or background flag.', 400);
    const agent = manager.ownerAgent(execution.agent), project = manager.data.sessions[agent?.id];
    if (!project || project.legacy) throw new WorkbenchError('NO_MANAGED_PROJECT', 'Start a new isolated project to use this tool.');
    const cwd = path.resolve(project.root, args.workdir ?? '.');
    if (!within(project.root, cwd)) throw new WorkbenchError('OUTSIDE_PROJECT', 'Command directory is outside the project.', 403);
    const [realRoot, realCwd] = await Promise.all([fs.realpath(project.root), fs.realpath(cwd)]);
    check();
    if (!within(realRoot, realCwd)) throw new WorkbenchError('OUTSIDE_PROJECT', 'Command directory resolves outside the project.', 403);
    if (ctx.shell.sandboxMode === undefined || !ctx.sandboxPolicy) throw new WorkbenchError('NO_PROJECT_SANDBOX', 'A filesystem-confining shell and policy are required; refusing unconfined execution.', 503);
    const standing = ctx.sandboxPolicy.resolve({ session: execution.agent.session });
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(standing.mode)) throw new WorkbenchError('NO_PROJECT_SANDBOX', 'Unknown project execution policy.', 503);
    const mode = standing.mode === 'read-only' ? 'read-only' : 'workspace-write';
    const node = config.nodePath ?? '/data/harness/node/bin/node', wrapper = config.wrapperPath ?? '/data/harness/app/development/project-run.cjs';
    const testHelper = config.testHelperPath ?? path.join(path.dirname(wrapper), 'test-command.cjs');
    if (![node, wrapper, testHelper].every(value => path.isAbsolute(value))) throw new WorkbenchError('INVALID_RUNTIME_CONFIG', 'Absolute project runtime paths are required.');
    execution.signal.throwIfAborted();
    // Keep admitted arguments immutable and in the audit trail. Adapt only a
    // small, literal verification grammar; arbitrary shell/JavaScript is intact.
    const filtered = normalizeVerificationCommand(args.command);
    const compatible = nodeTestCommandRecipe(filtered.command, { nodePath: node, helperPath: testHelper });
    const command = 'exec ' + [node, wrapper, '--', 'bash', '-o', 'pipefail', '-c', compatible.command].map(quote).join(' ');
    const background = args.run_in_background === true;
    const spec = ctx.shell.resolve({ command, workdir: cwd, timeoutMs: background ? projectJobLifetime(args.timeoutMs) : Math.min(120000, Math.max(1000, args.timeoutMs ?? 60000)), signal: execution.signal, onExpiry: background ? 'none' : 'kill', dshEnv: { ...ctx.shellEnv.collect(execution), DSH_PROJECT_ROOT: project.root, DSH_PROJECT_READ_ONLY: mode === 'read-only' ? '1' : '0' }, sandboxPolicy: { mode, workspaceRoot: project.root, additionalWritableRoots: mode === 'read-only' ? [] : project.gitWritableRoots ?? [] } });
    const adaptations = [];
    if (filtered.changed) adaptations.push(filtered.reason === 'VERIFICATION_STATUS_ECHO_REMOVED' ? '[Harness: terminal status echo and display filters removed; the direct verifier retains its real exit code and bounded diagnostics.]' : filtered.reason === 'VERIFICATION_OUTPUT_FILTERS_REMOVED' ? '[Harness: terminal display filters removed from verification; bounded output preserves progress and the real exit status.]' : '[Harness: terminal tail filter removed from verification; bounded output retains the first diagnostic.]');
    if (compatible.changed) adaptations.push('[Harness: Node test compatibility helper used; directory operands select real test files, with original options and exit status retained.]');
    return { cwd, spec, adaptations };
  }
  const run = async (args, execution) => {
    const prepared = await prepare(args, execution);
    check();
    execution.signal.throwIfAborted();
    if (args.run_in_background === true) return { ...prepared, background: await processes.start(prepared, execution, args) };
    const result = await (await ctx.shell.execute(prepared.spec)).result();
    check();
    execution.signal.throwIfAborted();
    if (result.aborted) { const error = Error('Project command aborted'); error.name = 'AbortError'; throw error; }
    return { ...prepared, result: prepared.adaptations.length ? { ...result, stdout: { ...result.stdout, text: prepared.adaptations.join('\n') + '\n' + result.stdout.text } } : result };
  };
  run.dispose = processes.dispose;
  return run;
}

export function registerProjectTool(ctx, manager, run = createProjectCommandRunner(ctx, manager), binding = manager.execution ?? ctx.projectExecutionMode) {
  const mode=bindProjectExecution(binding);
  const tool = {
    name: 'project_exec',
    description: 'Run a shell command inside this isolated project, using the same executor as managed bash. Writes remain confined; assigned ports, database and prepared tools are preserved. Use direct verification commands without exit-masking pipelines. Foreground commands stop after at most120000ms. Explicit run_in_background starts a session-owned SDK job with a five-minute default and ten-minute maximum lifetime; use job_output/job_list/job_kill by its returned job ID, never nohup, setsid or process-name kills. There is no automatic timeout promotion.',
    parameters: projectCommandParameters,
    output: { schema: { oneOf: [{ type: 'object', properties: { cwd: { type: 'string' }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, stdout: { type: 'string' }, stderr: { type: 'string' }, timedOut: { type: 'boolean' } }, required: ['cwd', 'exitCode', 'stdout', 'stderr', 'timedOut'], additionalProperties: false }, projectBackgroundSchema] }, render: (args, v) => v.kind === 'background' ? renderProjectBackground(args, v) : [{ type: 'text', text: `Exit code: ${v.exitCode}${v.timedOut ? ' (timed out)' : ''}\n${v.stdout}${v.stderr ? '\n[stderr]\n' + v.stderr : ''}` }] },
    async execute(args, execution) {
      mode.assertUnchanged();
      const value = await run(args, execution);
      mode.assertUnchanged();
      if (value.background) return value.background;
      const { cwd, result } = value;
      return { cwd, exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text, timedOut: result.timedOut };
    },
  };
  const dispose=ctx.tools.register(tool, { when: ({ agent }) => { const p = manager.data.sessions[manager.ownerAgent(agent)?.id]; return Boolean(p && !p.legacy); } });
  return {definition:tool,handles:exec=>exec.name==='project_exec'&&ctx.tools.get(exec.name,exec.agent,exec.toolSet)===tool,dispose};
}
