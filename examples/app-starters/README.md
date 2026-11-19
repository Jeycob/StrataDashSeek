# Optional application starters

In HomeAI, ask for a new temperature converter or a compatible expense CSV CLI in an empty project. The first matching user turn gets a short offer. The agent can accept it through the existing project executor and then inspect and adapt the files. Unrelated requests receive the regular tool schema and context. The offer applies only to a new, independently owned project.

For local development or an explicitly seeded comparison, use Node 24 from the repository root:

```text
node examples/app-starters/seed.cjs temperature-form <empty-project>
node examples/app-starters/seed.cjs csv-expense-report <empty-project>
```

Choose one command. The destination must already exist and can contain Git metadata. The seeder copies only the named files, with exclusive creation for each file. It makes no network requests.

| Starter | Version and scope | Run and verify |
| --- | --- | --- |
| `temperature-form` | v1, one HTML file with a numeric input, immediate conversion and validation. Derived from the preserved B005 app. | Open `index.html` or serve it with the normal project preview. Check 0 °C → 32 °F and 100 °C → 212 °F. Run `node examples/app-starters/check-temperature.cjs` to check the pinned starter's JavaScript locally. |
| `csv-expense-report` | v1, existing dependency-free Node CLI with quoted CSV, duplicate handling, pending rows, refunds and integer-cents arithmetic. Its example data are synthetic. | From the seeded project, run `node src/report-cli.mjs data/expenses.csv report.json` and `node --test test/public.test.mjs test/edge-cases.test.mjs`. Expect 7 posted rows and a total of 1460.50 CZK. |

The CSV starter combines the existing CLI, sample data and tests with the archived repaired report engine. Use the form for small browser calculators and the CLI for CSV reports with the documented fixture columns. A task with different requirements can start from its normal project. The #16 B03 fixture has a different schema and retains its own checks. [Repaired report engine](../../benchmarks/disposable-20261114/results/csv-1/csv-agent/src/report.mjs) · [CSV inputs and tests](../../benchmarks/disposable-20261114/fixture/) · [Paired pilot plan](MEASUREMENT.md).
