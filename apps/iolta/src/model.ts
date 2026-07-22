/**
 * IOLTA trust-accounting domain model (Phase 2 · issues #11, #15).
 *
 * Two structural problems drove this module:
 *
 *  1. #11 — the three reconciliation legs were all derived from ONE
 *     `transactions` array, so the "three-way" reconciliation could tie out by
 *     construction. This module makes the four evidentiary streams first-class
 *     and *distinct types* so a leg can never be silently re-sourced from
 *     another:
 *       - BankTransaction   — a line as it appears on the BANK statement (bank evidence)
 *       - BookTransaction   — a line as recorded in the firm's checkbook register (book evidence)
 *       - StatementPeriod   — the bank's authoritative ending balance for a period
 *       - MatchRecord       — links a book entry to the bank line that cleared it
 *     Whether a book item is "outstanding" / "in transit" now comes from the
 *     MATCH stream (bank evidence), not from a `clearDate` the user types onto
 *     the book row.
 *
 *  2. #15 — `statementBalances`/`reconciliations` docs used bare month IDs
 *     (`2026-07`) and the account was hardcoded `iolta-trust`, so the first
 *     user to write a month owned it for everyone and multiple trust accounts
 *     were impossible. This module introduces firms → memberships → trust
 *     accounts → account-scoped periods, and deterministic, collision-free
 *     doc-id helpers.
 *
 * Multi-tenancy posture (Decision 1 = "C", recommended default; Decision 3 of
 * the #19 memo is NOT yet ratified): we build the general firms→accounts
 * hierarchy so nothing is hardcoded to one firm, but the app runs single-firm
 * today by deriving a per-user default trust account. No architectural door to
 * SaaS is closed; no invoice/payment "system of record" is assumed.
 */

// ---------------------------------------------------------------------------
// Tenancy hierarchy
// ---------------------------------------------------------------------------

/** A law firm — the tenant boundary. Single firm in practice today. */
export interface Firm {
  id: string;
  name: string;
  createdAt?: unknown;
}

export type MembershipRole = 'owner' | 'admin' | 'member';

/** A user's membership in a firm. Governs which firm's data a uid may touch. */
export interface Membership {
  id: string;
  firmId: string;
  uid: string;
  role: MembershipRole;
}

/** A trust (IOLTA) account belonging to a firm. Replaces the hardcoded id. */
export interface TrustAccount {
  id: string;
  firmId: string;
  name: string;
  /** Owning user's uid — the ownership key Firestore rules enforce. */
  uid: string;
  bankName?: string;
  accountNumberLast4?: string;
}

// ---------------------------------------------------------------------------
// The four independent reconciliation streams (#11)
// ---------------------------------------------------------------------------

/**
 * A line item exactly as it appears on the BANK statement — bank evidence.
 * Independent of what the firm recorded. `amount` is signed: positive credits
 * the account (deposit), negative debits it (check paid, fee).
 */
export interface BankTransaction {
  id: string;
  accountId: string;
  uid: string;
  /** Date the bank POSTED the item (may differ from the book/issue date). */
  postedDate: string; // YYYY-MM-DD
  amount: number; // signed
  description: string;
  checkNumber?: string;
  /** Statement period this line belongs to (YYYY-MM). */
  statementPeriod: string;
}

/**
 * A line item as recorded in the firm's checkbook register — book evidence.
 * This is the app's existing Transaction, now named for its role in the model.
 */
export interface BookTransaction {
  id: string;
  accountId: string;
  uid: string;
  clientId?: string;
  clientName?: string;
  date: string; // YYYY-MM-DD (issue/record date)
  amount: number; // signed: + receipt, - disbursement
  type: 'receipt' | 'disbursement';
  checkNumber?: string;
  description: string;
  month: string; // YYYY-MM
}

/** The bank's authoritative ending balance for a statement period. */
export interface StatementPeriod {
  accountId: string;
  uid: string;
  month: string; // YYYY-MM
  endingBalance: number;
  periodStart?: string; // YYYY-MM-DD
  periodEnd?: string; // YYYY-MM-DD
}

/** Links a book entry to the bank line that cleared it (the reconciliation act). */
export interface MatchRecord {
  id: string;
  accountId: string;
  uid: string;
  bookTxId: string;
  bankTxId: string;
  matchedAt?: string;
}

// ---------------------------------------------------------------------------
// Doc-id scoping (#15) — collision-free, account-scoped Firestore ids
// ---------------------------------------------------------------------------

/** Separator for composite doc ids. `__` is Firestore-id-safe (no '/'). */
export const ID_SEP = '__';

/** Default trust-account slug when a firm has one unnamed account. */
export const DEFAULT_ACCOUNT_SLUG = 'trust';

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * The per-user default trust-account id. Uid-scoped so two users NEVER collide
 * on the same period doc (the #15 bug), while the `${slug}` prefix leaves room
 * for additional named accounts (`operating`, `escrow`, …) under one user.
 * Not hardcoded 'iolta-trust'.
 */
export function defaultAccountId(uid: string): string {
  if (!uid) throw new Error('defaultAccountId: uid is required');
  return `${DEFAULT_ACCOUNT_SLUG}${ID_SEP}${uid}`;
}

/**
 * Account-scoped period doc id: `${accountId}__${month}`.
 * Because every accountId is itself uid/firm-scoped, the same calendar month
 * for two different accounts (or two different users) maps to two DISTINCT docs
 * — no first-writer-wins collision.
 */
export function periodDocId(accountId: string, month: string): string {
  if (!accountId) throw new Error('periodDocId: accountId is required');
  if (!MONTH_RE.test(month)) throw new Error(`periodDocId: invalid month ${month}`);
  return `${accountId}${ID_SEP}${month}`;
}

/** Extract the `YYYY-MM` month back out of a period doc id. */
export function monthFromPeriodDocId(docId: string): string {
  const month = docId.slice(-7);
  if (!MONTH_RE.test(month)) throw new Error(`monthFromPeriodDocId: no month in ${docId}`);
  return month;
}
