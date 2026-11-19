'use strict';

const { readStarter, applyStarterFiles } = require('./starter-files.cjs');

const [id, destination] = process.argv.slice(2);
if (!id || !destination || process.argv.length !== 4) {
  console.error('Usage: node examples/app-starters/seed.cjs <temperature-form|csv-expense-report> <empty-project>');
  process.exitCode = 1;
} else {
  const files = applyStarterFiles(destination, readStarter(id));
  console.log(id + ': copied ' + files.length + ' files.');
}
