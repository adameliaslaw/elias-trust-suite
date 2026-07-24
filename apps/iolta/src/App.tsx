/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  auth, db, handleFirestoreError, OperationType 
} from './firebase';
import { 
  signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User 
} from 'firebase/auth';
import { 
  collection, query, onSnapshot, addDoc, deleteDoc, doc, updateDoc, 
  where, Timestamp, setDoc, getDocs, serverTimestamp
} from 'firebase/firestore';
import { 
  Upload, FileText, CheckCircle, AlertTriangle, Users, 
  Plus, Trash2, ChevronRight, Search, LogOut, Loader2,
  Calendar, DollarSign, Clock, Filter, ArrowUpDown, X as LucideX, Check, Lock
} from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, isBefore, isAfter, isEqual, subDays, addDays } from 'date-fns';
import { Client, Transaction, Reconciliation, RPCViolation } from './types';
import { toCents, fromCents } from './money';
import { appendAuditEvent, flushAuditQueue, verifyAuditChain } from './audit';
import { computeReconciliations, legacyStreams } from './reconciliation';
import { defaultAccountId, periodDocId } from './model';
import {
  buildFinalizedPacket,
  reconciliationCompletedPayload,
  canonicalizeInputs,
  packetDocId,
  assertPeriodMutable,
  LockedPeriodError,
  reopenForAmendment,
  periodExceptions,
  renderPacketDocument,
  DEFAULT_ATTESTATION_STATEMENT,
  RECON_AUTHORITY,
  type FrozenInputs,
  type SourceDocument,
} from './lifecycle';
import { signPacket, assertPacketSignedOff, packetSignoffAuditEvent } from './signoff';
import {
  parseDelimited,
  transactionFingerprint,
  dedupeTransactions,
  newClientNames,
  signConsistencyError,
  signedForType,
} from './imports';
import { buildLedgerView } from './ledger';
import { parseBankContent } from './services/geminiService';
import Chatbot from './components/Chatbot';
import { motion, AnimatePresence } from 'motion/react';

// --- Components ---

const TabButton = ({ active, onClick, icon: Icon, label }: { active: boolean, onClick: () => void, icon: any, label: string }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
      active 
        ? 'border-indigo-600 text-indigo-600 bg-indigo-50/50' 
        : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
    }`}
  >
    <Icon size={18} />
    {label}
  </button>
);

const SortHeader = ({ label, field, currentSort, onSort }: { label: string, field: string, currentSort: { field: string, direction: 'asc' | 'desc' }, onSort: (field: string) => void }) => (
  <th 
    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-50 group"
    onClick={() => onSort(field)}
  >
    <div className="flex items-center gap-1">
      {label}
      <ArrowUpDown size={14} className={`transition-opacity ${currentSort.field === field ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'}`} />
    </div>
  </th>
);

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'receipts' | 'disbursements' | 'outstanding' | 'reconciliation' | 'ledgers'>('receipts');
  
  const [clients, setClients] = useState<Client[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  
  const [sortConfig, setSortConfig] = useState<{ field: string, direction: 'asc' | 'desc' }>({ field: 'date', direction: 'desc' });
  const [searchTerm, setSearchTerm] = useState("");
  const [ledgerSearchTerm, setLedgerSearchTerm] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState<'all' | 'positive' | 'negative' | 'zero'>('all');
  const [modalFilterType, setModalFilterType] = useState<'all' | 'receipt' | 'disbursement'>('all');
  const [modalDateRange, setModalDateRange] = useState({ start: '', end: '' });

  const [isClearModalOpen, setIsClearModalOpen] = useState(false);
  const [txToClear, setTxToClear] = useState<Transaction | null>(null);
  const [clearDate, setClearDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const [statementBalances, setStatementBalances] = useState<Record<string, number>>({});
  const [isStatementModalOpen, setIsStatementModalOpen] = useState(false);
  const [targetMonth, setTargetMonth] = useState("");
  const [newStatementBalance, setNewStatementBalance] = useState(0);

  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [isClientModalOpen, setIsClientModalOpen] = useState(false);

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<Transaction | null>(null);

  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [pendingTransactions, setPendingTransactions] = useState<Partial<Transaction>[]>([]);
  // Retained source statements (server keeps the file; we keep name+hash+bytes)
  // so a finalized packet can prove it reproduces from these exact documents.
  const [pendingSources, setPendingSources] = useState<SourceDocument[]>([]);
  const [sourceStatements, setSourceStatements] = useState<any[]>([]);

  // Reconciliation finalize / reopen (lifecycle #14).
  const [isFinalizeModalOpen, setIsFinalizeModalOpen] = useState(false);
  const [finalizeMonth, setFinalizeMonth] = useState<string>('');
  const [finalizeMode, setFinalizeMode] = useState<'finalize' | 'reopen'>('finalize');
  const [attestChecked, setAttestChecked] = useState(false);
  const [amendReason, setAmendReason] = useState('');
  const [finalizing, setFinalizing] = useState(false);

  // Tamper-evident audit chain status (verify-on-open). 'failed' renders a
  // blocking banner: a broken chain means the trust records cannot be relied
  // on until investigated.
  const [auditStatus, setAuditStatus] = useState<
    { state: 'idle' | 'checking' | 'ok'; entries?: number } |
    { state: 'failed'; error: string; atSeq: number | null }
  >({ state: 'idle' });

  const actorFor = (u: User) => u.email || u.uid;

  // --- Auth ---

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = () => auth.signOut();

  // --- Audit chain: verify-on-open + offline-queue flush ---
  // A compliance log that opens without complaint after tampering is worse
  // than no log: the whole chain is re-verified on every sign-in, and a
  // failure is a blocking banner, not a console note.
  useEffect(() => {
    if (!user) return;
    setAuditStatus({ state: 'checking' });
    verifyAuditChain(user.uid)
      .then(r => setAuditStatus(r.ok
        ? { state: 'ok', entries: r.entries }
        : { state: 'failed', error: (r as { error: string }).error, atSeq: (r as { atSeq: number | null }).atSeq }))
      .catch(e => {
        // Verification itself failing (offline, rules not deployed yet) is
        // not proof of tampering — log it, don't block the app.
        console.warn('audit chain verification unavailable:', e);
        setAuditStatus({ state: 'idle' });
      });
    flushAuditQueue(user.uid).catch(e => console.warn('audit queue flush failed:', e));
    const onOnline = () => flushAuditQueue(user.uid).catch(e => console.warn('audit queue flush failed:', e));
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [user]);

  // --- Data Fetching ---

  useEffect(() => {
    if (!user) return;

    // Owner-scoped queries: firestore.rules restrict every document to
    // resource.data.uid == request.auth.uid, and rules are not filters —
    // queries must explicitly filter on uid or they will be rejected.
    // (Sorting is done client-side so no composite indexes are required.)
    const qClients = query(collection(db, 'clients'), where('uid', '==', user.uid));
    const unsubClients = onSnapshot(qClients, (snapshot) => {
      setClients(snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Client))
        .sort((a, b) => a.name.localeCompare(b.name)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'clients'));

    const qTransactions = query(collection(db, 'transactions'), where('uid', '==', user.uid));
    const unsubTransactions = onSnapshot(qTransactions, (snapshot) => {
      setTransactions(snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as Transaction))
        .sort((a, b) => b.date.localeCompare(a.date)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'transactions'));

    const qReconciliations = query(collection(db, 'reconciliations'), where('uid', '==', user.uid));
    const unsubReconciliations = onSnapshot(qReconciliations, (snapshot) => {
      setReconciliations(snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as any))
        .sort((a, b) => b.month.localeCompare(a.month)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'reconciliations'));

    const qStatementBalances = query(collection(db, 'statementBalances'), where('uid', '==', user.uid));
    const unsubStatementBalances = onSnapshot(qStatementBalances, (snapshot) => {
      // Doc ids are now account-scoped ("{accountId}__{month}", issue #15), so
      // key the reconciliation map by the document's `month` field, not its id.
      const balances: Record<string, number> = {};
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        const monthKey = data.month ?? doc.id; // fall back to legacy bare-month ids
        balances[monthKey] = data.balance;
      });
      setStatementBalances(balances);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'statementBalances'));

    const qSourceStatements = query(collection(db, 'sourceStatements'), where('uid', '==', user.uid));
    const unsubSourceStatements = onSnapshot(qSourceStatements, (snapshot) => {
      setSourceStatements(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'sourceStatements'));

    return () => {
      unsubClients();
      unsubTransactions();
      unsubReconciliations();
      unsubStatementBalances();
      unsubSourceStatements();
    };
  }, [user]);

  // A month is LOCKED once its reconciliation is finalized (lifecycle #14).
  // Every transaction mutation checks this set before writing.
  const lockedMonths = useMemo(
    () => new Set(reconciliations.filter(r => r.lifecycleStatus === 'finalized').map(r => r.month)),
    [reconciliations]
  );

  // Guard a transaction mutation against locked periods; alerts and returns
  // false if the write would touch a finalized month (its date or a new date).
  const ensureUnlocked = (dates: { date?: string; toDate?: string }): boolean => {
    try {
      assertPeriodMutable(dates, lockedMonths);
      return true;
    } catch (e) {
      if (e instanceof LockedPeriodError) {
        alert(e.message);
        return false;
      }
      throw e;
    }
  };

  // --- Validation Logic ---
  const validateTransaction = (tx: any): string[] => {
    const errors: string[] = [];
    if (!tx.date || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) {
      errors.push(`Invalid date format for transaction: ${tx.description || 'Unknown'}`);
    }
    if (isNaN(tx.amount) || tx.amount === 0) {
      errors.push(`Invalid amount for transaction on ${tx.date || 'unknown date'}`);
    }
    if (!tx.type || !['receipt', 'disbursement'].includes(tx.type)) {
      errors.push(`Missing or invalid transaction type for ${tx.description}`);
    }
    return errors;
  };

  // --- File Upload & Processing ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    
    setIsUploading(true);
    setUploadProgress("Reading files...");
    
    const formData = new FormData();
    Array.from(e.target.files).forEach(file => formData.append('files', file));

    try {
      // The endpoint now requires a Firebase ID token (audit issue #3).
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/process-files', {
        method: 'POST',
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
        body: formData
      });
      
      if (!response.ok) throw new Error("Failed to process files");
      
      const data = await response.json();
      setUploadProgress(`Analyzing ${data.files.length} documents with AI...`);
      
      const allExtracted: Partial<Transaction>[] = [];
      const errors: string[] = [];
      for (const fileData of data.files) {
        const isImage = fileData.content.startsWith('IMAGE_DATA:');

        // Deterministic FIRST: a clean CSV/XLS (the server exports sheets to CSV)
        // is parsed exactly by the machine — no AI, no nondeterminism. The AI
        // extractor is only the fallback for content this parser can't structure
        // (images, prose PDFs, or an unrecognized layout).
        let extracted: Partial<Transaction>[] = [];
        if (!isImage) {
          const det = parseDelimited(fileData.content);
          if (det.recognized && det.rows.length > 0) {
            extracted = det.rows;
            errors.push(...det.errors);
          }
        }
        if (extracted.length === 0) {
          extracted = await parseBankContent(fileData.content, isImage);
        }

        for (const tx of extracted) {
          const txErrors = validateTransaction(tx);
          if (txErrors.length > 0) {
            errors.push(...txErrors);
          } else {
            allExtracted.push(tx);
          }
        }
      }

      // Capture the retained-source metadata (server keeps the bytes and
      // returns a content hash per file) so a later finalize can cite the
      // exact documents this import came from (#22).
      const sources: SourceDocument[] = (data.files as any[])
        .filter(f => typeof f.sha256 === 'string' && f.sha256.length > 0)
        .map(f => ({ name: f.name, sha256: f.sha256, bytes: typeof f.bytes === 'number' ? f.bytes : 0 }));

      setValidationErrors(errors);
      setPendingTransactions(allExtracted);
      setPendingSources(sources);
      setIsReviewModalOpen(true);
      setUploadProgress("Ready for review");
    } catch (error) {
      console.error("Upload error:", error);
      alert("Error processing files. Please try again.");
    } finally {
      setIsUploading(false);
      setTimeout(() => setUploadProgress(""), 2000);
    }
  };

  const handleConfirmReview = async () => {
    if (!user) return;
    try {
      const actor = actorFor(user);

      // 1. Enforce the sign/type invariant at the import layer (not just the
      //    manual modal): a row whose declared type contradicts its amount sign
      //    is rejected, never silently coerced into a fabricated transaction.
      const rejected: string[] = [];
      const validRows = pendingTransactions
        .filter(tx => {
          const type = (tx.type as 'receipt' | 'disbursement') ?? 'receipt';
          const err = signConsistencyError(type, tx.amount ?? 0);
          if (err) {
            rejected.push(`${tx.description || tx.date || 'row'}: ${err}`);
            return false;
          }
          return true;
        })
        // Normalize amount sign from type (idempotent for already-signed rows).
        .map(tx => ({ ...tx, amount: signedForType((tx.type as 'receipt' | 'disbursement') ?? 'receipt', tx.amount ?? 0) }));

      // 2. Idempotent import: skip rows already present (by fingerprint), so
      //    re-running the same import is a no-op. Dedupes within the batch too.
      const existingFingerprints = new Set(transactions.map(transactionFingerprint));
      const { fresh, duplicates } = dedupeTransactions(validRows, existingFingerprints);

      // 3. Create each NEW client once (case-insensitive), never N records for a
      //    client named on N rows. Build a name → id map for assignment.
      const namesToCreate = newClientNames(fresh, clients.map(c => c.name));
      const nameToId = new Map<string, string>(
        clients.map(c => [c.name.toLowerCase(), c.id] as const),
      );
      const createdClients: { clientId: string; name: string }[] = [];
      for (const name of namesToCreate) {
        const clientRef = await addDoc(collection(db, 'clients'), {
          name,
          balance: 0,
          uid: user.uid,
          createdAt: serverTimestamp()
        });
        nameToId.set(name.toLowerCase(), clientRef.id);
        createdClients.push({ clientId: clientRef.id, name });
      }

      // 4. Persist only the fresh, sign-valid rows — but NEVER into a locked
      //    (finalized) month. A row dated in a finalized period is refused, not
      //    silently added to an immutable record (#14).
      const lockedSkipped: string[] = [];
      const importedMonths = new Set<string>();
      for (const tx of fresh) {
        const rawName = tx.clientName?.trim();
        const hasClient = !!rawName && rawName.toLowerCase() !== 'unassigned';
        const clientId = hasClient ? (nameToId.get(rawName!.toLowerCase()) ?? 'unassigned') : 'unassigned';
        const clientName = hasClient ? rawName! : 'Unassigned';
        const month = tx.date ? format(parseISO(tx.date), 'yyyy-MM') : format(new Date(), 'yyyy-MM');

        if (lockedMonths.has(month)) {
          lockedSkipped.push(`${tx.date} ${tx.description ?? ''} — ${month} is finalized/locked.`);
          continue;
        }
        importedMonths.add(month);

        await addDoc(collection(db, 'transactions'), {
          ...tx,
          clientId,
          clientName,
          month,
          uid: user.uid,
          createdAt: serverTimestamp(),
          isOutstanding: tx.type === 'disbursement' && !tx.clearDate,
          rpcViolations: detectRPCViolations({ ...tx, clientId })
        });
      }

      // 4b. Retain the SOURCE statements behind this import (server kept the
      //     bytes; we record name + content hash + which months they cover) so
      //     a finalized packet reproduces from these exact documents (#22).
      const accountId = defaultAccountId(user.uid);
      const coveredMonths = Array.from(importedMonths).sort();
      for (const src of pendingSources) {
        try {
          await setDoc(doc(db, 'sourceStatements', `${accountId}__${src.sha256}`), {
            accountId,
            name: src.name,
            sha256: src.sha256,
            bytes: src.bytes,
            months: coveredMonths,
            uid: user.uid,
            importedAt: serverTimestamp(),
          });
        } catch (e) {
          console.warn('failed to record source statement', e);
        }
      }

      // One BATCH audit event, not one per row: a statement import is a single
      // act, and N sequential CAS appends would multiply contention. Exact
      // integer-cent totals via the money bridge — never floats.
      let receiptsCents = 0, disbursementsCents = 0;
      for (const tx of fresh) {
        const cents = toCents(tx.amount ?? 0);
        if (tx.type === 'disbursement') disbursementsCents += Math.abs(cents);
        else receiptsCents += cents;
      }
      for (const c of createdClients) {
        await appendAuditEvent(user.uid, 'trust.client_created', { clientId: c.clientId, name: c.name, actor });
      }
      await appendAuditEvent(user.uid, 'trust.import_confirmed', {
        rowCount: fresh.length,
        duplicatesSkipped: duplicates.length,
        rejected: rejected.length,
        receiptsCents: String(receiptsCents),
        disbursementsCents: String(disbursementsCents),
        source: 'review',
        actor
      });

      // Surface why rows didn't import (duplicates skipped, contradictions rejected).
      const notices: string[] = [];
      if (duplicates.length) notices.push(`${duplicates.length} duplicate row(s) skipped (already imported).`);
      if (lockedSkipped.length) notices.push(`${lockedSkipped.length} row(s) skipped — dated in a finalized/locked month:`, ...lockedSkipped);
      notices.push(...rejected);
      setValidationErrors(notices);

      setIsReviewModalOpen(false);
      setPendingTransactions([]);
      setPendingSources([]);
    } catch (error) {
      console.error("Failed to save reviewed transactions", error);
    }
  };

  const filteredClients = useMemo(() => {
    let result = clients;
    if (ledgerSearchTerm) {
      const lower = ledgerSearchTerm.toLowerCase();
      result = result.filter(c => c.name.toLowerCase().includes(lower) || c.matterDescription?.toLowerCase().includes(lower));
    }
    // Compare in exact cents: legacy float-noise balances (e.g. 1e-14)
    // must classify as zero, not positive/negative.
    if (ledgerFilter === 'positive') result = result.filter(c => toCents(c.balance) > 0);
    if (ledgerFilter === 'negative') result = result.filter(c => toCents(c.balance) < 0);
    if (ledgerFilter === 'zero') result = result.filter(c => toCents(c.balance) === 0);
    return result;
  }, [clients, ledgerSearchTerm, ledgerFilter]);

  const detectRPCViolations = (tx: any): string[] => {
    const violations = [];
    const desc = tx.description.toLowerCase();
    
    // Rule 1:21-6 & RPC 1.15
    if (desc.includes('rent') || desc.includes('payroll') || desc.includes('salary') || desc.includes('tax') || desc.includes('personal')) {
      violations.push("Potential Commingling: Firm or personal expense detected in IOLTA.");
    }
    if (desc.includes('cash') || (tx.checkNumber && desc === 'cash')) {
      violations.push("RPC Violation: Check made out to 'Cash' is prohibited.");
    }
    if (tx.amount < 0 && tx.clientId) {
      const client = clients.find(c => c.id === tx.clientId);
      // Integer-cents comparison to avoid float residue false negatives.
      if (client && toCents(client.balance) + toCents(tx.amount) < 0) {
        violations.push(`RPC Violation: Disbursement of $${Math.abs(tx.amount)} exceeds client's available balance of $${client.balance}.`);
      }
    }
    if (tx.type === 'receipt' && !tx.clientName) {
      violations.push("Record Keeping: Unidentified receipt. Must assign to a client.");
    }
    return violations;
  };

  // --- Sorting & Filtering ---

  const handleSort = (field: string) => {
    setSortConfig(prev => ({
      field,
      direction: prev.field === field && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const filteredTransactions = useMemo(() => {
    let result = transactions.filter(tx => {
      if (activeTab === 'receipts') return tx.type === 'receipt';
      if (activeTab === 'disbursements') return tx.type === 'disbursement';
      if (activeTab === 'outstanding') return tx.isOutstanding;
      return true;
    });

    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      result = result.filter(tx => 
        tx.clientName?.toLowerCase().includes(lower) || 
        tx.description.toLowerCase().includes(lower) ||
        tx.checkNumber?.includes(lower)
      );
    }

    return result.sort((a, b) => {
      const valA = (a as any)[sortConfig.field];
      const valB = (b as any)[sortConfig.field];
      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [transactions, activeTab, searchTerm, sortConfig]);

  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [newTx, setNewTx] = useState<Partial<Transaction>>({
    date: format(new Date(), 'yyyy-MM-dd'),
    amount: 0,
    type: 'receipt',
    description: '',
    month: format(new Date(), 'yyyy-MM')
  });

  // --- Client Balance Sync ---

  useEffect(() => {
    if (!user || transactions.length === 0 || clients.length === 0) return;

    const syncBalances = async () => {
      for (const client of clients) {
        const clientTxs = transactions.filter(tx => tx.clientId === client.id);
        // Integer-cents math: exact summation, exact comparison — no $0.01
        // tolerance that could mask a real penny discrepancy (audit #10).
        const newBalanceCents = clientTxs.reduce((sum, tx) => sum + toCents(tx.amount), 0);
        
        if (newBalanceCents !== toCents(client.balance)) {
          try {
            await updateDoc(doc(db, 'clients', client.id), { balance: fromCents(newBalanceCents) });
          } catch (error) {
            console.error("Failed to sync client balance", error);
          }
        }
      }
    };

    const timeoutId = setTimeout(syncBalances, 2000); // Debounce sync
    return () => clearTimeout(timeoutId);
  }, [transactions, clients, user]);

  // --- Reconciliation Logic ---

  // Three-way reconciliation, computed in exact integer cents (audit #7/#10/#13).
  // Logic lives in src/reconciliation.ts so it is unit-tested without a render.
  const reconciliationSummary = useMemo(
    () => computeReconciliations(transactions, clients, statementBalances),
    [transactions, clients, statementBalances]
  );

  // --- Persist DRAFT Reconciliation Snapshots (lifecycle #14) ---
  // Writes the computed three-way reconciliation for each month to
  // /reconciliations/{accountId__month} as a DRAFT so the current state is
  // visible and queryable. Two deliberate changes from Phase 2:
  //   1. A FINALIZED (locked) month is never touched — its record is immutable
  //      and must not be silently recomputed or overwritten.
  //   2. This effect NO LONGER emits `reconciliation.completed`. That compliance
  //      event is sealed ONLY by an explicit attorney attest + finalize
  //      (handleFinalizeMonth), never auto-emitted on a debounce (EVALUATION M2,
  //      pairs with #13). A month that merely computes as reconciled seals nothing.
  // Writes stay idempotent (only on change) to prevent render/write loops.
  useEffect(() => {
    if (!user || reconciliationSummary.length === 0) return;

    const accountId = defaultAccountId(user.uid);
    const persistReconciliations = async () => {
      for (const recon of reconciliationSummary) {
        const existing = reconciliations.find(r => r.month === recon.month);
        // Never overwrite a finalized/locked month's immutable record.
        if (existing?.lifecycleStatus === 'finalized') continue;
        const unchanged = existing !== undefined &&
          existing.lifecycleStatus === 'draft' &&
          toCents(existing.bankBalance) === toCents(recon.statementBalance) &&
          toCents(existing.bookBalance) === toCents(recon.bookBalance) &&
          toCents(existing.clientBalanceTotal) === toCents(recon.clientBalanceTotal) &&
          toCents(existing.outstandingChecksTotal ?? 0) === toCents(recon.outstandingChecksTotal) &&
          toCents(existing.depositsInTransitTotal ?? 0) === toCents(recon.depositsInTransitTotal) &&
          (existing.status ?? (existing.isReconciled ? 'reconciled' : 'discrepancy')) === recon.status &&
          existing.isReconciled === recon.isReconciled;
        if (unchanged) continue;

        try {
          await setDoc(doc(db, 'reconciliations', periodDocId(accountId, recon.month)), {
            month: recon.month,
            accountId,
            bankBalance: recon.statementBalance,
            bookBalance: recon.bookBalance,
            clientBalanceTotal: recon.clientBalanceTotal,
            outstandingChecksTotal: recon.outstandingChecksTotal,
            depositsInTransitTotal: recon.depositsInTransitTotal,
            isReconciled: recon.isReconciled,
            status: recon.status,
            // Lifecycle: a recomputed snapshot is a DRAFT. `version` carries the
            // current working version forward (bumped by a reopen-for-amendment).
            lifecycleStatus: 'draft',
            version: existing?.version ?? 1,
            uid: user.uid,
            updatedAt: serverTimestamp()
          });
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, 'reconciliations');
        }
      }
    };

    const timeoutId = setTimeout(persistReconciliations, 1500); // Debounce writes
    return () => clearTimeout(timeoutId);
  }, [reconciliationSummary, reconciliations, user]);

  // --- Attest + Finalize a reconciled month (lifecycle #14) ---
  // The DELIBERATE act that seals a month: freezes the bank/book/statement/match
  // inputs and the computed legs into an immutable, retained, reproducible packet
  // (@elias/audit hashing), records the attorney attestation, emits the (now
  // self-consistent) reconciliation.completed event, and LOCKS the month.
  const handleFinalizeMonth = async () => {
    if (!user || !finalizeMonth) return;
    const summary = reconciliationSummary.find(r => r.month === finalizeMonth);
    if (!summary) return;

    const exceptions = periodExceptions(summary);
    if (exceptions.length > 0) {
      alert('Resolve these exceptions before finalizing:\n\n' + exceptions.map(e => `• ${e.message}`).join('\n'));
      return;
    }

    setFinalizing(true);
    try {
      const accountId = defaultAccountId(user.uid);
      const actor = actorFor(user);
      const existing = reconciliations.find(r => r.month === finalizeMonth);
      const version = existing?.version ?? 1;
      const amendmentReason = version > 1 ? (existing?.amendmentReason ?? amendReason.trim()) : undefined;
      if (version > 1 && !amendmentReason) {
        alert('This is an amendment (version > 1). A reason is required.');
        setFinalizing(false);
        return;
      }

      // Freeze the exact inputs that produced this month's legs (through month
      // end), via the same legacy adapter the summary was computed from — no drift.
      const monthEnd = format(endOfMonth(parseISO(`${finalizeMonth}-01`)), 'yyyy-MM-dd');
      const monthTxns = transactions.filter(t => t.date <= monthEnd);
      const streams = legacyStreams(monthTxns, clients, { [finalizeMonth]: statementBalances[finalizeMonth] });
      const inputs: FrozenInputs = canonicalizeInputs({
        bankTransactions: streams.bankTransactions,
        bookTransactions: streams.bookTransactions,
        statementPeriods: streams.statementPeriods,
        matches: streams.matches,
        clients: clients.map(c => ({ id: c.id, name: c.name, balance: c.balance })),
      });

      // Retained source statements covering this month (server keeps the bytes).
      const sources: SourceDocument[] = sourceStatements
        .filter(s => Array.isArray(s.months) && s.months.includes(finalizeMonth))
        .map(s => ({ name: s.name, sha256: s.sha256, bytes: s.bytes }));

      const finalizedAt = new Date().toISOString();
      const attestation = {
        attestedBy: actor,
        attestedAt: finalizedAt,
        statement: DEFAULT_ATTESTATION_STATEMENT,
      };
      const packet = buildFinalizedPacket({
        accountId,
        month: finalizeMonth,
        version,
        attestation,
        finalizedAt,
        finalizedBy: actor,
        reconciliation: summary,
        inputs,
        sources,
        amendmentReason,
      });

      // The uniform attorney sign-off (Phase 7 / #26): the same content-addressed
      // reviewSignoff billable puts on a client invoice, here on the trust
      // reconciliation packet. It binds to the packet's sealed contentHash, so an
      // amendment (new version → new hash) needs a fresh sign-off. Gate the
      // retained deliverable on it — a packet can't be issued unless a matching,
      // approved sign-off covers it (fail-closed; the attesting attorney is the
      // signer).
      const packetSignoff = signPacket(packet, { attorney: actor, signedAt: finalizedAt });
      assertPacketSignedOff(packet, packetSignoff);

      // 1. Retain the immutable packet + its sign-off (create-only; never overwritten).
      await setDoc(doc(db, 'reconciliationPackets', packetDocId(accountId, finalizeMonth, version)), {
        ...packet,
        uid: user.uid,
        signoff: packetSignoff,
        // A deterministic rendered artifact, retained alongside the structured
        // packet so the exact audit document reproduces byte-for-byte.
        document: renderPacketDocument(packet),
        createdAt: serverTimestamp(),
      });

      // 2. Flip the period to finalized/locked on its reconciliation record.
      await setDoc(doc(db, 'reconciliations', periodDocId(accountId, finalizeMonth)), {
        month: finalizeMonth,
        accountId,
        bankBalance: summary.statementBalance,
        bookBalance: summary.bookBalance,
        clientBalanceTotal: summary.clientBalanceTotal,
        outstandingChecksTotal: summary.outstandingChecksTotal,
        depositsInTransitTotal: summary.depositsInTransitTotal,
        isReconciled: summary.isReconciled,
        status: summary.status,
        lifecycleStatus: 'finalized',
        version,
        contentHash: packet.contentHash,
        retentionUntil: packet.retentionUntil,
        lockedAt: serverTimestamp(),
        finalizedBy: actor,
        uid: user.uid,
        updatedAt: serverTimestamp(),
      });

      // 3. Seal the (self-consistent) compliance event — ONLY here, on the
      //    deliberate attested finalize. bankBalanceCents is the ADJUSTED bank
      //    balance and book − bank === difference (fixes EVALUATION M2).
      const monthDate = parseISO(`${finalizeMonth}-01`);
      await appendAuditEvent(user.uid, 'reconciliation.completed', reconciliationCompletedPayload(packet, {
        reconciliationId: `${accountId}:${finalizeMonth}:v${version}`,
        periodStart: format(startOfMonth(monthDate), 'yyyy-MM-dd'),
        periodEnd: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
      }));

      // 4. Chain the uniform compliance.signoff event — the same event billable
      //    appends when an attorney signs off on a client invoice, so the trail
      //    names who signed exactly this packet content.
      await appendAuditEvent(user.uid, 'compliance.signoff', packetSignoffAuditEvent(packetSignoff).payload);

      setIsFinalizeModalOpen(false);
      setAttestChecked(false);
      setAmendReason('');
    } catch (error) {
      console.error('Finalize failed', error);
      alert(`Finalize failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFinalizing(false);
    }
  };

  // --- Reopen a finalized month for amendment (lifecycle #14) ---
  // The only way out of a lock, and never silent: requires a reason, bumps the
  // version, and returns the month to draft. The prior packet stays retained.
  const handleReopenMonth = async () => {
    if (!user || !finalizeMonth) return;
    const existing = reconciliations.find(r => r.month === finalizeMonth);
    if (!existing || existing.lifecycleStatus !== 'finalized') return;
    if (!amendReason.trim()) {
      alert('Reopening a finalized reconciliation requires a documented reason.');
      return;
    }
    setFinalizing(true);
    try {
      const accountId = defaultAccountId(user.uid);
      const next = reopenForAmendment({ status: 'finalized', version: existing.version ?? 1 }, amendReason);
      await updateDoc(doc(db, 'reconciliations', periodDocId(accountId, finalizeMonth)), {
        lifecycleStatus: 'draft',
        version: next.version,
        amendmentReason: next.reason,
        reopenedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await appendAuditEvent(user.uid, 'reconciliation.reopened', {
        accountId,
        month: finalizeMonth,
        newVersion: next.version,
        reason: next.reason,
        actor: actorFor(user),
      });
      setIsFinalizeModalOpen(false);
      setAmendReason('');
    } catch (error) {
      console.error('Reopen failed', error);
      alert(`Reopen failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFinalizing(false);
    }
  };

  const handleStatementBalanceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetMonth || !user) return;

    try {
      // Account-scoped doc id (issue #15): "{accountId}__{month}", never a bare
      // month that the first writer would own for every user.
      const accountId = defaultAccountId(user.uid);
      await setDoc(doc(db, 'statementBalances', periodDocId(accountId, targetMonth)), {
        balance: newStatementBalance,
        accountId,
        month: targetMonth,
        uid: user.uid,
        updatedAt: serverTimestamp()
      });
      await appendAuditEvent(user.uid, 'trust.statement_balance_set', {
        month: targetMonth,
        balanceCents: String(toCents(newStatementBalance)),
        actor: actorFor(user)
      });
      setIsStatementModalOpen(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'statementBalances');
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTx || !user) return;

    // Reject an edit that touches a locked month — either the row's current
    // month or a new date that would move it into/within a finalized period (#14).
    const beforeForLock = transactions.find(t => t.id === editingTx.id);
    if (!ensureUnlocked({ date: beforeForLock?.date, toDate: editingTx.date })) return;

    try {
      const month = format(parseISO(editingTx.date), 'yyyy-MM');
      // Snapshot BEFORE the write: the audit record carries what changed
      // from what, in exact cents.
      const before = transactions.find(t => t.id === editingTx.id);
      await updateDoc(doc(db, 'transactions', editingTx.id), {
        ...editingTx,
        month,
        isOutstanding: editingTx.type === 'disbursement' && !editingTx.clearDate,
        rpcViolations: detectRPCViolations(editingTx),
        updatedAt: serverTimestamp()
      });
      if (user) {
        const changedFields = (['date', 'amount', 'type', 'description', 'checkNumber', 'clientId', 'clearDate'] as const)
          .filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(editingTx[k]));
        await appendAuditEvent(user.uid, 'trust.transaction_edited', {
          transactionId: editingTx.id,
          beforeAmountCents: String(toCents(before?.amount ?? 0)),
          afterAmountCents: String(toCents(editingTx.amount ?? 0)),
          changedFields,
          actor: actorFor(user)
        });
      }
      setIsEditModalOpen(false);
      setEditingTx(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'transactions');
    }
  };

  const handleDeleteTransaction = async (id: string) => {
    const target = transactions.find(t => t.id === id);
    // A row dated within a finalized month cannot be deleted (#14).
    if (!ensureUnlocked({ date: target?.date })) return;
    if (!confirm("Are you sure you want to delete this transaction?")) return;
    try {
      // Deleting a ledger row is exactly what tamper-evidence exists for:
      // the chain keeps the amount snapshot of what was removed.
      const before = transactions.find(t => t.id === id);
      await deleteDoc(doc(db, 'transactions', id));
      if (user) {
        await appendAuditEvent(user.uid, 'trust.transaction_deleted', {
          transactionId: id,
          amountCents: String(toCents(before?.amount ?? 0)),
          month: before?.month ?? '',
          actor: actorFor(user)
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'transactions');
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTx.date || !newTx.amount || !newTx.type || !user) return;
    // No new entries into a finalized/locked month (#14).
    if (!ensureUnlocked({ date: newTx.date })) return;

    try {
      const month = format(parseISO(newTx.date), 'yyyy-MM');
      // Convention: receipts are positive, disbursements negative (types.ts).
      // The form collects a magnitude; the sign is derived from the type so
      // reconciliation math (outstanding checks, book balance) stays correct.
      const signedAmount = newTx.type === 'disbursement'
        ? -Math.abs(newTx.amount)
        : Math.abs(newTx.amount);
      const normalizedTx = { ...newTx, amount: signedAmount };
      const txRef = await addDoc(collection(db, 'transactions'), {
        ...normalizedTx,
        month,
        uid: user.uid,
        createdAt: serverTimestamp(),
        isOutstanding: newTx.type === 'disbursement' && !newTx.clearDate,
        rpcViolations: detectRPCViolations(normalizedTx)
      });
      await appendAuditEvent(user.uid, 'trust.transaction_added', {
        transactionId: txRef.id,
        clientId: newTx.clientId || 'unassigned',
        amountCents: String(toCents(signedAmount)),
        txType: newTx.type,
        month,
        source: 'manual',
        actor: actorFor(user)
      });
      setIsManualModalOpen(false);
      setNewTx({
        date: format(new Date(), 'yyyy-MM-dd'),
        amount: 0,
        type: 'receipt',
        description: '',
        month: format(new Date(), 'yyyy-MM')
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'transactions');
    }
  };

  const handleClearTransaction = async () => {
    if (!txToClear || !clearDate) return;
    // Marking a row cleared mutates a transaction dated within its month; if
    // that month is finalized/locked, refuse (#14).
    if (!ensureUnlocked({ date: txToClear.date })) return;
    try {
      await updateDoc(doc(db, 'transactions', txToClear.id), {
        clearDate,
        isOutstanding: false
      });
      if (user) {
        await appendAuditEvent(user.uid, 'trust.transaction_cleared', {
          transactionId: txToClear.id,
          clearDate,
          actor: actorFor(user)
        });
      }
      setIsClearModalOpen(false);
      setTxToClear(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'transactions');
    }
  };

  // --- Render Helpers ---

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-gray-50">
        <Loader2 className="animate-spin text-indigo-600" size={48} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white p-8 rounded-2xl shadow-xl text-center">
          <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <FileText size={32} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">NJ IOLTA Accounting</h1>
          <p className="text-gray-500 mb-8">Secure three-way reconciliation for New Jersey legal professionals.</p>
          <button
            onClick={handleLogin}
            className="w-full bg-indigo-600 text-white py-3 px-4 rounded-xl font-semibold hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
          >
            <img src="https://www.google.com/favicon.ico" className="w-4 h-4" alt="Google" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Blocking banner: the tamper-evident chain does not verify. A broken
          chain means someone or something altered the audit history — the
          trust records cannot be relied on until this is investigated. */}
      {auditStatus.state === 'failed' && (
        <div className="bg-red-700 text-white px-6 py-3 text-sm font-medium flex items-center gap-3" role="alert">
          <AlertTriangle size={18} className="shrink-0" />
          <span>
            <strong>AUDIT CHAIN INTEGRITY FAILURE</strong> — {auditStatus.error}
            {auditStatus.atSeq !== null && ` (entry seq ${auditStatus.atSeq})`}.
            The tamper-evident log for this trust account does not verify. Stop entering
            transactions and investigate before relying on these records (NJ Rule 1:21-6).
          </span>
        </div>
      )}
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white">
            <CheckCircle size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900 leading-tight">IOLTA Reconciliation</h1>
            <p className="text-xs text-gray-500">NJ Rule 1:21-6 reconciliation aid — not a compliance guarantee</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative">
            <input
              type="file"
              multiple
              onChange={handleFileUpload}
              className="hidden"
              id="file-upload"
              accept=".pdf,.csv,.xlsx,.xls,image/*"
            />
            <label
              htmlFor="file-upload"
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-all ${
                isUploading ? 'bg-gray-100 text-gray-400' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
              }`}
            >
              {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
              {isUploading ? 'Processing...' : 'Bulk Upload'}
            </label>
          </div>

          <div className="h-8 w-px bg-gray-200" />

          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium text-gray-900">{user.displayName}</p>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
            <button onClick={handleLogout} className="p-2 text-gray-400 hover:text-red-600 transition-colors">
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {validationErrors.length > 0 && (
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="mb-6 bg-red-50 border border-red-100 p-4 rounded-xl space-y-2"
          >
            <div className="flex items-center gap-2 text-red-700 font-bold text-sm">
              <AlertTriangle size={18} />
              <span>Data Validation Errors Found</span>
            </div>
            <ul className="text-xs text-red-600 list-disc list-inside space-y-1">
              {validationErrors.map((err, i) => <li key={i}>{err}</li>)}
            </ul>
            <p className="text-[10px] text-red-500 italic mt-2">Please correct these in your source files and re-upload.</p>
          </motion.div>
        )}

        {isUploading && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 bg-indigo-50 border border-indigo-100 p-4 rounded-xl flex items-center gap-3"
          >
            <Loader2 className="animate-spin text-indigo-600" size={20} />
            <span className="text-sm font-medium text-indigo-700">{uploadProgress}</span>
          </motion.div>
        )}

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden mb-6">
          <div className="flex border-b border-gray-100 overflow-x-auto">
            <TabButton active={activeTab === 'receipts'} onClick={() => setActiveTab('receipts')} icon={DollarSign} label="Receipts" />
            <TabButton active={activeTab === 'disbursements'} onClick={() => setActiveTab('disbursements')} icon={FileText} label="Disbursements" />
            <TabButton active={activeTab === 'outstanding'} onClick={() => setActiveTab('outstanding')} icon={Clock} label="Outstanding Checks" />
            <TabButton active={activeTab === 'reconciliation'} onClick={() => setActiveTab('reconciliation')} icon={CheckCircle} label="Three-Way Recon" />
            <TabButton active={activeTab === 'ledgers'} onClick={() => setActiveTab('ledgers')} icon={Users} label="Client Ledgers" />
          </div>

          <div className="p-4 border-b border-gray-50 flex items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input
                type="text"
                placeholder="Search by client, description, or check #..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>
            <button 
              onClick={() => setIsManualModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              <Plus size={18} />
              Manual Entry
            </button>
          </div>

          {activeTab === 'reconciliation' ? (
            <div className="p-6 space-y-6">
              {reconciliationSummary.map((recon) => (
                <div key={recon.month} className="bg-gray-50 rounded-2xl p-6 border border-gray-200">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xl font-bold text-gray-900">{format(parseISO(`${recon.month}-01`), 'MMMM yyyy')}</h3>
                    <div className="flex items-center gap-3">
                      {!lockedMonths.has(recon.month) && (
                        <button
                          onClick={() => {
                            setTargetMonth(recon.month);
                            setNewStatementBalance(recon.statementBalance);
                            setIsStatementModalOpen(true);
                          }}
                          className="text-xs font-bold text-indigo-600 hover:underline"
                        >
                          Set Statement Balance
                        </button>
                      )}
                      <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                        recon.status === 'reconciled' ? 'bg-green-100 text-green-700'
                          : recon.status === 'incomplete' ? 'bg-amber-100 text-amber-700'
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {recon.status === 'reconciled' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
                        {recon.status === 'reconciled' ? 'Reconciled'
                          : recon.status === 'incomplete' ? 'Incomplete'
                          : 'Out of Balance'}
                      </div>
                      {/* Lifecycle #14: finalize/lock control, or locked badge + reopen. */}
                      {(() => {
                        const periodDoc = reconciliations.find(r => r.month === recon.month);
                        const finalized = periodDoc?.lifecycleStatus === 'finalized';
                        const attestable = periodExceptions(recon).length === 0;
                        if (finalized) {
                          return (
                            <div className="flex items-center gap-2">
                              <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold uppercase bg-gray-800 text-white" title={`Retained through ${periodDoc?.retentionUntil ?? ''} (NJ Rule 1:21-6)`}>
                                <Lock size={12} /> Finalized v{periodDoc?.version ?? 1}
                              </span>
                              <button
                                onClick={() => { setFinalizeMonth(recon.month); setFinalizeMode('reopen'); setAmendReason(''); setIsFinalizeModalOpen(true); }}
                                className="text-xs font-bold text-amber-600 hover:underline"
                              >
                                Reopen to Amend
                              </button>
                            </div>
                          );
                        }
                        return (
                          <button
                            disabled={!attestable}
                            onClick={() => { setFinalizeMonth(recon.month); setFinalizeMode('finalize'); setAttestChecked(false); setAmendReason(''); setIsFinalizeModalOpen(true); }}
                            title={attestable ? 'Attest and finalize this month' : 'Resolve exceptions before finalizing'}
                            className={`flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-lg ${attestable ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                          >
                            <Lock size={12} /> Attest &amp; Finalize
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Bank Statement Balance</p>
                      {recon.hasStatementBalance ? (
                        <p className="text-xl font-bold text-gray-900">${recon.statementBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                      ) : (
                        <p className="text-xl font-bold text-amber-600">Not entered</p>
                      )}
                    </div>
                    <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Adjusted Bank Balance</p>
                      <p className="text-xl font-bold text-gray-900">${recon.adjustedBankBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                      <p className="text-[10px] text-gray-400 mt-1">
                        Less {recon.outstandingChecksCount} outstanding checks: ${Math.abs(recon.outstandingChecksTotal).toFixed(2)}
                        {' · '}
                        Plus {recon.depositsInTransitCount} deposits in transit: ${recon.depositsInTransitTotal.toFixed(2)}
                      </p>
                    </div>
                    <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Book Balance</p>
                      <p className="text-xl font-bold text-gray-900">${recon.bookBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                      <p className="text-[10px] text-gray-400 mt-1">Sum of all transactions through month end</p>
                    </div>
                    <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Client Ledger Total</p>
                      <p className="text-xl font-bold text-gray-900">${recon.clientBalanceTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                    </div>
                  </div>

                  {/* Schedule of Client Balances */}
                  <div className="mt-6">
                    <h4 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
                      <Users size={16} />
                      Schedule of Client Balances
                    </h4>
                    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                          <tr>
                            <th className="px-4 py-2 text-left">Client Name</th>
                            <th className="px-4 py-2 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {recon.clientBalances.map((cb, i) => (
                            <tr key={i}>
                              <td className="px-4 py-2 text-gray-700">{cb.name}</td>
                              <td className={`px-4 py-2 text-right font-medium ${cb.balance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                                ${cb.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-gray-50 font-bold">
                            <td className="px-4 py-2">Total Client Balances</td>
                            <td className="px-4 py-2 text-right">${recon.clientBalanceTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {recon.status === 'incomplete' && (
                    <div className="mt-4 p-3 bg-amber-50 border border-amber-100 rounded-lg text-sm text-amber-800 flex items-center gap-2">
                      <AlertTriangle size={16} />
                      <span>
                        No bank statement balance entered for this month — reconciliation is incomplete.
                        Set the statement balance to reconcile.
                      </span>
                    </div>
                  )}

                  {recon.status === 'discrepancy' && (
                    <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700 space-y-1">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={16} />
                        <span>Discrepancy detected — the three reconciliation legs do not match:</span>
                      </div>
                      <ul className="list-disc list-inside text-xs space-y-0.5 pl-1">
                        <li>
                          Adjusted bank vs book balance: ${fromCents(toCents(recon.adjustedBankBalance) - toCents(recon.bookBalance)).toFixed(2)}
                          {' '}(timing/recording differences)
                        </li>
                        <li>
                          Book balance vs client ledgers: ${fromCents(toCents(recon.bookBalance) - toCents(recon.clientBalanceTotal)).toFixed(2)}
                          {' '}(usually unassigned transactions)
                        </li>
                        <li>
                          Adjusted bank vs client ledgers: ${fromCents(toCents(recon.adjustedBankBalance) - toCents(recon.clientBalanceTotal)).toFixed(2)}
                        </li>
                      </ul>
                    </div>
                  )}
                </div>
              ))}
              {reconciliationSummary.length === 0 && (
                <div className="text-center py-12 text-gray-400 italic">
                  No reconciliation data available. Upload bank statements to begin.
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <SortHeader label="Date" field="date" currentSort={sortConfig} onSort={handleSort} />
                    <SortHeader label="Client" field="clientName" currentSort={sortConfig} onSort={handleSort} />
                    <SortHeader label="Description" field="description" currentSort={sortConfig} onSort={handleSort} />
                    <SortHeader label="Check #" field="checkNumber" currentSort={sortConfig} onSort={handleSort} />
                    <SortHeader label="Amount" field="amount" currentSort={sortConfig} onSort={handleSort} />
                    <SortHeader label="Clear Date" field="clearDate" currentSort={sortConfig} onSort={handleSort} />
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-gray-50 transition-colors group">
                      <td className="px-4 py-4 text-sm text-gray-600 whitespace-nowrap">{tx.date}</td>
                      <td className="px-4 py-4 text-sm font-medium text-gray-900">{tx.clientName || 'Unassigned'}</td>
                      <td className="px-4 py-4 text-sm text-gray-600">
                        <div className="flex flex-col">
                          <span>{tx.description}</span>
                          {tx.rpcViolations?.map((v, i) => (
                            <span key={i} className="text-[10px] text-red-500 font-bold flex items-center gap-1 mt-1">
                              <AlertTriangle size={10} /> {v}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-600">{tx.checkNumber || '-'}</td>
                      <td className={`px-4 py-4 text-sm font-bold ${tx.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {tx.amount < 0 ? '-' : '+'}${Math.abs(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-4 text-sm text-gray-500 italic">
                      {tx.clearDate ? (
                        <span className="text-gray-600">{tx.clearDate}</span>
                      ) : (
                        <button 
                          onClick={() => { setTxToClear(tx); setIsClearModalOpen(true); }}
                          className="text-indigo-600 hover:underline font-medium"
                        >
                          Mark Cleared
                        </button>
                      )}
                    </td>
                      <td className="px-4 py-4 text-right">
                        <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all">
                          <button 
                            onClick={() => { setEditingTx(tx); setIsEditModalOpen(true); }}
                            className="p-2 text-gray-400 hover:text-indigo-600 transition-colors"
                          >
                            <FileText size={16} />
                          </button>
                          <button 
                            onClick={() => handleDeleteTransaction(tx.id)}
                            className="p-2 text-gray-400 hover:text-red-600 transition-colors"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredTransactions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-gray-400 italic">
                        No transactions found for this view.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Client Ledgers View (Conditional) */}
        {activeTab === 'ledgers' && (
          <div className="space-y-6">
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                  type="text"
                  placeholder="Search clients by name or matter..."
                  value={ledgerSearchTerm}
                  onChange={(e) => setLedgerSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <Filter size={16} className="text-gray-400" />
                <select 
                  value={ledgerFilter}
                  onChange={(e) => setLedgerFilter(e.target.value as any)}
                  className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  <option value="all">All Balances</option>
                  <option value="positive">Positive Only</option>
                  <option value="negative">Negative (Violations)</option>
                  <option value="zero">Zero Balance</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredClients.map(client => (
                <motion.div
                  key={client.id}
                  whileHover={{ y: -4 }}
                  onClick={() => { setSelectedClient(client); setIsClientModalOpen(true); }}
                  className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 cursor-pointer hover:shadow-md transition-all"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold ${
                      client.balance < 0 ? 'bg-red-100 text-red-600' : 'bg-indigo-100 text-indigo-600'
                    }`}>
                      {client.name.charAt(0)}
                    </div>
                    <ChevronRight size={20} className="text-gray-300" />
                  </div>
                  <h3 className="text-lg font-bold text-gray-900 mb-1">{client.name}</h3>
                  <p className="text-xs text-gray-500 mb-4 line-clamp-1">{client.matterDescription || 'No matter description'}</p>
                  <div className="flex items-center justify-between pt-4 border-t border-gray-50">
                    <span className="text-xs text-gray-400 font-medium uppercase">Current Balance</span>
                    <span className={`text-sm font-bold ${client.balance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                      ${client.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </motion.div>
              ))}
              {filteredClients.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-400 italic">
                  No clients found matching your search.
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <Chatbot />

      {/* Client Ledger Modal */}
      <AnimatePresence>
        {isClientModalOpen && selectedClient && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsClientModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-4xl max-h-[80vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">{selectedClient.name}</h2>
                  <p className="text-sm text-gray-500">Individual Client Ledger</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Filter size={14} className="text-gray-400" />
                    <select 
                      value={modalFilterType}
                      onChange={(e) => setModalFilterType(e.target.value as any)}
                      className="bg-white border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none"
                    >
                      <option value="all">All Types</option>
                      <option value="receipt">Receipts</option>
                      <option value="disbursement">Disbursements</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-gray-400" />
                    <input 
                      type="date" 
                      value={modalDateRange.start}
                      onChange={(e) => setModalDateRange(prev => ({ ...prev, start: e.target.value }))}
                      className="bg-white border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none"
                    />
                    <span className="text-gray-400">-</span>
                    <input 
                      type="date" 
                      value={modalDateRange.end}
                      onChange={(e) => setModalDateRange(prev => ({ ...prev, end: e.target.value }))}
                      className="bg-white border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none"
                    />
                  </div>
                  <button onClick={() => setIsClientModalOpen(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                    <LucideX size={24} />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
                <table className="w-full">
                  <thead className="text-xs font-semibold text-gray-400 uppercase tracking-wider text-left border-b border-gray-100">
                    <tr>
                      <th className="pb-3">Date</th>
                      <th className="pb-3">Description</th>
                      <th className="pb-3">Check #</th>
                      <th className="pb-3 text-right">Debit</th>
                      <th className="pb-3 text-right">Credit</th>
                      <th className="pb-3 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {/* Running balance CARRIES the opening balance forward
                        (issue #21): filtering to a date range no longer restarts
                        the balance at zero — the first visible row already
                        reflects everything prior. Integer-cents throughout. */}
                    {buildLedgerView(
                      transactions.filter(tx => tx.clientId === selectedClient.id),
                      {
                        start: modalDateRange.start || undefined,
                        end: modalDateRange.end || undefined,
                        type: modalFilterType,
                      },
                    ).rows.map(({ tx, runningBalance }, i) => (
                        <tr key={i} className="text-sm">
                          <td className="py-4 text-gray-600">{tx.date}</td>
                          <td className="py-4 text-gray-900 font-medium">{tx.description}</td>
                          <td className="py-4 text-gray-600">{tx.checkNumber || '-'}</td>
                          <td className="py-4 text-right text-red-600">{tx.amount < 0 ? `$${Math.abs(tx.amount).toFixed(2)}` : ''}</td>
                          <td className="py-4 text-right text-green-600">{tx.amount > 0 ? `$${tx.amount.toFixed(2)}` : ''}</td>
                          <td className="py-4 text-right font-bold text-gray-900">${runningBalance.toFixed(2)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="p-6 bg-indigo-600 text-white flex items-center justify-between">
                <span className="font-semibold">Final Ledger Balance</span>
                <span className="text-2xl font-bold">${selectedClient.balance.toFixed(2)}</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Review Transactions Modal */}
      <AnimatePresence>
        {isReviewModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-4xl max-h-[80vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-gray-100 flex justify-between items-center">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Review Transactions</h2>
                  <p className="text-sm text-gray-500">Confirm or adjust client assignments before saving.</p>
                </div>
                <button onClick={() => setIsReviewModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                  <LucideX size={24} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-8">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs uppercase sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-left">Date</th>
                      <th className="px-4 py-3 text-left">Description</th>
                      <th className="px-4 py-3 text-left">Client Name (AI Identified)</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {pendingTransactions.map((tx, i) => (
                      <tr key={i}>
                        <td className="px-4 py-4">{tx.date}</td>
                        <td className="px-4 py-4">
                          <div className="font-medium text-gray-900">{tx.description}</div>
                          {tx.checkNumber && <div className="text-[10px] text-gray-400">Check #{tx.checkNumber}</div>}
                        </td>
                        <td className="px-4 py-4">
                          <input 
                            type="text"
                            value={tx.clientName || ''}
                            onChange={(e) => {
                              const newTxs = [...pendingTransactions];
                              newTxs[i].clientName = e.target.value;
                              setPendingTransactions(newTxs);
                            }}
                            className="w-full px-3 py-1 bg-indigo-50 border border-indigo-100 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                            placeholder="Assign Client..."
                          />
                        </td>
                        <td className={`px-4 py-4 text-right font-bold ${tx.amount! < 0 ? 'text-red-600' : 'text-green-600'}`}>
                          ${Math.abs(tx.amount!).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="p-8 bg-gray-50 border-t border-gray-100 flex justify-end gap-4">
                <button 
                  onClick={() => setIsReviewModalOpen(false)}
                  className="px-6 py-2 text-gray-600 font-bold hover:bg-gray-200 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleConfirmReview}
                  className="px-8 py-2 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  Confirm & Save {pendingTransactions.length} Transactions
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit Transaction Modal */}
      <AnimatePresence>
        {isEditModalOpen && editingTx && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsEditModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden"
            >
              <form onSubmit={handleEditSubmit} className="p-8 space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-bold text-gray-900">Edit Transaction</h2>
                  <button type="button" onClick={() => setIsEditModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                    <LucideX size={24} />
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Date</label>
                      <input 
                        type="date" 
                        required
                        value={editingTx.date}
                        onChange={(e) => setEditingTx({...editingTx, date: e.target.value})}
                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Type</label>
                      <select 
                        value={editingTx.type}
                        onChange={(e) => setEditingTx({...editingTx, type: e.target.value as any})}
                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      >
                        <option value="receipt">Receipt</option>
                        <option value="disbursement">Disbursement</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Client</label>
                    <select 
                      value={editingTx.clientId}
                      onChange={(e) => {
                        const client = clients.find(c => c.id === e.target.value);
                        setEditingTx({...editingTx, clientId: e.target.value, clientName: client?.name});
                      }}
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    >
                      <option value="">Select Client (Optional)</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Amount</label>
                    <div className="relative">
                      <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                      <input 
                        type="number" 
                        step="0.01"
                        required
                        value={Math.abs(editingTx.amount || 0)}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          setEditingTx({...editingTx, amount: editingTx.type === 'disbursement' ? -val : val});
                        }}
                        className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Description</label>
                    <textarea 
                      required
                      value={editingTx.description}
                      onChange={(e) => setEditingTx({...editingTx, description: e.target.value})}
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 h-24 resize-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Check Number</label>
                      <input 
                        type="text"
                        value={editingTx.checkNumber || ''}
                        onChange={(e) => setEditingTx({...editingTx, checkNumber: e.target.value})}
                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Clear Date</label>
                      <input 
                        type="date"
                        value={editingTx.clearDate || ''}
                        onChange={(e) => setEditingTx({...editingTx, clearDate: e.target.value})}
                        className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                <button 
                  type="submit"
                  className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  Update Transaction
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Clear Transaction Modal */}
      <AnimatePresence>
        {isClearModalOpen && txToClear && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsClearModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <h2 className="text-xl font-bold text-gray-900 mb-4">Mark as Cleared</h2>
              <p className="text-sm text-gray-500 mb-6">Enter the date when check #{txToClear.checkNumber} cleared the bank.</p>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Clear Date</label>
                  <input 
                    type="date" 
                    required
                    autoFocus
                    value={clearDate}
                    onChange={(e) => setClearDate(e.target.value)}
                    className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
                <button 
                  onClick={handleClearTransaction}
                  className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  Confirm Cleared
                </button>
                <button 
                  onClick={() => setIsClearModalOpen(false)}
                  className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Statement Balance Modal */}
      <AnimatePresence>
        {isStatementModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setIsStatementModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-sm rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <h2 className="text-xl font-bold text-gray-900 mb-4">Set Statement Balance</h2>
              <p className="text-sm text-gray-500 mb-6">Enter the bank statement balance for {format(parseISO(`${targetMonth}-01`), 'MMMM yyyy')}.</p>
              
              <form onSubmit={handleStatementBalanceSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Statement Balance</label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input 
                      type="number" 
                      step="0.01"
                      required
                      autoFocus
                      value={newStatementBalance}
                      onChange={(e) => setNewStatementBalance(parseFloat(e.target.value))}
                      className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>
                <button 
                  type="submit"
                  className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  Save Balance
                </button>
                <button 
                  type="button"
                  onClick={() => setIsStatementModalOpen(false)}
                  className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Attest & Finalize / Reopen Modal (lifecycle #14) */}
      <AnimatePresence>
        {isFinalizeModalOpen && finalizeMonth && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !finalizing && setIsFinalizeModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              {finalizeMode === 'finalize' ? (
                <>
                  <h2 className="text-xl font-bold text-gray-900 mb-1 flex items-center gap-2">
                    <Lock size={18} /> Attest &amp; Finalize — {format(parseISO(`${finalizeMonth}-01`), 'MMMM yyyy')}
                  </h2>
                  <p className="text-sm text-gray-500 mb-4">
                    Finalizing freezes this month's bank, book, statement and match records
                    into an immutable, retained packet (seven years, {RECON_AUTHORITY}) and
                    locks every transaction dated within it. This is a deliberate attorney act.
                  </p>
                  {(() => {
                    const existing = reconciliations.find(r => r.month === finalizeMonth);
                    const version = existing?.version ?? 1;
                    return version > 1 ? (
                      <div className="mb-4">
                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Amendment reason (version {version})</label>
                        <textarea
                          value={amendReason}
                          onChange={(e) => setAmendReason(e.target.value)}
                          placeholder="Why is this month being re-finalized?"
                          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20"
                          rows={2}
                        />
                      </div>
                    ) : null;
                  })()}
                  <label className="flex items-start gap-2 mb-6 text-sm text-gray-700">
                    <input type="checkbox" checked={attestChecked} onChange={(e) => setAttestChecked(e.target.checked)} className="mt-0.5" />
                    <span>{DEFAULT_ATTESTATION_STATEMENT}</span>
                  </label>
                  <button
                    disabled={!attestChecked || finalizing}
                    onClick={handleFinalizeMonth}
                    className={`w-full py-3 rounded-xl font-bold transition-colors ${attestChecked && !finalizing ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                  >
                    {finalizing ? 'Finalizing…' : 'Attest & Finalize'}
                  </button>
                </>
              ) : (
                <>
                  <h2 className="text-xl font-bold text-gray-900 mb-1">Reopen {format(parseISO(`${finalizeMonth}-01`), 'MMMM yyyy')} to Amend</h2>
                  <p className="text-sm text-gray-500 mb-4">
                    Reopening unlocks this month for correction. The finalized packet stays
                    retained; your amendment produces a new version. A documented reason is required.
                  </p>
                  <div className="mb-6">
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Reason for reopening</label>
                    <textarea
                      value={amendReason}
                      onChange={(e) => setAmendReason(e.target.value)}
                      placeholder="e.g. Bank corrected a mis-posted deposit for this period."
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20"
                      rows={3}
                      autoFocus
                    />
                  </div>
                  <button
                    disabled={!amendReason.trim() || finalizing}
                    onClick={handleReopenMonth}
                    className={`w-full py-3 rounded-xl font-bold transition-colors ${amendReason.trim() && !finalizing ? 'bg-amber-600 text-white hover:bg-amber-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                  >
                    {finalizing ? 'Reopening…' : 'Reopen for Amendment'}
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={finalizing}
                onClick={() => setIsFinalizeModalOpen(false)}
                className="w-full mt-3 bg-gray-100 text-gray-600 py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Manual Entry Modal — records a receipt or disbursement by hand
          (handleManualSubmit existed but had no UI, so the toolbar button was
          dead; audit issue #20). */}
      <AnimatePresence>
        {isManualModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsManualModalOpen(false)}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden p-8"
            >
              <h2 className="text-xl font-bold text-gray-900 mb-4">Manual Transaction Entry</h2>
              <p className="text-sm text-gray-500 mb-6">Record a receipt or disbursement directly. Enter the amount as a positive number — the sign follows the type.</p>

              <form onSubmit={handleManualSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Type</label>
                    <select
                      value={newTx.type}
                      onChange={(e) => setNewTx(prev => ({ ...prev, type: e.target.value as Transaction['type'] }))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    >
                      <option value="receipt">Receipt</option>
                      <option value="disbursement">Disbursement</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Date</label>
                    <input
                      type="date"
                      required
                      value={newTx.date}
                      onChange={(e) => setNewTx(prev => ({ ...prev, date: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Amount</label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      autoFocus
                      value={newTx.amount ? Math.abs(newTx.amount) : ''}
                      onChange={(e) => setNewTx(prev => ({ ...prev, amount: parseFloat(e.target.value) }))}
                      className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Client</label>
                  <select
                    value={newTx.clientId || ''}
                    onChange={(e) => {
                      const client = clients.find(c => c.id === e.target.value);
                      setNewTx(prev => ({ ...prev, clientId: e.target.value || undefined, clientName: client?.name }));
                    }}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="">Unassigned</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                {newTx.type === 'disbursement' && (
                  <div>
                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Check # (optional)</label>
                    <input
                      type="text"
                      value={newTx.checkNumber || ''}
                      onChange={(e) => setNewTx(prev => ({ ...prev, checkNumber: e.target.value }))}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Description</label>
                  <input
                    type="text"
                    required
                    value={newTx.description}
                    onChange={(e) => setNewTx(prev => ({ ...prev, description: e.target.value }))}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                >
                  Add Transaction
                </button>
                <button
                  type="button"
                  onClick={() => setIsManualModalOpen(false)}
                  className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
