/**
 * Firestore plumbing for the iolta tamper-evident audit chain.
 *
 * Layout (per user):
 *   auditEntries/{uid}_{seq:012d}  — one sealed entry per doc, CREATE-ONLY
 *                                    (firestore.rules denies update/delete)
 *   auditMeta/{uid}                — chain head {seq, hash}: the CAS cursor
 *
 * Single-writer semantics across tabs/devices: every append runs inside
 * runTransaction — read head, seal next entry, write entry + head atomically.
 * Firestore retries the transaction on contention, so two tabs racing to
 * append seq N serialize instead of forking the chain.
 *
 * Honest limits (also in the PR):
 *  - Hashes are computed client-side; rules cannot verify SHA-256 linkage,
 *    so a client with write access could rewrite the whole chain + head.
 *    Tamper-evidence covers UNDETECTED later modification, not a malicious
 *    authorized client (same residual packages/audit documents).
 *  - Offline: transactions need connectivity. Failed appends queue in
 *    localStorage and flush on reconnect; chain order can lag ledger order,
 *    and entry timestamps record the true mutation time.
 */
import {
  collection, doc, getDocs, query, runTransaction, serverTimestamp, where,
} from 'firebase/firestore';
import { db } from './firebase';
import { buildNextEntry, verifyEntryDocs } from './audit-chain';
import type { ChainVerification, EntryDoc, SealedEntry } from './audit-chain';
import type { AuditEventPayloads, AuditEventType } from '@elias/audit/core';

const entryDocId = (uid: string, seq: number): string => `${uid}_${String(seq).padStart(12, '0')}`;
const queueKey = (uid: string): string => `elias_audit_queue_${uid}`;

interface QueuedEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

function readQueue(uid: string): QueuedEvent[] {
  try {
    return JSON.parse(localStorage.getItem(queueKey(uid)) || '[]') as QueuedEvent[];
  } catch {
    return [];
  }
}

function writeQueue(uid: string, events: QueuedEvent[]): void {
  try {
    localStorage.setItem(queueKey(uid), JSON.stringify(events));
  } catch { /* storage full/blocked — the mutation itself already committed */ }
}

/** Transactional append. Throws on failure — callers use appendAuditEvent. */
async function appendNow<T extends AuditEventType>(
  uid: string,
  type: T,
  payload: AuditEventPayloads[T],
  timestamp?: string,
): Promise<SealedEntry<T>> {
  return runTransaction(db, async (tx) => {
    const headRef = doc(db, 'auditMeta', uid);
    const snap = await tx.get(headRef);
    const data = snap.exists() ? (snap.data() as { seq: number; hash: string }) : null;
    const head = data && Number.isInteger(data.seq) && typeof data.hash === 'string'
      ? { seq: data.seq, hash: data.hash }
      : null;
    const entry = buildNextEntry(head, type, payload, timestamp);
    // set() with a deterministic id: a retried create of the same seq writes
    // the same doc id, so a conflict surfaces as a transaction retry rather
    // than a duplicate.
    tx.set(doc(db, 'auditEntries', entryDocId(uid, entry.seq)), { ...entry, uid });
    tx.set(headRef, { seq: entry.seq, hash: entry.hash, uid, updatedAt: serverTimestamp() });
    return entry;
  });
}

/**
 * Append one audit event. Never throws: on failure (offline, contention,
 * rules not yet deployed) the event is queued in localStorage and flushed
 * by flushAuditQueue on the next online session. The ledger mutation this
 * records has already committed by the time this is called.
 */
export async function appendAuditEvent<T extends AuditEventType>(
  uid: string,
  type: T,
  payload: AuditEventPayloads[T],
): Promise<void> {
  try {
    await appendNow(uid, type, payload);
  } catch (e) {
    console.warn('audit append queued (offline or contention):', e);
    const q = readQueue(uid);
    q.push({ type, payload: payload as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });
    writeQueue(uid, q);
  }
}

/** Flush queued events in order. Returns the number still pending. */
export async function flushAuditQueue(uid: string): Promise<number> {
  const q = readQueue(uid);
  if (!q.length) return 0;
  const remaining: QueuedEvent[] = [];
  for (const ev of q) {
    try {
      // Queue entries are sealed with their ORIGINAL mutation timestamp —
      // chain order may lag ledger order, but the record tells the truth
      // about when the mutation happened.
      // eslint-disable-next-line no-await-in-loop
      await appendNow(uid, ev.type as AuditEventType, ev.payload as unknown as AuditEventPayloads[AuditEventType], ev.timestamp);
    } catch (e) {
      console.warn('audit queue flush paused:', e);
      remaining.push(ev, ...q.slice(q.indexOf(ev) + 1));
      break;
    }
  }
  writeQueue(uid, remaining);
  return remaining.length;
}

/**
 * Verify-on-open: fetch every entry for this user and re-verify the whole
 * chain. Sorting client-side avoids a composite Firestore index.
 */
export async function verifyAuditChain(uid: string): Promise<ChainVerification> {
  const snap = await getDocs(query(collection(db, 'auditEntries'), where('uid', '==', uid)));
  const docs = snap.docs
    .map(d => d.data() as EntryDoc)
    .sort((a, b) => a.seq - b.seq);
  return verifyEntryDocs(docs);
}
