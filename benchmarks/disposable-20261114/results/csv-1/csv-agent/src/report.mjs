// Expense report builder: strict CSV parsing + safe-integer cent arithmetic.

const HEADER = ['id', 'date', 'category', 'amount_czk', 'status'];
const COLUMNS = HEADER.length;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const AMOUNT_RE = /^[+-]?\d+\.\d{2}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS_IN_YEAR = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Remove a single leading UTF-8 BOM. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * RFC-4180-style parser for comma separated text.
 * Handles quoted fields, doubled ("") escaped quotes, embedded newlines and
 * both LF and CRLF terminators. Malformed quoting throws TypeError.
 * A row is only emitted once it is terminated, so trailing blank lines never
 * become data rows. A comma always commits the field before it, so text ending
 * with a comma still carries the empty field that follows it.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  // True while the comma at the end of the consumed text opened a new field
  // that the loop never got to read (the empty field after "a,b," at EOF).
  let pendingField = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    pendingField = false;
    let field = '';
    let terminated = false;

    if (text[i] === '"') {
      i += 1; // opening quote
      let closed = false;
      while (i < n) {
        const ch = text[i];
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1; // closing quote
          closed = true;
          break;
        }
        field += ch;
        i += 1;
      }
      if (!closed) throw new TypeError('Malformed CSV: unterminated quoted field');

      if (i < n) {
        const ch = text[i];
        if (ch === ',') {
          row.push(field);
          i += 1;
          pendingField = true;
          continue;
        }
        if (ch === '\n') {
          terminated = true;
          i += 1;
        } else if (ch === '\r') {
          terminated = true;
          i += text[i + 1] === '\n' ? 2 : 1;
        } else {
          throw new TypeError(
            `Malformed CSV: unexpected ${JSON.stringify(ch)} after closing quote`,
          );
        }
      }
      row.push(field);
    } else {
      while (i < n) {
        const ch = text[i];
        if (ch === ',' || ch === '\n' || ch === '\r') break;
        if (ch === '"') {
          throw new TypeError('Malformed CSV: unexpected quote inside unquoted field');
        }
        field += ch;
        i += 1;
      }
      if (i < n) {
        const ch = text[i];
        if (ch === ',') {
          row.push(field);
          i += 1;
          pendingField = true;
          continue;
        }
        terminated = true;
        if (ch === '\r' && text[i + 1] === '\n') i += 2;
        else i += 1;
      }
      row.push(field);
    }

    if (terminated) {
      rows.push(row);
      row = [];
    }
  }

  if (pendingField) row.push('');
  if (row.length > 0) rows.push(row);
  return rows;
}

/** Drop blank (empty or whitespace-only, single-field) lines at the end. */
function dropTrailingBlankRows(rows) {
  let end = rows.length;
  while (end > 0) {
    const row = rows[end - 1];
    if (row.length === 1 && row[0].trim() === '') {
      end -= 1;
      continue;
    }
    break;
  }
  return rows.slice(0, end);
}

function daysInMonth(year, month) {
  if (month !== 2) return MONTHS_IN_YEAR[month - 1];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

/** Validate YYYY-MM-DD as a real calendar date; return the YYYY-MM bucket. */
function parseDate(raw, where) {
  const match = DATE_RE.exec(raw);
  if (!match) {
    throw new TypeError(`Invalid date ${JSON.stringify(raw)} on ${where}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new TypeError(`Invalid date ${JSON.stringify(raw)} on ${where}`);
  }
  return `${match[1]}-${match[2]}`;
}

/** Parse a signed decimal with exactly two fractional digits into integer cents. */
function parseAmountCents(raw, where) {
  if (!AMOUNT_RE.test(raw)) {
    throw new TypeError(`Invalid amount ${JSON.stringify(raw)} on ${where}`);
  }
  const negative = raw[0] === '-';
  const body = raw[0] === '+' || raw[0] === '-' ? raw.slice(1) : raw;
  const digits = body.replace('.', '');
  const magnitude = BigInt(digits);
  if (magnitude > MAX_SAFE_CENTS) {
    throw new TypeError(`Amount ${JSON.stringify(raw)} on ${where} exceeds safe integer cents`);
  }
  return negative ? -Number(magnitude) : Number(magnitude);
}

/**
 * Add cents exactly and reject any partial total that leaves the safe-integer
 * range. A safe overall total does not imply safe per-bucket subtotals: equal
 * positive and negative amounts can cancel globally while one subtotal overflows.
 */
function addCents(current, delta, label, where) {
  const sum = BigInt(current) + BigInt(delta);
  if (sum > MAX_SAFE_CENTS || sum < -MAX_SAFE_CENTS) {
    throw new TypeError(`${label} exceeds safe integer cents on ${where}`);
  }
  return Number(sum);
}

/** Cents to a fixed two-decimal string, never "-0.00". */
function formatCents(cents) {
  const magnitude = Math.abs(cents);
  const whole = Math.trunc(magnitude / 100);
  const fraction = magnitude % 100;
  const digits = `${whole}.${String(fraction).padStart(2, '0')}`;
  return cents < 0 && magnitude !== 0 ? `-${digits}` : digits;
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function buildReport(csv) {
  if (typeof csv !== 'string') {
    throw new TypeError('buildReport expects a CSV string');
  }

  const rows = dropTrailingBlankRows(parseCsv(stripBom(csv)));
  if (rows.length === 0) {
    return { postedCount: 0, totalCzk: '0.00', months: [], categories: [] };
  }

  const header = rows.shift();
  if (
    header.length !== COLUMNS ||
    HEADER.some((name, index) => header[index] !== name)
  ) {
    throw new TypeError(
      `Invalid CSV header: expected ${HEADER.join(',')} but got ${JSON.stringify(header.join(','))}`,
    );
  }

  const seen = new Map(); // id -> canonical row key
  const monthTotals = new Map();
  const categoryTotals = new Map();
  let postedCount = 0;
  let totalCents = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const where = `row ${index + 2}`;
    if (row.length !== COLUMNS) {
      throw new TypeError(
        `Invalid column count on ${where}: expected ${COLUMNS} but got ${row.length}`,
      );
    }

    const [rawId, rawDate, rawCategory, rawAmount, rawStatus] = row;

    if (rawId.trim() === '') throw new TypeError(`Invalid empty id on ${where}`);

    const month = parseDate(rawDate, where);

    const category = rawCategory.trim().normalize('NFC');
    if (category === '') throw new TypeError(`Invalid empty category on ${where}`);

    const cents = parseAmountCents(rawAmount, where);

    if (rawStatus !== 'posted' && rawStatus !== 'pending') {
      throw new TypeError(`Invalid status ${JSON.stringify(rawStatus)} on ${where}`);
    }

    const key = JSON.stringify([rawId, rawDate, category, cents, rawStatus]);
    const previous = seen.get(rawId);
    if (previous !== undefined) {
      if (previous !== key) {
        throw new TypeError(`Conflicting duplicate id ${JSON.stringify(rawId)} on ${where}`);
      }
      continue; // exact duplicate of an already counted row
    }
    seen.set(rawId, key);

    if (rawStatus !== 'posted') continue; // validated, but not part of totals

    postedCount += 1;
    totalCents = addCents(totalCents, cents, 'Running total', where);
    const monthLabel = `Month subtotal for ${month}`;
    const categoryLabel = `Category subtotal for ${JSON.stringify(category)}`;
    monthTotals.set(month, addCents(monthTotals.get(month) ?? 0, cents, monthLabel, where));
    categoryTotals.set(category, addCents(categoryTotals.get(category) ?? 0, cents, categoryLabel, where));
  }

  const months = [...monthTotals.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([month, cents]) => ({ month, totalCzk: formatCents(cents) }));

  const categories = [...categoryTotals.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([category, cents]) => ({ category, totalCzk: formatCents(cents) }));

  return {
    postedCount,
    totalCzk: formatCents(totalCents),
    months,
    categories,
  };
}
