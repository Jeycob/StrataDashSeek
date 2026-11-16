import { createProjectCommandRunner, projectCommandParameters } from './project-tool.mjs';
import { renderProjectBackground } from './project-process.mjs';

const stream = value => ({ text: value.text, truncated: Boolean(value.truncated), ...(value.spillPath === undefined ? {} : { spillPath: value.spillPath }) });
function foreground({ cwd, spec, result }) {
  return { kind: 'foreground', cwd, exitCode: result.exitCode, signal: result.signal ?? null, timedOut: result.timedOut, aborted: result.aborted, timeoutMs: result.timeoutMs ?? spec.timeoutMs, stdout: stream(result.stdout), stderr: stream(result.stderr), ...(result.sandbox ? { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied, ...(result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement }), ...(result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed }) } } : {}) };
}
function render(args, value) {
  if (value.kind === 'background') return renderProjectBackground(args, value);
  const text = part => part.text + (part.truncated ? '\n[output truncated; full output: ' + (part.spillPath ?? '(unavailable)') + ']' : '');
  const out = text(value.stdout), err = text(value.stderr);
  let body = out + (err ? (out && !out.endsWith('\n') ? '\n' : '') + '[stderr]\n' + err : '');
  if (!body) body = '(no output)';
  const markers = [];
  if (value.sandbox?.denied) markers.push('[sandbox: file access denied under ' + value.sandbox.mode + ' mode]');
  if (value.timedOut) markers.push('[timed out after ' + value.timeoutMs + 'ms]');
  if (value.signal !== null) markers.push('[killed by signal: ' + value.signal + ']');
  else if (value.exitCode !== 0) markers.push('[exit code: ' + value.exitCode + ']');
  return [{ type: 'text', text: body + (markers.length ? (body.endsWith('\n') ? '' : '\n') + markers.join('\n') : '') }];
}

// Scoped registrations are a supported SDK seam. No frozen tool execution is
// rewritten and no pre-execute/approval middleware is bypassed.
export function createManagedShell(ctx, manager, run = createProjectCommandRunner(ctx, manager)) {
  const registrations = new Map(), definitions = new WeakSet();
  function candidate(agent) {
    return Boolean(manager.ownerAgent(agent));
  }
  const removeGuard = ctx.tools.guard(exec => ['bash','exec_command','terminal'].includes(exec.name) && exec.agent && !handles(exec)
    ? { reason: 'Host shell execution is unavailable; use an enrolled isolated project.' } : undefined);
  function install(agent) {
    if (registrations.has(agent) || !candidate(agent)) return;
    const original = ctx.tools.get('bash', agent); if (!original || definitions.has(original)) return;
    const definition = { ...original, description: 'Run a confined bash command in this isolated project with its assigned ports, database and prepared tools, using the same executor as project_exec. Foreground commands stop after at most120000ms. Explicit run_in_background returns an owned SDK job ID with a five-minute default and ten-minute maximum lifetime; use job_output/job_list/job_kill, never nohup, setsid or broad process-name kills. No timeout promotion or permission escalation. Inspect real exit codes.', parameters: projectCommandParameters, isConcurrencySafe: () => false, output: { ...original.output, render }, async execute(args, execution) { const project=manager.data.sessions[manager.ownerAgent(execution.agent)?.id];if(!project||project.legacy||project.nativeWorktree||project.independentRepository===false||project.settings?.projectMode==='continue')throw Object.assign(Error('Model commands require an independently enrolled project; existing files are retained.'),{code:'PROJECT_RUNTIME_NOT_ISOLATED'});const value = await run(args, execution); return value.background ?? foreground(value); } };
    const dispose = agent.ctx.tools.register(definition); definitions.add(definition); registrations.set(agent, { definition, dispose });
  }
  function handles(exec) { return exec.name === 'bash' && Boolean(exec.agent) && definitions.has(ctx.tools.get('bash', exec.agent, exec.toolSet)); }
  function remove(agent) { const entry = registrations.get(agent); if (!entry) return; entry.dispose(); definitions.delete(entry.definition); registrations.delete(agent); }
  return { install, handles, remove, dispose() { for (const agent of [...registrations.keys()]) remove(agent); removeGuard(); } };
}
