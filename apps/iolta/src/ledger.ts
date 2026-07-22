/**
 * Client-ledger running balances & chronological validation (Phase 2, #21).
 *
 * Two defects:
 *
 *  1. The individual-client ledger modal computed its running balance starting
 *     from ZERO for whatever rows the date/type filter left visible. Filter a
 *     client to "March onward" and the opening balance silently vanished, so
 *     every displayed balance was wrong by the pre-window total. A ledger's
 *     running balance must carry the OPENING balance (everything before the
 *     window) forward.
 *
 *  2. No chronological validation: a trust ledger that dips below zero at any
 *     point is a Rule 1:21-6 / RPC 1.15 red flag (disbursing more than a client
 *     holds — misappropriation of another client's funds). We validate the
 *     running balance point-by-point and report the offending row with
 *     provenance (which transaction, on what date, drove it negative).
 *
 * All math is exact integer cents via @elias/money.
 */
import { toCents, fromCents } from './money';

export interface LedgerRow<T> {
  tx: T;
  runningBalance: number;
  runningBalanceCents: number;
}

export interface LedgerFilter {
  start?: string; // YYYY-MM-DD inclusive
  end?: string; // YYYY-MM-DD inclusive
  type?: 'all' | 'receipt' | 'disbursement';
}

interface LedgerTx {
  date: string;
  amount: number;
  type: 'receipt' | 'disbursement';
}

export interface LedgerView<T> {
  /** Sum of all rows chronologically BEFORE the visible window. */
  openingBalance: number;
  openingBalanceCents: number;
  rows: LedgerRow<T>[];
  closingBalance: number;
  closingBalanceCents: number;
}

/**
 * Build a filtered ledger view whose running balance carries the opening
 * balance forward. `allTx` is the client's COMPLETE history; the running
 * balance is computed over the full chronology, then the view is windowed to
 * the filter — so the first visible row already reflects everything prior.
 */
export function buildLedgerView<T extends LedgerTx>(
  allTx: T[],
  filter: LedgerFilter = {},
): LedgerView<T> {
  const chronological = [...allTx].sort((a, b) => a.date.localeCompare(b.date));

  const inWindow = (tx: T) => {
    if (filter.start && tx.date < filter.start) return false;
    if (filter.end && tx.date > filter.end) return false;
    if (filter.type && filter.type !== 'all' && tx.type !== filter.type) return false;
    return true;
  };

  let runningCents = 0;
  let openingCents = 0;
  let sawWindowRow = false;
  const rows: LedgerRow<T>[] = [];

  for (const tx of chronological) {
    const visible = inWindow(tx);
    // Opening balance = everything chronologically before the FIRST visible row.
    if (!sawWindowRow && !visible) {
      openingCents += toCents(tx.amount);
    }
    runningCents += toCents(tx.amount);
    if (visible) {
      sawWindowRow = true;
      rows.push({ tx, runningBalance: fromCents(runningCents), runningBalanceCents: runningCents });
    }
  }

  // If the type filter excludes rows inside the date window, those still affect
  // the running balance (they happened) but are not shown — openingCents above
  // only accumulates pre-first-visible rows, which is the correct carry.
  return {
    openingBalance: fromCents(openingCents),
    openingBalanceCents: openingCents,
    rows,
    closingBalance: fromCents(runningCents),
    closingBalanceCents: runningCents,
  };
}

export interface BalanceViolation<T> {
  tx: T;
  date: string;
  runningBalance: number;
  runningBalanceCents: number;
  message: string;
}

/**
 * Validate a client ledger chronologically: flag every point at which the
 * running balance goes negative (trust overdraw). Each violation names the
 * transaction and date that drove the balance below zero — the source
 * provenance an examiner needs to trace the error.
 */
export function validateLedgerChronology<T extends LedgerTx & { description?: string }>(
  allTx: T[],
): BalanceViolation<T>[] {
  const chronological = [...allTx].sort((a, b) => a.date.localeCompare(b.date));
  const violations: BalanceViolation<T>[] = [];
  let runningCents = 0;
  for (const tx of chronological) {
    runningCents += toCents(tx.amount);
    if (runningCents < 0) {
      violations.push({
        tx,
        date: tx.date,
        runningBalance: fromCents(runningCents),
        runningBalanceCents: runningCents,
        message:
          `Ledger went negative ($${fromCents(runningCents).toFixed(2)}) on ${tx.date}` +
          (tx.description ? ` after "${tx.description}"` : '') +
          ' — disbursement exceeds funds held for this client (RPC 1.15).',
      });
    }
  }
  return violations;
}
