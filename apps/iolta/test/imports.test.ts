// Atomic + idempotent import regression tests (issue #21).
//
// Headline (exit criterion): re-running an import is a NO-OP. Also: deterministic
// CSV parse before any AI fallback; duplicate clients within one import are
// collapsed; a transaction whose type contradicts its amount sign is rejected
// at the import/model layer (Phase 1 only normalized this in the manual modal).
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import {
  parseDelimited,
  parseCsvRows,
  transactionFingerprint,
  dedupeTransactions,
  newClientNames,
  signConsistencyError,
  signedForType,
} from '../src/imports';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const CSV = [
  'Date,Description,Check Number,Amount,Client Name,Type',
  '2026-03-05,Retainer deposit,,1500.00,Acme Corp,receipt',
  '03/06/2026,"Filing fee, county",1001,-250.00,Acme Corp,disbursement',
  '2026-03-07,Settlement funds,,"$3,000.00",Beta LLC,receipt',
].join('\n');

test('deterministic CSV parse structures a clean statement without the AI', () => {
  const { rows, recognized, errors } = parseDelimited(CSV);
  assert.equal(recognized, true);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '2026-03-05');
  assert.equal(rows[0].amount, 1500);
  assert.equal(rows[0].type, 'receipt');
  assert.equal(rows[1].date, '2026-03-06'); // MM/DD/YYYY normalized
  assert.equal(rows[1].amount, -250);
  assert.equal(rows[1].checkNumber, '1001');
  assert.equal(rows[1].description, 'Filing fee, county'); // quoted comma preserved
  assert.equal(rows[2].amount, 3000); // $ and thousands separator stripped
});

test('unrecognized content signals AI fallback (recognized === false)', () => {
  const { recognized } = parseDelimited('Dear Sir, please find enclosed your statement...');
  assert.equal(recognized, false);
});

test('RE-RUNNING AN IMPORT IS A NO-OP (the exit criterion)', () => {
  const { rows } = parseDelimited(CSV);
  // First import: nothing stored yet → everything is fresh.
  const first = dedupeTransactions(rows, new Set<string>());
  assert.equal(first.fresh.length, 3);
  assert.equal(first.duplicates.length, 0);

  // Persist their fingerprints (what the store now contains).
  const stored = new Set(first.fresh.map(transactionFingerprint));

  // Second import of the SAME file: zero fresh, all duplicates. No-op.
  const second = dedupeTransactions(rows, stored);
  assert.equal(second.fresh.length, 0, 'second import must add nothing');
  assert.equal(second.duplicates.length, 3);
});

test('dedup also collapses a line repeated within a single file', () => {
  const { rows } = parseDelimited(CSV);
  const withRepeat = [...rows, rows[0]]; // same first row twice
  const { fresh, duplicates } = dedupeTransactions(withRepeat, new Set());
  assert.equal(fresh.length, 3);
  assert.equal(duplicates.length, 1);
});

test('duplicate clients within one import create ONE client, case-insensitively', () => {
  const rows = [
    { clientName: 'Acme Corp' },
    { clientName: 'acme corp' }, // same client, different case
    { clientName: 'Beta LLC' },
    { clientName: undefined }, // unassigned
  ];
  const names = newClientNames(rows, []);
  assert.deepEqual(names, ['Acme Corp', 'Beta LLC']);
});

test('a client that already exists is not re-created', () => {
  const names = newClientNames([{ clientName: 'Acme Corp' }, { clientName: 'Gamma' }], ['acme corp']);
  assert.deepEqual(names, ['Gamma']);
});

test('a CSV row whose type contradicts its amount sign is REJECTED', () => {
  const bad = [
    'Date,Description,Amount,Type',
    '2026-03-05,Bad receipt,-100.00,receipt', // signed negative but labeled receipt
  ].join('\n');
  const { rows, errors } = parseDelimited(bad);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /contradicts amount sign/);
});

test('signConsistencyError enforces the stored sign convention at the model layer', () => {
  assert.equal(signConsistencyError('receipt', 100), null);
  assert.equal(signConsistencyError('disbursement', -100), null);
  assert.match(signConsistencyError('receipt', -100)!, /negative/);
  assert.match(signConsistencyError('disbursement', 100)!, /positive/);
  assert.match(signConsistencyError('receipt', 0)!, /non-zero/);
});

test('signedForType derives the sign from the type (manual-entry parity)', () => {
  assert.equal(signedForType('receipt', 100), 100);
  assert.equal(signedForType('receipt', -100), 100);
  assert.equal(signedForType('disbursement', 100), -100);
  assert.equal(signedForType('disbursement', -100), -100);
});

test('parseCsvRows handles escaped quotes and CRLF', () => {
  const grid = parseCsvRows('a,"b ""x"" c",d\r\n1,2,3\r\n');
  assert.deepEqual(grid, [['a', 'b "x" c', 'd'], ['1', '2', '3']]);
});

console.log(`\n${passed} passed`);
