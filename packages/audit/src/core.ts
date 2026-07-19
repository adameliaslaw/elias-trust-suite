// Browser-safe surface of @elias/audit: everything EXCEPT FsJsonlStorage,
// which imports node:fs. Browser bundles (apps/iolta, Vite) must import from
// '@elias/audit/core' so no Node builtin ever reaches the client graph.
export { AuditLog, AuditIntegrityError, GENESIS_HASH, computeEntryHash } from './audit-log.js';
export type { AuditEntry, AuditEntryBody, AuditLogOptions, VerificationResult } from './audit-log.js';
export { AUDIT_EVENT_TYPES } from './events.js';
export type {
  AuditEventPayloads,
  AuditEventType,
  AuthLoginFailedPayload,
  AuthPasswordChangedPayload,
  BankTransactionsImportedPayload,
  ClioEntrySyncedPayload,
  ConfigChangedPayload,
  EntryOverrideWrittenPayload,
  ExpensePayload,
  HttpWritePayload,
  InvoiceCreatedPayload,
  InvoiceDeletedPayload,
  InvoicePaymentRecordedPayload,
  InvoiceSentPayload,
  InvoiceUpdatedPayload,
  LawpayPaymentRecordedPayload,
  LawpayRequestCreatedPayload,
  LedgerLegacyAnchoredPayload,
  PayrollDepositRecordedPayload,
  PayrollPaymentPayload,
  PayrollRunCreatedPayload,
  PayrollRunFinalizedPayload,
  ReconciliationCompletedPayload,
  SalesImportedPayload,
  SalesTaxRemittedPayload,
  SettingsChangedPayload,
  TimeEntryPayload,
  TrustClientCreatedPayload,
  TrustImportConfirmedPayload,
  TrustStatementBalanceSetPayload,
  TrustTransactionAddedPayload,
  TrustTransactionClearedPayload,
  TrustTransactionDeletedPayload,
  TrustTransactionEditedPayload,
  Vendor1099Payload,
} from './events.js';
export { InMemoryStorage } from './storage.js';
export type { AuditStorage } from './storage.js';
export { stableStringify } from './stable-stringify.js';
export { sha256Hex } from './sha256.js';
