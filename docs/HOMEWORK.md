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

**Session that just ran:** Phase 6 (epic #25) — **PR 9**: the eighth slice of the `server.js` split. Branch
`claude/phase6-server-split-bank` off latest `main` (`2886521`); PR **#44 open, referencing #25**
(`Refs #25`, not `Fixes` — the epic still has structural items left). Pure structural refactor fully covered by
the 252-check smoke suite (NOT money/tax logic), so per CONTRIBUTING it may land on green CI. **Repo auto-merge
is DISABLED**, so this session merged it by hand after the `ci` workflow concluded success (squash). Checks no
new #25 boxes on its own; the "split `server.js`" box stays open until the whole file is decomposed across
follow-up PRs.

**Context — PR 1 through PR 8 are MERGED.** PR 1 (`@elias/rules` moat + payroll retrofit + four payroll/tax
correctness fixes) landed as **PR #36** → `main` **`361e900`**. PR 2 (sales-tax + reports route group extracted
into `apps/books/lib/routes/reports.js`) landed as **PR #37** → `main` **`298d948`**. PR 3 (expenses route group
extracted into `apps/books/lib/routes/expenses.js`) landed as **PR #38** → `main` **`cdcd631`**. PR 4 (customers
route group extracted into `apps/books/lib/routes/customers.js`) landed as **PR #39** → `main` **`ca7219c`**. PR 5
(billable-time route group extracted into `apps/books/lib/routes/time.js`) landed as **PR #40** → `main`
**`635db72`**. PR 6 (recurring-invoice route group extracted into `apps/books/lib/routes/recurring.js`) landed as
**PR #41** → `main` **`b04f01e`**. PR 7 (household-taxes route group extracted into
`apps/books/lib/routes/household.js`) landed as **PR #42** → `main` **`1b3e33b`**. PR 8 (payroll route group
extracted into `apps/books/lib/routes/payroll.js`) landed as **PR #43** → `main` **`2886521`**. #25 has **6/8
boxes** checked and stays OPEN for the two structural items (server split; schema migrations/roles/durable storage).

**What landed this session (behavior-preserving, covered by the existing smoke suite):**
- **Continued the incremental `server.js` split.** Extracted the **bank** feed route group — the 17 handlers
  `GET /api/bank/status`, `PUT/DELETE /api/bank/config`, `POST /api/bank/link-token`, `POST /api/bank/exchange`,
  `POST /api/bank/sync`, `DELETE /api/bank/connections/:id`, `POST /api/bank/import-csv`,
  `GET/POST /api/bank/rules`, `DELETE /api/bank/rules/:id`, `POST /api/bank/apply-rules`,
  `GET /api/bank/transactions`, and the review-queue `POST /api/bank/transactions/:id/{expense,match,exclude,
  restore}` — verbatim into **`apps/books/lib/routes/bank.js`**, exported as `(route, deps) => {...}`. `server.js`
  requires it **in place** (same spot the block sat, between the expenses and payroll requires), so
  route-registration order is unchanged; the handlers close over an explicit `deps` object (`sendJSON, notFound,
  badRequest, readBody, uid, round2, todayISO, save, commit, audit, money, plaid, parseBankCSV, decorateInvoice,
  salestax`) instead of the monolith's module scope. `server.js` 1081 → 777 lines.
- **Four bank-only helpers moved IN with the group** (grep-confirmed no other callers in `server.js`):
  `publicConnection` (strips accessToken/cursor off a connection), `txnKey` (CSV dedup key), `syncConnection`
  (Plaid cursor sync loop), `ruleFor` (matches an outflow to a categorization rule). The `plaid` and
  `parseBankCSV` requires are used **only** by this group, but following the expenses/payroll precedent the
  `require` lines stay at the top of `server.js` and the modules thread through `deps` (NOT re-required in the
  module). `decorateInvoice` and `salestax` are shared across groups → threaded, not moved. (Note: `server.js`
  line 197's `plaid` is a destructuring key on `db.settings`, not the module — don't be fooled by grep.)
- **Mixed persistence preserved EXACTLY (do NOT "fix" the direction of any path).** The characterization here
  corrects the prior handoff's loose phrasing: the ONLY two money-commit paths in the bank group are the
  feed-import endpoints — `POST /api/bank/sync` and `POST /api/bank/import-csv`, each of which `commit`s a
  `bank.transactions_imported` event (exact signed net via `money.sum`/`money.add`) through the transactional
  outbox. **Every other mutation calls `save(db)` directly**, including the review-queue
  `.../transactions/:id/{expense,match,exclude,restore}` paths (they record an already-settled bank event into
  the local book — no new cash movement), plus config PUT/DELETE, exchange, connection delete, and rule CRUD /
  apply-rules. `.../match` is the one that pushes an invoice payment carrying `salestax.taxSplitSnapshot(dMatch)`
  (the 3rd of the three snapshot sites). The 252-check `smoke.test.js` suite is **identical before/after** and
  still passes.

**The extraction pattern (follow it for the next group):**
1. Create `apps/books/lib/routes/<group>.js` exporting `module.exports = function (route, deps) { const {...} = deps; route(method, pattern, handler); ... }`.
2. Copy the handlers **verbatim** (don't "improve" them — this is a refactor). Identify every free variable
   each handler used from `server.js` module scope and add it to the destructured `deps`. If an inline helper
   FUNCTION (not a require) is used ONLY by the group (grep to confirm), move it in as an inner function;
   requires and shared helpers thread through `deps` (keep the `require` line at the top of `server.js`).
3. In `server.js`, replace the inline `route(...)` block with `require('./lib/routes/<group>')(route, { ...deps });`
   **at the same location** so registration order is preserved (route order only matters for overlapping
   patterns, but keeping it identical keeps the diff honest and the smoke net exact).
4. `npm run typecheck` + `npm test --workspace apps/books` must stay green with the **same 252 count**.

**Next session → continue the split (own PRs, one cohesive group each), then the other structural item:**
- **Next split slices.** Eight groups are now extracted (reports, expenses, customers, time, recurring,
  household, payroll, bank). Remaining route groups (see the `route(` map in `server.js`): **invoices ~7**, plus
  auth/companies/settings and the audit/backup tail. Suggested next: **invoices** (the last big domain group).
  **Watch out for `invoices`:** it drags in the shared `createInvoice` constructor (used by the recurring
  scheduler that runs at boot, plus the sales-import and already-extracted time-invoice + recurring-POST routes —
  `createInvoice` is the constructor `generateRecurring`/time/sales-import all thread), so it is NOT
  self-contained the way the eight extracted groups were — give it a dedicated pass and thread `createInvoice`
  (leave it defined in server.js and pass it through `deps`, as the time and recurring groups already do). Watch
  generally for handlers referencing module-level helpers you haven't passed yet (`scheduleRecurring`,
  `secureAttr`, `PUBLIC_ROUTES`, the plaid/csv/receipts requires) — thread them through `deps`. Note
  `decorateInvoice` and `generateRecurring` are shared across groups + the boot scheduler — thread them, don't
  move them. The invoices group carries two of the three `salestax.taxSplitSnapshot` sites (create/edit payment
  push + sales-import) — thread `salestax`; it also references `validInvoice` (shared with the recurring group,
  already threaded there — keep it in `server.js` and thread it).
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
