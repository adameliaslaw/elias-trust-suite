// Client-ledger running-balance & chronological-validation tests (issue #21).
//
// Bug 1: the filtered client-ledger view restarted its running balance at ZERO,
// dropping the opening balance whenever a date/type filter hid earlier rows.
// Bug 2: no chronological validation of trust overdraw (a ledger dipping below
// zero is an RPC 1.15 red flag), and no source provenance for the offending row.
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import { buildLedgerView, validateLedgerChronology } from '../src/ledger';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

interface Tx {
  date: string;
  amount: number;
  type: 'receipt' | 'disbursement';
  description?: string;
}

const history: Tx[] = [
  { date: '2026-01-10', amount: 1000, type: 'receipt', description: 'Jan retainer' },
  { date: '2026-02-15', amount: -200, type: 'disbursement', description: 'Feb filing fee' },
  { date: '2026-03-05', amount: 500, type: 'receipt', description: 'Mar deposit' },
  { date: '2026-03-20', amount: -100, type: 'disbursement', description: 'Mar service' },
];

test('unfiltered ledger running balance is correct end to end', () => {
  const view = buildLedgerView(history);
  assert.equal(view.openingBalance, 0);
  assert.deepEqual(view.rows.map(r => r.runningBalance), [1000, 800, 1300, 1200]);
  assert.equal(view.closingBalance, 1200);
});

test('filtered-to-March ledger CARRIES the opening balance (does not restart at zero)', () => {
  const view = buildLedgerView(history, { start: '2026-03-01' });
  // Opening = Jan 1000 − Feb 200 = 800 (everything before the window).
  assert.equal(view.openingBalance, 800);
  // First visible March row's running balance must be 800 + 500 = 1300, NOT 500.
  assert.deepEqual(view.rows.map(r => r.runningBalance), [1300, 1200]);
  assert.equal(view.rows[0].runningBalance, 1300);
});

test('type filter still reflects hidden rows in the running balance', () => {
  // Show only receipts, but the Feb disbursement still happened before March.
  const view = buildLedgerView(history, { start: '2026-03-01', type: 'receipt' });
  assert.equal(view.openingBalance, 800);
  assert.equal(view.rows.length, 1); // only the Mar receipt is visible
  assert.equal(view.rows[0].runningBalance, 1300);
});

test('chronological validation flags a trust overdraw with source provenance', () => {
  const overdrawn: Tx[] = [
    { date: '2026-04-01', amount: 100, type: 'receipt', description: 'Small deposit' },
    { date: '2026-04-02', amount: -300, type: 'disbursement', description: 'Overpayment' },
    { date: '2026-04-03', amount: 500, type: 'receipt', description: 'Later top-up' },
  ];
  const violations = validateLedgerChronology(overdrawn);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].date, '2026-04-02');
  assert.equal(violations[0].runningBalance, -200);
  assert.match(violations[0].message, /Overpayment/);
  assert.match(violations[0].message, /RPC 1\.15/);
});

test('a ledger that never goes negative has no violations', () => {
  assert.deepEqual(validateLedgerChronology(history), []);
});

console.log(`\n${passed} passed`);
