# Status — Elias Trust Suite

> **Living handoff. A new session should read this file first,** then
> [HOMEWORK.md](HOMEWORK.md) for exactly where to start, then the epic issue for the phase.
> Canonical plan: [CONSOLIDATION_PLAN.md](CONSOLIDATION_PLAN.md) · Findings narrative:
> [EVALUATION.md](EVALUATION.md) · Backlog: GitHub Issues **#11–#27**.
> Last updated: 2026-07-22 — assessment reconciled with a second independent evaluation; backlog filed.

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
2026-07-22:
- ✅ `npm ci` clean (0 vulns); typecheck clean; suites pass **when green**.
- ⚠️ **CI is not deterministically green** — billable `test/audit.test.js:127` is flaky (asserts
  `"300"` absent; collides with SHA-256 hex) → random red ~1/8 runs. (#20)
- ❌ **IOLTA PDF import throws** on every upload (`pdf-parse` export shape). (#12, verified)
- ❌ **IOLTA reconciliation is partly circular** — legs share one source; "correct math" ≠ correct
  model. (#11)
- ❌ **A month with no statement balance can display "Reconciled."** (#13, verified)
- ❌ **Audit verify ignores the head it maintains**; lost localStorage queue drops entries silently.
  (#16, verified)
- ❌ **Multi-user/month collisions**; trust account hardcoded `iolta-trust`. (#15, verified)
- ❌ **Books stores Plaid/ACH/employee-bank secrets in plaintext**, backups included. (#24)
- ❌ **Matterproof invents attorney time** (~0.1h/prompt) and its **review gate is bypassable**.
  (#17, #18)

The tests are valuable but largely do not cover these paths.

## Phase tracker

| Phase | Epic | Status |
|---|---|---|
| 0 — Define the product | #19 | ⬜ Not started (owner decisions) |
| 1 — Contain risk + regression tests | #20 | ⬜ Not started ← **START HERE (code)** |
| 2 — Rebuild IOLTA accounting model | #21 | ⬜ Blocked on 0/1 |
| 3 — Reconciliation lifecycle + retention | #22 | ⬜ Blocked on 2 |
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

- Product-definition decisions (#19) gate Phases 2, 6, 7.
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
- iolta `start: node server.ts` does not run under the stated Node 20 min; only `dev` (tsx) works.
- Test runs may `chmod +x` `apps/billable/bin/billable.js` (mode-only diff) — discard it.
