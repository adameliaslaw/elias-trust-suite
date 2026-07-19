/**
 * Closed vocabulary of auditable events for the Elias Trust Suite.
 *
 * Money fields are ALWAYS integer cents encoded as decimal strings —
 * the same representation as `Money.toJSON()` from @elias/money — so the
 * audit trail can never carry a float64 amount. The packages stay
 * dependency-free; the convention is the contract.
 */

export interface ReconciliationCompletedPayload {
  /** Unique id of the three-way reconciliation run (Rule 1:21-6 record). */
  reconciliationId: string;
  /** Trust account / IOLTA account identifier. */
  accountId: string;
  /** Inclusive period, ISO 8601 dates (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  /** Book (ledger) balance, integer cents as decimal string. */
  bookBalanceCents: string;
  /** Adjusted bank balance, integer cents as decimal string. */
  bankBalanceCents: string;
  /** book - bank after adjustments. Must be "0" for a balanced recon; recorded either way. */
  differenceCents: string;
  /** Attorney/staff principal who completed the reconciliation. */
  performedBy: string;
}

export interface PayrollPaymentPayload {
  paymentId: string;
  employeeId: string;
  /** Net pay, integer cents as decimal string. */
  amountCents: string;
  /** Pay period label, e.g. "2025-01" or "2025-W03". */
  payPeriod: string;
  method: 'ach' | 'check';
  initiatedBy: string;
  /** Idempotency-Key used for the money movement (guards double-pay retries). */
  idempotencyKey: string;
}

export interface InvoiceSentPayload {
  invoiceId: string;
  clientId: string;
  /** Invoice total, integer cents as decimal string. */
  amountCents: string;
  sentBy: string;
  /** Destination address the invoice was sent to. */
  sentTo: string;
}

export interface AuthLoginFailedPayload {
  /** Principal that attempted to authenticate (email/username). */
  principal: string;
  /** Machine-readable failure reason, e.g. "bad_password", "mfa_failed", "locked". */
  reason: string;
  /** Source IP, when known. */
  ip?: string;
}

// ---------------------------------------------------------------------------
// Extended vocabulary (audit wiring, PR #8). Conventions:
// - every money field is integer cents as a decimal string, NEVER a float
// - `actor` is the principal who performed the mutation (session user,
//   Firebase uid/email, or 'local' for single-user apps)
// - batch events (imports) carry row counts and exact cent totals, not rows
// ---------------------------------------------------------------------------

export interface AuthPasswordChangedPayload {
  principal: string;
}

/** Path-level coverage for every non-GET write (books). Bodies are never
 * logged — they can carry passwords and bank keys. */
export interface HttpWritePayload {
  method: string;
  path: string;
  status: number;
  actor: string;
}

export interface SettingsChangedPayload {
  /** Top-level setting keys that changed — values may be sensitive, keys are not. */
  keys: string[];
  actor: string;
}

export interface InvoiceCreatedPayload {
  invoiceId: string;
  clientId: string;
  /** Invoice total, integer cents as decimal string. */
  totalCents: string;
  /** How the invoice came to exist: manual | import | recurring | time. */
  source: 'manual' | 'import' | 'recurring' | 'time';
  actor: string;
}

export interface InvoiceUpdatedPayload {
  invoiceId: string;
  totalCents: string;
  changedFields: string[];
  actor: string;
}

export interface InvoiceDeletedPayload {
  invoiceId: string;
  /** Total at deletion time — the record of what was removed. */
  totalCents: string;
  actor: string;
}

export interface InvoicePaymentRecordedPayload {
  invoiceId: string;
  paymentCents: string;
  actor: string;
}

export interface SalesImportedPayload {
  rowCount: number;
  totalCents: string;
  source: string;
  actor: string;
}

export interface TimeEntryPayload {
  entryId: string;
  customerId: string;
  /** Hours as a decimal string (e.g. "1.5") — not money, but exact. */
  hours: string;
  /** Hourly rate, integer cents as decimal string. */
  rateCents: string;
  actor: string;
}

export interface ExpensePayload {
  expenseId: string;
  amountCents: string;
  category: string;
  actor: string;
}

export interface Vendor1099Payload {
  vendorId: string;
  amountCents: string;
  actor: string;
}

export interface BankTransactionsImportedPayload {
  count: number;
  /** Signed net of imported rows, integer cents as decimal string. */
  netCents: string;
  source: 'sync' | 'csv';
  actor: string;
}

export interface PayrollRunCreatedPayload {
  runId: string;
  payPeriod: string;
  actor: string;
}

export interface PayrollRunFinalizedPayload {
  runId: string;
  payPeriod: string;
  employeeCount: number;
  totalNetCents: string;
  actor: string;
}

export interface PayrollDepositRecordedPayload {
  depositId: string;
  amountCents: string;
  period: string;
  actor: string;
}

export interface SalesTaxRemittedPayload {
  remittanceId: string;
  amountCents: string;
  period: string;
  actor: string;
}

// --- billable (evidence-grade time ledger) ---

export interface EntryOverrideWrittenPayload {
  entryId: string;
  /** Override fields touched (reviewed, hours, writeOff, narrative, ...). */
  fields: string[];
  /** Hours before/after when the override changed them, as decimal strings. */
  hoursBefore?: string;
  hoursAfter?: string;
  writeOff?: boolean;
  actor: string;
}

export interface LawpayRequestCreatedPayload {
  reference: string;
  amountCents: string;
  actor: string;
}

export interface LawpayPaymentRecordedPayload {
  reference: string;
  amountCents: string;
  actor: string;
}

export interface ConfigChangedPayload {
  keys: string[];
  actor: string;
}

export interface ClioEntrySyncedPayload {
  entryId: string;
  clioId: string;
  actor: string;
}

/** Anchors a pre-chain legacy ledger: its content can no longer be altered
 * without breaking every comparison against this entry. */
export interface LedgerLegacyAnchoredPayload {
  eventCount: number;
  /** sha256 of the legacy ledger file content at anchor time. */
  sha256: string;
  actor: string;
}

// --- iolta (Firestore trust ledger; chain sealed via CAS head) ---

export interface TrustTransactionAddedPayload {
  transactionId: string;
  clientId: string;
  /** Signed: receipts positive, disbursements negative. Integer cents string. */
  amountCents: string;
  txType: 'receipt' | 'disbursement';
  month: string;
  source: 'manual' | 'import' | 'review';
  actor: string;
}

export interface TrustTransactionEditedPayload {
  transactionId: string;
  beforeAmountCents: string;
  afterAmountCents: string;
  changedFields: string[];
  actor: string;
}

export interface TrustTransactionDeletedPayload {
  transactionId: string;
  /** Amount snapshot at deletion — deletions are what tamper-evidence is for. */
  amountCents: string;
  month: string;
  actor: string;
}

export interface TrustTransactionClearedPayload {
  transactionId: string;
  clearDate: string;
  actor: string;
}

export interface TrustClientCreatedPayload {
  clientId: string;
  name: string;
  actor: string;
}

export interface TrustStatementBalanceSetPayload {
  month: string;
  balanceCents: string;
  actor: string;
}

export interface TrustImportConfirmedPayload {
  rowCount: number;
  receiptsCents: string;
  disbursementsCents: string;
  source: string;
  actor: string;
}

export interface AuditEventPayloads {
  'reconciliation.completed': ReconciliationCompletedPayload;
  'payroll.payment': PayrollPaymentPayload;
  'invoice.sent': InvoiceSentPayload;
  'auth.login_failed': AuthLoginFailedPayload;
  'auth.password_changed': AuthPasswordChangedPayload;
  'http.write': HttpWritePayload;
  'settings.changed': SettingsChangedPayload;
  'invoice.created': InvoiceCreatedPayload;
  'invoice.updated': InvoiceUpdatedPayload;
  'invoice.deleted': InvoiceDeletedPayload;
  'invoice.payment_recorded': InvoicePaymentRecordedPayload;
  'sales.imported': SalesImportedPayload;
  'time_entry.created': TimeEntryPayload;
  'time_entry.updated': TimeEntryPayload;
  'time_entry.deleted': TimeEntryPayload;
  'expense.created': ExpensePayload;
  'expense.updated': ExpensePayload;
  'expense.deleted': ExpensePayload;
  'vendor1099.recorded': Vendor1099Payload;
  'bank.transactions_imported': BankTransactionsImportedPayload;
  'payroll.run_created': PayrollRunCreatedPayload;
  'payroll.run_finalized': PayrollRunFinalizedPayload;
  'payroll.deposit_recorded': PayrollDepositRecordedPayload;
  'salestax.remitted': SalesTaxRemittedPayload;
  'entry.override_written': EntryOverrideWrittenPayload;
  'lawpay.request_created': LawpayRequestCreatedPayload;
  'lawpay.payment_recorded': LawpayPaymentRecordedPayload;
  'config.changed': ConfigChangedPayload;
  'clio.entry_synced': ClioEntrySyncedPayload;
  'ledger.legacy_anchored': LedgerLegacyAnchoredPayload;
  'trust.transaction_added': TrustTransactionAddedPayload;
  'trust.transaction_edited': TrustTransactionEditedPayload;
  'trust.transaction_deleted': TrustTransactionDeletedPayload;
  'trust.transaction_cleared': TrustTransactionClearedPayload;
  'trust.client_created': TrustClientCreatedPayload;
  'trust.statement_balance_set': TrustStatementBalanceSetPayload;
  'trust.import_confirmed': TrustImportConfirmedPayload;
}

export type AuditEventType = keyof AuditEventPayloads;

export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  'reconciliation.completed',
  'payroll.payment',
  'invoice.sent',
  'auth.login_failed',
  'auth.password_changed',
  'http.write',
  'settings.changed',
  'invoice.created',
  'invoice.updated',
  'invoice.deleted',
  'invoice.payment_recorded',
  'sales.imported',
  'time_entry.created',
  'time_entry.updated',
  'time_entry.deleted',
  'expense.created',
  'expense.updated',
  'expense.deleted',
  'vendor1099.recorded',
  'bank.transactions_imported',
  'payroll.run_created',
  'payroll.run_finalized',
  'payroll.deposit_recorded',
  'salestax.remitted',
  'entry.override_written',
  'lawpay.request_created',
  'lawpay.payment_recorded',
  'config.changed',
  'clio.entry_synced',
  'ledger.legacy_anchored',
  'trust.transaction_added',
  'trust.transaction_edited',
  'trust.transaction_deleted',
  'trust.transaction_cleared',
  'trust.client_created',
  'trust.statement_balance_set',
  'trust.import_confirmed',
];
