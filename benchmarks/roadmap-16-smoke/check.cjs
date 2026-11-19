'use strict';

const assert = require('assert').strict;
const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const { runInNewContext } = require('vm');

const expected = require('./expected.json');

function readPinned(path, sha256) {
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  return bytes.toString('utf8');
}

function counterSequence(script) {
  const value = { textContent: '', classList: { toggle() {} } };
  const clicks = new Map();
  const document = {
    getElementById(id) {
      if (id === 'value') return value;
      return { addEventListener: (event, callback) => clicks.set(id, callback) };
    },
  };
  runInNewContext(script, { document }, { timeout: 1000 });
  const observed = [Number(value.textContent)];
  for (const id of ['plus', 'minus', 'minus', 'reset']) {
    clicks.get(id)();
    observed.push(Number(value.textContent));
  }
  return observed;
}

const counterHtml = readPinned(resolve(__dirname, 'reference/counter.html'),
  '218f9e09179ebe30bba631e4755ae26bc2e25732a053d73e7f6b38015d015082');
const counterScript = counterHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const expectedSequence = expected.counter;
const clampedCounter = counterScript.replace('value -= 1;', 'value = Math.max(0, value - 1);');
assert.deepEqual(counterSequence(counterScript), expectedSequence);
const clampedSequence = counterSequence(clampedCounter);
assert.deepEqual(clampedSequence, [0, 1, 0, 0, 0]);
assert.throws(() => assert.deepEqual(clampedSequence, expectedSequence), { code: 'ERR_ASSERTION' });
console.log('Counter: preserved output PASS; counter clamped to zero rejected.');

function checkNoteUpdates({ concurrentStatuses, finalVersion, staleStatus }) {
  assert.deepEqual([...concurrentStatuses].sort(), [200, 409]);
  assert.equal(finalVersion, 2);
  assert.equal(staleStatus, 409);
}
checkNoteUpdates(expected.b10.reference);
assert.throws(() => checkNoteUpdates(expected.b10.unfixed), { code: 'ERR_ASSERTION' });
console.log('B10 compact API examples: patched reference accepted; unfixed baseline rejected.');

function summarizeFrozenExpenses(csv) {
  const [header, ...rows] = csv.trimEnd().split(/\r?\n/);
  assert.equal(header, 'id,date,category,amount');
  const seen = new Map();
  const result = { totalCents: 0, count: 0, duplicateCount: 0, errorCount: 0, byCategory: {} };
  // This checksum-pinned fixture is unquoted. The product's CSV parser has broader requirements.
  for (const row of rows) {
    const fields = row.split(',');
    assert.equal(fields.length, 4);
    const [id, date, category, amount] = fields;
    const parsedDate = new Date(date + 'T00:00:00Z');
    if (!id || !/^-?\d+\.\d{2}$/.test(amount) || Number.isNaN(parsedDate.getTime())
        || parsedDate.toISOString().slice(0, 10) !== date) {
      result.errorCount++;
      continue;
    }
    const signature = JSON.stringify([date, category, amount]);
    if (seen.has(id)) {
      if (seen.get(id) === signature) result.duplicateCount++;
      else result.errorCount++;
      continue;
    }
    seen.set(id, signature);
    const cents = Number(amount.replace('.', ''));
    const group = category || 'Nezařazeno';
    result.totalCents += cents;
    result.count++;
    result.byCategory[group] = (result.byCategory[group] || 0) + cents;
  }
  return result;
}

const csv = readPinned(resolve(__dirname, 'inputs/expenses.csv'),
  '91bf417ed80593a12883ecf724d89cdf6dd9836385873857d969dde047b2bf45');
const correctExpenses = summarizeFrozenExpenses(csv);
function checkExpenses(summary, report) {
  assert.deepEqual(summary, expected.b03);
  assert.deepEqual(report, summary);
}
checkExpenses(correctExpenses, JSON.parse(JSON.stringify(correctExpenses)));
const doubleCounted = {
  ...correctExpenses, totalCents: 101801, count: 7, duplicateCount: 0,
  byCategory: { ...correctExpenses.byCategory, Doprava: 642 },
};
assert.throws(() => checkExpenses(doubleCounted, doubleCounted), { code: 'ERR_ASSERTION' });
assert.throws(() => checkExpenses(correctExpenses, doubleCounted), { code: 'ERR_ASSERTION' });
console.log('B03: frozen CSV oracle PASS; duplicated row and mismatched download rejected.');
