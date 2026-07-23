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

**Session that just ran:** Phase 6 (epic #25) — **PR 6**: the fifth slice of the `server.js` split. Branch
`claude/phase6-recurring-extraction-60y0nh` off latest `main` (`635db72`); PR **open, referencing #25**
(`Refs #25`, not `Fixes` — the epic still has structural items left). Pure structural refactor fully covered by
the 252-check smoke suite (NOT money/tax logic), so per CONTRIBUTING it may land on green CI. **Repo auto-merge
is DISABLED**, so this session merged it by hand after the `ci` workflow concluded success (squash). Checks no
new #25 boxes on its own; the "split `server.js`" box stays open until the whole file is decomposed across
follow-up PRs.

**Context — PR 1 + PR 2 + PR 3 + PR 4 + PR 5 are MERGED.** PR 1 (`@elias/rules` moat + payroll retrofit + four
payroll/tax correctness fixes) landed as **PR #36** → `main` **`361e900`**. PR 2 (sales-tax + reports route group
extracted into `apps/books/lib/routes/reports.js`) landed as **PR #37** → `main` **`298d948`**. PR 3 (expenses
route group extracted into `apps/books/lib/routes/expenses.js`) landed as **PR #38** → `main` **`cdcd631`**.
PR 4 (customers route group extracted into `apps/books/lib/routes/customers.js`) landed as **PR #39** → `main`
**`ca7219c`**. PR 5 (billable-time route group extracted into `apps/books/lib/routes/time.js`) landed as
**PR #40** → `main` **`635db72`**. #25 has **6/8 boxes** checked and stays OPEN for the two structural items
(server split; schema migrations/roles/durable storage).

**What landed this session (behavior-preserving, covered by the existing smoke suite):**
- **Continued the incremental `server.js` split.** Extracted the **recurring-invoice** route group — the 4
  handlers `GET /api/recurring`, `POST /api/recurring`, `PUT /api/recurring/:id`, `DELETE /api/recurring/:id` —
  verbatim into **`apps/books/lib/routes/recurring.js`**, exported as `(route, deps) => {...}`. `server.js`
  requires it **in place** (after `generateRecurring`/`validInvoice` are defined), so route-registration order
  is unchanged; the handlers close over an explicit `deps` object (`sendJSON, notFound, badRequest, readBody,
  save, recurring, validInvoice, generateRecurring, audit`) instead of the monolith's module scope. `server.js`
  1857 → 1837 lines.
- **Two shared thread-throughs (do NOT move — left in `server.js`, passed through `deps`).**
  `validInvoice` (defined `server.js:82`) is shared with the invoices route group (`POST /api/recurring` reuses
  the same shape check). `generateRecurring` (defined `server.js:289`) is shared with the **boot scheduler** —
  `materializeAllRecurring`/`scheduleRecurring` runs the same daily+startup sweep, and `POST /api/recurring`
  calls it to bill an immediate first invoice — and it closes over
  `createInvoice`/`commitMany`/`decorateInvoice`/`audit`/`todayISO`, so it stays defined in `server.js`. This is
  the `scheduleRecurring` boot dependency the prior handoff flagged; it was a **clean thread-through** (the
  scheduler and the route call the same server-level helper), not a reason to skip recurring.
- **Persistence preserved exactly (do NOT "fix" this).** The template CRUD is non-money: `GET` only reads;
  `PUT`/`DELETE` call `save(db)` directly. `POST /api/recurring` is **mixed** — it calls `generateRecurring`
  (which `commitMany`s any invoices due today or earlier, `source: 'recurring'` — a crash-atomic money path)
  and then `save(db)` for the template. That was carried over verbatim; do NOT collapse it to a single pattern.
  The 252-check `smoke.test.js` suite is **identical before/after** and still passes — the characterization
  safety net for this slice.

**The extraction pattern (follow it for the next group):**
1. Create `apps/books/lib/routes/<group>.js` exporting `module.exports = function (route, deps) { const {...} = deps; route(method, pattern, handler); ... }`.
2. Copy the handlers **verbatim** (don't "improve" them — this is a refactor). Identify every free variable
   each handler used from `server.js` module scope and add it to the destructured `deps`.
3. In `server.js`, replace the inline `route(...)` block with `require('./lib/routes/<group>')(route, { ...deps });`
   **at the same location** so registration order is preserved (route order only matters for overlapping
   patterns, but keeping it identical keeps the diff honest and the smoke net exact).
4. `npm run typecheck` + `npm test --workspace apps/books` must stay green with the **same 252 count**.

**Next session → continue the split (own PRs, one cohesive group each), then the other structural item:**
- **Next split slices.** Five groups are now extracted (reports, expenses, customers, time, recurring).
  Remaining route groups by handler count (see the `route(` map in `server.js`): payroll 19, bank 17,
  household 8, invoices 7, plus auth/companies/settings and the audit/backup tail. Suggested next: the big ones
  (**payroll**, **bank**, **household**). **Watch out for `invoices`:** it drags in the shared `createInvoice`
  constructor (used by the recurring scheduler that runs at boot, plus the sales-import and now-extracted
  time-invoice + recurring-POST routes — `createInvoice` is the constructor `generateRecurring`/time/sales-import
  all thread), so it is NOT self-contained the way expenses/customers/time/recurring were — give it a dedicated
  pass and thread `createInvoice` (leave it defined in server.js and pass it through `deps`, as the time and
  recurring groups already do). Watch generally for handlers referencing module-level helpers you haven't passed
  yet (`scheduleRecurring`, `secureAttr`, `PUBLIC_ROUTES`, the plaid/csv/receipts/deposits/nacha/filings
  requires) — thread them through `deps`. Note `decorateInvoice` and `generateRecurring` are shared across
  groups + the boot scheduler — thread them, don't move them.
- **Schema migrations / roles / durable storage before any multi-user deploy** (checklist item). Books is a
  single-file JSON store today; design a migration/versioning story + role model. Gates multi-user.
- **Migrate more domains into `@elias/rules`:** sales-tax rate + ST-50/51 calendar, LEDES units, the 1040
  planner brackets — same cited pattern, so those constants stop being inline literals.
- Then **Phase 7 (#26)** — suite integration + `packages/auth` (still needs 6).
- **Phase 8 (#27)** stays parallelizable but "finalize last" (deploy-unblocking infra OK; not the integrated
  release cut).

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books **252**-suite,
billable, iolta, audit 16, money 22, rules 13); `npm run typecheck` clean; `grep -c msh.team package-lock.json`
= 0. Backlog: #24 CLOSED (P5); #16/#17/#18, #14, #11/#15, #12/#13/#20 closed; #19 ratified + closed.

Phase 7 (#26) still needs 6. All money through `@elias/money`, all compliance events through `@elias/audit`;
new money mutations use `store.commit`/`commitMany`, never `save(db)` + `audit.append`.

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
