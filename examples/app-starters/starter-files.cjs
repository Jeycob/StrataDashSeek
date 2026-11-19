'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const lab = resolve(__dirname, '../../benchmarks/disposable-20261114');
const csvRoot = resolve(lab, 'fixture');
const starters = new Map([
  ['temperature-form', [['index.html', resolve(__dirname, 'temperature-form/index.html')]]],
  ['csv-expense-report', [
    ['src/report.mjs', resolve(lab, 'results/csv-1/csv-agent/src/report.mjs')],
    ...['package.json', 'src/report-cli.mjs', 'data/expenses.csv', 'test/public.test.mjs',
      'test/edge-cases.test.mjs'].map(file => [file, resolve(csvRoot, file)]),
  ]],
]);

function readStarter(id) {
  const files = starters.get(id);
  if (!files) throw new Error('Unknown application starter');
  return files.map(([target, source]) => [target, readFileSync(source).toString('base64')]);
}

// Sent as trusted code to the existing managed executor with the selected
// bundled files. The executor's current directory is the owned project.
function applyStarterFiles(directory, files) {
  const fs = require('node:fs');
  const path = require('node:path');
  const project = fs.realpathSync(directory);
  const lockName = '.homeai-starter-lock';
  const lock = path.join(project, lockName);
  fs.mkdirSync(lock);
  try {
    if (fs.readdirSync(project).some(name => name !== '.git' && name !== lockName)) {
      throw new Error('Starter requires an empty project directory');
    }
    for (const [file, data] of files) {
      if (!/^(?:[a-z][a-z0-9.-]*\/)*[a-z][a-z0-9.-]*$/u.test(file)) {
        throw new Error('Invalid bundled starter path');
      }
      const target = path.join(project, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(data, 'base64'), { flag: 'wx' });
    }
  } finally {
    fs.rmdirSync(lock);
  }
  return files.map(([file]) => file);
}

module.exports = { readStarter, applyStarterFiles };
