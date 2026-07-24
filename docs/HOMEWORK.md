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

**Session that just ran:** Phase 7 (epic #26), first PR — **built `packages/auth` (`@elias/auth`)** and
retrofitted books to consume it. Also did Phase 6 bookkeeping: **PR 13 (#48) is MERGED** (squashed to `main` as
`31771a9`), so #25's migrations/roles/durable-storage box is fully closed; STATUS.md's header + phase-tracker were
flipped to reflect it. Branch `claude/phase-7-suite-auth-r2ajo0` off latest `main` (`31771a9`). PR references #26
as `Refs #26` (the epic has five more checklist items after this one). **Auth/security-adjacent → per
CONTRIBUTING, auto-merge is OFF and it is left for HUMAN REVIEW** (correctness rides on 31 reproducing tests +
the unchanged books suite). Repo auto-merge is disabled anyway.

**Why this PR first:** #26's checklist explicitly calls for "Build `packages/auth` (planned, never built): one
sign-in model + a uniform, audited attorney review/sign-off flow." The 3-role owner/bookkeeper/read-only model +
per-principal identity already lived in books' dispatcher (Phase 6 / #25); this lifts that core into a shared
package so every app authorizes against ONE definition, and adds the sign-off primitive the checklist names. It's
the foundation the remaining #26 items build on.

**What landed (packages/auth; TS/ESM, vitest, zero runtime deps — mirrors `@elias/money` / `@elias/rules`):**
- **`src/password.ts`** — `hashPassword` / `verifyPassword` (scrypt, per-password salt, constant-time compare,
  fails closed on malformed stored values).
- **`src/sessions.ts`** — `SessionStore` class: opaque tokens → `{createdAt,lastSeen,username}`, sliding idle +
  absolute cap, `create/validate/principal/destroy/clear`. `username: null` = the DEFAULT OWNER (household
  password). Injectable `now()` + `mintToken()` for exact tests; `.sessions` Map exposed so an app can surface a
  test hook.
- **`src/throttle.ts`** — `LoginThrottle` class: per-key (books passes client IP) brute-force lockout,
  `lockedMs/recordFail/reset/clear`, injectable clock.
- **`src/roles.ts`** — the canonical `ROLES = ['owner','bookkeeper','read-only']`, `isRole` guard, and
  `roleAllows(role, method, pathname, policy)` — the exact dispatcher decision, with the app-specific
  `isOwnerOnly` + `isWriteAllowedForReadOnly` predicates INJECTED (books names `/api/principals*`, `/api/backup`,
  `/api/password` owner-only; read-only may still `POST /api/logout`).
- **`src/cookies.ts`** — `parseCookieHeader` (never throws on a bad %-escape).
- **`src/review.ts`** — the NEW attorney sign-off primitive. `reviewSignoff(output, {attorney, decision, note,
  signedAt})` binds to a SHA-256 of the CANONICALIZED `{kind,id,content}` (key-order-stable). `verifySignoff`
  recomputes and fails once the output changes → a stale approval can't silently cover edited numbers.
  `signoffAuditEvent` renders the canonical `compliance.signoff` event for the app's tamper-evident chain (the
  package deliberately does NOT depend on `@elias/audit`; each app supplies its own). Requires an attorney;
  requires a note on a rejection.
- Tests: `test/{password,sessions,throttle,roles,cookies,review}.test.ts` — **31 vitest checks**.

**books retrofit (proves it's consumed, not shelf-ware; behavior identical):**
- **`apps/books/lib/auth.js`** is now a thin HTTP adapter over `@elias/auth`. It keeps ONLY the request glue —
  cookie extraction, the `req.socket` throttle key, the `QUICKBUCKS_DISABLE_AUTH` env flag — and delegates
  password/sessions/throttle/cookie-parsing to the package. **The exported surface is unchanged** (same function
  names + the `SESSION_*`/`LOGIN_*` constants + `_reset` + `_sessions` → `store.sessions`), so `server.js`, the
  eleven route groups, and every test are untouched.
- **`apps/books/server.js`** role gate calls the shared `roleAllows` with books' `ROLE_POLICY` injected;
  `isRole` is threaded to the principals route so the role SET is single-sourced with the gate.
- **`apps/books/lib/routes/principals.js`** validates roles via the injected `isRole` (dropped its local `ROLES`
  literal).
- **`apps/books/package.json`** adds the `@elias/auth` dep + builds it in `pretest`.

**Next session → keep working epic #26 (five items remain).** Highest-leverage next steps, roughly in order:
1. **Canonical firm/client/matter/user IDs across apps** (checklist item 1) — the shared entity layer. Likely a
   small `@elias/entities` (or fold into `@elias/auth`) so books/iolta/billable reference the same client + matter
   ids. This unblocks the end-to-end workflow item.
2. **Wire the attorney sign-off** (`reviewSignoff`/`verifySignoff`) into each app's compliance outputs — e.g.
   gate an iolta reconciliation packet and a billable client invoice on a verified sign-off, appending
   `signoffAuditEvent` to that app's chain. The primitive exists + is tested; this is the integration.
3. **Retrofit iolta + billable auth** onto `@elias/auth` the same way books now is (one sign-in model).
4. One suite nav shell + firm profile + home page; then the end-to-end Matterproof→confirmed-time→one-invoice→
   payment→books workflow with trust funds firewalled; then surface-trio (REST+CLI+web) parity.

**Also available (correctness/moat, parallel, not a #26 blocker):** migrate more domains into `@elias/rules` with
the same cited pattern — sales-tax rate + ST-50/51 calendar, LEDES units, 1040 planner brackets. **Phase 8 (#27)**
stays parallelizable but "finalize last."

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books **252**-smoke + 30 role +
11 secrets + 5 outbox + 21 migration + 9 sqlite + audit; **@elias/auth 31**; billable, iolta 18+16, audit 16,
money 22, rules 13); `npm run typecheck` clean; a clean `rm -rf node_modules && npm ci` succeeded first try;
`grep -c msh.team package-lock.json` = 0. `packages/auth/dist` is gitignored (built by `pretest`, like the other
packages). All money through `@elias/money`, all compliance events through `@elias/audit`.

**Gotchas (carried forward + new):**
- **NEW — `@elias/auth` is ESM; books is CommonJS.** books `require('@elias/auth')` works because Node ≥ 22.5
  supports `require(esm)` (same as it already does for `@elias/rules`). Its `dist/` must be built before books
  runs — books' `pretest` now builds `money+audit+rules+auth`. If you run a books test DIRECTLY after editing
  `packages/auth/src/*`, rebuild first: `npm run build --workspace @elias/auth`.
- **NEW — sign-off is content-addressed.** `verifySignoff` hashes the CANONICALIZED output; if you sign a
  document and later change ANY field, verification fails by design (re-sign). Array order is significant; object
  key order is not.
- **NEW — role policy is injected, not hardcoded in the package.** To change WHICH books paths are owner-only,
  edit `ROLE_POLICY` / `isOwnerOnly` in `server.js` — NOT `@elias/auth`. The package owns the role SET + the
  decision shape; each app owns its path policy.
- **schema migrations (SQLite tables):** append `{version:N, up(db)}` to `SCHEMA_MIGRATIONS` in
  `apps/books/lib/sqlite.js` (bumps `PRAGMA user_version`). **doc shape:** append `{version:N, up(obj)}` to
  `COMPANY_/GLOBAL_MIGRATIONS` in `lib/migrations.js` + bump the matching `*_SCHEMA_VERSION`. Don't edit an
  existing step. In-memory `db` is plaintext; secrets seal only in `store.docText`; the outbox is a TABLE (never
  write owed events into the doc). `node:sqlite` needs Node ≥ 22.5 (books `engines`); CI is 24. `books.db` uses
  `journal_mode=DELETE` — don't switch to WAL without teaching the tar backup about the sidecars.
- **crash-sim in tests:** `store._evict` + `audit._reset` + `sqlite._reset()` simulate a restart; durable data is
  `books.db`. `store._docText(db)` stages raw docs.
- **roles / dispatcher gate:** authorization lives in `server.js` (`isOwnerOnly`/`roleAllows`/`resolveRole`), NOT
  in handlers. New principals go in `global.json.principals` (the `global` row); role re-resolved per request.
- **`@elias/rules`/`@elias/auth` build order:** apps depend on the built `dist/`; books' `pretest` builds them.
  `dist/` is gitignored.
- **payroll params come from `@elias/rules`** (`payrollValues(year)`); add a tax year by registering a cited
  `PayrollParams`, not a per-year JS table.
- **Do NOT `git checkout apps/billable/bin/billable.js`** to drop a mode diff — HEAD mode is `100755`. If a run
  flips the bit, `chmod 755`, NOT 644. This session did not touch it.
- **`npm ci` can install incompletely** (missing `@elias/*` symlink / `@types/node` → a TS build fails);
  **re-run `npm ci`** if a build fails. Keep `grep -c msh.team package-lock.json` = 0.
- **Raw `api.github.com` curl is blocked (403)** — use `mcp__github__*` tools. Pushing docs to the branch
  retriggers CI — merge only after the run on the **final** commit concludes success.
- **billable's `test/run.js` fires async tests WITHOUT awaiting**; billable has no typecheck/lint in CI (plain
  JS) — lean on `node test/run.js`.
