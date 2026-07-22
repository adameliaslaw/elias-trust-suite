// Three-way reconciliation status regression tests (audit issue #13).
// The bug: a month with NO bank statement balance entered was treated as a
// $0.00 statement, so an all-zero month (or any month whose legs happened to
// tie at zero) displayed "Reconciled" and sealed a reconciliation.completed
// audit event — claiming compliance that was never performed. A month without
// a statement balance is INCOMPLETE, never reconciled.
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import { computeReconciliations } from '../src/reconciliation';
import type { Transaction, Client } from '../src/types';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const client: Client = { id: 'c1', name: 'Acme Corp', balance: 0 };

function tx(partial: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    date: '2026-01-15',
    clearDate: '2026-01-20',
    amount: 0,
    type: 'receipt',
    description: 'test',
    month: '2026-01',
    isOutstanding: false,
    ...partial,
  } as Transaction;
}

// A month whose legs all tie at zero, with NO statement balance entered.
const zeroingTxns: Transaction[] = [
  tx({ clientId: 'c1', amount: 100, type: 'receipt' }),
  tx({ clientId: 'c1', amount: -100, type: 'disbursement', checkNumber: '1001' }),
];

test('month with NO statement balance is INCOMPLETE, never reconciled (the #13 bug)', () => {
  const [recon] = computeReconciliations(zeroingTxns, [client], {});
  assert.equal(recon.month, '2026-01');
  assert.equal(recon.hasStatementBalance, false);
  assert.equal(recon.status, 'incomplete');
  assert.equal(recon.isReconciled, false); // was true — all legs zero looked "reconciled"
});

test('an explicit $0.00 statement balance is a real entry, distinct from missing', () => {
  const [recon] = computeReconciliations(zeroingTxns, [client], { '2026-01': 0 });
  assert.equal(recon.hasStatementBalance, true);
  // book = 0, clientTotal = 0, adjustedBank = 0 → legs tie → genuinely reconciled.
  assert.equal(recon.status, 'reconciled');
  assert.equal(recon.isReconciled, true);
});

test('statement balance entered and legs match → reconciled', () => {
  const txns = [tx({ clientId: 'c1', amount: 100, type: 'receipt' })];
  const [recon] = computeReconciliations(txns, [{ ...client, balance: 100 }], { '2026-01': 100 });
  assert.equal(recon.status, 'reconciled');
  assert.equal(recon.isReconciled, true);
  assert.equal(recon.statementBalance, 100);
});

test('statement balance entered but legs disagree → discrepancy (not incomplete)', () => {
  const txns = [tx({ clientId: 'c1', amount: 100, type: 'receipt' })];
  // Statement says 250 but book/ledger say 100 → out of balance.
  const [recon] = computeReconciliations(txns, [{ ...client, balance: 100 }], { '2026-01': 250 });
  assert.equal(recon.hasStatementBalance, true);
  assert.equal(recon.status, 'discrepancy');
  assert.equal(recon.isReconciled, false);
});

test('outstanding checks and deposits in transit are reflected in the adjusted balance', () => {
  const txns = [
    tx({ clientId: 'c1', amount: 500, type: 'receipt', clearDate: '2026-01-10' }), // cleared
    tx({ clientId: 'c1', amount: -100, type: 'disbursement', checkNumber: '2001', clearDate: undefined }), // outstanding
  ];
  // book = 500 - 100 = 400; client ledger = 400.
  // A statement showing 500 with a 100 outstanding check reconciles: 500 - 100 = 400.
  const [recon] = computeReconciliations(txns, [{ ...client, balance: 400 }], { '2026-01': 500 });
  assert.equal(recon.outstandingChecksCount, 1);
  assert.equal(recon.adjustedBankBalance, 400);
  assert.equal(recon.bookBalance, 400);
  assert.equal(recon.status, 'reconciled');
});

console.log(`\n${passed} passed`);
