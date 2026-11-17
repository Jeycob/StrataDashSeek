// Model-facing host filesystem tools must never run for managed projects.
// Install before tools.resolve for EVERY agent (including children). The global
// guard also rejects old admitted snapshots and missing/late shadow installs.
// No host fs/subprocess calls or native execute/render callbacks are retained.
import {bindProjectExecution} from './execution-mode.mjs';
export const projectFileToolNames = Object.freeze(['read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'str_replace_editor']);
const names = new Set(projectFileToolNames);
const MAX_OUTPUT_BYTES = 262144;
const string={type:'string'},integer={type:'integer',minimum:1};
const parameters=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const fallbackParameters={read:parameters({file_path:string,offset:integer,limit:integer},['file_path']),read_image:parameters({file_path:string},['file_path']),write:parameters({file_path:string,content:string},['file_path','content']),edit:parameters({file_path:string,old_string:string,new_string:string,replace_all:{type:'boolean'}},['file_path','old_string','new_string']),apply_patch:parameters({patch:string},['patch']),glob:parameters({pattern:string,path:string},['pattern']),grep:parameters({pattern:string,path:string,include:string},['pattern']),str_replace_editor:parameters({command:string,path:string},['command','path'])};
function failure(code) { const error = Error(code); error.code = code; return error; }

// handlers is trusted integration configuration, never model input. Each handler
// receives ({name, arguments, project:{ownerId,root}}, actualSDKExecution).
// It MUST use the isolated executor, revalidate authority/read-only policy, map
// host project paths into /workspace, enforce operation bounds and cancellation,
// and return {text:string,truncated:boolean}. A shell runner alone is NOT such a
// handler: guest file semantics must be implemented before enabling a name.
// Missing handlers fail closed. No native fallback, including images/patches.
export function createProjectFileTools(ctx, manager, handlers = {}, binding = manager.execution ?? ctx.projectExecutionMode) {
  const mode=bindProjectExecution(binding);if(mode.snapshot.mode!=='isolated-guest')throw failure('PROJECT_EXECUTION_MODE_MISMATCH');
  const implementations = new Map(projectFileToolNames.filter(name => Object.hasOwn(handlers, name) && typeof handlers[name] === 'function').map(name => [name, handlers[name]]));
  const registrations = new Map(), definitions = new WeakSet();
  function candidate(agent) {
    return Boolean(agent && manager.ownerAgent(agent));
  }
  function handles(exec) {
    return names.has(exec.name) && Boolean(exec.agent) && definitions.has(ctx.tools.get(exec.name, exec.agent, exec.toolSet));
  }
  const removeGuard = ctx.tools.guard(exec => names.has(exec.name) && Boolean(exec.agent) && !handles(exec)
    ? { reason: 'Unisolated project file tool refused; refresh the scoped tool registration.' } : undefined);
  function install(agent) {
    mode.assertUnchanged();
    if (!candidate(agent)) return;
    let entries = registrations.get(agent);
    if (!entries) { entries = new Map(); registrations.set(agent, entries); }
    for (const name of projectFileToolNames) {
      if (entries.has(name)) continue;
      const original = ctx.tools.get(name, agent);
      if (definitions.has(original)) continue;
      // Copy only input schema, never callbacks/metadata retaining host services.
      const definition = {
        name, parameters: original?.parameters??fallbackParameters[name],
        description: (original?.description??'Operate on the current isolated project.') + ' Managed project: this operation requires the isolated file backend. Unsupported operations fail closed. No host filesystem fallback or permission escalation.' + (name === 'apply_patch' ? ' Isolated patch subset: one relative file per call; Add, Delete, or Update with literal @@ hunks and unique exact context. Move, multi-file, anchor text and files without a final newline are unsupported; use write/edit instead.' : ''),
        isConcurrencySafe: () => false,
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' }, truncated: { type: 'boolean' } }, required: ['text', 'truncated'], additionalProperties: false },
          render: (_args, result) => [{ type: 'text', text: result.text + (result.truncated ? '\n[isolated file output truncated]' : '') }],
        },
        async execute(args, execution) {
          mode.assertUnchanged();
          execution.signal.throwIfAborted();
          const owner = manager.ownerAgent(execution.agent), project = manager.data.sessions[owner?.id];
          if (!project || project.legacy || project.independentRepository !== true || project.nativeWorktree || !candidate(execution.agent)) throw failure('NO_MANAGED_PROJECT');
          if (args.sandbox_permissions !== undefined || args.justification !== undefined) throw failure('PROJECT_FILE_ESCALATION_REFUSED');
          const handler = implementations.get(name);
          if (!handler) throw failure('ISOLATED_FILE_OPERATION_UNAVAILABLE');
          let result;
          try {
            result = await handler(Object.freeze({ name, arguments: args, project: Object.freeze({ ownerId: owner.id, root: project.root }) }), execution);
          } catch {
            execution.signal.throwIfAborted();
            throw failure('ISOLATED_FILE_OPERATION_FAILED');
          }
          // Await the executor's quiescence even after cancellation; never race
          // a mutation against an early abort response.
          execution.signal.throwIfAborted();
          mode.assertUnchanged();
          if (!result || typeof result.text !== 'string' || typeof result.truncated !== 'boolean' || Buffer.byteLength(result.text, 'utf8') > MAX_OUTPUT_BYTES) throw failure('ISOLATED_FILE_RESULT_INVALID');
          return { text: result.text, truncated: result.truncated };
        },
      };
      const dispose = agent.ctx.tools.register(definition);
      definitions.add(definition); entries.set(name, { definition, dispose });
    }
  }
  function remove(agent) {
    const entries = registrations.get(agent);
    if (!entries) return;
    for (const { definition, dispose } of entries.values()) { dispose(); definitions.delete(definition); }
    registrations.delete(agent);
  }
  let disposed = false;
  return { install, handles, remove, dispose() {
    if (disposed) return;
    disposed = true;
    for (const agent of [...registrations.keys()]) remove(agent);
    removeGuard();
  } };
}
