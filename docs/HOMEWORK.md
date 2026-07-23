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

**Session that just ran:** Phase 6 (epic #25) — **PR 13: DURABLE STORAGE (the last sub-item of the
migrations/roles/storage box).** Replaced the JSON-per-company file store with **SQLite** via the built-in
`node:sqlite`. Branch `claude/sqlite-durable-storage-iqvhdx` off latest `main` (`5a94a6f`); PR references #25 as
`Refs #25` (the epic was already closed by the owner — this PR completes its final checkbox, and the box now
closes). **Money-at-rest + migrations change → per CONTRIBUTING, auto-merge is OFF and it is left for HUMAN
REVIEW** (correctness rides on reproducing tests written first). Repo auto-merge is disabled anyway.

**The dependency decision (called out in the PR):** the suite's zero-dep ethos + D2=B "host as-is" rule out
`better-sqlite3` (a native node-gyp addon — needs a C toolchain, breaks a bare `npm ci`). Chose **`node:sqlite`**:
built INTO Node (since 22.5), no npm dependency, no native compile. It loads flag-free on 22.5+ and CI runs Node
24. Cost: the **books Node floor moved 20 → 22.5** (`apps/books/package.json` `engines`). The one experimental
stderr warning is filtered by message in `lib/sqlite.js` (honest — noted in the PR; every other warning still
surfaces).

**What landed (books; reproducing tests written first, then implementation):**
- **`lib/sqlite.js` (new).** Owns the durable connection (`data/books.db`), `journal_mode=DELETE` +
  `synchronous=FULL` (crash-atomic, self-contained file after commit → the tar backup stays trivially correct).
  Three tables: `global` (single household row), `company` (one JSON doc per company), `outbox` (the real
  transactional outbox). **SQLite TABLE schema is versioned by `PRAGMA user_version`** (ordered DDL steps) — a
  layer SEPARATE from the doc-shape `schemaVersion`. **Lossless JSON→SQLite import** on first boot: reads any
  legacy `global.json` / `company-*.json` / `db.json`, applies the doc migration, drains any pending in-doc
  outbox into the `outbox` table, inserts rows, and renames each file `*.migrated` (idempotent across restarts).
  Already-sealed secret strings move verbatim (never decrypted mid-import).
- **Design choice — a DOCUMENT store on SQLite, NOT a relational rewrite.** Each company stays one in-memory JSON
  doc, so every route handler + the **252-check smoke suite are unchanged**. The win is REAL transactions.
- **Secrets-at-rest re-derived (`lib/store.js` `docText`).** The in-memory db is ALWAYS plaintext; `docText`
  seals known leaves (via `lib/secrets.js`, untouched) + strips the vestigial in-doc outbox, then the sealed JSON
  is stored in the `company.doc` column. Proven: no plaintext secret in the raw `books.db` bytes; `books.db` is
  0600; keyfile still excluded from backups.
- **Transactional outbox re-derived on SQLite (`lib/outbox.js`).** `stage()` writes the company doc UPDATE + the
  owed-event INSERTs in ONE `BEGIN IMMEDIATE … COMMIT` — after commit BOTH are durable or NEITHER is (rollback
  proven). `flush()` delivers each owed event to the tamper-evident chain (idempotent on `msg_id` via
  `audit.appendIdempotent`) and DELETEs the row as it lands → exactly-once. `recoverAll(companiesFn)` on boot
  redelivers anything a crash stranded. `store.commit`/`commitMany` and `server.js`'s boot call updated to the
  new signatures; every money handler is otherwise unchanged.
- **`lib/global.js`** `loadGlobal`/`saveGlobal` now read/write the single `global` row (same normalization as
  before); `DATA_DIR` still exported here (anchors the audit chain, receipts, keyfile, backups).
- Tests: **`test/sqlite.test.js` (9, new)** lossless import + `user_version`; re-derived **`test/outbox.test.js`
  (5)** SQLite exactly-once/recovery/rollback; **`test/secrets.test.js` (11)** ciphertext in `books.db`;
  **`test/migrations.test.js` (21)** doc runner + JSON→SQLite on-disk round trip. `test/smoke.test.js` had two
  backup/receipt assertions repointed at `books.db` (behavior identical, 252 checks).

**Next session → Phase 7 (#26): suite integration + `packages/auth`** (the natural home for the per-principal
identity + role work started in books — the 3-role model landed in books' dispatcher first). Read the epic issue
#26. **Also available (correctness/moat, parallel, not a #25 blocker):** migrate more domains into `@elias/rules`
with the same cited pattern — sales-tax rate + ST-50/51 calendar, LEDES units, 1040 planner brackets — so those
constants stop being inline literals. **Phase 8 (#27)** stays parallelizable but "finalize last."

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books **252**-smoke + **9**
sqlite + **11** secrets + **5** outbox + **21** migration + **30** role + the rest, billable, iolta, audit 16,
money 22, rules 13); `npm run typecheck` clean; `grep -c msh.team package-lock.json` = 0; `package-lock.json`
unchanged (no new dependency — `node:sqlite` is built in). `data/` is gitignored (books.db never committed). All
money through `@elias/money`, all compliance events through `@elias/audit`; money mutations use
`store.commit`/`commitMany`, never `save(db)` + `audit.append`.

**Gotchas (carried forward + new):**
- **NEW — SQLite engine (`lib/sqlite.js`):** two migration layers. To change TABLES, append a `{ version: N,
  up(db) }` step to `SCHEMA_MIGRATIONS` (bumps `PRAGMA user_version`); to change the DOC shape, use
  `lib/migrations.js` (`schemaVersion`) exactly as before. The in-memory `db` is plaintext; secrets seal ONLY in
  `store.docText`. The outbox is a TABLE now — never write owed events into the doc; `docText` strips the
  vestigial `db.outbox`. `node:sqlite` needs Node ≥ 22.5 (books `engines`); CI is 24. `books.db` uses
  `journal_mode=DELETE` (single self-contained file after commit) — do NOT switch to WAL without teaching the tar
  backup to checkpoint/include the `-wal`/`-shm` sidecars.
- **NEW — crash-sim in tests:** `store._evict` (drop the in-memory doc cache) + `audit._reset` + optionally
  `sqlite._reset()` (close+reopen the connection) simulate a restart; the durable data is `books.db`. `store._docText(db)`
  is a test hook for staging raw docs.
- **schema migrations (doc layer):** to add a store-doc migration, append `{ version: N, up(obj) }` to
  `COMPANY_MIGRATIONS`/`GLOBAL_MIGRATIONS` and bump the matching `*_SCHEMA_VERSION`. Do NOT edit an existing step.
- **roles / dispatcher gate:** authorization lives in `server.js` (`isOwnerOnly`/`roleAllows`/`resolveRole`), NOT
  in handlers. New principals go in `global.json.principals` (now the `global` row); role re-resolved per request.
- **`@elias/rules` build order:** `apps/books` depends on built `@elias/rules` `dist/`. books' `pretest` builds
  money + audit + rules; if you run a books test directly after editing `packages/rules/src/*`, rebuild rules
  first (`npm run build --workspace @elias/rules`). `dist/` is gitignored.
- **payroll params come from `@elias/rules`** (`payrollValues(year)`); add a tax year by registering a cited
  `PayrollParams`, not a per-year JS table.
- **Do NOT `git checkout apps/billable/bin/billable.js`** to drop a mode diff — HEAD mode is `100755`. If a run
  flips the bit, `chmod 755`, NOT 644. This session did not touch it.
- **`npm ci` can install incompletely** (missing `@elias/rules` symlink / `@types/node` → the `@elias/audit` TS
  build fails); **re-run `npm ci`** (hit this session; re-run fixed it). Keep `grep -c msh.team package-lock.json`
  = 0.
- **Raw `api.github.com` curl is blocked (403)** — use `mcp__github__*` tools. Pushing docs to the branch
  retriggers CI — merge only after the run on the **final** commit concludes success.
- **billable's `test/run.js` fires async tests WITHOUT awaiting**; billable has no typecheck/lint in CI (plain
  JS) — lean on `node test/run.js`.
