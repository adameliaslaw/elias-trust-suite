// Attorney sign-off on a finalized IOLTA reconciliation packet (Phase 7 · #26).
//
// The same uniform, audited sign-off billable puts on a client invoice, here on
// the trust-account reconciliation packet. These tests pin:
//  1. WIRE-COMPATIBILITY with @elias/auth in BOTH directions — iolta's browser-
//     safe digest equals @elias/auth's `outputDigest`, `@elias/auth.verifySignoff`
//     accepts a Signoff iolta produced, and iolta's `verifyPacketSignoff` accepts
//     a Signoff `@elias/auth.reviewSignoff` produced. This is the lock-step pin
//     that lets iolta hash browser-safe (no node:crypto) yet stay identical to
//     the shared primitive.
//  2. CONTENT-ADDRESSING — amending the packet (new version → new contentHash)
//     invalidates an earlier sign-off; a stale approval can't cover new numbers.
//  3. FAIL-CLOSED — a missing or rejected sign-off blocks issuance.
//  4. The `compliance.signoff` audit event shape.
//
// Zero-dependency runner (node assert via tsx), matching the suite style. This
// test runs under Node, so it CAN import the real @elias/auth (node:crypto) —
// only the browser bundle can't, which is exactly why signoff.ts reimplements
// the digest browser-safe.
import assert from 'node:assert/strict';
import { reconcileStreams } from '../src/reconciliation';
import type { MonthReconciliation } from '../src/reconciliation';
import type { BankTransaction, BookTransaction, StatementPeriod, MatchRecord } from '../src/model';
import {
  buildFinalizedPacket,
  DEFAULT_ATTESTATION_STATEMENT,
  type Attestation,
  type FrozenInputs,
  type BuildPacketArgs,
  type FinalizedPacket,
} from '../src/lifecycle';
import {
  RECON_SIGNOFF_KIND,
  packetOutput,
  packetOutputDigest,
  signPacket,
  verifyPacketSignoff,
  assertPacketSignedOff,
  packetSignoffAuditEvent,
} from '../src/signoff';
// The REAL shared primitive (node:crypto) — the wire-compat reference.
import { outputDigest, reviewSignoff, verifySignoff } from '@elias/auth';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// A genuinely reconciled March (same fixture shape as lifecycle.test.ts).
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

function packet(over: Partial<BuildPacketArgs> = {}): FinalizedPacket {
  return buildFinalizedPacket(buildArgs(over));
}

const SIGNED_AT = '2026-04-01T15:01:00.000Z';

// ===========================================================================
// 1. Wire-compatibility with the real @elias/auth (the lock-step pin).
// ===========================================================================

test('#26 — the ComplianceOutput is keyed on the packet doc id and the recon kind', () => {
  const p = packet();
  const out = packetOutput(p);
  assert.equal(out.kind, RECON_SIGNOFF_KIND);
  assert.equal(out.id, `${p.accountId}__${p.month}__v${p.version}`);
  // The output binds the packet's own content hash — so it covers every number.
  assert.equal((out.content as { contentHash: string }).contentHash, p.contentHash);
});

test('#26 — iolta browser-safe digest is byte-identical to @elias/auth outputDigest', () => {
  const out = packetOutput(packet());
  // packetOutputDigest uses @elias/audit/core (portable sha256 + stableStringify);
  // outputDigest uses node:crypto + canonicalize. They MUST agree.
  assert.equal(packetOutputDigest(out), outputDigest(out));
});

test('#26 — @elias/auth.verifySignoff accepts a Signoff iolta produced (forward wire-compat)', () => {
  const p = packet();
  const signoff = signPacket(p, { attorney: 'attorney@firm.example', signedAt: SIGNED_AT });
  // The shared verifier, fed iolta's record + the same ComplianceOutput, agrees.
  assert.equal(verifySignoff(signoff, packetOutput(p)), true);
});

test('#26 — iolta.verifyPacketSignoff accepts a Signoff @elias/auth produced (backward wire-compat)', () => {
  const p = packet();
  const authSignoff = reviewSignoff(packetOutput(p), {
    attorney: 'attorney@firm.example', decision: 'approved', signedAt: SIGNED_AT,
  });
  assert.equal(verifyPacketSignoff(authSignoff, p), true);
  // And the two producers yield identical records for the same inputs.
  assert.deepEqual(signPacket(p, { attorney: 'attorney@firm.example', signedAt: SIGNED_AT }), authSignoff);
});

// ===========================================================================
// 2. Content-addressing — an amendment invalidates an earlier sign-off.
// ===========================================================================

test('#26 — a sign-off stops verifying once the packet is amended (content-addressed)', () => {
  const v1 = packet({ version: 1 });
  const signoff = signPacket(v1, { attorney: 'attorney@firm.example', signedAt: SIGNED_AT });
  assert.equal(verifyPacketSignoff(signoff, v1), true);

  // A v2 amendment is a distinct record with a different contentHash + doc id.
  const v2 = packet({ version: 2, amendmentReason: 'Bank corrected a posting error' });
  assert.notEqual(v1.contentHash, v2.contentHash);
  assert.equal(verifyPacketSignoff(signoff, v2), false);
  assert.throws(() => assertPacketSignedOff(v2, signoff), /does not match its current content/);
});

// ===========================================================================
// 3. Fail-closed — missing / rejected sign-off blocks issuance.
// ===========================================================================

test('#26 — assertPacketSignedOff throws with no sign-off on record', () => {
  assert.throws(() => assertPacketSignedOff(packet(), null), /No attorney sign-off on record/);
});

test('#26 — a rejection blocks issuance (and requires a note)', () => {
  const p = packet();
  assert.throws(
    () => signPacket(p, { attorney: 'attorney@firm.example', decision: 'rejected' }),
    /must include a note/,
  );
  const rejected = signPacket(p, {
    attorney: 'attorney@firm.example', decision: 'rejected', note: 'legs do not tie on my re-check', signedAt: SIGNED_AT,
  });
  assert.throws(() => assertPacketSignedOff(p, rejected), /signed off as rejected/);
  // An approved, matching sign-off is accepted and returned.
  const approved = signPacket(p, { attorney: 'attorney@firm.example', signedAt: SIGNED_AT });
  assert.equal(assertPacketSignedOff(p, approved), approved);
});

test('#26 — signPacket requires a reviewing attorney', () => {
  assert.throws(() => signPacket(packet(), { attorney: '   ' }), /reviewing attorney is required/);
});

// ===========================================================================
// 4. The compliance.signoff audit event.
// ===========================================================================

test('#26 — packetSignoffAuditEvent renders the shared compliance.signoff event', () => {
  const p = packet();
  const signoff = signPacket(p, {
    attorney: 'attorney@firm.example', note: 'reviewed and reconciled', signedAt: SIGNED_AT,
  });
  const ev = packetSignoffAuditEvent(signoff);
  assert.equal(ev.type, 'compliance.signoff');
  assert.equal(ev.payload.outputKind, RECON_SIGNOFF_KIND);
  assert.equal(ev.payload.outputId, `${p.accountId}__${p.month}__v${p.version}`);
  assert.equal(ev.payload.decision, 'approved');
  assert.equal(ev.payload.actor, 'attorney@firm.example');
  assert.equal(ev.payload.contentHash, signoff.contentHash);
  assert.equal(ev.payload.note, 'reviewed and reconciled');
});

console.log(`\n${passed} signoff tests passed`);
