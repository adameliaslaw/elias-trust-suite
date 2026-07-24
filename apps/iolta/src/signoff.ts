/**
 * Attorney sign-off on a finalized IOLTA reconciliation packet (Phase 7 · #26).
 *
 * The same uniform, audited attorney sign-off billable puts on a client invoice,
 * here on the trust-account reconciliation packet. @elias/auth defines the shape
 * (`Signoff`) and the content-addressing rule — a sign-off binds to the SHA-256
 * of the canonicalized `{kind, id, content}`, so editing the reviewed output
 * after sign-off invalidates it and a stale approval can never silently cover
 * mutated numbers.
 *
 * WHY THIS FILE INSTEAD OF IMPORTING @elias/auth: `@elias/auth` hashes with
 * `node:crypto`, which a Vite BROWSER bundle can't load — and the finalize path
 * runs in the browser (App.tsx → Firestore). So this module reproduces the SAME
 * digest browser-safe, using `@elias/audit/core`'s portable `sha256Hex` +
 * `stableStringify` (already this app's packet-hashing primitives). Those two
 * serializers are byte-identical to `@elias/auth`'s `canonicalize` for JSON-safe
 * input, so the digests match exactly. `test/signoff.test.ts` PROVES it against
 * the real `@elias/auth` in both directions (`verifySignoff` accepts our record;
 * we accept its record), pinning the two in lock-step — the decoupled-package
 * pattern the suite uses (membership.ts ↔ @elias/auth ROLES, review.ts ↔
 * @elias/audit). Only the `Signoff`/`ComplianceOutput` TYPES are imported from
 * @elias/auth (erased at build time — no `node:crypto` reaches the browser).
 *
 * The packet is ALREADY content-hashed (`FinalizedPacket.contentHash`), so a
 * sign-off keyed on that hash transitively covers every reconciled number, and
 * any amendment (new version → new contentHash) needs a fresh sign-off.
 */
import { stableStringify, sha256Hex } from '@elias/audit/core';
import type { ComplianceSignoffPayload } from '@elias/audit/core';
import type { Signoff, ComplianceOutput, SignoffDecision } from '@elias/auth';
import type { FinalizedPacket } from './lifecycle';

/** The @elias/auth output family for a trust-reconciliation sign-off. */
export const RECON_SIGNOFF_KIND = 'iolta.reconciliation';

export interface ReviewPacketInput {
  /** Reviewing attorney principal (email/uid). */
  attorney: string;
  /** Defaults to 'approved'. A rejection must carry a note. */
  decision?: SignoffDecision;
  note?: string;
  /** ISO-8601 instant; defaults to now. Pass the packet's finalizedAt for determinism. */
  signedAt?: string;
}

/**
 * The @elias/auth `ComplianceOutput` under review for a finalized packet: keyed
 * on the packet's stable doc id (account/month/version), content = the sealed
 * `contentHash` plus the account/month/version, authority, and attestation.
 * Because the packet is already content-hashed, binding here is enough to make
 * the sign-off cover the whole reconciliation.
 */
export function packetOutput(packet: FinalizedPacket): ComplianceOutput {
  return {
    kind: RECON_SIGNOFF_KIND,
    id: `${packet.accountId}__${packet.month}__v${packet.version}`,
    content: {
      accountId: packet.accountId,
      month: packet.month,
      version: packet.version,
      authority: packet.authority,
      contentHash: packet.contentHash,
      attestation: packet.attestation,
    },
  };
}

/**
 * SHA-256 (hex) of the canonicalized `{kind, id, content}` — byte-identical to
 * `@elias/auth`'s `outputDigest`, computed browser-safe via `@elias/audit/core`.
 */
export function packetOutputDigest(output: ComplianceOutput): string {
  return sha256Hex(stableStringify({ kind: output.kind, id: output.id, content: output.content }));
}

/**
 * Record an attorney's sign-off on a finalized packet. Reproduces
 * `@elias/auth.reviewSignoff` exactly (same validation, same fields), browser-
 * safe. Throws if the attorney is blank or a rejection carries no note.
 */
export function signPacket(packet: FinalizedPacket, input: ReviewPacketInput): Signoff {
  const attorney = String(input.attorney || '').trim();
  if (!attorney) throw new Error('A reviewing attorney is required');
  const decision: SignoffDecision = input.decision ?? 'approved';
  const note = input.note != null ? String(input.note).trim() : '';
  if (decision === 'rejected' && !note) {
    throw new Error('A rejection must include a note explaining why');
  }
  const output = packetOutput(packet);
  const base: Signoff = {
    outputKind: output.kind,
    outputId: output.id,
    contentHash: packetOutputDigest(output),
    decision,
    attorney,
    signedAt: input.signedAt ?? new Date().toISOString(),
  };
  return note ? { ...base, note } : base;
}

/**
 * True if `signoff` still matches `packet` (recomputed hash) — i.e. the packet
 * has not changed since it was signed. The content-addressing guard.
 */
export function verifyPacketSignoff(signoff: Signoff, packet: FinalizedPacket): boolean {
  const output = packetOutput(packet);
  return (
    signoff.outputKind === output.kind &&
    signoff.outputId === output.id &&
    signoff.contentHash === packetOutputDigest(output)
  );
}

/**
 * The issuance gate: throw unless a present, APPROVED, content-matching sign-off
 * covers `packet`. Called before a finalized packet is retained / rendered /
 * exported as a compliance deliverable, so an unsigned, rejected, or
 * stale-signed (tampered/amended) packet can never be issued.
 */
export function assertPacketSignedOff(packet: FinalizedPacket, signoff: Signoff | null | undefined): Signoff {
  const output = packetOutput(packet);
  if (!signoff) {
    throw new Error(
      `No attorney sign-off on record for reconciliation packet ${output.id}; ` +
        'the packet cannot be issued without one.',
    );
  }
  if (signoff.decision !== 'approved') {
    throw new Error(
      `Reconciliation packet ${output.id} was signed off as ${signoff.decision}, not approved; it cannot be issued.`,
    );
  }
  if (!verifyPacketSignoff(signoff, packet)) {
    throw new Error(
      `The sign-off for reconciliation packet ${output.id} does not match its current content ` +
        '(it changed since sign-off); re-sign before issuing.',
    );
  }
  return signoff;
}

/**
 * The canonical `compliance.signoff` audit event for a packet sign-off, to be
 * appended to iolta's tamper-evident chain. Mirrors `@elias/auth`'s
 * `signoffAuditEvent` and is typed against the shared @elias/audit vocabulary.
 */
export function packetSignoffAuditEvent(signoff: Signoff): {
  type: 'compliance.signoff';
  payload: ComplianceSignoffPayload;
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
