/**
 * Three-way reconciliation computation (audit issues #7, #10, #13).
 *
 * Extracted from App.tsx so the accounting logic is unit-testable without a
 * React render or Firebase. All money is computed in exact integer cents via
 * @elias/money (src/money.ts) — no float drift in the reconciliation identity.
 *
 * Issue #13 — a month with NO bank statement balance entered is INCOMPLETE,
 * never reconciled. Treating a missing balance as $0.00 let an all-zero month
 * display "Reconciled" and seal a compliance event that was never earned. The
 * status is now explicit: 'incomplete' (no balance yet), 'reconciled' (balance
 * entered AND all three legs tie), or 'discrepancy' (balance entered, legs
 * disagree).
 */
import { parseISO, endOfMonth, isBefore, isEqual, isAfter } from 'date-fns';
import { toCents, fromCents } from './money';
import type { Transaction, Client } from './types';

export type ReconStatus = 'incomplete' | 'reconciled' | 'discrepancy';

export interface MonthReconciliation {
  month: string;
  hasStatementBalance: boolean;
  status: ReconStatus;
  isReconciled: boolean;
  statementBalance: number;
  adjustedBankBalance: number;
  bookBalance: number;
  clientBalanceTotal: number;
  outstandingChecksCount: number;
  outstandingChecksTotal: number;
  depositsInTransitCount: number;
  depositsInTransitTotal: number;
  clientBalances: { name: string; balance: number }[];
}

export function computeReconciliations(
  transactions: Transaction[],
  clients: Client[],
  statementBalances: Record<string, number>,
): MonthReconciliation[] {
  const months = Array.from(new Set(transactions.map(tx => tx.month))).sort().reverse();
  return months.map(month => {
    const monthDate = parseISO(`${month}-01`);
    const monthEnd = endOfMonth(monthDate);
    const onOrBeforeMonthEnd = (dateStr: string) =>
      isBefore(parseISO(dateStr), monthEnd) || isEqual(parseISO(dateStr), monthEnd);
    // Not cleared by month end = no clearDate, or cleared after month end.
    const notClearedByMonthEnd = (tx: Transaction) =>
      !tx.clearDate || isAfter(parseISO(tx.clearDate), monthEnd);

    // All money below is computed in integer cents (audit #10).

    // Bank Statement Balance — user-provided. A missing entry is NOT $0.00:
    // it means reconciliation cannot be performed yet (issue #13). Distinguish
    // "no entry" from an explicit 0 with hasOwnProperty.
    const hasStatementBalance = Object.prototype.hasOwnProperty.call(statementBalances, month);
    const statementBalanceCents = hasStatementBalance ? toCents(statementBalances[month]) : 0;

    // Outstanding Checks: disbursements issued on/before month end, but
    // cleared after month end or not yet cleared (amounts are negative).
    const outstandingChecks = transactions.filter(tx =>
      tx.type === 'disbursement' &&
      onOrBeforeMonthEnd(tx.date) &&
      notClearedByMonthEnd(tx)
    );
    const outstandingTotalCents = outstandingChecks.reduce((sum, tx) => sum + toCents(tx.amount), 0);

    // Deposits in Transit: receipts dated on/before month end, but cleared
    // after month end or not yet cleared (audit #7 — was missing entirely).
    const depositsInTransit = transactions.filter(tx =>
      tx.type === 'receipt' &&
      onOrBeforeMonthEnd(tx.date) &&
      notClearedByMonthEnd(tx)
    );
    const depositsInTransitTotalCents = depositsInTransit.reduce((sum, tx) => sum + toCents(tx.amount), 0);

    // Leg 1: Adjusted Bank Balance
    //   = statement balance − outstanding checks + deposits in transit
    // (check amounts are negative, deposits positive, so plain addition).
    const adjustedBankBalanceCents = statementBalanceCents + outstandingTotalCents + depositsInTransitTotalCents;

    // Leg 2: Book (checkbook) Balance — sum of ALL transactions through
    // month end, regardless of client assignment (audit #7 — was missing).
    const bookBalanceCents = transactions
      .filter(tx => onOrBeforeMonthEnd(tx.date))
      .reduce((sum, tx) => sum + toCents(tx.amount), 0);

    // Leg 3: Client Ledger Total (sum of all client balances as of month end)
    const clientBalancesCents = clients.map(client => {
      const balanceCents = transactions
        .filter(tx => tx.clientId === client.id && onOrBeforeMonthEnd(tx.date))
        .reduce((sum, tx) => sum + toCents(tx.amount), 0);
      return { name: client.name, balanceCents };
    });
    const clientBalanceTotalCents = clientBalancesCents.reduce((sum, c) => sum + c.balanceCents, 0);

    // Three-way reconciliation: all three legs must match to the penny. But a
    // month with no statement balance cannot be reconciled at all — the
    // adjusted-bank leg would be built on a fabricated $0.00 statement.
    const legsMatch =
      adjustedBankBalanceCents === bookBalanceCents &&
      bookBalanceCents === clientBalanceTotalCents;
    const isReconciled = hasStatementBalance && legsMatch;
    const status: ReconStatus = !hasStatementBalance
      ? 'incomplete'
      : legsMatch
        ? 'reconciled'
        : 'discrepancy';

    return {
      month,
      hasStatementBalance,
      status,
      isReconciled,
      statementBalance: fromCents(statementBalanceCents),
      adjustedBankBalance: fromCents(adjustedBankBalanceCents),
      bookBalance: fromCents(bookBalanceCents),
      clientBalanceTotal: fromCents(clientBalanceTotalCents),
      outstandingChecksCount: outstandingChecks.length,
      outstandingChecksTotal: fromCents(outstandingTotalCents),
      depositsInTransitCount: depositsInTransit.length,
      depositsInTransitTotal: fromCents(depositsInTransitTotalCents),
      clientBalances: clientBalancesCents
        .filter(c => c.balanceCents !== 0)
        .map(c => ({ name: c.name, balance: fromCents(c.balanceCents) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}
