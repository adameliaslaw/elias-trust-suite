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

**Session that just ran:** Phase 7 (epic #26), PR B — **built `packages/entities` (`@elias/entities`)**, the
suite's canonical firm/client/matter/user identity, and wired **books** to consume it. Also did the standing
bookkeeping flip: **PR A (#49) is MERGED** (squashed to `main` as `63ea43e`), so STATUS.md's header +
phase-tracker row 7 + Done/Not-yet-built lists were updated to record `@elias/auth` as merged. Branch
`claude/phase-7-canonical-entities-4b1p0j` off latest `main` (`63ea43e`). PR references #26 as `Refs #26` (the
epic has four checklist items left after this one).

**Merge posture:** this increment is **additive + non-security-sensitive** — a new zero-runtime-dep package plus a
read-only, additive books decoration (`GET /api/companies` gains a `canonicalId` field; no id/keying/money path
changed). Per CONTRIBUTING that makes it eligible for in-session squash-merge once CI is green on the final commit.
Repo auto-merge is disabled, so the merge is a manual `merge_pull_request` (squash). **If merged in-session, the
NEXT session must flip this PR's label to MERGED with its squash SHA** in STATUS.md's header + phase-tracker (the
standing convention).

**Why this increment:** #26's checklist item 1 is "Shared **firm / client / matter / user IDs + roles** across all
apps (canonical entities)." The survey found each app names these differently (books opaque base36 `uid()`, iolta
Firestore auto-ids + composite `trust__<uid>`, billable free-text client/matter strings) with **no shared
vocabulary** — so the "same" client can't be referenced across apps. It also found the **role vocabulary already
forked**: books/`@elias/auth` use `owner/bookkeeper/read-only` while iolta memberships use `owner/admin/member`.
`@elias/entities` is the shared identity layer that fixes both, and it unblocks the end-to-end workflow item (a
billable matter → a books client invoice → an iolta trust ledger, all the SAME canonical client).

**What landed (`packages/entities`; TS/ESM, vitest, zero runtime deps — mirrors `@elias/auth`/`@elias/money`):**
- **`src/ids.ts`** — typed, prefixed, opaque ids: `EntityKind = firm|client|matter|user`; prefixes
  `firm_`/`clnt_`/`mtr_`/`usr_`; `makeEntityId`/`firmId`/`clientId`/`matterId`/`userId`, `parseEntityId`
  (splits on the FIRST `_` only, so iolta's `trust__abc` local part survives) / `tryParseEntityId` /
  `isEntityId(v, kind?)` / `entityKindOf` / `localIdOf`. Free text → ids via `slugifyLocalId` (legible) and
  content-addressed `deriveLocalId(...parts)` / `deriveEntityId` (sha256, NUL-joined so `['a','bc']` ≠
  `['ab','c']`) — two apps that agree on a natural key derive the SAME id without coordinating. Fails closed on
  bad kind/local-id.
- **`src/entities.ts`** — minimal `CanonicalEntity` records + validating constructors `firmEntity` / `clientEntity`
  (opt. `firmId`) / `matterEntity` (requires a `clientId`) / `userEntity` (`username: null` = default owner). Each
  validates the id KIND matches the constructor. `exactOptionalPropertyTypes`-safe (optional fields spread, never
  set to `undefined`).
- **`src/membership.ts`** — the role reconciliation: `CANONICAL_ROLES` (mirrors `@elias/auth` ROLES) ↔
  `FIRM_MEMBERSHIP_ROLES` (iolta's owner/admin/member) via `normalizeMembershipRole` (admin→bookkeeper,
  member→read-only) and `toMembershipRole` (a proven bijection); `firmMembership(firmId, userId, role)`. Roles are
  string literals here, NOT imported from `@elias/auth`, on purpose — the shared packages stay decoupled (no
  inter-package build edge, same philosophy as review.ts ↔ @elias/audit); a test pins the exact list to keep
  lock-step.
- **`src/registry.ts`** — `EntityRegistry`: `register`/`get`/`has`/`entities`, `link(id, app, localRef)` +
  `resolve(app, kind, localRef)` (the cross-app join), `aliasesOf`, and `toJSON`/`fromJSON` so an app persists it.
  Fails closed: can't link an unregistered id; register/fromJSON reject an id whose prefix ≠ record kind.
- **`src/index.ts`** — the barrel. Tests: `test/{ids,entities,membership,registry}.test.ts` — **50 vitest checks**.

**books consumption (proves it's consumed, not shelf-ware; additive + read-only):**
- **`apps/books/lib/entities.js`** — a thin adapter: `firmIdFor(company)` → `firm_<company.id>`,
  `clientIdFor(customer)` → `clnt_<customer.id>`, `userIdFor(principal)` → `usr_<principal.id>` (default owner →
  `usr_owner`). Pure projection — it does NOT change how books stores/keys anything.
- **`apps/books/lib/routes/auth.js`** — `GET /api/companies` now returns each company's `canonicalId` (the firm
  id) additively. `require('../entities')` at module scope.
- **`apps/books/package.json`** — adds the `@elias/entities` dep, builds it in `pretest`, and runs
  `test/entities.test.js` (6 adapter checks) in the test script.

**Next session → keep working epic #26 (four items remain).** Highest-leverage next steps, roughly in order:
1. **Wire the attorney sign-off** (`reviewSignoff`/`verifySignoff`/`signoffAuditEvent` from `@elias/auth`) into
   each app's compliance outputs — gate an iolta reconciliation packet and a billable client invoice on a verified
   sign-off, appending `signoffAuditEvent` to that app's tamper-evident chain. The primitive exists + is tested;
   this is the integration. (Now that canonical ids exist, the signed output can carry a canonical `{kind,id}`.)
2. **Retrofit iolta + billable auth** onto `@elias/auth` the same way books is (one sign-in model). While there,
   consider using `@elias/entities` to give iolta clients / billable matters canonical ids too (billable's
   free-text client|matter is the natural `deriveEntityId('matter', client, matter)` case; iolta memberships are
   the `normalizeMembershipRole` case).
3. One suite nav shell + firm profile + home page (`canonicalId` from `GET /api/companies` is ready to key it).
4. The end-to-end Matterproof→confirmed-time→one-invoice→payment→books workflow with trust funds firewalled; then
   surface-trio (REST+CLI+web) parity. The `EntityRegistry` is the join layer for this.

**Also available (correctness/moat, parallel, not a #26 blocker):** migrate more domains into `@elias/rules`
(sales-tax rate + ST-50/51 calendar, LEDES units, 1040 planner brackets). **Phase 8 (#27)** stays parallelizable
but "finalize last."

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books **252**-smoke + 30 role +
**6 entities-adapter** + 21 migration + 9 sqlite + 11 secrets + 5 outbox + audit; **@elias/entities 50**;
@elias/auth 31; billable 56; iolta 18+16; audit 16; money 22; rules 13); `npm run typecheck` clean;
`grep -c msh.team package-lock.json` = 0. `packages/entities/dist` is gitignored (built by each consumer's
`pretest`, like the other packages). All money through `@elias/money`, all compliance events through `@elias/audit`.

**Gotchas (carried forward + new):**
- **NEW — `@elias/entities` is ESM; books is CommonJS.** books `require('@elias/entities')` works because Node
  ≥ 22.5 supports `require(esm)` (same as `@elias/auth`/`@elias/rules`). Its `dist/` must be built before books
  runs — books' `pretest` now builds `money+audit+rules+auth+entities`. If you run a books test DIRECTLY after
  editing `packages/entities/src/*`, rebuild first: `npm run build --workspace @elias/entities`.
- **NEW — entity ids are OPAQUE + fail-closed.** Don't read structure out of the local part beyond the kind
  prefix. `makeEntityId` rejects spaces/slashes/pipes and a leading non-alnum — pass free text through
  `slugifyLocalId` (legible) or `deriveLocalId` (hash) first. `parseEntityId` splits on the FIRST `_` only, so a
  local id may contain `_` (iolta `trust__abc`).
- **NEW — `@elias/entities` stays decoupled (zero inter-package deps).** The canonical role literals in
  `membership.ts` are kept in lock-step with `@elias/auth` ROLES by a pinning test, NOT a code import — so a
  future change to the role set must touch BOTH (packages/auth/src/roles.ts and packages/entities/src/membership.ts)
  and both tests will catch a drift. This is deliberate (same pattern as review.ts not importing @elias/audit).
- **NEW — the Write tool can inject a literal NUL byte where a space is typed inside a string literal**, turning
  the `.ts` file "binary" (git treats it so). If you see `git diff --numstat` show `-  -` for a source file, or
  `grep` reports "binary file matches", strip it: `perl -i -pe 's/\x00/\\u0000/g' <file>` then confirm
  `tr -cd '\000' < file | wc -c` is 0. (The two intentional NUL separators — `deriveLocalId`'s join and the
  registry alias key — are written as explicit `\u0000` escapes, so the source stays clean ASCII.)
- **`@elias/auth` sign-off is content-addressed.** `verifySignoff` hashes the CANONICALIZED output; change any
  field after signing → verification fails by design (re-sign). Array order significant; object key order not.
  Role policy is INJECTED per app (books' `ROLE_POLICY`/`isOwnerOnly` in `server.js`), not in `@elias/auth`.
- **schema migrations (SQLite tables):** append `{version:N, up(db)}` to `SCHEMA_MIGRATIONS` in
  `apps/books/lib/sqlite.js` (bumps `PRAGMA user_version`). **doc shape:** append `{version:N, up(obj)}` to
  `COMPANY_/GLOBAL_MIGRATIONS` in `lib/migrations.js` + bump the matching `*_SCHEMA_VERSION`. Don't edit an
  existing step. In-memory `db` is plaintext; secrets seal only in `store.docText`; the outbox is a TABLE (never
  write owed events into the doc). `node:sqlite` needs Node ≥ 22.5 (books `engines`); CI is 24.
- **crash-sim in tests:** `store._evict` + `audit._reset` + `sqlite._reset()` simulate a restart; durable data is
  `books.db`. `store._docText(db)` stages raw docs.
- **roles / dispatcher gate:** authorization lives in `server.js` (`isOwnerOnly`/`roleAllows`/`resolveRole`), NOT
  in handlers. New principals go in `global.json.principals` (the `global` row); role re-resolved per request.
- **package build order:** apps depend on the built `dist/`; each app's `pretest`/`pretypecheck` builds them.
  `dist/` is gitignored. No `@elias/*` package imports another today — keep it that way to avoid build-order pain.
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
