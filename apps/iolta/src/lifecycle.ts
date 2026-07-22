/**
 * Reconciliation lifecycle state machine + retained packet (Phase 3 · #14).
 *
 * Phase 2 made the three-way reconciliation *correct* (independent streams).
 * It was still not *defensible*: App.tsx recomputed a month's summary on every
 * keystroke and auto-wrote it (and, when it happened to tie out, auto-sealed a
 * `reconciliation.completed` event) on a 1.5 s debounce. So there was no
 * "finalize", history was mutable, and the compliance trail was spammed with
 * events no attorney ever attested to (EVALUATION M2).
 *
 * This module separates COMPUTING A DRAFT from FINALIZING A PERIOD, and makes a
 * finalized period an immutable, retained, reproducible record:
 *
 *   draft ──resolve exceptions──▶ (attestable) ──attorney attest + finalize──▶ finalized/locked
 *                                                                                     │
 *                                                        amend/reopen (reason + new version)
 *                                                                                     ▼
 *                                                                                   draft(v+1)
 *
 * A finalized month:
 *   - FREEZES its bank/book/statement/match inputs and the computed legs into a
 *     `FinalizedPacket` whose `contentHash` is `sha256(canonical(body))` — the
 *     same hashing @elias/audit uses, so the packet is chainable and portable.
 *   - cites its AUTHORITY (NJ Court Rule 1:21-6) and its retention deadline
 *     (finalizedAt + 7 years, Rule 1:21-6(h)).
 *   - reproduces BYTE-FOR-BYTE: `buildFinalizedPacket` is a pure function of its
 *     inputs, and `renderPacketDocument` is a pure function of the packet, so
 *     regenerating either yields identical bytes.
 *   - is LOCKED: a transaction dated within a locked month cannot be edited,
 *     added, moved, or deleted (`assertPeriodMutable`).
 *
 * Amending a finalized month never mutates it silently: `reopenForAmendment`
 * requires a reason and bumps the version. The prior packet stays retained; the
 * amendment produces a NEW version that runs the lifecycle again.
 *
 * This module is pure and browser-safe (no Firebase, no node:fs): it imports
 * only @elias/audit/core (browser surface) and the app's money bridge, so the
 * whole lifecycle is unit-testable in plain Node (tsx) without a render or a
 * network round-trip. App.tsx and firestore.rules enforce it; this file is the
 * single source of the rules.
 */
import { stableStringify, sha256Hex } from '@elias/audit/core';
import type { ReconciliationCompletedPayload } from '@elias/audit/core';
import { toCents } from './money';
import type { MonthReconciliation } from './reconciliation';
import type {
  BankTransaction,
  BookTransaction,
  StatementPeriod,
  MatchRecord,
} from './model';

// ---------------------------------------------------------------------------
// Constants — the authority this record cites and the retention it promises.
// ---------------------------------------------------------------------------

export type LifecycleStatus = 'draft' | 'finalized';

/** The NJ authority a finalized trust reconciliation is retained under. */
export const RECON_AUTHORITY = 'NJ Court Rule 1:21-6';

/** Rule 1:21-6(h): trust-account records must be kept seven years. */
export const RETENTION_YEARS = 7;

/** Default attestation language surfaced in the finalize UI. */
export const DEFAULT_ATTESTATION_STATEMENT =
  'I have reviewed this three-way reconciliation and attest that, to the best of my ' +
  'knowledge, the trust account records are accurate and complete for the period ' +
  '(NJ Court Rule 1:21-6, RPC 1.15).';

// ---------------------------------------------------------------------------
// The attested finalize + the frozen packet.
// ---------------------------------------------------------------------------

/** The deliberate attorney sign-off that turns a draft into a sealed record. */
export interface Attestation {
  /** Attorney principal (email/uid) who attested — NOT a background process. */
  attestedBy: string;
  /** ISO 8601 UTC instant of the attestation. */
  attestedAt: string;
  /** The attestation language the attorney affirmed. */
  statement: string;
}

/**
 * The evidentiary inputs frozen at finalize — exactly what was reconciled, so
 * the packet reproduces the legs from source and an examiner can re-derive
 * every number rather than trust a stored total.
 */
export interface FrozenInputs {
  bankTransactions: BankTransaction[];
  bookTransactions: BookTransaction[];
  statementPeriods: StatementPeriod[];
  matches: MatchRecord[];
  /** Client identities + balances as of period end (Schedule of Client Balances). */
  clients: { id: string; name: string; balance: number }[];
}

/**
 * A retained source document (bank statement, check image, CSV) behind a
 * finalized month. We retain the CONTENT HASH so the packet can prove it was
 * built from this exact file even when only a stored copy — not the packet —
 * holds the bytes (server.ts retains the copy; #22 "retain source statements").
 */
export interface SourceDocument {
  /** Original filename as uploaded. */
  name: string;
  /** sha256 of the source bytes (hex). */
  sha256: string;
  /** Byte length of the source. */
  bytes: number;
}

/** The immutable, retained record a finalized month produces. */
export interface FinalizedPacket {
  accountId: string;
  month: string; // YYYY-MM
  /** 1 for the first finalize; incremented by each amendment. */
  version: number;
  status: 'finalized';
  /** The rule the record is kept under. */
  authority: string;
  attestation: Attestation;
  /** ISO 8601 UTC instant the packet was finalized. */
  finalizedAt: string;
  /** Principal who finalized (normally === attestation.attestedBy). */
  finalizedBy: string;
  /** Required for version > 1: why this month was reopened and amended. */
  amendmentReason?: string;
  /** The frozen three-way summary — the computed legs at finalize time. */
  reconciliation: MonthReconciliation;
  /** The frozen inputs the legs were computed from. */
  inputs: FrozenInputs;
  /** Content hashes of the retained source statements. */
  sources: SourceDocument[];
  /** ISO date (YYYY-MM-DD) through which this packet must be retained. */
  retentionUntil: string;
  /** sha256 over the canonical packet body (every field above). Seals it. */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Exceptions — the "resolve exceptions" gate before a month can be attested.
// ---------------------------------------------------------------------------

export type ExceptionCode =
  | 'no_statement_balance'
  | 'out_of_balance'
  | 'unrecorded_bank_item'
  | 'negative_client_ledger';

export interface PeriodException {
  code: ExceptionCode;
  message: string;
}

/**
 * The blocking exceptions that must be resolved before a month can be attested
 * and finalized. A month may only be sealed as "reconciled" when it genuinely
 * is: statement entered, all three legs tie, no unbooked bank line, no client
 * ledger in overdraw. These are exactly the conditions Rule 1:21-6 / RPC 1.15
 * would have an attorney certify.
 */
export function periodExceptions(recon: MonthReconciliation): PeriodException[] {
  const exceptions: PeriodException[] = [];
  if (!recon.hasStatementBalance) {
    exceptions.push({
      code: 'no_statement_balance',
      message: 'No bank statement balance entered — the reconciliation is incomplete.',
    });
  }
  if (recon.hasStatementBalance && recon.status !== 'reconciled') {
    exceptions.push({
      code: 'out_of_balance',
      message: 'The three reconciliation legs do not tie — resolve the discrepancy before finalizing.',
    });
  }
  if (recon.unrecordedBankItems.length > 0) {
    exceptions.push({
      code: 'unrecorded_bank_item',
      message:
        `${recon.unrecordedBankItems.length} bank line(s) never recorded in the book — ` +
        'record or explain them before finalizing.',
    });
  }
  for (const cb of recon.clientBalances) {
    if (toCents(cb.balance) < 0) {
      exceptions.push({
        code: 'negative_client_ledger',
        message: `Client "${cb.name}" ledger is negative — a trust overdraw must be resolved (RPC 1.15).`,
      });
    }
  }
  return exceptions;
}

/** A month is attestable only when it has no unresolved blocking exceptions. */
export function isAttestable(recon: MonthReconciliation): boolean {
  return periodExceptions(recon).length === 0;
}

// ---------------------------------------------------------------------------
// Retention date math — TZ-independent so the packet reproduces on any machine.
// ---------------------------------------------------------------------------

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Add whole calendar years to an ISO date/datetime, operating on the string
 * (never local `Date`), so the result is identical regardless of the running
 * machine's timezone — a hard requirement for a byte-for-byte reproducible
 * packet. Feb 29 in a non-leap target year clamps to Feb 28.
 */
export function addYearsIso(iso: string, years: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/.exec(iso);
  if (!m) throw new Error(`addYearsIso: not an ISO date/datetime: ${iso}`);
  const year = parseInt(m[1], 10) + years;
  const month = parseInt(m[2], 10);
  let day = parseInt(m[3], 10);
  if (month === 2 && day === 29 && !isLeapYear(year)) day = 28;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}${m[4] ?? ''}`;
}

/** The retention deadline (YYYY-MM-DD) for a packet finalized at `finalizedAt`. */
export function retentionDeadline(finalizedAt: string): string {
  return addYearsIso(finalizedAt, RETENTION_YEARS).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Building the finalized packet — the deliberate attested finalize.
// ---------------------------------------------------------------------------

export interface BuildPacketArgs {
  accountId: string;
  month: string;
  /** 1 for the first finalize; > 1 for an amendment (requires a reason). */
  version: number;
  attestation: Attestation;
  /** ISO 8601 UTC instant. Passed in (not read from a clock) so the packet is deterministic. */
  finalizedAt: string;
  finalizedBy: string;
  reconciliation: MonthReconciliation;
  inputs: FrozenInputs;
  sources: SourceDocument[];
  /** Required when version > 1. */
  amendmentReason?: string;
}

/**
 * Freeze inputs in a canonical order so the packet's `contentHash` depends on
 * the CONTENT of the streams, never the order the arrays happened to arrive in
 * (Firestore snapshot order, client sort). This is what makes the packet
 * reproducible byte-for-byte from independently-fetched inputs.
 */
export function canonicalizeInputs(inputs: FrozenInputs): FrozenInputs {
  return {
    bankTransactions: [...inputs.bankTransactions].sort(
      (a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id),
    ),
    bookTransactions: [...inputs.bookTransactions].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    ),
    statementPeriods: [...inputs.statementPeriods].sort((a, b) => a.month.localeCompare(b.month)),
    matches: [...inputs.matches].sort((a, b) => a.id.localeCompare(b.id)),
    clients: [...inputs.clients].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Seal a finalized packet. Pure and deterministic: same inputs → identical
 * `contentHash` and identical `renderPacketDocument` output, on any machine and
 * regardless of input array order. Refuses to seal a month that still has
 * unresolved exceptions, or an amendment (version > 1) with no reason.
 */
export function buildFinalizedPacket(args: BuildPacketArgs): FinalizedPacket {
  const {
    accountId, month, version, attestation, finalizedAt, finalizedBy,
    reconciliation, inputs, sources, amendmentReason,
  } = args;

  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`buildFinalizedPacket: version must be a positive integer, got ${version}`);
  }
  if (version > 1 && !amendmentReason?.trim()) {
    throw new Error('buildFinalizedPacket: an amendment (version > 1) requires a reason');
  }
  const exceptions = periodExceptions(reconciliation);
  if (exceptions.length > 0) {
    throw new Error(
      `buildFinalizedPacket: cannot finalize ${month} with unresolved exceptions: ` +
        exceptions.map(e => e.code).join(', '),
    );
  }

  const retentionUntil = retentionDeadline(finalizedAt);
  const canonicalInputs = canonicalizeInputs(inputs);
  const canonicalSources = [...sources].sort((a, b) => a.sha256.localeCompare(b.sha256));

  // The canonical body the contentHash seals — every field EXCEPT contentHash.
  // Undefined amendmentReason is omitted (stableStringify drops undefined) so a
  // v1 packet hashes identically whether or not the key is present in code.
  const body = {
    accountId,
    month,
    version,
    status: 'finalized' as const,
    authority: RECON_AUTHORITY,
    attestation,
    finalizedAt,
    finalizedBy,
    ...(amendmentReason?.trim() ? { amendmentReason: amendmentReason.trim() } : {}),
    reconciliation,
    inputs: canonicalInputs,
    sources: canonicalSources,
    retentionUntil,
  };
  const contentHash = sha256Hex(stableStringify(body));
  return { ...body, contentHash };
}

/** Firestore/localStorage doc id for a packet: account + month + version scoped. */
export function packetDocId(accountId: string, month: string, version: number): string {
  if (!accountId) throw new Error('packetDocId: accountId is required');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`packetDocId: invalid month ${month}`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`packetDocId: invalid version ${version}`);
  return `${accountId}__${month}__v${version}`;
}

// ---------------------------------------------------------------------------
// The self-consistent reconciliation.completed payload (fixes EVALUATION M2).
// ---------------------------------------------------------------------------

export interface CompletedPayloadMeta {
  reconciliationId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
}

/**
 * Build the `reconciliation.completed` audit payload from a finalized packet.
 *
 * The old App.tsx write stored the RAW statement balance in `bankBalanceCents`
 * while computing `differenceCents` from the ADJUSTED bank balance — so a
 * "reconciled" month sealed `difference:"0"` alongside `book ≠ bank`, an
 * internally contradictory record (EVALUATION M2). Here `bankBalanceCents` is
 * the adjusted bank balance and `differenceCents` is derived from the same two
 * numbers, so the identity `book − bank === difference` always holds.
 */
export function reconciliationCompletedPayload(
  packet: FinalizedPacket,
  meta: CompletedPayloadMeta,
): ReconciliationCompletedPayload {
  const bookCents = toCents(packet.reconciliation.bookBalance);
  const bankCents = toCents(packet.reconciliation.adjustedBankBalance);
  return {
    reconciliationId: meta.reconciliationId,
    accountId: packet.accountId,
    periodStart: meta.periodStart,
    periodEnd: meta.periodEnd,
    bookBalanceCents: String(bookCents),
    // The ADJUSTED bank balance — the number `differenceCents` is measured against.
    bankBalanceCents: String(bankCents),
    differenceCents: String(bookCents - bankCents),
    performedBy: packet.attestation.attestedBy,
  };
}

// ---------------------------------------------------------------------------
// Immutable lock — a locked month rejects edits to any tx dated within it.
// ---------------------------------------------------------------------------

/** The YYYY-MM a YYYY-MM-DD date falls in. */
export function monthOfDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) throw new Error(`monthOfDate: invalid date ${date}`);
  return date.slice(0, 7);
}

/** Thrown when a mutation would touch a finalized/locked period. */
export class LockedPeriodError extends Error {
  readonly month: string;
  constructor(month: string) {
    super(
      `Reconciliation for ${month} is finalized and locked (NJ Court Rule 1:21-6). ` +
        'Reopen it with a documented reason to amend — locked records are never silently changed.',
    );
    this.name = 'LockedPeriodError';
    this.month = month;
  }
}

export function isMonthLocked(month: string, lockedMonths: Iterable<string>): boolean {
  for (const m of lockedMonths) if (m === month) return true;
  return false;
}

/**
 * Guard a transaction mutation against locked periods. Both the transaction's
 * current month AND any target month (an edit that moves a row's date) must be
 * unlocked — you can neither remove a row from a locked month nor back-date a
 * row into one. Throws `LockedPeriodError`; callers surface it to the user.
 */
export function assertPeriodMutable(
  dates: { date?: string; toDate?: string },
  lockedMonths: Iterable<string>,
): void {
  const locked = new Set<string>();
  for (const m of lockedMonths) locked.add(m);
  const check = (d?: string) => {
    if (!d) return;
    const month = monthOfDate(d);
    if (locked.has(month)) throw new LockedPeriodError(month);
  };
  check(dates.date);
  check(dates.toDate);
}

// ---------------------------------------------------------------------------
// Amend / reopen — the only way out of a locked period, and never silent.
// ---------------------------------------------------------------------------

export interface PeriodLifecycle {
  status: LifecycleStatus;
  version: number;
}

/**
 * Reopen a finalized month for amendment. Requires a reason (recorded on the
 * next packet) and returns the next lifecycle: version + 1, back to draft. The
 * prior finalized packet remains retained — an amendment adds a version, it
 * does not overwrite history.
 */
export function reopenForAmendment(
  current: PeriodLifecycle,
  reason: string,
): { status: 'draft'; version: number; reason: string } {
  if (current.status !== 'finalized') {
    throw new Error('reopenForAmendment: only a finalized period can be reopened for amendment');
  }
  if (!reason?.trim()) {
    throw new Error('reopenForAmendment: reopening a finalized period requires a reason');
  }
  return { status: 'draft', version: current.version + 1, reason: reason.trim() };
}

// ---------------------------------------------------------------------------
// Reproducible audit-packet document (deterministic CSV/text artifact).
// ---------------------------------------------------------------------------

function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function money(n: number): string {
  return toCents(n) < 0
    ? `-$${(Math.abs(toCents(n)) / 100).toFixed(2)}`
    : `$${(toCents(n) / 100).toFixed(2)}`;
}

/**
 * Render a finalized packet to a deterministic, human-and-machine-readable
 * audit document (header block + CSV sections). Pure function of the packet:
 * regenerating it yields byte-for-byte identical output — the reproducibility
 * Rule 1:21-6 audit-readiness needs. Rows are emitted in a fixed sort order so
 * output never depends on input array ordering. A real PDF can wrap this text;
 * the bytes that matter for reproduction are here.
 */
export function renderPacketDocument(packet: FinalizedPacket): string {
  const r = packet.reconciliation;
  const lines: string[] = [];
  lines.push('IOLTA THREE-WAY RECONCILIATION — FINALIZED PACKET');
  lines.push(`Authority: ${packet.authority}`);
  lines.push(`Account: ${packet.accountId}`);
  lines.push(`Period: ${packet.month}  (version ${packet.version})`);
  lines.push(`Finalized: ${packet.finalizedAt} by ${packet.finalizedBy}`);
  lines.push(`Attested: ${packet.attestation.attestedAt} by ${packet.attestation.attestedBy}`);
  lines.push(`Attestation: ${packet.attestation.statement}`);
  if (packet.amendmentReason) lines.push(`Amendment reason: ${packet.amendmentReason}`);
  lines.push(`Retain until: ${packet.retentionUntil}`);
  lines.push(`Content hash (sha256): ${packet.contentHash}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push(`Statement balance,${money(r.statementBalance)}`);
  lines.push(`Adjusted bank balance,${money(r.adjustedBankBalance)}`);
  lines.push(`Book balance,${money(r.bookBalance)}`);
  lines.push(`Client ledger total,${money(r.clientBalanceTotal)}`);
  lines.push(`Outstanding checks,${r.outstandingChecksCount},${money(r.outstandingChecksTotal)}`);
  lines.push(`Deposits in transit,${r.depositsInTransitCount},${money(r.depositsInTransitTotal)}`);
  lines.push(`Status,${r.status}`);
  lines.push('');
  lines.push('SCHEDULE OF CLIENT BALANCES');
  lines.push('client,balance');
  for (const cb of [...r.clientBalances].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${csvCell(cb.name)},${money(cb.balance)}`);
  }
  lines.push('');
  lines.push('BOOK TRANSACTIONS');
  lines.push('date,type,amount,checkNumber,client,description');
  const books = [...packet.inputs.bookTransactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  for (const t of books) {
    lines.push([
      csvCell(t.date), csvCell(t.type), money(t.amount), csvCell(t.checkNumber),
      csvCell(t.clientName), csvCell(t.description),
    ].join(','));
  }
  lines.push('');
  lines.push('BANK TRANSACTIONS');
  lines.push('postedDate,amount,checkNumber,description');
  const banks = [...packet.inputs.bankTransactions].sort(
    (a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id),
  );
  for (const t of banks) {
    lines.push([
      csvCell(t.postedDate), money(t.amount), csvCell(t.checkNumber), csvCell(t.description),
    ].join(','));
  }
  lines.push('');
  lines.push('RETAINED SOURCE DOCUMENTS');
  lines.push('name,bytes,sha256');
  for (const s of [...packet.sources].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    lines.push(`${csvCell(s.name)},${s.bytes},${s.sha256}`);
  }
  return lines.join('\n') + '\n';
}
