'use strict';
// Issue #18 stopgap — Matterproof must not emit CLIENT-FACING BILLS yet.
//
// Two unresolved defects make outbound billing unsafe until Phase 4 (#23):
//   #17 — browser/hook capture invents attorney time (~0.1h/prompt); the
//         numbers are machine-generated, not confirmed human minutes.
//   #18 — the review gate is bypassable, so unreviewed (or duplicate) time
//         can reach an invoice / payment link / accounting push.
//
// Until reviewed-only, confirmed-minutes billing is enforced, every path that
// produces something a CLIENT sees or pays — LEDES/HTML invoices, LawPay
// payment links, Clio pushes — is refused. Internal, non-client outputs
// (text/csv timesheets, unit economics, request listing) are NOT gated.
//
// The switch is a deploy-time env var, deliberately NOT a dashboard-toggleable
// config field: a containment stopgap must not be clickable away by anyone
// with web-UI access. An informed operator can opt in with
// BILLABLE_ALLOW_CLIENT_EXPORTS=1.

/** Read at call time so tests (and operators) can toggle without reload. */
function clientExportsAllowed() {
  return process.env.BILLABLE_ALLOW_CLIENT_EXPORTS === '1';
}

const DISABLED_MESSAGE =
  'Client-facing billing is disabled pending review enforcement (issue #18). ' +
  'Matterproof-captured time is not yet human-confirmed (#17) and the review gate ' +
  'is bypassable, so bills must not reach clients until Phase 4 (#23). Internal ' +
  'reports (text, csv, economics) are unaffected. To override for testing, set ' +
  'BILLABLE_ALLOW_CLIENT_EXPORTS=1.';

module.exports = { clientExportsAllowed, DISABLED_MESSAGE };
