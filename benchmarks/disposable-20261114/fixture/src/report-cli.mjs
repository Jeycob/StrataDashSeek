import fs from 'node:fs';
import { buildReport } from './report.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node src/report-cli.mjs input.csv output.json');
fs.writeFileSync(output, JSON.stringify(buildReport(fs.readFileSync(input, 'utf8')), null, 2) + '\n');
