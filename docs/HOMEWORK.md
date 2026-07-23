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

**Session that just ran:** Phase 6 (epic #25) — **PR 11**: the pass that **FINISHES the "split `server.js`" box**.
Branch `claude/phase6-server-split-auth-audit` off latest `main` (`40a8dee`); PR **#46 open, referencing #25**
(`Refs #25`, not `Fixes` — the epic still has ONE structural item left: schema migrations/roles/durable storage).
Pure structural refactor fully covered by the 252-check smoke suite (NOT money/tax logic), so per CONTRIBUTING it
may land on green CI. **Repo auto-merge is DISABLED**, so this session merged it by hand after the `ci` workflow
concluded success on the final (docs) commit (squash). **Checks the "split `server.js`" box on #25** — with these
two clusters out, all 11 route groups live in `lib/routes/*` and `server.js` is the bootstrap + dispatch + the
shared invoice/recurring constructors that legitimately stay.

**Context — PR 1 through PR 10 are MERGED.** PR 1 (`@elias/rules` moat + payroll retrofit + four payroll/tax
correctness fixes) landed as **PR #36** → `main` **`361e900`**. PR 2 (sales-tax + reports route group extracted
into `apps/books/lib/routes/reports.js`) landed as **PR #37** → `main` **`298d948`**. PR 3 (expenses route group
extracted into `apps/books/lib/routes/expenses.js`) landed as **PR #38** → `main` **`cdcd631`**. PR 4 (customers
route group extracted into `apps/books/lib/routes/customers.js`) landed as **PR #39** → `main` **`ca7219c`**. PR 5
(billable-time route group extracted into `apps/books/lib/routes/time.js`) landed as **PR #40** → `main`
**`635db72`**. PR 6 (recurring-invoice route group extracted into `apps/books/lib/routes/recurring.js`) landed as
**PR #41** → `main` **`b04f01e`**. PR 7 (household-taxes route group extracted into
`apps/books/lib/routes/household.js`) landed as **PR #42** → `main` **`1b3e33b`**. PR 8 (payroll route group
extracted into `apps/books/lib/routes/payroll.js`) landed as **PR #43** → `main` **`2886521`**. PR 9 (bank feed
route group extracted into `apps/books/lib/routes/bank.js`) landed as **PR #44** → `main` **`1f348f1`**. PR 10
(invoices route group extracted into `apps/books/lib/routes/invoices.js`) landed as **PR #45** → `main`
**`40a8dee`**. With PR 11 the **server-split box closes**; #25 has **7/8 boxes** checked and stays OPEN for the one
remaining structural item (schema migrations/roles/durable storage).

**What landed this session (behavior-preserving, covered by the existing smoke suite):**
- **Finished the incremental `server.js` split — the two remaining inline clusters.** Extracted both verbatim,
  each wired in place so route-registration order is unchanged; handlers close over an explicit `deps` object
  instead of the monolith's module scope. `server.js` **629 → 493 lines**.
  - **`apps/books/lib/routes/auth.js`** — the **auth/companies/settings** cluster (10 handlers): `GET
    /api/auth-status`, `POST /api/login`, `POST /api/logout`, `POST /api/password`, `GET/POST /api/companies`,
    `POST /api/companies/:id/select`, `GET/PUT /api/settings`, `GET /api/categories`. deps: `sendJSON, notFound,
    badRequest, readBody, loadGlobal, saveGlobal, companies, createCompany, commit, audit, auth, salestax`.
  - **`apps/books/lib/routes/audit.js`** — the **audit/backup tail** (3 read-only GETs): `GET /api/audit`, `GET
    /api/audit/chain`, `GET /api/backup`. deps: `sendJSON, todayISO, audit, backup, auth, loadGlobal`.
- **One helper moved IN, the dispatcher's collaborators stayed OUT.** `secureAttr` (the `; Secure` cookie
  attribute over TLS, L3) is used ONLY by the auth cluster's cookie-setting handlers (grep-confirmed), so it moved
  into `auth.js` as an inner function — like `validExpense`/`validCustomer`/the four bank helpers before it.
  Crucially, **`PUBLIC_ROUTES` and the session/auth middleware stayed in `server.js`**: the request *dispatcher*
  (`handleRequest`) consults them, not just the handlers, so moving them would have broken auth on every route.
- **Persistence preserved EXACTLY (no `commit`↔`save(db)` conversions).** This cluster is session/auth-flavored,
  mostly **non-money**: password + company-registry writes hit the household `global.json` via `saveGlobal()`;
  `login`/`logout`/`select` only set cookies (login/password also append an `auth.*` audit event directly). The
  **one** money-adjacent exception is `PUT /api/settings`, which commits `settings.changed` through the
  transactional outbox — `commit` is threaded, not introduced. The audit/backup tail is entirely read-only —
  nothing saves or commits; `GET /api/audit` returns `{ verified, entries }` from the tamper-evident chain, not
  the vestigial `db.auditLog` (H1). The 252-check smoke suite is **identical before/after** and still passes.

**The extraction pattern (now complete — kept for reference / future modularization):**
1. Create `apps/books/lib/routes/<group>.js` exporting `module.exports = function (route, deps) { const {...} = deps; route(method, pattern, handler); ... }`.
2. Copy the handlers **verbatim** (don't "improve" them — this is a refactor). Identify every free variable
   each handler used from `server.js` module scope and add it to the destructured `deps`. If an inline helper
   FUNCTION (not a require) is used ONLY by the group (grep to confirm), move it in as an inner function;
   requires and shared helpers thread through `deps` (keep the `require` line at the top of `server.js`).
   **Helpers the dispatcher itself uses (`PUBLIC_ROUTES`, the auth middleware) stay in `server.js`.**
3. In `server.js`, replace the inline `route(...)` block with `require('./lib/routes/<group>')(route, { ...deps });`
   **at the same location** so registration order is preserved (route order only matters for overlapping
   patterns, but keeping it identical keeps the diff honest and the smoke net exact).
4. `npm run typecheck` + `npm test --workspace apps/books` must stay green with the **same 252 count**.

**`server.js` now (493 lines) is essentially the bootstrap:** requires + config, the shared helpers
(`sendJSON`/`readBody`/`badRequest`/`notFound`/`inRange`), the `route`/dispatch machinery
(`route`/`handleRequest`/`withCompanyLock`/`serveStatic`/`PUBLIC_ROUTES`), the shared invoice/recurring
constructors that legitimately stay (`validInvoice`/`createInvoice`/`generateRecurring`/`materializeAllRecurring`/
`scheduleRecurring`), and `createServer`/`recoverAll`/`listen`. All eleven route groups are in `lib/routes/*`.

**Next session → the ONE remaining Phase 6 structural item, then rules migration, then Phase 7:**
- **Schema migrations / roles / durable storage before any multi-user deploy** (the last unchecked #25 box).
  Books is a single-file JSON store today (`data/company-<id>.json` + `global.json`, whole-file `save()`); design
  a migration/versioning story (a `schemaVersion` on the store + forward migrations run on load) + a role model
  (owner vs. read-only vs. bookkeeper, given the household-shared password today). Gates multi-user. Once this box
  closes, **both** #25 structural items are done → Phase 6 complete → Phase 7 (#26).
- **Migrate more domains into `@elias/rules`:** sales-tax rate + ST-50/51 calendar, LEDES units, the 1040
  planner brackets — same cited pattern, so those constants stop being inline literals. (Correctness/moat, not a
  #25 checkbox blocker, but the natural next `@elias/rules` work.)
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
- **Do NOT `git checkout apps/billable/bin/billable.js` to drop a mode diff** — it reverts content too.
  **HEAD mode is `100755`** (an earlier handoff said `644` — that is WRONG for this repo state; verified
  `git ls-files -s` → `100755`). If a test run flips the bit, `chmod 755` to match HEAD, NOT `chmod 644`
  (`chmod 644` CREATES a diff here). This session's runs did not touch the bit.
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
