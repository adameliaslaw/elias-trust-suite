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

**Session that just ran:** Phase 4 (epic #23) — Matterproof billing redesign. All #23 checklist items done;
one PR opened off `main` (branch `claude/phase4-matterproof-billing-prr5ln`). Criticals #17 and #18 closed
by the PR.

**Decision context:** #19 **Decision 3 (system of record) is still unratified** (no sign-off comment, box
unchecked as of this session). Phase 4 is decision-safe under the recommended default C: time capture with
attorney-confirmed provenance and a reviewed-once export is squarely the suite's own time-capture domain. No
invoice/payment/AR "system of record" object was built — LEDES/Clio/LawPay stay integration *destinations*,
not a general ledger.

**What landed (commit SHA `dc598c2`):**
- **#17 — inferred time = zero (`apps/billable/src/entries.js`).** `finishTask` records the machine estimate
  as `suggestedHours` and sets billable `hours: 0`, `confirmed: false`; AI runtime stays as `seconds`
  (cost/provenance). A manual entry is attorney-entered, so it's `confirmed: true` by construction.
  `applyOverride` marks `entry.confirmed` when an attorney supplies hours, computes `entry.billable`
  (`!writeOff && confirmed && hours>0`), and prices the fee only for billable entries. `totals` gained
  `unconfirmed`/`billableCount`.
- **#18 — reviewed-only, mutually-exclusive, idempotent billing (new `apps/billable/src/client-billing.js`).**
  A single `billed` marker (`{destination, reference, at}`; legacy `lawpayRef`/`clioId` still count).
  `isClientBillable`/`classifyForClient` require reviewed + confirmed + not-written-off + not-already-billed,
  applied on EVERY client path: `ledes.js` and `report.js#htmlInvoice` filter internally; `lawpay.js`
  `classifyForBilling` and `clio.js` `classifyForPush` classify against the unified marker. `store.markBilled`
  + CLI `report --format ledes --bill` record a LEDES invoice as issued. Second export of an entry = no-op.
- **Rate snapshot at review** — `client-billing.reviewRateSnapshot` freezes `config.rate` onto the override
  the first time `reviewed` flips true (wired into `server.js` `/api/override`); `applyOverride` prices from
  `entry.rate` (snapshot), so the rate table never reprices historical entries.
- **M5 LEDES (`ledes.js`)** — `formatUnits` emits exact units (no hardcoded tenths); unit cost = the entry's
  snapshot rate; `units × unit-cost === line total` at tenths and quarter-hours. Multi-matter files group
  into one invoice per client/matter (`matterInvoiceNumber`), each with its own INVOICE_NUMBER/INVOICE_TOTAL
  and per-invoice line numbering.
- **M6 (`store.js`)** — `scrubForPrivacy` in `store.appendEvent` blanks prompt `detail` when
  `capturePrompts:false`, at the single choke point every writer (CLI `log`, POST /api/log, extension) passes
  through.
- **Fail-loud JSONL (`store.js`)** — `readEvents` throws (naming the line number) on a malformed record
  instead of silently dropping it.
- **Clio OAuth (`clio.js`)** — `buildAuthRequest` adds `state` + PKCE (S256); `waitForCode({expectedState,
  timeoutMs, onListening})` validates state (CSRF) and enforces a callback timeout; `exchangeToken` sends the
  `code_verifier`.
- **Stopgap removed** — deleted `src/exports-gate.js` + `test/exports-gate.test.js` and every
  `BILLABLE_ALLOW_CLIENT_EXPORTS` reference (server, CLI, run.js). Dashboard shows the confirm-minutes UX
  (est vs confirmed, unconfirmed count); README/ETHICS de-claimed accordingly.
- New tests: `test/phase4.test.js` (16 cases) wired into `test/run.js`; several existing run.js tests updated
  to the new confirmed-minutes contract (no tests deleted to go green — the removed exports-gate test pinned a
  deliberately-superseded stopgap and was replaced by stronger structural tests).

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — billable 52, iolta 18,
audit 16, money 22; books green); typecheck clean. Billable determinism verified 5/5 runs. Backlog: #17/#18
closed by this PR; #14 (Phase 3), #11/#15 (Phase 2), #12/#13/#20 (Phase 1) closed. #19 unratified.

**Next session → Phase 5 (epic #24): data + audit hardening.** Unblocked (Phases 2–4 done). Context:
`docs/EVALUATION.md` — H1 (books audit screen shows the forgeable log, not the tamper-evident chain), #16
(billable audit verify ignores the head it maintains; lost localStorage queue drops entries silently), #24
(books stores Plaid/ACH/employee-bank secrets in plaintext, backups included), plus M7 (books data-store
races) and M8 (GET endpoints mutate state). All money through `@elias/money`, all compliance events through
`@elias/audit`.

**Gotchas (carried forward + new):**
- `npm ci` then `npm run build --workspace @elias/money --workspace @elias/audit` before app tests (apps
  depend on built `dist/`). **After editing `packages/audit` types, rebuild it** or dependents typecheck
  against stale `dist/`. (Phase 4 did NOT touch `@elias/audit` — the new billing events reuse the existing
  `entry.override_written` chain, so no audit rebuild was needed.)
- **Do NOT `git checkout apps/billable/bin/billable.js` to drop a `chmod +x` mode diff** — it reverts
  content too. Use `chmod 644` / `git update-index --chmod=-x`. HEAD mode is `100644`. (The billable test
  run flips the bit; `chmod 644` before staging cleared it this session too.)
- Lockfile must keep `grep -c msh.team package-lock.json` = 0.
- **billable's test runner (`test/run.js`) fires async tests WITHOUT awaiting** — they resume after the whole
  synchronous sweep and read whatever `process.env.BILLABLE_HOME` is then set to. A sync test that
  `freshHome()`s and leaves a *throwing* ledger active will crash unrelated async tests. Phase 4's new tests
  either stay synchronous or save/restore `BILLABLE_HOME`; if you add async billable tests, keep them
  self-consistent on the final env and never leave a corrupt home active.
- billable billing logic lives in the pure modules — `entries.js` (build/override/totals),
  `client-billing.js` (the billed marker + client-export gate), `ledes.js`, `economics.js`. Extend those,
  not the `server.js` request handlers.
- billable has no typecheck/lint in CI (plain JS, L1) — lean on the runtime tests (`node test/run.js`).
