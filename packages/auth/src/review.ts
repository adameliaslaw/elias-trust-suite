// Uniform, audited attorney review / sign-off for compliance outputs (#26).
//
// Every app in the suite emits outputs a licensed attorney is on the hook for —
// an IOLTA reconciliation packet, a client invoice, a payroll filing. This is
// the ONE shape that records "an attorney reviewed exactly this and signed".
//
// The sign-off is CONTENT-ADDRESSED: it binds to a SHA-256 of the exact output
// under review (canonicalized so key order can't change the hash). If the
// output is later edited, `verifySignoff` fails against the new content, so a
// stale approval can never silently cover mutated numbers — the reviewer must
// sign again. `reviewSignoff` is pure and storage-agnostic; it returns a record
// the app persists, and `signoffAuditEvent` renders the canonical event the app
// appends to its own tamper-evident audit chain (kept out of this package so
// each app supplies its own @elias/audit instance).

import { createHash } from 'node:crypto';

export type SignoffDecision = 'approved' | 'rejected';

/** The thing being signed off: a stable kind + id and its exact content. */
export interface ComplianceOutput {
  /** Output family, e.g. 'invoice', 'iolta.reconciliation', 'payroll.filing'. */
  kind: string;
  /** Stable identifier of this output within its kind. */
  id: string;
  /** The exact content the attorney reviewed; hashed canonically. */
  content: unknown;
}

export interface Signoff {
  outputKind: string;
  outputId: string;
  /** SHA-256 (hex) of the canonicalized output at sign-off time. */
  contentHash: string;
  decision: SignoffDecision;
  /** Principal username of the reviewing attorney. */
  attorney: string;
  /** ISO-8601 instant the sign-off was recorded. */
  signedAt: string;
  /** Optional reviewer note (required in practice for a rejection). */
  note?: string;
}

export interface ReviewInput {
  attorney: string;
  decision: SignoffDecision;
  note?: string;
  /** ISO-8601 instant; defaults to now. Injectable for deterministic tests. */
  signedAt?: string;
}

/**
 * Deterministic JSON: objects are re-emitted with keys sorted recursively so
 * two structurally equal outputs hash identically regardless of key order.
 * Arrays keep their order (order is meaningful). Non-plain values (numbers,
 * strings, booleans, null) serialize as-is.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 (hex) of an output's canonicalized {kind,id,content}. */
export function outputDigest(output: ComplianceOutput): string {
  return createHash('sha256')
    .update(canonicalize({ kind: output.kind, id: output.id, content: output.content }))
    .digest('hex');
}

/**
 * Record an attorney's decision on an output. Pure: no storage, no audit side
 * effect — the caller persists the returned record and appends
 * {@link signoffAuditEvent}. Throws if `attorney` is blank or a rejection
 * carries no note (a rejection with no reason is not reviewable).
 */
export function reviewSignoff(output: ComplianceOutput, input: ReviewInput): Signoff {
  const attorney = String(input.attorney || '').trim();
  if (!attorney) throw new Error('A reviewing attorney is required');
  const note = input.note != null ? String(input.note).trim() : '';
  if (input.decision === 'rejected' && !note) {
    throw new Error('A rejection must include a note explaining why');
  }
  const base: Signoff = {
    outputKind: output.kind,
    outputId: output.id,
    contentHash: outputDigest(output),
    decision: input.decision,
    attorney,
    signedAt: input.signedAt ?? new Date().toISOString(),
  };
  return note ? { ...base, note } : base;
}

/**
 * True if `signoff` still matches `output` byte-for-byte (recomputed hash).
 * False once the output has changed since it was signed — the guard that stops
 * an approval from covering later edits.
 */
export function verifySignoff(signoff: Signoff, output: ComplianceOutput): boolean {
  return (
    signoff.outputKind === output.kind &&
    signoff.outputId === output.id &&
    signoff.contentHash === outputDigest(output)
  );
}

/**
 * The canonical audit event for a sign-off, to be appended to the app's
 * tamper-evident chain. `actor` is included so the chain names the signer.
 */
export function signoffAuditEvent(signoff: Signoff): {
  type: 'compliance.signoff';
  payload: Record<string, unknown>;
} {
  return {
    type: 'compliance.signoff',
    payload: {
      outputKind: signoff.outputKind,
      outputId: signoff.outputId,
      contentHash: signoff.contentHash,
      decision: signoff.decision,
      actor: signoff.attorney,
      signedAt: signoff.signedAt,
      ...(signoff.note ? { note: signoff.note } : {}),
    },
  };
}
