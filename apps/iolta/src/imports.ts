/**
 * Atomic, idempotent statement imports (Phase 2, issue #21 / Codex items).
 *
 * Three defects this module closes:
 *
 *  1. Non-deterministic parsing — every import went straight to the AI
 *     extractor, even a clean CSV/XLS the machine can read exactly. We now parse
 *     delimited text DETERMINISTICALLY first; the AI is only a fallback for
 *     content this parser can't structure (images, prose PDFs).
 *
 *  2. Re-running an import duplicated everything — no dedup. Each row gets a
 *     stable fingerprint (date + exact cents + type + check# + normalized
 *     description + client), so importing the same file twice is a no-op.
 *
 *  3. Duplicate clients within one import — the same client named on N rows
 *     could create N client records. New client names are de-duplicated
 *     case-insensitively, within the batch and against existing clients.
 *
 * Plus a data-integrity invariant used by every write path: a transaction whose
 * declared type contradicts its amount sign is REJECTED (Phase 1 only
 * normalized this in the Manual Entry modal — here it is enforced at the model
 * / import layer too).
 *
 * Pure + browser-safe: no Node builtins, no csv-parse dependency (the parser is
 * a small RFC-4180 reader), so it bundles into the Vite client and unit-tests
 * with tsx.
 */
import { toCents } from './money';

export interface ParsedRow {
  date: string; // YYYY-MM-DD
  amount: number; // signed: + receipt, - disbursement
  type: 'receipt' | 'disbursement';
  description: string;
  checkNumber?: string;
  clientName?: string;
  clearDate?: string;
}

// ---------------------------------------------------------------------------
// Sign / type invariant (#: reject type ↔ amount-sign contradictions)
// ---------------------------------------------------------------------------

/**
 * The stored convention is: receipts are positive, disbursements negative.
 * Returns an error message if a signed amount contradicts its declared type,
 * else null. A zero amount is never a valid transaction.
 */
export function signConsistencyError(
  type: 'receipt' | 'disbursement',
  amount: number,
): string | null {
  const cents = toCents(amount);
  if (cents === 0) return 'Amount must be non-zero.';
  if (type === 'receipt' && cents < 0) {
    return `Receipt cannot have a negative amount (${amount}).`;
  }
  if (type === 'disbursement' && cents > 0) {
    return `Disbursement cannot have a positive amount (${amount}).`;
  }
  return null;
}

/** Force a magnitude to the sign its type implies (receipt +, disbursement −). */
export function signedForType(type: 'receipt' | 'disbursement', magnitude: number): number {
  const abs = Math.abs(magnitude);
  return type === 'disbursement' ? -abs : abs;
}

// ---------------------------------------------------------------------------
// Deterministic delimited (CSV / sheet-exported-CSV) parsing
// ---------------------------------------------------------------------------

/** Minimal RFC-4180 CSV reader: quoted fields, escaped quotes, CRLF/LF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else {
      field += c;
    }
  }
  // trailing field / row (no final newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

const HEADER_SYNONYMS: Record<string, string[]> = {
  date: ['date', 'transaction date', 'posted date', 'issue date', 'trans date'],
  amount: ['amount', 'amt'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'payment', 'debits'],
  credit: ['credit', 'deposit', 'deposits', 'credits'],
  type: ['type', 'transaction type', 'txn type'],
  description: ['description', 'memo', 'details', 'payee', 'narrative', 'note'],
  check: ['check', 'check #', 'check number', 'check no', 'chk', 'chk #', 'cheque'],
  client: ['client', 'client name', 'matter', 'name'],
  clearDate: ['clear date', 'cleared', 'clear', 'cleared date'],
};

function classifyHeader(cell: string): string | null {
  const norm = cell.trim().toLowerCase();
  for (const [key, syns] of Object.entries(HEADER_SYNONYMS)) {
    if (syns.includes(norm)) return key;
  }
  return null;
}

/** Parse "$1,234.50", "(45.00)", "-45" → a JS number. NaN if unparseable. */
function parseMoney(raw: string): number {
  const s = raw.trim();
  if (s === '') return NaN;
  const negative = /^\(.*\)$/.test(s) || s.trim().startsWith('-');
  const digits = s.replace(/[()$,\s]/g, '').replace(/^-/, '');
  if (digits === '' || !/^\d*\.?\d+$/.test(digits)) return NaN;
  const n = parseFloat(digits);
  return negative ? -n : n;
}

function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY or M/D/YYYY (and dash variants)
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

export interface ParseResult {
  rows: ParsedRow[];
  errors: string[];
  /** True when the parser recognized a usable header and structured the text. */
  recognized: boolean;
}

/**
 * Deterministically parse delimited statement text. Returns `recognized: false`
 * when no usable header is found so the caller can fall back to the AI parser.
 */
export function parseDelimited(text: string): ParseResult {
  const errors: string[] = [];
  const grid = parseCsvRows(text);
  if (grid.length < 2) return { rows: [], errors, recognized: false };

  const header = grid[0].map(classifyHeader);
  const col = (key: string) => header.indexOf(key);
  const iDate = col('date');
  const iAmount = col('amount');
  const iDebit = col('debit');
  const iCredit = col('credit');
  const iType = col('type');
  const iDesc = col('description');
  const iCheck = col('check');
  const iClient = col('client');
  const iClear = col('clearDate');

  // Need at minimum a date and some amount source.
  if (iDate < 0 || (iAmount < 0 && iCredit < 0 && iDebit < 0)) {
    return { rows: [], errors, recognized: false };
  }

  const rows: ParsedRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '');
    const rowLabel = `row ${r + 1}`;

    const date = normalizeDate(get(iDate));
    if (!date) { errors.push(`${rowLabel}: unparseable date "${get(iDate)}".`); continue; }

    // Determine signed amount + whether the source itself carried a sign.
    let signed: number;
    let sourceSigned = false;
    if (iCredit >= 0 || iDebit >= 0) {
      const credit = iCredit >= 0 ? parseMoney(get(iCredit)) : NaN;
      const debit = iDebit >= 0 ? parseMoney(get(iDebit)) : NaN;
      const creditVal = Number.isNaN(credit) ? 0 : Math.abs(credit);
      const debitVal = Number.isNaN(debit) ? 0 : Math.abs(debit);
      signed = creditVal - debitVal;
      sourceSigned = true; // debit/credit columns are inherently signed
    } else {
      const amt = parseMoney(get(iAmount));
      if (Number.isNaN(amt)) { errors.push(`${rowLabel}: unparseable amount "${get(iAmount)}".`); continue; }
      signed = amt;
      sourceSigned = /[-()]/.test(get(iAmount).trim());
    }

    // Determine declared type, if any.
    let declaredType: 'receipt' | 'disbursement' | null = null;
    if (iType >= 0) {
      const t = get(iType).trim().toLowerCase();
      if (['receipt', 'deposit', 'credit'].includes(t)) declaredType = 'receipt';
      else if (['disbursement', 'withdrawal', 'debit', 'check', 'payment'].includes(t)) declaredType = 'disbursement';
    }

    // If the source signed the amount AND declared a contradicting type → reject.
    if (declaredType && sourceSigned) {
      const signImpliesType = signed < 0 ? 'disbursement' : 'receipt';
      if (signed !== 0 && signImpliesType !== declaredType) {
        errors.push(`${rowLabel}: type "${declaredType}" contradicts amount sign (${signed}).`);
        continue;
      }
    }

    const type: 'receipt' | 'disbursement' =
      declaredType ?? (signed < 0 ? 'disbursement' : 'receipt');
    const finalAmount = signedForType(type, signed);

    const signErr = signConsistencyError(type, finalAmount);
    if (signErr) { errors.push(`${rowLabel}: ${signErr}`); continue; }

    const description = (iDesc >= 0 ? get(iDesc) : '').trim() || '(imported)';
    const checkNumber = iCheck >= 0 ? get(iCheck).trim() || undefined : undefined;
    const clientName = iClient >= 0 ? get(iClient).trim() || undefined : undefined;
    const clearDate = iClear >= 0 ? normalizeDate(get(iClear)) || undefined : undefined;

    rows.push({ date, amount: finalAmount, type, description, checkNumber, clientName, clearDate });
  }

  return { rows, errors, recognized: true };
}

// ---------------------------------------------------------------------------
// Idempotent dedup (importing the same file twice is a no-op)
// ---------------------------------------------------------------------------

function normDescription(desc: string | undefined): string {
  return (desc ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Stable fingerprint of a transaction's identity for dedup. Amount is compared
 * in exact integer cents (never floats). Two rows with the same date, cents,
 * type, check number, description and client are the same import line.
 */
export function transactionFingerprint(tx: {
  date?: string;
  amount?: number | null;
  type?: string;
  checkNumber?: string;
  description?: string;
  clientName?: string;
}): string {
  return [
    tx.date ?? '',
    String(toCents(tx.amount ?? 0)),
    tx.type ?? '',
    (tx.checkNumber ?? '').trim(),
    normDescription(tx.description),
    normDescription(tx.clientName),
  ].join('|');
}

export interface DedupResult<T> {
  fresh: T[];
  duplicates: T[];
}

/**
 * Split incoming rows into genuinely new vs already-present, by fingerprint.
 * Deduplicates WITHIN the batch too, so a file that repeats a line imports it
 * once. Idempotent: re-running with the previous rows' fingerprints in
 * `existingFingerprints` yields an empty `fresh`.
 */
export function dedupeTransactions<T extends Parameters<typeof transactionFingerprint>[0]>(
  incoming: T[],
  existingFingerprints: Set<string>,
): DedupResult<T> {
  const fresh: T[] = [];
  const duplicates: T[] = [];
  const seen = new Set(existingFingerprints);
  for (const tx of incoming) {
    const fp = transactionFingerprint(tx);
    if (seen.has(fp)) {
      duplicates.push(tx);
    } else {
      seen.add(fp);
      fresh.push(tx);
    }
  }
  return { fresh, duplicates };
}

/**
 * Resolve the distinct NEW client names an import needs to create: case-
 * insensitive, de-duplicated within the batch and against existing clients.
 * Returns the canonical (first-seen) spelling for each new name. Prevents N
 * client records for one client mentioned on N rows.
 */
export function newClientNames(
  rows: { clientName?: string }[],
  existingClientNames: string[],
): string[] {
  const existing = new Set(existingClientNames.map(n => n.trim().toLowerCase()));
  const result: string[] = [];
  const added = new Set<string>();
  for (const row of rows) {
    const name = row.clientName?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (existing.has(key) || added.has(key)) continue;
    added.add(key);
    result.push(name);
  }
  return result;
}
