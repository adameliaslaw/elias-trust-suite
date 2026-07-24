'use strict';
// Attorney sign-off gate for the billable CLIENT INVOICE (Phase 7 · #26).
//
// A LEDES invoice is a compliance output a licensed attorney is on the hook
// for. The structural gate (#17/#18) already ensures only reviewed, confirmed,
// unbilled entries reach a client — but nothing bound an attorney's signature
// to the EXACT assembled invoice. This wires @elias/auth's content-addressed
// sign-off into the billing act: an attorney signs off on the exact
// {entries, amounts, total} for one (client, matter), the sign-off binds to a
// SHA-256 of that content, and `report --format ledes --bill` refuses to stamp
// the mutually-exclusive billed marker unless a matching, APPROVED sign-off is
// on record. Editing the invoice after sign-off (adding an entry, repricing)
// changes the content hash, so a stale approval can never cover mutated
// numbers — the attorney must re-sign.
//
// The signed output is keyed on the suite's CANONICAL matter id
// (@elias/entities deriveEntityId('matter', client, matter)), so the same
// invoice is addressable across the suite without any app coordinating ids.
//
// This module is PURE over its inputs: it computes the output, produces the
// Signoff record and the audit event, and decides validity. Persistence and
// the audit append live in store.js (recordSignoff), so the tamper-evident
// chain stays the single writer.

const { reviewSignoff, verifySignoff, signoffAuditEvent } = require('@elias/auth');
const { deriveEntityId } = require('@elias/entities');
const { isClientBillable } = require('./client-billing');
const { sumCents } = require('./money');

const INVOICE_KIND = 'invoice';

/** The canonical matter id every app in the suite agrees on for client|matter. */
function matterEntityId(client, matter) {
  return deriveEntityId('matter', String(client), String(matter));
}

/**
 * The client-billable entries for exactly one (client, matter), in a stable
 * order (by id) so the assembled invoice — and therefore its content hash — is
 * independent of ledger ordering.
 */
function invoiceEntries(entries, client, matter) {
  return entries
    .filter(isClientBillable)
    .filter((e) => e.client === client && e.matter === matter)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Assemble the exact ComplianceOutput under review for one (client, matter):
 * each billable entry reduced to its compliance-relevant leaves plus the
 * integer-cents invoice total. Pure + deterministic — the SAME entries always
 * produce the SAME content, hence the SAME content hash (canonicalize sorts
 * object keys; we sort the lines by id so array order is stable too). Amounts
 * are exact decimal strings so a float can never perturb the hash.
 */
function invoiceOutput(entries, client, matter) {
  const list = invoiceEntries(entries, client, matter);
  let totalCents = 0;
  const lines = list.map((e) => {
    totalCents += sumCents(e.amount, e.aiCost || 0);
    return {
      id: e.id,
      date: e.date,
      hours: String(e.hours),
      rate: (e.rate || 0).toFixed(2),
      amount: (e.amount || 0).toFixed(2),
      aiCost: (e.aiCost || 0).toFixed(2),
      code: e.code || '',
      description: e.description || '',
    };
  });
  return {
    kind: INVOICE_KIND,
    id: matterEntityId(client, matter),
    content: {
      client: String(client),
      matter: String(matter),
      entryCount: lines.length,
      totalCents,
      lines,
    },
  };
}

/**
 * Record an attorney's decision on the CURRENT assembled invoice for
 * (client, matter). Returns the ComplianceOutput, the Signoff record to
 * persist, and the audit event to append. Throws (via reviewSignoff) if the
 * attorney is blank or a rejection carries no note.
 */
function signInvoice(entries, client, matter, { attorney, decision = 'approved', note, signedAt } = {}) {
  const output = invoiceOutput(entries, client, matter);
  const input = { attorney, decision };
  if (note != null && String(note).trim()) input.note = note;
  if (signedAt) input.signedAt = signedAt;
  const signoff = reviewSignoff(output, input);
  return { output, signoff, event: signoffAuditEvent(signoff) };
}

/**
 * True when `signoff` is a valid, APPROVED cover for `output`: present, an
 * approval (not a rejection), and still matching the content (verifySignoff
 * recomputes the hash, so a changed invoice fails here).
 */
function invoiceSignoffValid(signoff, output) {
  return !!signoff && signoff.decision === 'approved' && verifySignoff(signoff, output);
}

/**
 * The billing gate: throw unless a matching, approved sign-off covers the exact
 * current invoice for (client, matter). Called at the `--bill` choke point
 * before any entry is stamped billed, so an unsigned, rejected, or stale-signed
 * invoice can never be issued. Returns the current output on success.
 */
function assertInvoiceSignedOff(entries, client, matter, signoff) {
  const output = invoiceOutput(entries, client, matter);
  if (!signoff) {
    throw new Error(
      `No attorney sign-off on record for ${client} / ${matter} (${output.id}); ` +
        'run `billable signoff <client> <matter> --attorney "..."` before billing.',
    );
  }
  if (signoff.decision !== 'approved') {
    throw new Error(
      `Invoice for ${client} / ${matter} was signed off as ${signoff.decision}, not approved; it cannot be billed.`,
    );
  }
  if (!verifySignoff(signoff, output)) {
    throw new Error(
      `The sign-off for ${client} / ${matter} does not match the current invoice ` +
        '(it changed since sign-off); re-sign before billing.',
    );
  }
  return output;
}

module.exports = {
  INVOICE_KIND,
  matterEntityId,
  invoiceEntries,
  invoiceOutput,
  signInvoice,
  invoiceSignoffValid,
  assertInvoiceSignedOff,
};
