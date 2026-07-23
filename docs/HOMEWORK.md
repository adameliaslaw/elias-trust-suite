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

**Session that just ran:** Phase 6 (epic #25) — **first PR** (the coherent money/tax-correctness slice). Branch
`claude/phase6-rules-payroll-b9n748` off `main`; PR **open, referencing #25** (`Refs #25`, not `Fixes` — the
epic has structural items left). **Auto-merge intentionally OFF** (money/tax-correctness — per CONTRIBUTING's
exception) — human review requested. This PR does **not** close #25; it checks 5 of its 8 boxes.

**What landed this session (each with a reproducing test):**
- **`packages/rules` (`@elias/rules`) — the moat, built.** Effective-date-keyed, version-parameterized rule
  sets where every constant carries a primary-source citation. `src/rules.ts`: `cite()`/`Cited<T>`,
  `materialize()` (strips citations → the plain values the engine consumes), `citedLeaves()`/`citationAt()`
  for provenance, and a registry with `resolveByDate()`. `src/payroll.ts`: the full 2026 payroll/withholding
  set (mirrors the old `tables2026.js` keys/values exactly, each leaf cited), plus the previously-absent IRC
  **§402(g)** limit; `payrollValues(year)` returns the plain shape and throws for an unregistered year.
  `src/nacha.ts`: ACH service-class codes cited to the NACHA rules. 13 vitest tests incl. a moat invariant
  (every constant has a non-empty authority+locator).
- **Payroll retrofit.** `apps/books/lib/payroll/engine.js` now sources params via `require('@elias/rules').payrollValues(year)`;
  **`tables2026.js` deleted**. `test/payroll.test.js` + `test/tax1040.test.js` take `T` from
  `payrollValues(2026)`. Unknown-year error message changed to `/No payroll rule set/` (smoke + payroll tests updated).
- **Salestax snapshot (`lib/salestax.js:35`).** Editing a paid invoice no longer restates prior-period income
  or the sales-tax **trust** liability: `taxSplitSnapshot(dInv)` freezes the invoice tax/total ratio onto each
  payment at record time (all 3 push sites in `server.js`), and `paymentIncomeParts` reads `payment.taxSnapshot`
  when present (legacy snapshot-less payments fall back to the live invoice).
- **Payroll aggregate net guard + §402(g) (`engine.js`).** `deductionAmounts` caps elective 401(k)/Roth
  deferrals by remaining annual §402(g) room (YTD via new `ytd.electiveDeferrals`, summed in
  `service.js#ytdTotals`). `computePaycheck` now has an `evaluate()` closure + a guard loop that trims voluntary
  deductions (after-tax → Roth → pre-tax 401k → health, re-evaluating taxes after a pre-tax trim) so **net can
  never go negative** (a negative check was silently dropped from NACHA). New result fields: `electiveDeferral`,
  `deductionsReduced`.
- **NACHA credit-only 220 (`nacha.js`).** PPD payroll batch header + control now declare service class **220**
  (credits only), not mixed **200**, single-sourced from `@elias/rules` `ACH_SERVICE_CLASS.CREDITS_ONLY`.
- **Stale NIIT comment (`tax1040.js:13`).** Header said "no NIIT" while the module computes Form 8960 NIIT —
  corrected.

**Books' accounting role (checklist item) — settled by #19, no code.** D3=C already decided it: integrate with
a real accounting system; do NOT build the missing double-entry layer (chart of accounts / journals / trial
balance / A-P). Checked that box in #25 with a one-line note citing the #19 ratification; invoice/payment
objects stay thin + integration-oriented.

**Design notes for the reviewer:**
- `payrollValues(year)` is memoized and materializes to the **exact** old `tables2026` numeric shape, so all
  existing payroll/filings/tax1040/nacha tests pass unchanged — the retrofit is provenance, not a value change.
- §402(g) 2026 limit is set to **$24,500** with a citation note (IRC §402(g)(1); IRS Notice 2025-67) flagging
  "verify before a live filing" — same honest posture as the 1040 planner. Catch-up (age 50+) is not modeled.
- The net guard is a documented conservative behavior: trimming a *pre-tax* deferral raises taxable wages, so
  `evaluate()` re-runs each iteration; it always converges (worst case all voluntary deductions zeroed →
  net = gross − taxes + reimb ≥ 0). After-tax/Roth trims are exact (no tax effect).

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books 252-suite incl.
payroll 27 + salestax 10 + nacha 17, billable, iolta, audit 16, money 22, **rules 13**); `npm run typecheck`
clean; `grep -c msh.team package-lock.json` = 0. Backlog: #24 CLOSED (P5); #16/#17/#18, #14, #11/#15,
#12/#13/#20 closed; #19 ratified + closed.

**Next session → remaining Phase 6 (#25) structural items (own PRs), then Phase 7:**
- **Incrementally split the monolithic `apps/books/server.js` behind tests** (checklist item). It's ~2,200
  lines of route handlers; extract cohesive route groups (invoices, payroll, salestax…) into modules with the
  existing tests as the safety net. One PR per slice.
- **Schema migrations / roles / durable storage before any multi-user deploy** (checklist item). Books is a
  single-file JSON store today; design a migration/versioning story + role model. Gates multi-user.
- **Migrate more domains into `@elias/rules`:** sales-tax rate + ST-50/51 calendar, LEDES units, the 1040
  planner brackets — same cited pattern, so those constants stop being inline literals.
- Then **Phase 7 (#26)** — suite integration + `packages/auth` (still needs 6).
- **Phase 8 (#27)** stays parallelizable but "finalize last" (deploy-unblocking infra OK; not the integrated
  release cut).

Phase 7 (#26) still needs 6. All money through `@elias/money`, all compliance events through `@elias/audit`.

**Gotchas (carried forward + new):**
- **NEW — `@elias/rules` build order:** `apps/books` now depends on the built `@elias/rules` `dist/`. books'
  `pretest` builds money + audit + **rules** (`--workspace @elias/rules`); if you run a books test file
  directly (`node test/payroll.test.js`) after editing `packages/rules/src/*`, **rebuild rules first**
  (`npm run build --workspace @elias/rules`) or you'll test stale dist. Root CI (`npm ci` → `typecheck` →
  `test`) covers it because books' pretest fires. `dist/` is gitignored (don't commit it).
- **NEW — payroll params come from `@elias/rules`:** `tables2026.js` is **gone**. Tax/withholding constants
  live in `packages/rules/src/payroll.ts`, each cited; the engine reads them via `payrollValues(year)`
  (memoized, materialized to the old plain shape). To add a tax year: add a cited `PayrollParams` for that
  year and `registerPayroll` it — do NOT reintroduce a per-year JS table. Every leaf MUST carry a non-empty
  `authority`+`locator` (a rules test enforces this). Adding/moving constants → update the citation.
- **NEW — payroll net guard + §402(g):** `computePaycheck` never returns negative net (voluntary deductions
  are trimmed after-tax→Roth→pre-tax-401k→health, re-evaluating taxes on a pre-tax trim). Elective deferrals
  are §402(g)-capped using `ytd.electiveDeferrals` (summed in `service.js#ytdTotals` from
  `dedPretax401k`+`dedRoth401k`). New result fields: `electiveDeferral`, `deductionsReduced`. If you add a
  new deferral kind, add it to `ELECTIVE_DEFERRAL_KINDS` in `engine.js`.
- **NEW — salestax snapshot:** new invoice payments carry `taxSnapshot` (the invoice tax/total ratio at
  payment time); `salestax.paymentIncomeParts` reads it so a later invoice edit can't restate a booked
  period. If you add another code path that pushes to `inv.payments`, attach `salestax.taxSplitSnapshot(dInv)`
  (there are 3 sites in `server.js`). Legacy payments without a snapshot still use the live invoice.
- **NEW — books transactional outbox:** money handlers now call `store.commit(db, companyId, type, payload)`
  (or `commitMany(db, companyId, [{type, payload}, ...])`) INSTEAD of `save(db); await audit.append(...)`.
  If you add a new money mutation, use `commit`, not the old pair — otherwise its audit event is not
  crash-atomic. commit does enqueue→save→flush; the in-memory `db.outbox` is drained on success. Recovery
  runs on boot (`outbox.recoverAll`). A new semantic event delivered via commit gets an extra `outboxId`
  field in its audit payload (idempotency key) — harmless, additive.
- **NEW — billable Clio intents:** `clio.push_intent` is a ledger event (like `payment_request`), ignored by
  `buildEntries` (only `prompt`/`tool`/`stop`/`manual` become billable time), so it never becomes billable
  time. If you change `activityBody`'s shape, `pushKey` (which hashes date/quantity/note) changes too — a
  content change is intentionally a *different* idempotency key.
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
- **books secrets-at-rest (#24):** the in-memory `db` is ALWAYS plaintext; encryption happens only in
  `store.save`/`store.load` via `lib/secrets.js`. If you add a new secret field, add its path to
  `applyToSecrets` — it is an enumerated allowlist on purpose. The key resolves from
  `QUICKBUCKS_ENCRYPTION_KEY` (any passphrase) or a generated `data/.secret.key` (0600); tests use the keyfile
  path (they `delete process.env.QUICKBUCKS_ENCRYPTION_KEY`). The keyfile is excluded from backups — keep it
  that way, and keep new data files 0600.
- **books audit UI reads the chain now (H1):** `/api/audit` returns `{ verified, entries }`, not an array.
  `db.auditLog` is vestigial (still written by the dispatcher for back-compat) — nothing reads it anymore.
