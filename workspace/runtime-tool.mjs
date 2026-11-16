import { WorkbenchError } from './policy.mjs';
export function registerRuntimeCapabilities(ctx, manager, capabilities) {
  const project = agent => manager.data.sessions[manager.ownerAgent(agent)?.id];
  ctx.tools.register({
    name: 'runtime_capabilities',
    description: 'Read the current isolated project deployment capabilities: existing Docker/Compose files to reuse, registered build/deployment, owned jobs, managed Docker sleep/start state and real host disk reserve. This never wakes Docker, cleans files, installs software or deploys. Call before deployment; use the typed project_apps tool and wait for final tests/browser verification. An asleep VM is configured, not missing Docker. Automatic safe temporary cleanup runs before capacity rejection; never lower reserves or remove models, credentials or application data.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    output: { schema: { type: 'object', properties: { version: { type: 'integer' }, timestamp: { type: 'string' } }, required: ['version', 'timestamp'], additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new WorkbenchError('INVALID_CAPABILITY_ARGUMENTS', 'This tool accepts no paths or project IDs.');
      execution.signal.throwIfAborted(); const record = project(execution.agent);
      if (!record || record.legacy) throw new WorkbenchError('NO_MANAGED_PROJECT', 'An isolated project is required.');
      const result = await capabilities.snapshot(record.root); execution.signal.throwIfAborted(); return result;
    },
  }, { when: ({ agent }) => { const record = project(agent); return Boolean(record && !record.legacy); } });
  ctx.systemPrompt.context({ name: 'workspace-runtime:deployment-capabilities', order: 240, interpolate: false, text: assembly => {
    const agent = assembly.agent ?? ctx.agents.get(assembly.scope?.id), record = agent && project(agent);
    return record && !record.legacy ? capabilities.renderContext(record.root) : '';
  } });
}
