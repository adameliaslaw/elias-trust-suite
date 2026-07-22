// Reconciliation lifecycle + retention regression tests (Phase 3 · #14, EVALUATION M2).
//
// The bugs this pins down:
//  1. History was mutable and "finalize" did not exist — a reconciled month
//     was auto-written and a transaction dated within it could be edited
//     forever. A finalized month must be LOCKED, and an amendment must produce
//     a NEW VERSION with a reason (never a silent mutation).
//  2. `reconciliation.completed` was auto-emitted on a debounce whenever a
//     month computed as reconciled — not on a deliberate attested finalize.
//  3. The sealed payload was self-contradictory: bankBalanceCents held the raw
//     statement balance while differenceCents used the adjusted balance.
//  4. A finalized packet must reproduce BYTE-FOR-BYTE and be retained 7 years.
//
// Zero-dependency runner (node assert via tsx), matching the suite style.
import assert from 'node:assert/strict';
import { reconcileStreams } from '../src/reconciliation';
import type { MonthReconciliation } from '../src/reconciliation';
import type { BankTransaction, BookTransaction, StatementPeriod, MatchRecord } from '../src/model';
import {
  buildFinalizedPacket,
  reconciliationCompletedPayload,
  periodExceptions,
  isAttestable,
  assertPeriodMutable,
  LockedPeriodError,
  reopenForAmendment,
  renderPacketDocument,
  retentionDeadline,
  addYearsIso,
  packetDocId,
  RECON_AUTHORITY,
  DEFAULT_ATTESTATION_STATEMENT,
  type Attestation,
  type FrozenInputs,
  type BuildPacketArgs,
} from '../src/lifecycle';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// A genuinely reconciled March: one $500 receipt cleared, one $100 check
// outstanding; statement 500, adjusted 400 = book 400 = client 400.
function reconciledMarch(): { recon: MonthReconciliation; inputs: FrozenInputs } {
  const receipt: BookTransaction = {
    id: 'bk-r', accountId: 'a', uid: 'u', clientId: 'c1', clientName: 'Acme Corp',
    date: '2026-03-05', amount: 500, type: 'receipt', description: 'Retainer', month: '2026-03',
  };
  const check: BookTransaction = {
    id: 'bk-c', accountId: 'a', uid: 'u', clientId: 'c1', clientName: 'Acme Corp',
    date: '2026-03-10', amount: -100, type: 'disbursement', checkNumber: '1001',
    description: 'Filing fee', month: '2026-03',
  };
  const bankDep: BankTransaction = {
    id: 'bank-r', accountId: 'a', uid: 'u', postedDate: '2026-03-06', amount: 500,
    description: 'DEPOSIT', statementPeriod: '2026-03',
  };
  const matches: MatchRecord[] = [
    { id: 'm-r', accountId: 'a', uid: 'u', bookTxId: 'bk-r', bankTxId: 'bank-r' },
  ];
  const statementPeriods: StatementPeriod[] = [
    { accountId: 'a', uid: 'u', month: '2026-03', endingBalance: 500 },
  ];
  const clients = [{ id: 'c1', name: 'Acme Corp', balance: 400 }];
  const [recon] = reconcileStreams({
    bankTransactions: [bankDep], bookTransactions: [receipt, check],
    statementPeriods, matches, clients,
  });
  return {
    recon,
    inputs: { bankTransactions: [bankDep], bookTransactions: [receipt, check], statementPeriods, matches, clients },
  };
}

const attestation: Attestation = {
  attestedBy: 'attorney@firm.example',
  attestedAt: '2026-04-01T15:00:00.000Z',
  statement: DEFAULT_ATTESTATION_STATEMENT,
};

function buildArgs(over: Partial<BuildPacketArgs> = {}): BuildPacketArgs {
  const { recon, inputs } = reconciledMarch();
  return {
    accountId: 'trust__u', month: '2026-03', version: 1, attestation,
    finalizedAt: '2026-04-01T15:00:05.000Z', finalizedBy: 'attorney@firm.example',
    reconciliation: recon, inputs, sources: [
      { name: 'march-statement.pdf', sha256: 'a'.repeat(64), bytes: 1234 },
    ],
    ...over,
  };
}

// ===========================================================================
// #14 — a finalized month is LOCKED: editing/adding a tx dated within it is
// rejected, and an amendment produces a NEW VERSION with a reason.
// ===========================================================================

test('#14 — editing or adding a transaction in a LOCKED month is rejected', () => {
  const locked = ['2026-03'];
  // Adding/editing a row dated in March throws.
  assert.throws(() => assertPeriodMutable({ date: '2026-03-15' }, locked), LockedPeriodError);
  // Deleting (its date is in March) throws too.
  assert.throws(() => assertPeriodMutable({ date: '2026-03-31' }, locked), LockedPeriodError);
  // Back-dating a row INTO the locked month (toDate) is rejected.
  assert.throws(() => assertPeriodMutable({ date: '2026-05-01', toDate: '2026-03-20' }, locked), LockedPeriodError);
  // A row wholly in an OPEN month is fine.
  assert.doesNotThrow(() => assertPeriodMutable({ date: '2026-05-01' }, locked));
});

test('#14 — an amendment produces a NEW VERSION with a reason (not a silent mutation)', () => {
  // Reopen requires a reason and bumps the version.
  assert.throws(() => reopenForAmendment({ status: 'finalized', version: 1 }, '   '), /requires a reason/);
  assert.throws(() => reopenForAmendment({ status: 'draft', version: 1 }, 'x'), /only a finalized/);
  const reopened = reopenForAmendment({ status: 'finalized', version: 1 }, 'Bank corrected a posting error');
  assert.equal(reopened.status, 'draft');
  assert.equal(reopened.version, 2);

  // A v2 packet MUST carry a reason; a v1 packet must not require one.
  assert.throws(() => buildFinalizedPacket(buildArgs({ version: 2 })), /requires a reason/);
  const v2 = buildFinalizedPacket(buildArgs({ version: 2, amendmentReason: reopened.reason }));
  assert.equal(v2.version, 2);
  assert.equal(v2.amendmentReason, 'Bank corrected a posting error');
  // The amended packet is a DISTINCT retained record, not an overwrite of v1.
  const v1 = buildFinalizedPacket(buildArgs({ version: 1 }));
  assert.notEqual(v1.contentHash, v2.contentHash);
  assert.notEqual(packetDocId('trust__u', '2026-03', 1), packetDocId('trust__u', '2026-03', 2));
});

// ===========================================================================
// Seal reconciliation.completed ONLY on a deliberate attested finalize.
// ===========================================================================

test('a month that COMPUTES as reconciled does not emit reconciliation.completed until finalize', () => {
  const { recon } = reconciledMarch();
  // The computed summary says reconciled...
  assert.equal(recon.status, 'reconciled');
  assert.equal(recon.isReconciled, true);
  // ...but computing it produces NO completed payload. The only way to a
  // completed payload is through an explicit attest + finalize (a packet).
  assert.equal(typeof reconciliationCompletedPayload, 'function');
  // reconcileStreams has no emit surface — a reconciled status alone seals nothing.
  assert.ok(!('completed' in (recon as object)));
  assert.ok(!('auditEvent' in (recon as object)));

  // A deliberate finalize is what yields the payload.
  const packet = buildFinalizedPacket(buildArgs());
  const payload = reconciliationCompletedPayload(packet, {
    reconciliationId: 'trust__u:2026-03', periodStart: '2026-03-01', periodEnd: '2026-03-31',
  });
  assert.equal(payload.reconciliationId, 'trust__u:2026-03');
  assert.equal(payload.performedBy, 'attorney@firm.example');
});

test('a month with unresolved exceptions cannot be attested or finalized', () => {
  // A discrepancy month: statement 999 but legs tie at 400.
  const { recon: good } = reconciledMarch();
  const bad: MonthReconciliation = { ...good, statementBalance: 999, adjustedBankBalance: 899, status: 'discrepancy', isReconciled: false };
  assert.equal(isAttestable(bad), false);
  assert.ok(periodExceptions(bad).some(e => e.code === 'out_of_balance'));
  assert.throws(() => buildFinalizedPacket(buildArgs({ reconciliation: bad })), /unresolved exceptions/);

  // The reconciled month IS attestable.
  assert.equal(isAttestable(good), true);
  assert.equal(periodExceptions(good).length, 0);
});

// ===========================================================================
// The sealed payload is internally consistent (fixes EVALUATION M2).
// ===========================================================================

test('the sealed reconciliation.completed payload is self-consistent (book − bank === difference)', () => {
  const packet = buildFinalizedPacket(buildArgs());
  const payload = reconciliationCompletedPayload(packet, {
    reconciliationId: 'trust__u:2026-03', periodStart: '2026-03-01', periodEnd: '2026-03-31',
  });
  const book = parseInt(payload.bookBalanceCents, 10);
  const bank = parseInt(payload.bankBalanceCents, 10);
  const diff = parseInt(payload.differenceCents, 10);
  // The core invariant that was violated: bankBalanceCents is the ADJUSTED bank
  // balance (40000), NOT the raw statement (50000), and the identity holds.
  assert.equal(bank, 40000); // adjusted bank = $400.00, not statement $500.00
  assert.equal(book, 40000);
  assert.equal(book - bank, diff);
  assert.equal(diff, 0); // a genuinely reconciled month
});

// ===========================================================================
// Reproducible packet + seven-year retention (Rule 1:21-6).
// ===========================================================================

test('regenerating a finalized packet is byte-for-byte identical', () => {
  // Build the same packet twice from the same inputs (arrays in a different
  // order to prove render sort-stability) — identical hash and identical bytes.
  const a = buildFinalizedPacket(buildArgs());
  const shuffled = buildArgs();
  shuffled.inputs = {
    ...shuffled.inputs,
    bookTransactions: [...shuffled.inputs.bookTransactions].reverse(),
  };
  const b = buildFinalizedPacket(shuffled);
  assert.equal(a.contentHash, b.contentHash, 'contentHash must not depend on input array order');
  assert.equal(renderPacketDocument(a), renderPacketDocument(b), 'rendered packet must be byte-for-byte identical');
  // And rendering the SAME packet twice is trivially identical.
  assert.equal(renderPacketDocument(a), renderPacketDocument(a));
});

test('a finalized packet cites its authority and is retained seven years (Rule 1:21-6)', () => {
  const packet = buildFinalizedPacket(buildArgs());
  assert.equal(packet.authority, RECON_AUTHORITY);
  assert.equal(packet.status, 'finalized');
  // Finalized 2026-04-01 → retain through 2033-04-01 (7 years).
  assert.equal(packet.retentionUntil, '2033-04-01');
  assert.equal(retentionDeadline('2026-04-01T15:00:05.000Z'), '2033-04-01');
  // Leap-day clamp: 2028-02-29 + 7 → 2035-02-28 (2035 is not a leap year).
  assert.equal(addYearsIso('2028-02-29', 7), '2035-02-28');
  assert.equal(addYearsIso('2024-02-29T12:00:00.000Z', 4), '2028-02-29T12:00:00.000Z'); // stays a leap year
  // The retained source hash is part of the sealed, reproducible packet.
  assert.equal(packet.sources[0].sha256, 'a'.repeat(64));
});

console.log(`\n${passed} passed`);
