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

**Session that just ran:** Phase 6 (epic #25) — **PR 12**: the last structural box, **part 1 of 2** —
**schema-version + migration runner** and the **3-role household identity model**. Branch
`claude/elias-phase-6-migrations-5dfhbj` off latest `main` (`05e69cf`); PR referencing #25 (`Refs #25`, not
`Fixes` — durable storage, the box's third sub-item, is still outstanding as its own next PR). This is NOT a
pure structural refactor — it changes persistence + access control — so per CONTRIBUTING the correctness rides
on **reproducing tests written first** (migration round-trips + role enforcement), and the migration/security
risk is covered by those tests in CI. **Repo auto-merge is DISABLED**, so this session merged by hand after the
`ci` workflow concluded success on the final (docs) commit (squash).

**Owner decisions this session (ratified via AskUserQuestion):**
- **Role model = 3 household roles: owner / bookkeeper / read-only.** (Not per-company; the real identity/session
  home is Phase 7's `packages/auth` — this is the enforcement + audit-actor groundwork.)
- **Durable storage = SQLite is the committed direction, delivered as its own next HUMAN-REVIEWED PR** (not
  bundled with roles). JSON-per-company stays for now. Rationale: the switch re-touches the #24 secrets-at-rest +
  transactional-outbox atomicity (both built around whole-file JSON writes), so it deserves its own focused,
  reviewed pass — and doing it now (no real data yet) is the cheapest time to migrate. The schema-version +
  migration runner built this session is engine-agnostic and carries into SQLite.

**What landed this session (books; reproducing tests first, then implementation):**
- **Schema versioning + migration runner — `apps/books/lib/migrations.js`.** Every store file carries a
  `schemaVersion`. Ordered forward migrations (`{ version, up(obj) }`) run on load — applied only when their
  version exceeds the file's (idempotent), logged (`[migrate] …`), and **never lossy** (steps only add/
  transform). `store.load()` and `global.loadGlobal()` run the runner and, when a file is upgraded, **write it
  back atomically** (tmp + rename, 0600) like a normal `save`. Seed stamps the current version so a fresh install
  starts already-migrated. The old ad-hoc `migrate(db)` became **company migration v1** (now versioned + written
  back). **Two version namespaces:** `COMPANY_SCHEMA_VERSION = 1`, `GLOBAL_SCHEMA_VERSION = 2`.
  - **Gotcha fixed:** `loadGlobal` did `{ ...defaults, ...parsed }`, which let the default's current
    `schemaVersion` **mask** a legacy file's missing one (blinding the runner). Now it trusts
    `parsed.schemaVersion` explicitly. The company path has no such merge, so it was already correct.
  - Round-trip tests: `apps/books/test/migrations.test.js` (19 checks) — legacy fixture → load → upgraded shape,
    on disk + in memory, idempotent, 0600.
- **3-role household identity (owner / bookkeeper / read-only).** The **household-shared password stays the
  implicit DEFAULT OWNER**; named principals (bookkeeper / read-only) live in `global.json` `principals`, **seeded
  empty by global schema migration v2**. Every pre-roles behavior is preserved (the 252-check smoke suite is
  unchanged).
  - **Enforcement is in the DISPATCHER auth gate** (`server.js`), beside `PUBLIC_ROUTES` + the auth check —
    never in handlers (`isOwnerOnly`/`roleAllows`/`resolveRole`). owner = everything incl. principal admin +
    backup; bookkeeper = all day-to-day/money writes but **no owner-only routes**; read-only = **GETs (+ logout)
    only**. **Fail-closed** throughout (a session naming a deleted principal → 401).
  - **Owner-only routes:** `/api/principals*`, `/api/password`, `/api/backup`.
  - **`audit.actor` now surfaces the acting principal** (`jane@ip`); the default owner + trusted-network mode
    keep the original `local@ip`, so **every pre-existing actor string is unchanged**.
  - **`/api/login`** accepts an optional `username` (named-principal login); the password-only path is untouched.
    **`/api/auth-status`** now also returns `role`/`username` (additive). Owner-only principal-admin routes in
    **`apps/books/lib/routes/principals.js`** (GET/POST/PUT/DELETE `/api/principals`), wired in `server.js`.
  - **Session model:** a session stores only the principal's `username` (null = default owner); the **role is
    re-resolved from `global.json` per request**, so deleting a principal or changing a role takes effect on the
    next request. `auth.createSession(username)` + `auth.sessionPrincipal(token)` are the new hooks.
  - Role-enforcement tests: `apps/books/test/roles.test.js` (30 checks) — each role hits/is-denied the right
    routes, named-principal login, actor attribution, deleted-principal session denial.

**Next session → FINISH the #25 structural box (durable storage), then the rules migration, then close #25 → Phase 7:**
- **Durable storage = the SQLite PR (its OWN human-reviewed PR; leave auto-merge off / request review).** Replace
  the JSON-per-company file store with SQLite while there is still no real data. **Re-derive and re-verify the two
  #24 boundaries against SQLite transactions, do not mechanically port them:** (a) secrets-at-rest
  (`lib/secrets.js` seals known leaves on the way to a whole-file write) and (b) the transactional outbox
  (`lib/outbox.js` rides the owed audit event *inside* the company JSON so it commits atomically with the mutation
  via tmp+rename). SQLite's atomicity is row/transaction-level — the outbox can become a real table + a single
  transaction, but prove exactly-once delivery + crash recovery still hold. The `schemaVersion` + migration-runner
  concept carries over (a `schema_version` table / PRAGMA user_version + ordered forward migrations). Zero-dep
  ethos + D2=B "host as-is": `better-sqlite3` is a native addon (node-gyp) and `node:sqlite` needs newer Node than
  the repo's Node 20 target — call out the dependency choice in the PR. **When that lands, all three sub-items
  (migrations ✅ + roles ✅ + durable storage) are done → the box closes → confirm #25 exit criteria → Phase 7 (#26).**
- **Migrate more domains into `@elias/rules`** (correctness/moat, not a #25 blocker): sales-tax rate + ST-50/51
  calendar, LEDES units, the 1040 planner brackets — same cited pattern, so those constants stop being inline
  literals.
- Then **Phase 7 (#26)** — suite integration + `packages/auth` (the natural home for the per-principal identity +
  role work started here). **Phase 8 (#27)** stays parallelizable but "finalize last."

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books **252**-smoke + **19**
migration + **30** role, billable, iolta, audit 16, money 22, rules 13); `npm run typecheck` clean;
`grep -c msh.team package-lock.json` = 0. Backlog: #24 CLOSED (P5); #16/#17/#18, #14, #11/#15, #12/#13/#20 closed;
#19 ratified + closed. All money through `@elias/money`, all compliance events through `@elias/audit`; new money
mutations use `store.commit`/`commitMany`, never `save(db)` + `audit.append`. **When you add save/migration paths,
preserve the atomic-save + outbox semantics from #24.**

**Gotchas (carried forward + new):**
- **NEW — schema migrations:** to add a store-file migration, append a `{ version: N, up(obj) }` step to
  `COMPANY_MIGRATIONS` / `GLOBAL_MIGRATIONS` in `lib/migrations.js` (N = next integer) and bump the matching
  `*_SCHEMA_VERSION`. **Do NOT edit an existing step** — files already at that version will not re-run it. Migrated
  files are **written back atomically on load** (so a load can write; that is intentional + idempotent, and boot
  triggers it before serving, not on a user GET). `dist/` unaffected. If you change `loadGlobal`'s file-merge,
  keep it trusting `parsed.schemaVersion` (see the masking gotcha above) or the runner goes blind.
- **NEW — roles / dispatcher gate:** authorization lives in `server.js` (`isOwnerOnly`/`roleAllows`/`resolveRole`),
  NOT in handlers. If you add an owner-only route, add its path to `isOwnerOnly`. A session stores the principal
  `username`; role is resolved fresh from `global.json` each request. `audit.actor(req)` reads `req.principal`
  (set by the dispatcher) — a named principal → `username@ip`, the default owner / trusted mode → `local@ip`
  (unchanged). New principals go in `global.json.principals` (seeded by global migration v2); never store a
  password in plaintext (`auth.hashPassword`). The 252 smoke suite runs mostly with `QUICKBUCKS_DISABLE_AUTH=1`
  (→ owner, no gate) + the default-owner login, so it exercises no 403 paths — the role paths are covered by
  `test/roles.test.js`.
- **`@elias/rules` build order:** `apps/books` depends on the built `@elias/rules` `dist/`. books' `pretest`
  builds money + audit + rules; if you run a books test file directly after editing `packages/rules/src/*`,
  **rebuild rules first** (`npm run build --workspace @elias/rules`). `dist/` is gitignored.
- **payroll params come from `@elias/rules`:** `tables2026.js` is gone; constants live in
  `packages/rules/src/payroll.ts` (cited), read via `payrollValues(year)`. Add a tax year by registering a cited
  `PayrollParams`, not a per-year JS table.
- **books transactional outbox / secrets-at-rest (#24):** money handlers call `store.commit`/`commitMany`
  (enqueue→atomic save→flush), never `save(db)` + `audit.append`. The in-memory `db` is ALWAYS plaintext;
  encryption happens only in `store.save`/`store.load` via `lib/secrets.js` (add a new secret field's path to the
  enumerated `applyToSecrets` allowlist). `/api/audit` returns `{ verified, entries }` from the tamper-evident
  chain (H1). Keep new data files 0600; keep `data/.secret.key` out of backups.
- **Do NOT `git checkout apps/billable/bin/billable.js` to drop a mode diff** — HEAD mode is **`100755`**
  (verified `git ls-files -s`). If a run flips the bit, `chmod 755` to match, NOT `chmod 644`. This session did
  not touch it.
- **`npm ci` can install incompletely** (missing `@types/node` breaks the `@elias/audit` TS build); if a package
  build fails on missing node types, **re-run `npm ci`** (hit this session; re-run fixed it). Lockfile must keep
  `grep -c msh.team package-lock.json` = 0.
- **Raw `api.github.com` curl is blocked (403)** — use `mcp__github__*` tools. `actions_list`/`actions_get`
  outputs are huge — jq the saved file for the run id + `conclusion`. Pushing docs to the branch retriggers CI —
  merge only after the run on the **final** commit concludes success.
- **billable's `test/run.js` fires async tests WITHOUT awaiting**; keep new billable tests self-consistent on the
  final `BILLABLE_HOME`. billable has no typecheck/lint in CI (plain JS) — lean on `node test/run.js`.
