import {isMain} from '../runtime/require.cjs';
import { verifyProject, compactReport } from './core.mjs';

export function argumentsOf(argv) {
  const options = {}; const [operation, ...rest] = argv;
  if (operation !== 'verify') throw Error('Usage: cli.mjs verify --workspace <directory> [--contract .harness-quality.json] [--kind all|build|test|browser|acceptance]');
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--workspace': 'workspace', '--contract': 'contractPath', '--kind': 'kind' }[rest[i]];
    if (!key || !rest[i + 1] || options[key] !== undefined) throw Error('Invalid or duplicate argument.');
    options[key] = rest[i + 1];
  }
  if (!options.workspace) throw Error('--workspace is required.'); return options;
}

export async function main(argv) {
  const controller = new AbortController();
  const abort = () => controller.abort(Error('Verification cancelled.'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try { const report = await verifyProject({ ...argumentsOf(argv), signal: controller.signal }); console.log(JSON.stringify(compactReport(report))); return report.passed ? 0 : 1; }
  catch (e) { console.log(JSON.stringify({ passed: false, complete: false, stale: false, checks: [], code: e.code ?? 'VERIFICATION_FAILED', error: e.message })); return 1; }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
