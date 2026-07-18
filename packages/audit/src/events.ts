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

export interface AuditEventPayloads {
  'reconciliation.completed': ReconciliationCompletedPayload;
  'payroll.payment': PayrollPaymentPayload;
  'invoice.sent': InvoiceSentPayload;
  'auth.login_failed': AuthLoginFailedPayload;
}

export type AuditEventType = keyof AuditEventPayloads;

export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  'reconciliation.completed',
  'payroll.payment',
  'invoice.sent',
  'auth.login_failed',
];
