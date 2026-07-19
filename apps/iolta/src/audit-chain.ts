/**
 * Pure hash-chain logic for the iolta audit trail — browser-safe, no
 * Firebase imports, so it is unit-testable in plain Node (tsx).
 *
 * The chain format is exactly @elias/audit's:
 *   hash = sha256(prevHash + "\n" + canonical({seq, timestamp, type, payload}))
 * so entries sealed here verify with the same algorithm as books/billable,
 * and the trust ledger's history is portable across the suite.
 *
 * Why this module exists (design pass): packages/audit was built for a
 * single-writer local store with the tail cached in memory. iolta is
 * multi-tab / multi-device against Firestore — a cached tail forks. Instead
 * the chain head lives in Firestore (auditMeta/{uid}) and every append is a
 * compare-and-swap: read head → seal next entry → write entry + head
 * atomically. Concurrent writers lose the race and retry against the fresh
 * head — single-writer semantics survive as CAS serialization.
 */
import { computeEntryHash, GENESIS_HASH } from '@elias/audit/core';
import type { AuditEventPayloads, AuditEventType } from '@elias/audit/core';

/** The last sealed entry's position and hash — the chain's only cursor. */
export interface ChainHead {
  seq: number;
  hash: string;
}

export interface SealedEntry<T extends AuditEventType = AuditEventType> {
  seq: number;
  timestamp: string;
  type: T;
  payload: AuditEventPayloads[T];
  prevHash: string;
  hash: string;
}

/** Seal the next entry after `head` (null = empty chain → seq 0, GENESIS). */
export function buildNextEntry<T extends AuditEventType>(
  head: ChainHead | null,
  type: T,
  payload: AuditEventPayloads[T],
  timestamp?: string,
): SealedEntry<T> {
  const seq = head ? head.seq + 1 : 0;
  const prevHash = head ? head.hash : GENESIS_HASH;
  const ts = timestamp ?? new Date().toISOString();
  const body = { seq, timestamp: ts, type, payload };
  return { seq, timestamp: ts, type, payload, prevHash, hash: computeEntryHash(prevHash, body) };
}

export type ChainVerification =
  | { ok: true; entries: number }
  | { ok: false; entries: number; error: string; atSeq: number | null };

/** Fields a stored entry document must carry (a uid field may also be present;
 *  it is envelope, not part of the sealed body). */
export interface EntryDoc {
  seq: number;
  timestamp: string;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

/**
 * Re-verify a fetched chain: docs must already be sorted by seq ascending.
 * Mirrors AuditLog.verify() — every hash recomputed, first bad entry named.
 */
export function verifyEntryDocs(docs: EntryDoc[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < docs.length; i += 1) {
    const e = docs[i] as EntryDoc;
    if (!Number.isInteger(e.seq) || typeof e.timestamp !== 'string' || typeof e.type !== 'string' ||
        typeof e.prevHash !== 'string' || typeof e.hash !== 'string' ||
        typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) {
      return { ok: false, entries: docs.length, error: `entry ${i}: missing required fields`, atSeq: i };
    }
    if (e.seq !== i) {
      return { ok: false, entries: docs.length, error: `entry ${i}: seq is ${e.seq}, expected ${i} (gap or reorder)`, atSeq: e.seq };
    }
    if (e.prevHash !== prevHash) {
      return { ok: false, entries: docs.length, error: `entry ${i}: prevHash does not match previous entry's hash (chain broken)`, atSeq: i };
    }
    const expected = computeEntryHash(e.prevHash, { seq: e.seq, timestamp: e.timestamp, type: e.type, payload: e.payload });
    if (e.hash !== expected) {
      return { ok: false, entries: docs.length, error: `entry ${i}: hash mismatch — payload or metadata was altered after sealing`, atSeq: i };
    }
    prevHash = e.hash;
  }
  return { ok: true, entries: docs.length };
}

/**
 * Storage-independent CAS append with bounded retries. The Firestore path
 * gets the same semantics from runTransaction; this helper is for tests and
 * any future backend without native transactions.
 */
export interface HeadCas {
  read(): Promise<ChainHead | null>;
  /** Write entry + new head iff the stored head still equals expectedHead. */
  compareAndSwap(expectedHead: ChainHead | null, entry: SealedEntry, newHead: ChainHead): Promise<boolean>;
}

export async function casAppend<T extends AuditEventType>(
  store: HeadCas,
  type: T,
  payload: AuditEventPayloads[T],
  opts?: { maxRetries?: number; timestamp?: string },
): Promise<SealedEntry<T>> {
  const maxRetries = opts?.maxRetries ?? 5;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const head = await store.read();
    const entry = buildNextEntry(head, type, payload, opts?.timestamp);
    const newHead: ChainHead = { seq: entry.seq, hash: entry.hash };
    // eslint-disable-next-line no-await-in-loop
    if (await store.compareAndSwap(head, entry, newHead)) return entry;
  }
  throw new Error(`audit: append lost CAS race ${maxRetries} times — too much contention`);
}
