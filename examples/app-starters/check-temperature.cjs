'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const file = process.argv[2] || join(__dirname, 'temperature-form/index.html');
const bytes = readFileSync(file);
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  'aa534cf23daf2f38d9962acdd1d1507ea843b5d743702f3ee893fbfae908040e');
const html = bytes.toString('utf8');
const input = html.match(/<input\b[^>]*\bid="c"[^>]*\bvalue="([^"]*)"/);
const events = new Map();
const elements = {
  c: { value: input[1], addEventListener: (event, callback) => events.set(event, callback) },
  f: { textContent: '' },
  err: { textContent: '' },
};
runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],
  { document: { getElementById: id => elements[id] } }, { timeout: 1000 });
assert.equal(input[1], '0');
assert.match(elements.f.textContent, /^32[,.]00 °F$/);
elements.c.value = '100';
events.get('input')();
assert.match(elements.f.textContent, /^212[,.]00 °F$/);
assert.equal(elements.err.textContent, '');
console.log('Temperature form: 0 °C → 32 °F; 100 °C → 212 °F.');
