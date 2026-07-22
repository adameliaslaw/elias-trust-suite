# Elias Trust Suite — Consolidation & Remediation Plan

> **Canonical strategic plan.** For live status read [STATUS.md](STATUS.md); for the next
> session's starting point read [HOMEWORK.md](HOMEWORK.md); for the full findings narrative read
> [EVALUATION.md](EVALUATION.md). The tracked backlog lives in GitHub Issues **#11–#27**.
> Last reconciled with reality: 2026-07-22 (two independent evaluations merged — see EVALUATION.md).

## Where this stands, honestly

This repository is **worth continuing, but it is not yet one product.** It is three promising
applications sharing two genuinely good infrastructure libraries:

- **Books** (← quickbucks): a strong internal financial operating system.
- **IOLTA** (← IOLTA-Reconciliation): an appealing but incomplete trust-reconciliation prototype
  with foundational accounting-model flaws.
- **Matterproof** (← Billable.ai, pkg `@elias/billable`): a novel AI-work-provenance concept with
  an unsafe billing-time model.
- **`@elias/money` + `@elias/audit`**: thoughtfully implemented and well-tested. They become market
  value only when connected to finalization, retention, reporting, and recovery workflows.

The earlier plan (below, superseded) treated this as a migration exercise. The real work is
**defining the product, rebuilding IOLTA's accounting model, and making the compliance and billing
guarantees true** — then integrating the three apps under one identity.

## The moat (what to build toward)

Three-way reconciliation by itself is **not** unique — Clio Accounting already offers trust
reconciliation and historical reports. The defensible positions are:

1. **Continuous OAE audit-readiness** — always prepared for an NJ random audit: independent
   bank/book/client streams, an attested monthly lock, a reproducible retained packet.
2. **Proof + supervision of AI work** (Matterproof) — provenance and attorney review of
   AI-assisted work tied to LEDES/Clio, *not* inferred attorney time.
3. **Primary-source-anchored, versioned rule engine** — every tax/compliance constant cited to its
   N.J.S.A./N.J.A.C./IRS source and parameterized by effective date, so historical and amended
   periods compute correctly (`packages/rules`, Phase 6). This is the estate suite's proven moat.

## Phased plan (each phase = one fresh session; see the linked epic)

| Phase | Epic | Objective | Depends on |
|---|---|---|---|
| 0 | **#19** | Define the product (owner OS vs. commercial; hosting; system of record; pause Payroll/Bills) | — |
| 1 | **#20** | Contain risk + regression tests (PDF import, false-reconciled, flaky CI, disable unsafe exports) | — |
| 2 | **#21** | Rebuild IOLTA's accounting model (independent streams; firms/accounts; atomic imports) | 0, 1 |
| 3 | **#22** | Reconciliation lifecycle + 7-year retention (draft→attest→finalize→lock) | 2 |
| 4 | **#23** | Redesign Matterproof billing (confirmed human minutes; reviewed-only; idempotent) | 1 |
| 5 | **#24** | Data + audit hardening across apps (fail-closed verify; encrypt secrets; idempotency) | 2–4 |
| 6 | **#25** | Books role + correctness + `packages/rules` (versioned, cited) | 0 |
| 7 | **#26** | Suite integration + shared identity + `packages/auth` | 2–6 |
| 8 | **#27** | Release engineering + "just clone and run" | parallel; finalize last |

### Critical (release-blocking) defects — tracked individually

| # | App | Defect | Phase |
|---|---|---|---|
| **#11** | iolta | Reconciliation streams not independent (circular) | 2 |
| **#12** | iolta | PDF statement import throws (`pdf-parse` export) — *verified* | 1 |
| **#13** | iolta | Missing balance → false "Reconciled" — *verified* | 1/3 |
| **#14** | iolta | No reconciliation close/attest/lock; mutable history | 3 |
| **#15** | iolta | Multi-user/month collisions; hardcoded account — *verified* | 2 |
| **#16** | iolta | Audit completeness overstated (verify ignores head) — *verified* | 5 |
| **#17** | billable | Browser capture invents attorney time (~0.1h/prompt) | 4 |
| **#18** | billable | Review gate bypassable; unreviewed/duplicate billing | 4 |

## Pre-migration gates (Payroll, plaid-bill-tracker) — PAUSED per Phase 0

Do **not** migrate the remaining two source repos until the Books/Matterproof timekeeping overlap is
resolved and Phase 0 decides the system of record. When resumed, each still requires: source
security PR merged; secrets rotated + git history purged (Plaid); `packages/money` + `packages/audit`
adopted for new/changed code.

## What is already good (do not regress)

Exact-cent money; deterministic audit serialization with strong middle-chain tamper checks;
substantial Books domain logic (payroll/tax/NACHA/Schedule Elias) with extensive tests; Books &
Matterproof auth/rate-limiting/origin/server hardening; IOLTA verifies Firebase tokens server-side.
`npm ci` succeeds; production frontend build/typecheck/lint pass. Tests are valuable but **largely
miss** the critical IOLTA UI/server/reconciliation and Matterproof billing failures above.

---

<details>
<summary>Superseded original plan (2026-07-19) — kept for provenance</summary>

The original consolidation plan framed this as migrating 5 repos (IOLTA-Reconciliation, Payroll,
quickbucks, plaid-bill-tracker, Billable.ai) into `apps/*` behind shared `packages/*`, adopting
`money`/`audit` and adding CI. That migration wave completed for 3 of 5 apps and 2 of 5 packages,
which is real progress — but it validated byte-exact imports and money/audit wiring without
falsifying the product-level claims (reconciliation correctness, audit completeness, billing
honesty). The merged 2026-07-22 assessment supersedes it.
</details>
