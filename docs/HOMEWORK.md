# Homework — session-to-session handoff

> **Purpose.** Each phase of this plan runs in a **fresh session**. This file is the baton: it tells
> the next session exactly where to start, so it can begin cold with zero re-discovery. **The last
> thing every session does is rewrite this file for the next one.**

## How to use this file (read in this order every session)

1. Read [STATUS.md](STATUS.md) — current stage + phase tracker + reality check.
2. Read **this file's "Current handoff"** below — your concrete starting point.
3. Open the phase epic issue it points to; work its checklist.
4. Follow the branch/commit/PR conventions below.
5. **Before you end:** run the end-of-session ritual and rewrite the "Current handoff" for the next session.

## Conventions (stable across sessions)

- **Canonical source of truth:** GitHub Issues **#11–#27** + these `docs/`. Update the issue
  checklists as you complete items (check the box, add the commit SHA).
- **Branch per phase:** `claude/phaseN-<short-slug>` off `main`.
- **One PR per phase** (or per critical if large); reference the issue (`Fixes #NN`). Ready for
  review, not draft. Keep CI green — Phase 1 makes CI trustworthy first for exactly this reason.
- **Auto-merge convention** ([CONTRIBUTING.md](../CONTRIBUTING.md)): right after opening the PR,
  enable **squash auto-merge** (`enable_pr_auto_merge`, `mergeMethod: SQUASH`) so it lands on `main`
  when the `test` check passes — no waiting on the owner. Exception: if the change's correctness
  isn't covered by CI (migrations, security, money-at-rest, trust-fund logic), leave auto-merge off
  and request human review instead. Never weaken a test to go green.
- **Tests are the contract:** add a reproducing test *before* fixing each critical; never delete a
  test to make CI pass.
- **Money & audit:** all money through `@elias/money`; all compliance events through `@elias/audit`.
- **Do not regress** the "already good" list in CONSOLIDATION_PLAN.md.

## End-of-session ritual (do this before ending, every time)

1. Update the phase tracker in STATUS.md (⬜→🟨 in progress / ✅ done) and the epic issue checkboxes.
2. Note anything discovered that isn't yet an issue — file it or add it to the epic.
3. Rewrite the **"Current handoff"** section below: what you finished, what's next, exact files/refs,
   and any gotcha the next session needs.
4. Commit docs + push. If the phase PR is open, make sure STATUS/HOMEWORK reflect its state.

---

## Current handoff

**Session that just ran:** Phase 2 (epic #21) — rebuilt IOLTA's accounting model. All #21 checklist
items done; one PR opened off `main` (branch `claude/phase2-iolta-model-xygajy`). Criticals #11 and #15
closed by the PR.

**Decision context:** #19 **Decision 3 (system of record) is still unratified** (no sign-off comment,
box unchecked). Per plan, Phase 2 built the **decision-safe** structure: single-firm/multi-account now,
modeled so multi-tenant SaaS stays open (Decision 1's recommended default). No invoice/payment
"system of record" was assumed. Ratifying 3 later needs no schema change.

**What landed (with commit SHAs):**
- `c2c1c18` — the whole Phase 2 rebuild:
  - **#11 independent streams** — `src/model.ts` defines four distinct stream types (BankTransaction /
    BookTransaction / StatementPeriod / MatchRecord). `src/reconciliation.ts` gains `reconcileStreams()`:
    the three legs come from different streams; outstanding-vs-cleared is decided by the MATCH stream, and
    a **bank line never booked surfaces as a discrepancy** (`unrecordedBankItems`) — impossible before.
    Legacy `computeReconciliations()` kept as a thin adapter so Phase 1's tests stay green.
  - **#15 tenancy** — firms→memberships→trust-accounts; period doc IDs are account/uid-scoped
    (`{accountId}__{month}` via `periodDocId`), no hardcoded `iolta-trust`. `firestore.rules` scoped +
    firms/memberships/trustAccounts validators. **Rules still UNDEPLOYED** (Phase 8 / #27).
  - **Idempotent imports** — `src/imports.ts`: deterministic CSV/sheet parse *before* the AI fallback;
    fingerprint dedup (re-import = no-op); case-insensitive client dedup; type/sign-contradiction rejection.
  - **Ledger fixes** — `src/ledger.ts`: filtered running balance carries the opening balance forward
    (no restart-at-zero); chronological overdraw validation with provenance.
  - `App.tsx` wired to all of the above; `packages/audit` `TrustImportConfirmedPayload` gained optional
    `duplicatesSkipped`/`rejected` counts.
- New tests: `test/model.test.ts`, `test/imports.test.ts`, `test/ledger.test.ts`, plus #11 cases appended
  to `test/reconciliation.test.ts`. All wired into the iolta `test` script.

**State of the repo:** all suites green (`npm test` exit 0 across every workspace); typecheck clean.
Backlog: #11/#15 closed by this PR; #12/#13/#20 closed in Phase 1. #19 unratified (decision memo).

**Next session → Phase 3 (epic #22): reconciliation lifecycle + 7-year retention** (draft→attest→
finalize→lock; immutable retained packet). Now unblocked by Phase 2. Start points:
1. **#14** — no reconciliation close/attest/lock; history is mutable. Build the lifecycle state machine
   on top of the new streams: a finalized month freezes its bank/book/statement/match inputs + the
   computed legs into a retained, hash-chained packet (use `@elias/audit`).
2. 7-year retention of the finalized packet; a locked month rejects further edits to its inputs.
3. Consider persisting the four streams as real Firestore collections (today `reconciliation.ts` has a
   legacy adapter deriving bank/match from each book row's `clearDate`; the independent-stream core is
   ready for genuine bank-statement-line ingestion whenever the UI grows a bank-import surface).

**Gotchas (carried forward + new):**
- `npm ci` then `npm run build --workspace @elias/money --workspace @elias/audit` before app tests
  (apps depend on built `dist/`).
- **Do NOT `git checkout apps/billable/bin/billable.js` to drop a `chmod +x` mode diff** — it also reverts
  content. Use `chmod 644` / `git update-index --chmod=-x`. HEAD mode is `100644`. (Hit again this session;
  `chmod 644` cleared it.)
- Lockfile must keep `grep -c msh.team package-lock.json` = 0.
- iolta reconciliation logic lives in `src/reconciliation.ts` (`reconcileStreams` core + legacy adapter);
  domain types in `src/model.ts`; imports in `src/imports.ts`; ledger math in `src/ledger.ts`. Extend
  those pure modules, not the `App.tsx` `useMemo`/effects.
- iolta Firestore rules (`firestore.rules`) are written but **undeployed** — deployment is Phase 8 / #27.
