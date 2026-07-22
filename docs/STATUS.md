# Status — Elias Trust Suite

> **Living handoff. A new session should read this file first,** then
> [HOMEWORK.md](HOMEWORK.md) for exactly where to start, then the epic issue for the phase.
> Canonical plan: [CONSOLIDATION_PLAN.md](CONSOLIDATION_PLAN.md) · Findings narrative:
> [EVALUATION.md](EVALUATION.md) · Backlog: GitHub Issues **#11–#27**.
> Last updated: 2026-07-22 — Phase 2 (#21) complete (PR open): IOLTA rebuilt on independent bank/book/
> statement/match streams (#11), a firms→accounts multi-tenant hierarchy with account-scoped doc IDs (#15),
> and atomic + idempotent imports — all with reproducing tests. Phase 1 (#20) landed before it.

## Product

Trust / finance / accounting suite for a solo NJ law practice. npm workspaces: `apps/*`,
`packages/*`. Node 20+. **Current stage: pre-product** — three apps + two shared libs, not yet one
integrated product.

## Maturity (honest)

| Surface | Functionality | Differentiation | Ease of use | Value today |
|---|---|---|---|---|
| **Books** | Internal beta; broad, useful | High for Schedule Elias; ordinary elsewhere | Moderate | High for owner; moderate externally |
| **IOLTA** | Alpha; foundational reconciliation flaws | Moderate now; high as NJ audit-readiness product | Approachable UI, incomplete workflow | High potential, unreliable today |
| **Matterproof** | Experimental alpha | Very high conceptually | Developer-oriented | High potential; must not create client bills yet |
| **Suite** | Pre-product | Strong collection of ideas | Low — three setups/identities | High internal potential, low current sellability |

## Reality check on prior claims

The previous STATUS asserted "480 checks green" and a sound audit/reconciliation story. Verified
2026-07-22; Phase 1 (#20) has since fixed the items marked **FIXED** below:
- ✅ `npm ci` clean (0 vulns); typecheck clean; suites pass.
- ✅ **FIXED (#20)** — billable `test/audit.test.js:127` flake removed (structural leaf-value check,
  not a `"300"` substring). Verified green 10/10 runs → **CI is now deterministic.**
- ✅ **FIXED (#12)** — IOLTA PDF import uses the `pdf-parse` v2 `PDFParse` class; covered by a
  real-PDF fixture test.
- ✅ **FIXED (#11)** — IOLTA reconciliation now reconciles four independent streams (bank / book /
  statement / match); a bank line never booked surfaces as a discrepancy. Reproducing test added.
- ✅ **FIXED (#13)** — a month with no statement balance is now `incomplete`, never "Reconciled";
  only a genuinely reconciled month seals `reconciliation.completed`. Reproducing test added.
- ❌ **Audit verify ignores the head it maintains**; lost localStorage queue drops entries silently.
  (#16, verified — Phase 5)
- ✅ **FIXED (#15)** — firms→memberships→trust-accounts hierarchy; period doc IDs are account/uid-scoped
  (`{accountId}__{month}`), no hardcoded `iolta-trust`. Two firms/accounts coexist without collision
  (reproducing test). Rules written; deployment deferred (Phase 8 / #27).
- ❌ **Books stores Plaid/ACH/employee-bank secrets in plaintext**, backups included. (#24 — Phase 5)
- ⚠️ **Matterproof invents attorney time** (~0.1h/prompt) and its **review gate is bypassable**
  (#17, #18 — Phase 4). **Contained (#20):** client-facing exports (LEDES/HTML/LawPay/Clio) are now
  disabled by default; docs no longer claim actual-time billing.

The tests are valuable but largely do not cover these paths.

## Phase tracker

| Phase | Epic | Status |
|---|---|---|
| 0 — Define the product | #19 | ⬜ Not started (owner decisions; rewritten as a decision memo) |
| 1 — Contain risk + regression tests | #20 | ✅ Done — CI deterministic |
| 2 — Rebuild IOLTA accounting model | #21 | ✅ Done — PR open (#11, #15 closed) |
| 3 — Reconciliation lifecycle + retention | #22 | ⬜ Next ← **START HERE (code)** (unblocked by 2) |
| 4 — Redesign Matterproof billing | #23 | ⬜ Blocked on 1 |
| 5 — Data + audit hardening | #24 | ⬜ Blocked on 2–4 |
| 6 — Books role + `packages/rules` | #25 | ⬜ Blocked on 0 |
| 7 — Suite integration + `packages/auth` | #26 | ⬜ Blocked on 2–6 |
| 8 — Release engineering | #27 | ⬜ Parallelizable; finalize last |

## Done (real, keep)

- Repo scaffold (workspaces, tsconfig.base.json, CI on push/PR, repo public).
- `packages/money` (`@elias/money`) — exact bigint-cents; no float; no equality epsilon. 22 tests.
- `packages/audit` (`@elias/audit`) — hash-chained JSONL, pure-TS SHA-256, verify-on-open. 16 tests.
- `apps/books` ← quickbucks; `apps/iolta` ← IOLTA-Reconciliation; `apps/billable` ← Billable.ai —
  all migrated, money + audit wired at the calc layer.

## Blocked on owner

- Product-definition decisions (#19) gate Phases 6, 7. **Decision 3 (system of record) is still
  unratified**; Phase 2 proceeded on the decision-safe structure (single-firm/multi-account now,
  modeled multi-tenant per Decision 1's recommended default). Ratifying 3 later needs no schema change;
  overriding to "suite is system of record for invoices/payments" would add thin invoice/payment objects.
- iolta `firebase deploy --only firestore:rules` (rules still undeployed). (#27)
- Payroll: set `PAYROLL_ENCRYPTION_KEY`. plaid-bill-tracker: rotate Plaid creds + purge git history.
  Both migrations **paused** pending #19.

## Not yet built (planned packages)

`packages/rules` (versioned, cited — Phase 6 / #25) · `packages/auth` (Phase 7 / #26) ·
`packages/plaid` (deferred with bill-tracker migration).

## Verification environment notes

- `npm ci` works cleanly here (no puppeteer/Chromium trap). Lockfile is clean
  (`grep -c msh.team package-lock.json` = 0).
- iolta pulls `xlsx` from a CDN tarball (fragile — Phase 8 / #27).
- iolta `start` now runs `NODE_ENV=production tsx server.ts` (with a `prestart` build) — `node
  server.ts` couldn't run TypeScript under Node 20. Full deploy config (PORT/env loading) is Phase 8.
- Matterproof client-facing exports are gated behind `BILLABLE_ALLOW_CLIENT_EXPORTS=1` (#18 stopgap);
  the billable test suite sets it so capability tests still run.
- Test runs may `chmod +x` `apps/billable/bin/billable.js` (mode-only diff) — discard it.
