import path from 'node:path';
import fs from 'node:fs/promises';
import { WorkbenchError, within } from './policy.mjs';
import { normalizeVerificationCommand, nodeTestCommandRecipe } from './tool-recovery.mjs';
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
export const projectCommandParameters = { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command', 'description'], additionalProperties: false };

// Both model-facing command names enter the same bounded, confining executor.
export function createProjectCommandRunner(ctx, manager, config = {}) {
  return async (args, execution) => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(projectCommandParameters.properties, key))) throw new WorkbenchError('INVALID_COMMAND', 'Only command, description, workdir and timeoutMs are supported for managed foreground commands.', 400);
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 65536 || typeof args.description !== 'string' || !args.description.trim()) throw new WorkbenchError('INVALID_COMMAND', 'A bounded command and description are required.', 400);
    if (args.workdir !== undefined && typeof args.workdir !== 'string' || args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new WorkbenchError('INVALID_COMMAND', 'Invalid command directory or timeout.', 400);
    const agent = manager.ownerAgent(execution.agent), project = manager.data.sessions[agent?.id];
    if (!project || project.legacy) throw new WorkbenchError('NO_MANAGED_PROJECT', 'Start a new isolated project to use this tool.');
    const cwd = path.resolve(project.root, args.workdir ?? '.');
    if (!within(project.root, cwd)) throw new WorkbenchError('OUTSIDE_PROJECT', 'Command directory is outside the project.', 403);
    const [realRoot, realCwd] = await Promise.all([fs.realpath(project.root), fs.realpath(cwd)]);
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
    const spec = ctx.shell.resolve({ command, workdir: cwd, timeoutMs: Math.min(120000, Math.max(1000, args.timeoutMs ?? 60000)), signal: execution.signal, onExpiry: 'kill', dshEnv: { ...ctx.shellEnv.collect(execution), DSH_PROJECT_ROOT: project.root, DSH_PROJECT_READ_ONLY: mode === 'read-only' ? '1' : '0' }, sandboxPolicy: { mode, workspaceRoot: project.root, additionalWritableRoots: mode === 'read-only' ? [] : project.gitWritableRoots ?? [] } });
    const result = await (await ctx.shell.execute(spec)).result();
    execution.signal.throwIfAborted();
    if (result.aborted) { const error = Error('Project command aborted'); error.name = 'AbortError'; throw error; }
    const adaptations = [];
    if (filtered.changed) adaptations.push('[Harness: terminal tail filter removed from verification; bounded output retains the first diagnostic.]');
    if (compatible.changed) adaptations.push('[Harness: Node test compatibility helper used; directory operands select real test files, with original options and exit status retained.]');
    return { cwd, spec, result: adaptations.length ? { ...result, stdout: { ...result.stdout, text: adaptations.join('\n') + '\n' + result.stdout.text } } : result };
  };
}

export function registerProjectTool(ctx, manager, run = createProjectCommandRunner(ctx, manager)) {
  const tool = {
    name: 'project_exec',
    description: 'Run a shell command inside this isolated project, using the same executor as managed bash. Writes are confined to its directory. PORT, API_PORT, DATABASE_URL, prepared Playwright and optional .NET paths are set automatically. Use direct verification commands such as npm test, npm run build or dotnet test; do not mask their exit status with pipelines or || true. Literal Node test directories are expanded to bounded test file selections. Commands stop on timeout.',
    parameters: projectCommandParameters,
    output: { schema: { type: 'object', properties: { cwd: { type: 'string' }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, stdout: { type: 'string' }, stderr: { type: 'string' }, timedOut: { type: 'boolean' } }, required: ['cwd', 'exitCode', 'stdout', 'stderr', 'timedOut'], additionalProperties: false }, render: (_args, v) => [{ type: 'text', text: `Exit code: ${v.exitCode}${v.timedOut ? ' (timed out)' : ''}\n${v.stdout}${v.stderr ? '\n[stderr]\n' + v.stderr : ''}` }] },
    async execute(args, execution) {
      const { cwd, result } = await run(args, execution);
      return { cwd, exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text, timedOut: result.timedOut };
    },
  };
  ctx.tools.register(tool, { when: ({ agent }) => { const p = manager.data.sessions[manager.ownerAgent(agent)?.id]; return Boolean(p && !p.legacy); } });
}
