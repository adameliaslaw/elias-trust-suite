'use strict';
// Structural billing gate (Phase 4, #18). A time entry may reach a CLIENT only
// when it is:
//   (a) attorney-reviewed,
//   (b) built on attorney-CONFIRMED human minutes — inferred AI runtime is
//       never billable on its own (#17),
//   (c) not written off, and
//   (d) not already billed to some destination.
//
// Billing is MUTUALLY EXCLUSIVE across destinations. Once an entry is billed
// anywhere — a LawPay payment link, a Clio push, a LEDES invoice — every other
// destination treats it as already-billed, so a second export of the same
// entry is a no-op, never a double bill.
//
// This replaces the Phase 1 stopgap (BILLABLE_ALLOW_CLIENT_EXPORTS): the gate
// is no longer a deploy-time env switch that an operator could flip on while
// the underlying data was still unsafe — it is a property of each entry.

// The single billed marker. New writes use `billed` = {destination, reference,
// at}; older ledgers stamped destination-specific overrides (lawpayRef /
// clioId), which still count as billed so historical data keeps its
// idempotency and mutual-exclusivity.
function billedMarker(override) {
  if (!override) return null;
  if (override.billed && override.billed.destination) return override.billed;
  if (override.lawpayRef) return { destination: 'lawpay', reference: String(override.lawpayRef) };
  if (override.clioId != null && override.clioId !== '') {
    return { destination: 'clio', reference: String(override.clioId) };
  }
  return null;
}

function isBilled(override) {
  return billedMarker(override) != null;
}

// Split override-applied entries into those ready to bill a client and a
// breakdown of why the rest were skipped. Operates purely on the entry fields
// stamped by applyOverride (reviewed / confirmed / writeOff / hours / billed),
// so every client-facing path classifies identically.
function classifyForClient(entries) {
  const ready = [];
  const skipped = { unreviewed: 0, unconfirmed: 0, writeOff: 0, alreadyBilled: 0 };
  for (const e of entries) {
    if (e.billed) skipped.alreadyBilled++;
    else if (e.writeOff) skipped.writeOff++;
    else if (!e.reviewed) skipped.unreviewed++;
    else if (!e.confirmed || !(e.hours > 0)) skipped.unconfirmed++;
    else ready.push(e);
  }
  return { ready, skipped };
}

// True when an entry is safe to place in front of a client.
function isClientBillable(e) {
  return !!e && !e.billed && !e.writeOff && e.reviewed && e.confirmed && e.hours > 0;
}

// Freeze the rate onto an override the first time an entry is reviewed, so a
// later edit to the rate table never reprices already-reviewed work. Pure so
// every write path (server, CLI) snapshots identically; snapshots once and
// never overwrites a prior snapshot. Returns the patch to persist.
function reviewRateSnapshot(patch, config, existingOverride) {
  if (patch && patch.reviewed && (!existingOverride || existingOverride.rateSnapshot == null)) {
    return { ...patch, rateSnapshot: (config && config.rate) || 0 };
  }
  return patch;
}

module.exports = { billedMarker, isBilled, classifyForClient, isClientBillable, reviewRateSnapshot };
