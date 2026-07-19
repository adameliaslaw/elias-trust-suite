import type { AuditEventPayloads, AuditEventType } from './events.js';
import { sha256Hex } from './sha256.js';
import { stableStringify } from './stable-stringify.js';
import type { AuditStorage } from './storage.js';

/** prevHash of the first entry in every chain. */
export const GENESIS_HASH = 'GENESIS';

export interface AuditEntry<T extends AuditEventType = AuditEventType> {
  /** Position in the chain, 0-based, strictly increasing by 1. */
  readonly seq: number;
  /** ISO 8601 UTC timestamp. */
  readonly timestamp: string;
  readonly type: T;
  readonly payload: AuditEventPayloads[T];
  /** Hash of the previous entry, or GENESIS_HASH for seq 0. */
  readonly prevHash: string;
  /** sha256(prevHash + "\n" + canonical({seq, timestamp, type, payload})) */
  readonly hash: string;
}

export class AuditIntegrityError extends Error {
  readonly atSeq: number | null;
  constructor(message: string, atSeq: number | null) {
    super(message);
    this.name = 'AuditIntegrityError';
    this.atSeq = atSeq;
  }
}

export type VerificationResult =
  | { ok: true; entries: number }
  | { ok: false; entries: number; error: string; atSeq: number | null };

/** The canonical body an entry hash seals (everything except prevHash/hash). */
export interface AuditEntryBody {
  seq: number;
  timestamp: string;
  type: string;
  payload: unknown;
}

/**
 * The chain hash for an entry body: sha256(prevHash + "\n" + canonical(body)).
 * Exported so non-file storages (e.g. a Firestore compare-and-swap head) can
 * seal entries with the exact same format the verifier checks.
 */
export function computeEntryHash(prevHash: string, body: AuditEntryBody): string {
  return sha256Hex(`${prevHash}\n${stableStringify(body)}`);
}

const hashEntry = computeEntryHash;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredEntry(line: string, index: number): AuditEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new AuditIntegrityError(`line ${index}: invalid JSON`, index);
  }
  if (!isRecord(parsed)) {
    throw new AuditIntegrityError(`line ${index}: entry is not an object`, index);
  }
  const { seq, timestamp, type, payload, prevHash, hash } = parsed;
  if (
    typeof seq !== 'number' ||
    !Number.isInteger(seq) ||
    typeof timestamp !== 'string' ||
    typeof type !== 'string' ||
    !isRecord(payload) ||
    typeof prevHash !== 'string' ||
    typeof hash !== 'string'
  ) {
    throw new AuditIntegrityError(`line ${index}: entry is missing required fields`, index);
  }
  return parsed as unknown as AuditEntry;
}

export interface AuditLogOptions {
  /** Clock override for deterministic timestamps (tests). Defaults to system time. */
  clock?: () => Date;
  /**
   * Verify the full chain on open (default true). A compliance log that
   * opens without complaint after tampering is worse than no log.
   */
  verifyOnOpen?: boolean;
}

/**
 * Append-only, hash-chained audit log.
 *
 * Single-writer: one open AuditLog instance owns its storage. (Multiple
 * writers would fork the chain; verify() on next open would catch it.)
 */
export class AuditLog {
  private readonly storage: AuditStorage;
  private readonly clock: () => Date;
  private readonly tail: AuditEntry[] = [];
  // Serializes append(): even the single owning writer forks its own chain
  // when two append() calls interleave (both read tail.length before either
  // pushes). Found via books' post-response Layer A append racing the next
  // request's semantic append.
  private appendQueue: Promise<unknown> = Promise.resolve();

  private constructor(storage: AuditStorage, clock: () => Date) {
    this.storage = storage;
    this.clock = clock;
  }

  static async open(storage: AuditStorage, opts?: AuditLogOptions): Promise<AuditLog> {
    const log = new AuditLog(storage, opts?.clock ?? (() => new Date()));
    if (opts?.verifyOnOpen !== false) {
      const result = await log.verify();
      if (!result.ok) {
        throw new AuditIntegrityError(`audit log integrity check failed: ${result.error}`, result.atSeq);
      }
    }
    log.tail.push(...(await log.readEntries()));
    return log;
  }

  /** Append an event. Returns the sealed entry (with hash). Concurrent
   *  calls are serialized internally — they can never fork the chain. */
  append<T extends AuditEventType>(
    type: T,
    payload: AuditEventPayloads[T],
    opts?: { timestamp?: string },
  ): Promise<AuditEntry<T>> {
    const run = this.appendQueue.then(async (): Promise<AuditEntry<T>> => {
      const seq = this.tail.length;
      const prevHash = seq === 0 ? GENESIS_HASH : (this.tail[seq - 1] as AuditEntry).hash;
      const timestamp = opts?.timestamp ?? this.clock().toISOString();
      const body: AuditEntryBody = { seq, timestamp, type, payload };
      const entry: AuditEntry<T> = { seq, timestamp, type, payload, prevHash, hash: hashEntry(prevHash, body) };
      await this.storage.append(stableStringify(entry));
      this.tail.push(entry);
      return entry;
    });
    // A failed append must not wedge every later append behind its rejection.
    this.appendQueue = run.catch(() => undefined);
    return run;
  }

  /** Number of entries appended through this log instance. */
  get length(): number {
    return this.tail.length;
  }

  /** Entries appended through this instance (immutable copy). */
  entries(): readonly AuditEntry[] {
    return [...this.tail];
  }

  private async readEntries(): Promise<AuditEntry[]> {
    const lines = await this.storage.readAll();
    return lines.map((line, i) => parseStoredEntry(line, i));
  }

  /**
   * Re-read storage and check the whole chain:
   * valid JSONL, required fields, seq = 0..n-1 in order, prevHash linkage,
   * and exact hash recomputation for every entry.
   */
  async verify(): Promise<VerificationResult> {
    const lines = await this.storage.readAll();
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      let entry: AuditEntry;
      try {
        entry = parseStoredEntry(line, i);
      } catch (err) {
        if (err instanceof AuditIntegrityError) {
          return { ok: false, entries: lines.length, error: err.message, atSeq: err.atSeq };
        }
        throw err;
      }
      if (entry.seq !== i) {
        return {
          ok: false,
          entries: lines.length,
          error: `line ${i}: seq is ${entry.seq}, expected ${i} (gap or reorder)`,
          atSeq: entry.seq,
        };
      }
      if (entry.prevHash !== prevHash) {
        return {
          ok: false,
          entries: lines.length,
          error: `line ${i}: prevHash does not match previous entry's hash (chain broken)`,
          atSeq: i,
        };
      }
      const expected = hashEntry(entry.prevHash, {
        seq: entry.seq,
        timestamp: entry.timestamp,
        type: entry.type,
        payload: entry.payload,
      });
      if (entry.hash !== expected) {
        return {
          ok: false,
          entries: lines.length,
          error: `line ${i}: hash mismatch — payload or metadata was altered after sealing`,
          atSeq: i,
        };
      }
      prevHash = entry.hash;
    }
    return { ok: true, entries: lines.length };
  }
}
