import path from 'node:path';
import { WorkbenchError, within } from './policy.mjs';
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
export function registerProjectTool(ctx, manager) {
  const tool = {
    name: 'project_exec',
    description: 'Run a shell command inside this isolated project. Writes are confined to its directory. PORT, API_PORT, DATABASE_URL, prepared Playwright and optional .NET paths are set automatically. Use direct verification commands such as npm test, npm run build or dotnet test; do not mask their exit status with pipelines or || true. Commands are cancelled on timeout. Use this instead of bash for managed projects.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command', 'description'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { cwd: { type: 'string' }, exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] }, stdout: { type: 'string' }, stderr: { type: 'string' }, timedOut: { type: 'boolean' } }, required: ['cwd', 'exitCode', 'stdout', 'stderr', 'timedOut'], additionalProperties: false }, render: (_args, v) => [{ type: 'text', text: `Exit code: ${v.exitCode}${v.timedOut ? ' (timed out)' : ''}\n${v.stdout}${v.stderr ? '\n[stderr]\n' + v.stderr : ''}` }] },
    async execute(args, execution) {
      const agent = manager.ownerAgent(execution.agent), project = manager.data.sessions[agent?.id];
      if (!project || project.legacy) throw new WorkbenchError('NO_MANAGED_PROJECT', 'Start a new isolated project to use this tool.');
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 65536 || typeof args.description !== 'string') throw new WorkbenchError('INVALID_COMMAND', 'A bounded command and description are required.', 400);
      const cwd = path.resolve(project.root, args.workdir ?? '.'); if (!within(project.root, cwd)) throw new WorkbenchError('OUTSIDE_PROJECT', 'Command directory is outside the project.', 403);
      if (ctx.shell.sandboxMode === undefined) throw new WorkbenchError('NO_PROJECT_SANDBOX', 'A filesystem-confining shell is required; refusing unconfined execution.', 503);
      const command = 'exec /data/harness/node/bin/node /data/harness/app/development/project-run.cjs -- bash -o pipefail -c ' + quote(args.command);
      const spec = ctx.shell.resolve({ command, workdir: cwd, timeoutMs: Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 60000)), dshEnv: ctx.shellEnv.collect(execution), signal: execution.signal, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: project.root } });
      const result = await (await ctx.shell.execute(spec)).result();
      if (execution.signal.aborted || result.aborted) throw execution.signal.reason ?? Error('Project command aborted');
      return { cwd, exitCode: result.exitCode, stdout: result.stdout.text, stderr: result.stderr.text, timedOut: result.timedOut };
    },
  };
  ctx.tools.register(tool, { when: ({ agent }) => { const p = manager.data.sessions[manager.ownerAgent(agent)?.id]; return Boolean(p && !p.legacy); } });
}
