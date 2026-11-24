# Native output-limit recovery

After the pinned Native SDK saves a length-limited response, the plugin can request another normal step in the same turn. The SDK keeps the partial answer and usage and removes truncated tool calls. The next step passes through normal admission, Stop, the task budget and any installed FIFO. A short instruction in the SDK's recorded system prompt asks the model to resume from committed progress. Recovery creates no user message or inbox entry.

A turn allows up to eight continuations and stops after two consecutive stalled attempts. At the recovery step the plugin rejects an SDK call ID already attempted in that turn. A fresh call can repeat the same verification against changed files. A terminal output limit, including one followed only by repeated text or reasoning, keeps its incomplete status. The web client displays **Reply incomplete** for both new and historical incomplete turns.

The first request offers incremental writes in the `write` description when both `write` and `edit` are available. When a cut includes a discarded `write` or `edit` call, the recorded prompt and bounded file schemas remain active through later steps of the turn. Recovery requires a project-relative path. The native filesystem can exclusively create a small complete seed and tracks edits by resolved target identity. The isolated 9p workspace permits targeted edits to existing files. A recovery write there reports that the backend cannot safely publish a new file without replacing a concurrent creation. A confirmed content change counts as progress. A read, a rejected mutation, and a repeated identical edit do not. An empty stop while the file is still unconfirmed uses only the remaining ordinary continuation allowance.

The HomeAI Native supervisor includes the plugin in both launch modes. A separate Native profile such as Basalt/Inkling can add this Loader overlay from its signed release:

```yaml
- insert:
    - id: homeai-output-continuation
      name: file:///ABSOLUTE_SIGNED_RELEASE/runtime/output-continuation/index.mjs
```

Include the plugin directory and `runtime/require.cjs` in that release. The plugin resolves the reviewing SDK through the active profile's install anchor and uses the runtime resolver as a fallback. The supported `@deepseek-ai/dsh-agent-loop@0.2.2-rc.2` entry point has SHA-256 `f09f60814d4e96a880f41b9fc3832f33c56a28f954f48810d8439ce83ad6ffa8`. An unreviewed loop keeps its original terminal behavior and the browser describes its partial result.

After loading the release, an existing chat uses recovery for subsequent turns. Historical incomplete turns remain visible and a restart does not replay them.
