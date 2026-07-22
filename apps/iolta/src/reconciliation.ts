/**
 * Three-way reconciliation over INDEPENDENT streams (issues #7, #10, #11, #13).
 *
 * Phase 1 extracted this from App.tsx but still derived all three legs from a
 * single `transactions` array — so the "three-way" reconciliation could tie out
 * by construction (issue #11). Phase 2 reconciles four *independently sourced*
 * streams (see model.ts):
 *
 *   - bank transactions   (BANK evidence)   — what actually posted to the bank
 *   - book transactions   (BOOK evidence)   — what the firm recorded
 *   - statement periods                      — the bank's ending balance
 *   - match records                          — which book item cleared which bank line
 *
 * The three legs now come from different streams:
 *   Leg 1 Adjusted Bank  = statement ending balance − outstanding checks + deposits in transit,
 *                          where "outstanding"/"in transit" is decided by the MATCH stream
 *                          (bank evidence), not a clearDate typed onto the book row.
 *   Leg 2 Book Balance   = sum of BOOK transactions through period end.
 *   Leg 3 Client Ledgers = sum of BOOK transactions grouped by client.
 *
 * Because the streams are independent, a bank line that was never booked (a
 * bank fee, a direct deposit the register missed) is representable and SURFACES
 * as a discrepancy — the single-source model literally could not encode it.
 * Such lines are reported in `unrecordedBankItems`.
 *
 * All money is computed in exact integer cents via @elias/money (money.ts).
 *
 * Issue #13 — a month with NO statement period entered is INCOMPLETE, never
 * reconciled: the adjusted-bank leg would otherwise be built on a fabricated
 * $0.00 statement.
 *
 * The legacy entry point `computeReconciliations(transactions, clients,
 * statementBalances)` is preserved as a thin adapter (book = the register;
 * bank/matches synthesized from each row's clearDate) so callers and the Phase
 * 1 tests keep working while the core reconciles independent sources.
 */
import { parseISO, endOfMonth, isBefore, isEqual } from 'date-fns';
import { toCents, fromCents } from './money';
import type { Transaction, Client } from './types';
import type {
  BankTransaction,
  BookTransaction,
  StatementPeriod,
  MatchRecord,
} from './model';

export type ReconStatus = 'incomplete' | 'reconciled' | 'discrepancy';

export interface UnrecordedBankItem {
  bankTxId: string;
  postedDate: string;
  amount: number;
  description: string;
  checkNumber?: string;
}

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
  /** Bank lines posted by period end with no matching book entry (#11). */
  unrecordedBankItems: UnrecordedBankItem[];
  unrecordedBankItemsTotal: number;
  clientBalances: { name: string; balance: number }[];
}

export interface ReconInput {
  bankTransactions: BankTransaction[];
  bookTransactions: BookTransaction[];
  statementPeriods: StatementPeriod[];
  matches: MatchRecord[];
  clients: Client[];
}

/**
 * Reconcile the four independent streams into a per-month three-way summary.
 * This is the core; `computeReconciliations` adapts the legacy single-array
 * shape onto it.
 */
export function reconcileStreams(input: ReconInput): MonthReconciliation[] {
  const { bankTransactions, bookTransactions, statementPeriods, matches, clients } = input;

  const statementByMonth = new Map<string, StatementPeriod>();
  for (const sp of statementPeriods) statementByMonth.set(sp.month, sp);

  const bankById = new Map<string, BankTransaction>();
  for (const bt of bankTransactions) bankById.set(bt.id, bt);

  // book tx id -> the bank line it is matched to (if any).
  const matchByBookTx = new Map<string, BankTransaction>();
  const matchedBankIds = new Set<string>();
  for (const m of matches) {
    const bank = bankById.get(m.bankTxId);
    matchedBankIds.add(m.bankTxId);
    if (bank) matchByBookTx.set(m.bookTxId, bank);
  }

  // Months come from BOTH book activity and statement periods: a statement
  // period with no book activity is still a reconciliation case.
  const months = Array.from(
    new Set([
      ...bookTransactions.map(tx => tx.month),
      ...statementPeriods.map(sp => sp.month),
    ]),
  )
    .sort()
    .reverse();

  return months.map(month => {
    const monthEnd = endOfMonth(parseISO(`${month}-01`));
    const onOrBeforeMonthEnd = (dateStr: string) =>
      isBefore(parseISO(dateStr), monthEnd) || isEqual(parseISO(dateStr), monthEnd);

    // A book item is CLEARED by month end only if it is matched to a bank line
    // that POSTED on or before month end (bank evidence — issue #11). No match,
    // or a match to a line that posts later, means it is still outstanding.
    const clearedByMonthEnd = (bookTxId: string) => {
      const bank = matchByBookTx.get(bookTxId);
      return !!bank && onOrBeforeMonthEnd(bank.postedDate);
    };

    // Leg 1 pieces: outstanding checks & deposits in transit come from BOOK
    // items with no clearing bank evidence by period end.
    const outstandingChecks = bookTransactions.filter(
      tx => tx.type === 'disbursement' && onOrBeforeMonthEnd(tx.date) && !clearedByMonthEnd(tx.id),
    );
    const outstandingTotalCents = outstandingChecks.reduce((s, tx) => s + toCents(tx.amount), 0);

    const depositsInTransit = bookTransactions.filter(
      tx => tx.type === 'receipt' && onOrBeforeMonthEnd(tx.date) && !clearedByMonthEnd(tx.id),
    );
    const depositsInTransitTotalCents = depositsInTransit.reduce((s, tx) => s + toCents(tx.amount), 0);

    // Statement ending balance — from the STATEMENT stream, not the book.
    const statementPeriod = statementByMonth.get(month);
    const hasStatementBalance = statementPeriod !== undefined;
    const statementBalanceCents = hasStatementBalance ? toCents(statementPeriod!.endingBalance) : 0;

    // Leg 1: Adjusted Bank Balance = statement − outstanding + deposits in transit.
    const adjustedBankBalanceCents =
      statementBalanceCents + outstandingTotalCents + depositsInTransitTotalCents;

    // Leg 2: Book Balance — sum of ALL book transactions through month end.
    const bookBalanceCents = bookTransactions
      .filter(tx => onOrBeforeMonthEnd(tx.date))
      .reduce((s, tx) => s + toCents(tx.amount), 0);

    // Leg 3: Client Ledger Total.
    const clientBalancesCents = clients.map(client => {
      const balanceCents = bookTransactions
        .filter(tx => tx.clientId === client.id && onOrBeforeMonthEnd(tx.date))
        .reduce((s, tx) => s + toCents(tx.amount), 0);
      return { name: client.name, balanceCents };
    });
    const clientBalanceTotalCents = clientBalancesCents.reduce((s, c) => s + c.balanceCents, 0);

    // Bank evidence with no book counterpart by period end (#11). These are the
    // discrepancies the single-source model could not represent at all.
    const unrecordedBankItemsList = bankTransactions.filter(
      bt => onOrBeforeMonthEnd(bt.postedDate) && !matchedBankIds.has(bt.id),
    );
    const unrecordedBankItems: UnrecordedBankItem[] = unrecordedBankItemsList.map(bt => ({
      bankTxId: bt.id,
      postedDate: bt.postedDate,
      amount: bt.amount,
      description: bt.description,
      checkNumber: bt.checkNumber,
    }));
    const unrecordedBankItemsTotalCents = unrecordedBankItemsList.reduce(
      (s, bt) => s + toCents(bt.amount),
      0,
    );

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
      unrecordedBankItems,
      unrecordedBankItemsTotal: fromCents(unrecordedBankItemsTotalCents),
      clientBalances: clientBalancesCents
        .filter(c => c.balanceCents !== 0)
        .map(c => ({ name: c.name, balance: fromCents(c.balanceCents) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * Adapt the app's existing single `transactions` array (the checkbook register)
 * onto the independent-stream core. The register IS the book stream; each row's
 * `clearDate` synthesizes a matching bank line (posted on the clear date), which
 * reproduces the pre-Phase-2 outstanding/deposits-in-transit semantics exactly.
 * Statement balances become statement periods. No synthesized bank line is ever
 * unmatched, so `unrecordedBankItems` is empty in legacy mode.
 */
export function computeReconciliations(
  transactions: Transaction[],
  clients: Client[],
  statementBalances: Record<string, number>,
): MonthReconciliation[] {
  const bookTransactions: BookTransaction[] = transactions.map(tx => ({
    id: tx.id,
    accountId: '',
    uid: tx.uid ?? '',
    clientId: tx.clientId,
    clientName: tx.clientName,
    date: tx.date,
    amount: tx.amount,
    type: tx.type,
    checkNumber: tx.checkNumber,
    description: tx.description,
    month: tx.month,
  }));

  const bankTransactions: BankTransaction[] = [];
  const matches: MatchRecord[] = [];
  for (const tx of transactions) {
    if (!tx.clearDate) continue;
    const bankId = `bank:${tx.id}`;
    bankTransactions.push({
      id: bankId,
      accountId: '',
      uid: tx.uid ?? '',
      postedDate: tx.clearDate,
      amount: tx.amount,
      description: tx.description,
      checkNumber: tx.checkNumber,
      statementPeriod: tx.clearDate.slice(0, 7),
    });
    matches.push({ id: `match:${tx.id}`, accountId: '', uid: tx.uid ?? '', bookTxId: tx.id, bankTxId: bankId });
  }

  const statementPeriods: StatementPeriod[] = Object.keys(statementBalances).map(month => ({
    accountId: '',
    uid: '',
    month,
    endingBalance: statementBalances[month],
  }));

  return reconcileStreams({ bankTransactions, bookTransactions, statementPeriods, matches, clients });
}
