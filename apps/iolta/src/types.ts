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
  outstandingChecksTotal: number;
  depositsInTransitTotal: number;
  uid?: string; // Owner's Firebase Auth uid — enforced by firestore.rules
}

export interface RPCViolation {
  type: 'commingling' | 'negative_balance' | 'check_to_cash' | 'unidentified_funds';
  severity: 'high' | 'medium' | 'low';
  message: string;
  transactionId?: string;
  clientId?: string;
}
