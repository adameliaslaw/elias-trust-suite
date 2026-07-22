export interface Client {
  id: string;
  name: string;
  matterDescription?: string;
  balance: number;
  uid?: string; // Owner's Firebase Auth uid — enforced by firestore.rules
}

export interface Transaction {
  id: string;
  clientId?: string;
  clientName?: string;
  date: string; // YYYY-MM-DD (Issue Date for checks)
  clearDate?: string; // YYYY-MM-DD (Clear Date from bank statement)
  amount: number; // Positive for receipts, negative for disbursements
  type: 'receipt' | 'disbursement';
  checkNumber?: string;
  description: string;
  month: string; // YYYY-MM (Reconciliation Month)
  isOutstanding: boolean;
  rpcViolations?: string[];
  uid?: string; // Owner's Firebase Auth uid — enforced by firestore.rules
}

export interface Reconciliation {
  month: string; // YYYY-MM
  bankBalance: number;
  bookBalance: number;
  clientBalanceTotal: number;
  isReconciled: boolean;
  // 'incomplete' = no statement balance entered yet (issue #13); a month is
  // never "reconciled" without one. Optional for docs written before this field.
  status?: 'incomplete' | 'reconciled' | 'discrepancy';
  outstandingChecksTotal: number;
  depositsInTransitTotal: number;
  uid?: string; // Owner's Firebase Auth uid — enforced by firestore.rules
  // --- Reconciliation lifecycle (Phase 3, #14) ---
  // 'draft' = recomputed working snapshot; 'finalized' = attested + locked.
  lifecycleStatus?: 'draft' | 'finalized';
  // Working version; bumped by each reopen-for-amendment (starts at 1).
  version?: number;
  // Reason recorded when a finalized month was reopened (amendment provenance).
  amendmentReason?: string;
  // Content hash of the retained finalized packet (sha256).
  contentHash?: string;
  // ISO date (YYYY-MM-DD) through which the finalized packet must be retained.
  retentionUntil?: string;
  // Principal who finalized the month.
  finalizedBy?: string;
}

export interface RPCViolation {
  type: 'commingling' | 'negative_balance' | 'check_to_cash' | 'unidentified_funds';
  severity: 'high' | 'medium' | 'low';
  message: string;
  transactionId?: string;
  clientId?: string;
}
