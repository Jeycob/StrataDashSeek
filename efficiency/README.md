# Efficient local Qwen work

Implementation branch: `feat/qwen-efficiency`. Ownership: only `efficiency/`.
The workspace runtime owns project isolation, native shell, checkpoints and the
single repair budget; HomeAI owns Docker, lifecycle and sleep. This extension
does not create another repair loop or patch the model proxy.

Planned reviewable units:

1. Stable system instructions; semantic runtime context; bounded, archived shell
   logs; a tool for relevant file excerpts and current changes.
2. Narrow edits after a verified milestone. Large native overwrites require a
   one-use explanation tied to the current source hash and verification plan.
3. Observe canonical prompt/tool fingerprints. Preserve historical messages and
   tool-call/result pairing; do not reorder provider-owned tool declarations.
4. Record queue, model, tools, repair and verified success. Allocate a billing
   interval once across concurrent tasks; keep idle/unknown cost explicit.
5. Optional request-level FIFO scheduling, with at most one local inference
   stream, cancellation-safe release and overlap between inference and tools.
   Replace the old whole-turn gate only after coordinated isolated validation.

No speed or model-quality gain is claimed until measured on the actual engine.
Installed Strata is not assumed to accept vanilla llama.cpp flags. Read its
actual metrics and compare repeated stable prefixes with deliberately changed
prefixes. Do not restart or retune the live engine during this rollout.
