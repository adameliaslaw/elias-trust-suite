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

**Session that just ran:** Phase 1 (epic #20) — contained risk + added reproducing tests. All #20
checklist items done; one PR opened off `main` (branch `claude/phase1-contain-risk-ov083u`).

**What landed (with commit SHAs):**
- `daed6fa` — **flaky billable test fixed** (`test/audit.test.js`): structural leaf-value check instead
  of the `"300"` substring that collided with SHA-256 hex. **CI is now deterministic** (verified 10/10).
- `1a5f2ce` — **IOLTA PDF import (#12)**: `apps/iolta/src/pdf.ts` uses the `pdf-parse@2.4.5` `PDFParse`
  class; real-PDF fixture test (`test/pdf.test.ts`). Also fixes the iolta `start` script (tsx).
- `f879c5b` — **statement-balance / false-"Reconciled" (#13)**: logic extracted to
  `apps/iolta/src/reconciliation.ts` with a status of `incomplete|reconciled|discrepancy`; only a real
  reconciliation seals `reconciliation.completed`. Also: Manual Entry modal wired, duplicate `<Chatbot/>`
  removed. Reproducing test `test/reconciliation.test.ts`.
- `0dd7cd1` — **`toCents` scientific-notation crash**: `dec()` expands exponential form; magnitude guard
  moved to cents conversion (`iolta/src/money.ts`).
- `6e51d15` — **Matterproof client-facing exports disabled (#18 stopgap)**: `apps/billable/src/exports-gate.js`
  gates LEDES/HTML/LawPay/Clio on both CLI and HTTP; off unless `BILLABLE_ALLOW_CLIENT_EXPORTS=1`.
  Docs-honesty edits (billable README, iolta header) in the docs commit.

**State of the repo:** all suites green (`npm test` exit 0); typecheck clean. Backlog #11–#27 still open
except #12/#13 (closed by the PR) and #20 (epic, closed by the PR). #19 rewritten as a decision memo.

**Next session → Phase 2 (epic #21): rebuild IOLTA's accounting model.** Depends on Phase 0 (#19) product
decisions AND the now-complete Phase 1. **Check #19 first** — Phase 2 needs the "system of record" and
"single-firm vs multi-tenant" calls (the memo recommends single-firm/multi-account now, which keeps SaaS
open). If the owner hasn't signed off, build the general firms→accounts hierarchy anyway (decision-safe).
Start with:
1. **#11** — separate bank / book / statement / match streams so the three legs are independently sourced
   (ends the circular reconciliation). The Phase 1 `reconciliation.ts` still derives all legs from one
   `transactions` array — Phase 2 replaces that.
2. **#15** — firms → memberships → trust accounts → account-scoped monthly periods; remove hardcoded
   `iolta-trust`; uid/account-scoped doc IDs + Firestore rules.
3. Atomic + idempotent imports (deterministic CSV/XLS parse before AI fallback; dedupe); reject
   type/sign contradictions; fix filtered running balances restarting at zero.

**Gotchas:**
- `npm ci` then `npm run build --workspace @elias/money --workspace @elias/audit` before app tests
  (apps depend on built `dist/`).
- **Do NOT `git checkout apps/billable/bin/billable.js` to drop a `chmod +x` mode diff** — it also reverts
  content edits (bit me this session). Use `git update-index --chmod=-x` / `chmod 644` instead, or just
  leave the mode diff and don't stage it. HEAD mode is `100644`.
- Lockfile must keep `grep -c msh.team package-lock.json` = 0.
- iolta reconciliation logic now lives in `src/reconciliation.ts` (pure, unit-tested) — extend it there,
  not back inside the `App.tsx` `useMemo`.
