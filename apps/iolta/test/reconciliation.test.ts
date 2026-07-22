// Three-way reconciliation status regression tests (audit issue #13).
// The bug: a month with NO bank statement balance entered was treated as a
// $0.00 statement, so an all-zero month (or any month whose legs happened to
// tie at zero) displayed "Reconciled" and sealed a reconciliation.completed
// audit event — claiming compliance that was never performed. A month without
// a statement balance is INCOMPLETE, never reconciled.
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import { computeReconciliations, reconcileStreams } from '../src/reconciliation';
import type { Transaction, Client } from '../src/types';
import type {
  BankTransaction,
  BookTransaction,
  StatementPeriod,
  MatchRecord,
} from '../src/model';

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

// ===========================================================================
// Issue #11 — the three legs must come from INDEPENDENT streams. The heart of
// the fix: a bank line that was never booked is representable and surfaces as a
// discrepancy. The old single-`transactions` model could not encode a bank line
// with no book line, so it could tie out by construction.
// ===========================================================================

function bookTx(p: Partial<BookTransaction>): BookTransaction {
  return {
    id: Math.random().toString(36).slice(2),
    accountId: 'trust__uid-1',
    uid: 'uid-1',
    date: '2026-03-05',
    amount: 0,
    type: 'receipt',
    description: 'book',
    month: '2026-03',
    ...p,
  } as BookTransaction;
}

test('#11 — an unrecorded bank line (bank fee) surfaces as a discrepancy the single-source model could not represent', () => {
  // BOOK: one $1000 client receipt, cleared (matched to a bank deposit).
  const deposit = bookTx({ id: 'bk1', clientId: 'c1', amount: 1000, type: 'receipt' });
  // BANK: the matched $1000 deposit, PLUS a $30 service fee never entered in the book.
  const bankDeposit: BankTransaction = {
    id: 'bank-dep', accountId: 'trust__uid-1', uid: 'uid-1',
    postedDate: '2026-03-06', amount: 1000, description: 'DEPOSIT',
    statementPeriod: '2026-03',
  };
  const bankFee: BankTransaction = {
    id: 'bank-fee', accountId: 'trust__uid-1', uid: 'uid-1',
    postedDate: '2026-03-31', amount: -30, description: 'SERVICE FEE',
    statementPeriod: '2026-03',
  };
  const matches: MatchRecord[] = [
    { id: 'm1', accountId: 'trust__uid-1', uid: 'uid-1', bookTxId: 'bk1', bankTxId: 'bank-dep' },
  ];
  const statementPeriods: StatementPeriod[] = [
    // Ending balance reflects BOTH the deposit and the fee: 1000 − 30 = 970.
    { accountId: 'trust__uid-1', uid: 'uid-1', month: '2026-03', endingBalance: 970 },
  ];
  const [recon] = reconcileStreams({
    bankTransactions: [bankDeposit, bankFee],
    bookTransactions: [deposit],
    statementPeriods,
    matches,
    clients: [{ id: 'c1', name: 'Acme Corp', balance: 1000 }],
  });

  // Book & client ledger = 1000; adjusted bank = statement 970 (no outstanding/DIT).
  assert.equal(recon.bookBalance, 1000);
  assert.equal(recon.clientBalanceTotal, 1000);
  assert.equal(recon.adjustedBankBalance, 970);
  // The legs DON'T tie — this is the evidentiary discrepancy.
  assert.equal(recon.status, 'discrepancy');
  // And the unbooked bank line is named explicitly.
  assert.equal(recon.unrecordedBankItems.length, 1);
  assert.equal(recon.unrecordedBankItems[0].amount, -30);
  assert.equal(recon.unrecordedBankItemsTotal, -30);
});

test('#11 — outstanding vs cleared is decided by the MATCH stream, not a clearDate on the book row', () => {
  // Two identical book disbursements; only one has bank evidence that it cleared.
  const check1 = bookTx({ id: 'bk-c1', clientId: 'c1', amount: -100, type: 'disbursement', checkNumber: '1001' });
  const check2 = bookTx({ id: 'bk-c2', clientId: 'c1', amount: -100, type: 'disbursement', checkNumber: '1002' });
  const receipt = bookTx({ id: 'bk-r', clientId: 'c1', amount: 300, type: 'receipt' });
  const bankReceipt: BankTransaction = {
    id: 'bank-r', accountId: 'a', uid: 'u', postedDate: '2026-03-06', amount: 300, description: 'DEP', statementPeriod: '2026-03',
  };
  const bankCheck1: BankTransaction = {
    id: 'bank-c1', accountId: 'a', uid: 'u', postedDate: '2026-03-20', amount: -100, description: 'CHK 1001', checkNumber: '1001', statementPeriod: '2026-03',
  };
  const matches: MatchRecord[] = [
    { id: 'm-r', accountId: 'a', uid: 'u', bookTxId: 'bk-r', bankTxId: 'bank-r' },
    { id: 'm-c1', accountId: 'a', uid: 'u', bookTxId: 'bk-c1', bankTxId: 'bank-c1' },
  ];
  // Statement ending balance = 300 − 100 (only check 1001 cleared) = 200.
  // check 1002 is outstanding, so adjusted bank = 200 − 100 = 100? No:
  // adjusted = statement 200 + outstanding(−100) = 100. book = 300−100−100 = 100.
  const statementPeriods: StatementPeriod[] = [
    { accountId: 'a', uid: 'u', month: '2026-03', endingBalance: 200 },
  ];
  const [recon] = reconcileStreams({
    bankTransactions: [bankReceipt, bankCheck1],
    bookTransactions: [receipt, check1, check2],
    statementPeriods,
    matches,
    clients: [{ id: 'c1', name: 'Acme Corp', balance: 100 }],
  });
  assert.equal(recon.outstandingChecksCount, 1); // only check 1002, per bank evidence
  assert.equal(recon.outstandingChecksTotal, -100);
  assert.equal(recon.adjustedBankBalance, 100);
  assert.equal(recon.bookBalance, 100);
  assert.equal(recon.status, 'reconciled');
  assert.equal(recon.unrecordedBankItems.length, 0);
});

console.log(`\n${passed} passed`);
