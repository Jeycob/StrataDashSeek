// The SDK accepts JSON patch lists in --patch YAML files. Resolve the same ID that
// Basalt requires on /v1/chat/completions, before creating a Native session.
const origin = 'http://127.0.0.1:8080/v1';
const response = await fetch(`${origin}/models`, {
  redirect: 'error',
  signal: AbortSignal.timeout(5000),
});
if (!response.ok) throw new Error(`Basalt model discovery returned HTTP ${response.status}`);
const listing = await response.json();
const matches = Array.isArray(listing.data)
  ? listing.data.filter(model => model?.id === 'inkling-2-mini') : [];
if (matches.length !== 1 || matches[0].status?.value !== 'loaded') {
  throw new Error('Expected exactly one loaded inkling-2-mini entry on the lab Basalt server');
}
const model = matches[0];
const modalities = model.architecture?.input_modalities;
if (model.owned_by !== 'basalt' || !Array.isArray(modalities) ||
    !modalities.includes('text') || !modalities.includes('image')) {
  throw new Error('Expected a Basalt model with text and image input');
}
// Basalt reports the running engine's context here, independently of its training limit.
const servingContext = model.meta?.n_ctx;
if (!Number.isSafeInteger(servingContext) || servingContext <= 8192) {
  throw new Error('The Basalt serving context cannot accommodate the lab output allowance');
}
const provider = 'basalt-local';
const route = {
  displayName: 'Basalt on this machine',
  api: 'openai-completions',
  baseURL: origin,
  apiKeyEnv: 'BASALT_LOOPBACK_KEY',
  transport: 'sse',
  reasoning: 'low',
  thinkingBudgets: { minimal: 512, low: 1024, medium: 2048, high: 4096 },
  models: [{
    id: model.id,
    name: 'Inkling 2 Mini',
    contextWindow: Math.min(131072, servingContext),
    maxTokens: 8192,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
    compat: {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'openai',
      supportsReasoningEffort: true,
      supportsThinkingTokenBudget: true,
      thinkingTokenBudgetField: 'thinking_budget_tokens',
    },
  }],
};
const patches = [
  { id: 'llm-deepseek', disabled: true },
  { id: 'llm-deepseek-account', disabled: true },
  { id: 'web-search-deepseek', disabled: true },
  { id: 'web-deepseek-api', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'desktop-product-telemetry', disabled: true },
  { id: 'workspace-controller', config: { documentsDirectory: process.argv[2] } },
  { id: 'llm-pi-ai', config: { providers: { [provider]: route } } },
  { id: 'agent-default-model', config: { provider, model: model.id, reasoningEffort: 'low' } },
];
process.stdout.write(JSON.stringify(patches, null, 2) + '\n');
