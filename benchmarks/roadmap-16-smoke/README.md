# Roadmap #16 smoke checks

From a clean repository checkout, run `node benchmarks/roadmap-16-smoke/check.cjs`. The command uses local synthetic inputs and compact expected results. It needs no server, model, package install, private data or other checkout.

| Work | One original prompt and input | Check the result |
| --- | --- | --- |
| New app | [Counter prompt](inputs/counter.prompt.txt) in a clean project | In the delivered preview, check the initial value and click +, −, −, Reset. Expect 0 → 1 → 0 → −1 → 0. Check the terminal result for the existence and byte count of `index.html`. |
| Repair | [B10 prompt](inputs/b10.prompt.txt) with a fresh copy of [B10 input](inputs/b10/) in the project root | On a newly created note, concurrently PATCH different texts at `baseVersion:1` with `delayMs:100`. Expect 200 and 409. GET must return version 2 and the winning text. Another version-1 PATCH must return 409 and leave the GET response unchanged. |
| Data | [B03 prompt](inputs/b03.prompt.txt) with [expenses.csv](inputs/expenses.csv) in the project root | Import the CSV without filters. Check [all summary fields](expected.json) and compare the downloaded JSON with the displayed summary by keys and values. |

When copying B10, rename `test/original.test.mjs.fixture` to `test/original.test.mjs` in the **new project**. Its bytes are unchanged. The suffix keeps the deliberately faulty input fixture out of the repository's test discovery. Start the submitted notes app in the disposable project and use the API relative to its base URL. Exercise the counter and expense dashboard in a browser.

Offline, the checker executes the preserved counter's event handlers and rejects an in-memory copy that clamps the value to zero. It recalculates the B03 oracle from the original CSV and rejects a double-counted row and a mismatched download. B10 uses the compact status projections of the archived repaired and unfixed API runs. The offline command checks those examples. The B10 API steps above exercise an actual app.

Record the final message, visible result, session and actual check observation when the coordinator provides a live slot. Reuse an existing comparable output when it covers the case. This smoke suite has its own results. The official B03 and B10 pairs retain their original fixtures, prompts, test suites, limits and order.
