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

**Session that just ran:** Assessment + reconciliation (two independent evaluations merged) →
canonical docs + filed backlog. No application code changed.

**State of the repo:** clean working tree; `apps/*` + `packages/money|audit` as migrated; CI green
*when the flaky test doesn't fire*. Backlog #11–#27 filed. Docs (`STATUS`, `CONSOLIDATION_PLAN`,
`EVALUATION`, this file) are canonical.

**Next session → Phase 1 (epic #20).** Phase 0 (#19) is owner-only product decisions and does not
block Phase 1 code. Start here, in this order:

1. **Fix the flaky test first** so CI is trustworthy for everything after
   (`apps/billable/test/audit.test.js:127` — replace the `"300"` substring assertion with a
   structural payload check that the config *value* isn't present; keep the "secret never logged"
   intent). Verify: run `npm test` in `apps/billable` ~10× — must pass every time.
2. **Fix IOLTA PDF import** (#12): `apps/iolta/server.ts:9,230` — use the `pdf-parse@2.4.5` class API
   (`const { PDFParse } = require('pdf-parse')`), remove the `as any`, add a PDF-fixture test.
3. **Require an explicit statement balance** (#13): `apps/iolta/src/App.tsx:457,500-510,559` — a month
   with no balance entered is *incomplete*, never zero/"Reconciled"; only seal `reconciliation.completed`
   when actually reconciled.
4. Then the rest of #20's checklist: `toCents` scientific-notation crash (`iolta/src/money.ts:31`),
   Manual Entry dead button, duplicate `<Chatbot/>`, iolta `start` script, docs-honesty edits,
   disable client-facing Matterproof exports until review is enforced (#18 stopgap).

**Acceptance for Phase 1:** CI deterministically green; PDF import works under test; no path claims
unearned compliance; Matterproof cannot emit client-facing bills. Then update STATUS (Phase 1 → ✅,
Phase 2 → next) and rewrite this handoff for Phase 2 (#21).

**Gotchas:** `npm ci` then `npm run build --workspace @elias/money --workspace @elias/audit` before
app tests (apps depend on built `dist/`). Discard any `chmod +x` mode-only diff on
`apps/billable/bin/billable.js`. Lockfile must keep `grep -c msh.team` = 0.
