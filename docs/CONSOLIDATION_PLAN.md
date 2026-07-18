# Elias Trust Suite — Consolidation Plan

> **📍 Live progress tracker: see [docs/STATUS.md](STATUS.md)** (updated after every migration)

## Progress (2026-07-19)
- [x] Step 1: Scaffolds + packages/money + packages/audit (PR #1, 37 tests green)
- [x] Step 2: apps/books ← quickbucks (PR #2 — byte-exact verified, **372/372 tests green**, P&L netProfit bug found & fixed)
- [ ] Step 3: apps/iolta ← IOLTA-Reconciliation ← **NEXT**
- [ ] Step 4: apps/billable ← Billable.ai
- [ ] Step 5: apps/payroll ← Payroll
- [ ] Step 6: apps/bills ← plaid-bill-tracker

## Goal
One product for NJ attorney trust accounting + practice finance: IOLTA three-way reconciliation (Rule 1:21-6), payroll, bookkeeping, bill tracking, time/billing.

## Sources
| Source repo | Becomes | Notes |
|---|---|---|
| IOLTA-Reconciliation | apps/iolta | Core product. Needs recon-math rewrite (deposits-in-transit, book-balance leg, retained records) before migration. |
| Payroll | apps/payroll | Flask+SQLite; keep Python app, wrap behind shared audit/money conventions via a thin TS service boundary later. |
| quickbucks | apps/books | Best zero-dep engineering of the five; its session/auth patterns become packages/auth reference. |
| plaid-bill-tracker | apps/bills | Needs auth + secret scrub before any migration (critical). Plaid integration extracted to packages/plaid. |
| Billable.ai | apps/billable | Time tracking + LawPay; becomes the invoicing arm. Fix localhost CSRF first. |

## Target architecture
- npm workspaces; apps/ deployables, packages/ shared code.
- packages/money is mandatory for every money touch: integer cents, exact equality, no float64 anywhere (kills IOLTA #10, Payroll float reports, Billable NaN bugs).
- packages/audit: append-only hash-chained log for reconciliations, payroll payments, invoice lifecycle — compliance backbone for Rule 1:21-6 retention.
- packages/plaid: encrypted token storage (fixes bill-tracker #3 + Payroll plaintext-cred class), Idempotency-Key on all money movement (fixes Payroll #9).
- packages/rules: owner-scoped Firestore rules as the single source (fixes IOLTA #1).
- CI gate on every PR from day one (no source repo had one; Payroll auto-deploys without one).

## Migration order
1. Scaffolds + packages/money + packages/audit — this PR wave.
2. apps/books (quickbucks — cleanest, zero data deps).
3. apps/iolta (after its critical fixes PR merges: rules + recon math).
4. apps/billable (after localhost CSRF fix PR merges).
5. apps/payroll (largest; after encryption + idempotency PR merges).
6. apps/bills (last; needs the deepest security rework first).

## Pre-migration gates (per app)
- Critical/high security PR merged in source repo.
- Secrets rotated (owner: Plaid client_id/secret; purge git history).
- packages/money + packages/audit adopted for new/changed code.

## Post-migration
- Source repos archived with README pointers.
- Sellable surface: IOLTA-as-SaaS for NJ solos (three-way recon + retained records + audit trail) with payroll/billing add-ons.
