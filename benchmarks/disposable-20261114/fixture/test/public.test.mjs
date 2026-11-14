import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.mjs';

const H = 'id,date,category,amount_czk,status';

test('empty data', () => {
  assert.deepEqual(buildReport('id,date,category,amount_czk,status\n'), { postedCount: 0, totalCzk: '0.00', months: [], categories: [] });
});

test('empty input, BOM only and blank lines produce an empty report', () => {
  const empty = { postedCount: 0, totalCzk: '0.00', months: [], categories: [] };
  assert.deepEqual(buildReport(''), empty);
  assert.deepEqual(buildReport('\n\n \n'), empty);
  assert.deepEqual(buildReport('\ufeff' + H), empty);
  assert.deepEqual(buildReport(H + '\r\n\r\n\r\n'), empty);
  assert.deepEqual(buildReport(H + '\n   \n\t\n'), empty);
});

test('quoted fields, escaped quotes, embedded newlines, CRLF, BOM, duplicates and pending rows', () => {
  const csv =
    '\ufeff' +
    H + '\r\n' +
    'a,2026-09-30,Energy,1234.56,posted\r\n' +
    'b,2026-10-01,"Food, home",250.10,posted\r\n' +
    'c,2026-10-02,Energy,-34.56,posted\r\n' +
    'd,2026-10-03,Energy,999.00,pending\r\n' +
    'e,2026-10-04,"D\u011bti ""v\u00fdlet""",0.10,posted\r\n' +
    'e,2026-10-04,"D\u011bti ""v\u00fdlet""",0.10,posted\r\n' +
    'f,2026-11-01,"Multi\nline",10.00,posted\r\n' +
    'g,2026-11-02,Energy,0.20,posted\r\n' +
    'h,2026-11-03,Energy,0.10,posted\r\n';

  assert.deepEqual(buildReport(csv), {
    postedCount: 7,
    totalCzk: '1460.50',
    months: [
      { month: '2026-09', totalCzk: '1234.56' },
      { month: '2026-10', totalCzk: '215.64' },
      { month: '2026-11', totalCzk: '10.30' },
    ],
    categories: [
      { category: 'D\u011bti "v\u00fdlet"', totalCzk: '0.10' },
      { category: 'Energy', totalCzk: '1200.30' },
      { category: 'Food, home', totalCzk: '250.10' },
      { category: 'Multi\nline', totalCzk: '10.00' },
    ],
  });
});

test('duplicate ids count once, conflicting duplicates throw', () => {
  assert.deepEqual(buildReport(`${H}\na,2026-01-01,X,1.00,posted\na,2026-01-01,X,1.00,posted\n`), {
    postedCount: 1,
    totalCzk: '1.00',
    months: [{ month: '2026-01', totalCzk: '1.00' }],
    categories: [{ category: 'X', totalCzk: '1.00' }],
  });
  // A duplicated pending row is deduplicated as well.
  assert.deepEqual(buildReport(`${H}\na,2026-01-01,X,1.00,pending\na,2026-01-01,X,1.00,pending\n`), {
    postedCount: 0,
    totalCzk: '0.00',
    months: [],
    categories: [],
  });
  for (const row of [
    'a,2026-01-01,X,2.00,posted',
    'a,2026-01-02,X,1.00,posted',
    'a,2026-01-01,Y,1.00,posted',
    'a,2026-01-01,X,1.00,pending',
  ]) {
    assert.throws(() => buildReport(`${H}\na,2026-01-01,X,1.00,posted\n${row}\n`), TypeError);
  }
});

test('pending rows are validated but never create buckets', () => {
  assert.throws(() => buildReport(`${H}\na,2026-02-30,X,1.00,pending\n`), TypeError);
  assert.deepEqual(buildReport(`${H}\na,2026-05-31,X,-2.00,pending\nb,2026-05-31,Y,3.00,posted\n`), {
    postedCount: 1,
    totalCzk: '3.00',
    months: [{ month: '2026-05', totalCzk: '3.00' }],
    categories: [{ category: 'Y', totalCzk: '3.00' }],
  });
});

test('integer cents avoid binary float drift', () => {
  const report = buildReport(`${H}\na,2026-01-01,X,0.10,posted\nb,2026-01-01,X,0.20,posted\nc,2026-01-01,X,-0.30,posted\n`);
  assert.equal(report.totalCzk, '0.00');
  assert.deepEqual(report.categories, [{ category: 'X', totalCzk: '0.00' }]);
  assert.equal(buildReport(`${H}\na,2026-01-01,X,90071992547409.00,posted\nb,2026-01-01,X,0.01,posted\n`).totalCzk, '90071992547409.01');
  assert.throws(() => buildReport(`${H}\na,2026-01-01,X,90071992547409.91,posted\nb,2026-01-01,X,0.01,posted\n`), TypeError);
  assert.throws(() => buildReport(`${H}\na,2026-01-01,X,99999999999999999.99,posted\n`), TypeError);
});

test('amounts must be signed decimals with exactly two fractional digits', () => {
  for (const amount of ['1.5', '1.500', '1', '.50', '+.50', '1,50', '1e3', 'abc', '', ' 1.00', '1.00 ', '12.34.56', '--1.00', '0.1', '-0.001']) {
    assert.throws(() => buildReport(`${H}\na,2026-01-01,X,${amount},posted\n`), TypeError, amount);
  }
  for (const amount of ['+10.25', '-0.01', '0.00', '-0.00', '007.50', '90071992547409.91']) {
    assert.doesNotThrow(() => buildReport(`${H}\na,2026-01-01,X,${amount},posted\n`), amount);
  }
  assert.equal(buildReport(`${H}\na,2026-01-01,X,-5.00,posted\n`).totalCzk, '-5.00');
});

test('dates must be real calendar dates', () => {
  for (const date of ['2026-1-01', '26-01-01', '2026-01-1', '2026-13-01', '2026-00-10', '2026-02-30', '2025-02-29', '2026-04-31', '0000-01-01x', '2026-01-00', '2026-02 29', '']) {
    assert.throws(() => buildReport(`${H}\na,${date},X,1.00,posted\n`), TypeError, date);
  }
  for (const date of ['2024-02-29', '2000-02-29', '2026-12-31', '0400-02-29']) {
    assert.doesNotThrow(() => buildReport(`${H}\na,${date},X,1.00,posted\n`), date);
  }
});

test('status must be posted or pending', () => {
  for (const status of ['Posted', 'POSTED', 'posteds', '', 'paid', ' posted']) {
    assert.throws(() => buildReport(`${H}\na,2026-01-01,X,1.00,${status}\n`), TypeError, status);
  }
});

test('ids and categories must be non-empty; categories are trimmed and NFC-normalized', () => {
  assert.throws(() => buildReport(`${H}\n,2026-01-01,X,1.00,posted\n`), TypeError);
  assert.throws(() => buildReport(`${H}\na,2026-01-01,"  ",1.00,posted\n`), TypeError);
  assert.throws(() => buildReport(`${H}\na,2026-01-01,,1.00,posted\n`), TypeError);
  // "e" + combining caron normalizes to the precomposed form and merges buckets.
  assert.deepEqual(buildReport(`${H}\na,2026-01-01,  D\u011bti  ,1.00,posted\nb,2026-01-01,D\u0065\u030Cti,2.00,posted\n`), {
    postedCount: 2,
    totalCzk: '3.00',
    months: [{ month: '2026-01', totalCzk: '3.00' }],
    categories: [{ category: 'D\u011bti', totalCzk: '3.00' }],
  });
});

test('column counts and headers are strict', () => {
  assert.throws(() => buildReport('id,date,category,status\n1,2026-01-01,X,posted\n'), TypeError);
  assert.throws(() => buildReport('id,date,category,amount_czk\na,2026-01-01,X,1.00\n'), TypeError);
  assert.throws(() => buildReport(`${H}\na,2026-01-01,X,1.00\n`), TypeError);
  assert.throws(() => buildReport(`${H}\na,2026-01-01,X,1.00,posted,extra\n`), TypeError);
  assert.deepEqual(buildReport(`${H}\n\n\n`), { postedCount: 0, totalCzk: '0.00', months: [], categories: [] });
  assert.throws(() => buildReport(`${H}\na,2026-01-01,X,1.00,posted\n\nb,2026-01-02,Y,1.00,posted\n`), TypeError); // blank line inside data
});

test('malformed quoting is rejected', () => {
  const broken = [
    `${H}\na,2026-01-01,"X,1.00,posted\n`, // unterminated quote
    `${H}\na,2026-01-01,"X",1.00,posted"x\n`, // text after closing quote
    `${H}\na,2026-01-01,X"Y,1.00,posted\n`, // quote inside unquoted field
    `${H}\na,2026-01-01,X,1.00,po"sted\n`,
  ];
  for (const csv of broken) assert.throws(() => buildReport(csv), TypeError, JSON.stringify(csv));
});

test('buckets sort by month and by JS code-unit string order', () => {
  const report = buildReport(
    `${H}\n` +
    'a,2026-12-31,b,1.00,posted\n' +
    'b,2026-02-01,Z,1.00,posted\n' +
    'c,2026-10-01,_,1.00,posted\n' +
    'd,2026-01-01,\u00e9,1.00,posted\n' +
    'e,2026-01-02,A,1.00,posted\n',
  );
  assert.deepEqual(report.months.map((m) => m.month), ['2026-01', '2026-02', '2026-10', '2026-12']);
  assert.deepEqual(report.categories.map((c) => c.category), ['A', 'Z', '_', 'b', '\u00e9']);
});

test('non-string input is a TypeError', () => {
  for (const value of [undefined, null, 42, {}, ['a'], Buffer.from(H)]) {
    assert.throws(() => buildReport(value), TypeError);
  }
});
