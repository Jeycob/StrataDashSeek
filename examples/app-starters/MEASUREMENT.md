# Roadmap #17 paired pilot

The coordinator runs one pair per starter as an initial sample. There is one original prompt per run. Freeze the prompt bytes, inputs, acceptance steps, exact starter revision and budget before the pair. Collect the paired records on the single live slot, with the same release, actual model, reasoning, context and limits. Keep concurrent work out of the measurement window. Record cache state and actual tool or queue waits.

| Task | Order | Common black-box acceptance |
| --- | --- | --- |
| Bidirectional temperature form | A then B | From the delivered preview, select each direction and check 0 °C → 32 °F, 100 °C → 212 °F, 32 °F → 0 °C and −40 °F → −40 °C. Values update on input. |
| Monthly expense categories | B then A | Run the CLI on the same synthetic `data/expenses.csv`. Expect 7 posted rows, total 1460.50 CZK and monthly categories. September includes Energy 1234.56, October includes Energy −34.56 and Food, home 250.10, November includes Energy 0.30 and the multiline category 10.00. |

A starts in a fresh project with common inputs only. B starts in a fresh project seeded with the designated starter and the identical common inputs. The temperature task has no common input files. The CSV task uses the exact same [synthetic fixture](../../benchmarks/disposable-20261114/fixture/data/expenses.csv) in both projects. The seeding and adaptation happen before and within the same recorded task respectively. The exact prompt within a pair is unchanged.

For these pre-seeded A/B records, the coordinator uses `applicationStarters: false` in the workspace runtime configuration for both arms. This keeps A unseeded while holding runtime settings equal. Separately verify ordinary discovery with the default setting before attributing any live results to automatic offers.

## Pilot prompts

**Form**

> Vytvoř v jednom souboru index.html převodník teplot, který umožňuje přepnout z °C na °F a z °F na °C. Při změně směru nebo čísla se výsledek ihned přepočítá. Spusť použitelný náhled a ve finální zprávě uveď odkaz a stručné ověření.

**Report**

> Zpracuj přiložené data/expenses.csv příkazem node src/report-cli.mjs data/expenses.csv report.json. Sečti zaplacené položky bez duplicit v přesných haléřích. Do JSON dej postedCount, totalCzk a pole months s month, totalCzk a categories ve tvaru [{category,totalCzk}]. Částky zapisuj jako řetězce se dvěma desetinnými místy. Zachovej záporné vratky, uvozované kategorie včetně čárek a nového řádku a vynech pending položky. Vytvoř report.json z dodaného vstupu a ve finální zprávě uveď výsledek a postup spuštění.

## Record for each run

- Save the task, arm, order, seed and input digests, SID, effective runtime and model, cache condition, final output identity and acceptance status.
- Record seed/setup seconds, Native acceptance of the original prompt, final message time and independent acceptance time. Report time from submit to first usable accepted result and the elapsed cost of setup. For a failed run, record elapsed time to stop and reason, with acceptance time empty.
- Count each repair cycle after a failed check as one. Record the failed check, correction and repeat result, and track operator actions and follow-up prompts separately. Include tokens with uncached input, cache reads or writes and output in their own fields.
- Compare seconds and repairs within each pair only after checking both outputs. Retain failures and interruptions next to the measured outcomes. This two-pair pilot gives individual deltas. A general speed claim requires more paired samples.

This plan starts no model runs. The coordinator owns live scheduling, with #5 ahead of this pilot.
