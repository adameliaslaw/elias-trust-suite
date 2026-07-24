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

**Session that just ran:** Phase 7 (epic #26), PR C — **wired the attorney sign-off primitive into the billable
client invoice**, the first integration of `@elias/auth`'s `reviewSignoff`/`verifySignoff`/`signoffAuditEvent` into
an app's compliance output. Also did the standing bookkeeping flip: **PR B (#50) is MERGED** (squashed to `main` as
`91731ef`), so STATUS.md's header + phase-tracker row 7 + Done/Not-yet-built lists were updated to record
`@elias/entities` as merged. Branch `claude/phase-7-suite-integration-ep0brc` off latest `main` (`91731ef`). PR
references #26 as `Refs #26` (four checklist items remain after this one; the billable half of "wire the sign-off
into each app" is now done — iolta's reconciliation packet is the remaining half).

**Merge posture — SECURITY-SENSITIVE, leave for human review.** This increment gates a money-at-rest / client-facing
billing path on a signature check. It's additive (nothing pre-existing is billed differently — the gate only *adds*
a precondition) and fully test-covered, but it touches the "can this invoice be issued" decision, so per CONTRIBUTING
it should NOT auto-merge / self-merge. Auto-merge is disabled repo-wide; **leave PR C open for the owner** unless CI
+ a human review both clear it. **If it does get merged, the NEXT session must flip this PR's label to MERGED with
its squash SHA** in STATUS.md's header + phase-tracker (the standing convention).

**Why this increment:** #26's checklist item "**Build `packages/auth` … a uniform, audited attorney review/sign-off
flow on every compliance output**" had the primitive built + merged (PR #49) but not yet *integrated*. Now that
canonical entity ids exist (PR #50), the signed output can carry a canonical `{kind, id}`. The billable LEDES
invoice is the natural first target: it's the "one client invoice" the end-to-end workflow (item 4) rides on, and
billable's free-text `client|matter` is exactly the `deriveEntityId('matter', client, matter)` case the entities PR
flagged. So this advances the auth-integration item *and* threads `@elias/entities` through a real billing path.

**What landed (billable; plain CommonJS, `node test/run.js` harness):**
- **`apps/billable/src/signoff.js`** (new, pure) — `invoiceOutput(entries, client, matter)` assembles the exact
  client-billable invoice for one (client, matter) as an `@elias/auth` `ComplianceOutput`: `kind:'invoice'`,
  `id: deriveEntityId('matter', client, matter)` (canonical `@elias/entities` id), `content` = the billable entries
  reduced to compliance leaves (id/date/hours/rate/amount/aiCost/code/description, sorted by id) + integer-cents
  total. `signInvoice(...)` → `{output, signoff, event}` (wraps `reviewSignoff` + `signoffAuditEvent`).
  `invoiceSignoffValid` / `assertInvoiceSignedOff` are the gate — throw unless a present, **approved**, content-
  matching sign-off covers the current invoice.
- **`apps/billable/src/store.js`** — `signoffsPath()` / `readSignoffs()` / `readSignoff(matterId)` /
  `recordSignoff(matterId, signoff, event)`. `recordSignoff` persists to `signoffs.json` (0600, keyed by canonical
  matter id, latest-per-matter wins) and chains the `compliance.signoff` event into the tamper-evident trail via
  `audit.appendSemantic`. The audit chain retains every signature even though the JSON keeps only the latest.
- **`apps/billable/bin/billable.js`** — new `signoff <client> <matter> --attorney "Name" [--reject --note W]
  [--status]` command; and `report --format ledes --bill` now calls `assertInvoiceSignedOff` for every
  (client, matter) invoice in the export **before** stamping any billed marker (all-or-nothing; a throw is caught
  by `main().catch`, so nothing is billed). USAGE updated.
- **`apps/billable/package.json`** — adds `@elias/auth` + `@elias/entities` deps and builds them in `pretest`.
- **`apps/billable/test/signoff.test.js`** (new, 6 checks) + registered in `test/run.js`: canonical-id keying,
  content-addressing (stops verifying once the invoice grows), fail-closed on missing/rejected sign-off,
  persistence + chained `compliance.signoff` event, and a full CLI end-to-end (`--bill` refused → `signoff` →
  `--bill` succeeds → re-bill is a no-op).

**Next session → keep working epic #26 (four items remain).** Highest-leverage next steps, roughly in order:
1. **Finish item 1 — wire the sign-off onto the iolta reconciliation packet.** Mirror what billable now does: the
   iolta lifecycle (`apps/iolta/src/lifecycle.ts`) already finalizes a month into a content-hashed `FinalizedPacket`
   (attorney attest + `contentHash = sha256(canonical(body))`) — bind an `@elias/auth` `reviewSignoff` to that
   packet's content, keyed on a canonical `{kind:'iolta.reconciliation', id}` (derive a canonical id for the
   account/period), and append `signoffAuditEvent` into iolta's `audit-chain.ts`. **Note iolta is TS/ESM/vitest and
   browser-safe** — `@elias/auth`'s `reviewSignoff` uses `node:crypto`; check whether the lifecycle (browser-safe,
   imports only `@elias/audit/core`) can take a `node:crypto` dep, or compute the digest with the same
   `sha256Hex`/`stableStringify` from `@elias/audit/core` it already uses and only *store*/verify the Signoff shape.
   This is the one wrinkle — billable was easy because it's Node-only. (This IS security-sensitive → human review.)
2. **Retrofit iolta + billable auth** onto `@elias/auth` the same way books is (one sign-in model). While there,
   give iolta clients / billable matters canonical `@elias/entities` ids (billable's free-text client|matter is the
   `deriveEntityId('matter', …)` case — `signoff.js` already derives it; lift that into the entry model; iolta
   memberships are the `normalizeMembershipRole` case). (Security-sensitive → human review.)
3. One suite nav shell + firm profile + home page (`canonicalId` from `GET /api/companies` is ready to key it).
   **Lower-risk / eligible for in-session merge** — a good pick if you want an additive, non-security increment.
4. The end-to-end Matterproof→confirmed-time→one-invoice→payment→books workflow with trust funds firewalled; then
   surface-trio (REST+CLI+web) parity. The `EntityRegistry` is the join layer for this.

**Also available (correctness/moat, parallel, not a #26 blocker):** migrate more domains into `@elias/rules`
(sales-tax rate + ST-50/51 calendar, LEDES units, 1040 planner brackets). **Phase 8 (#27)** stays parallelizable
but "finalize last."

**State of the repo:** all suites green (`npm run typecheck` clean; full `npm test` exit 0). billable **62** (was 56;
+6 signoff) via `node test/run.js`; books 252 smoke + 30 roles + 6 entities-adapter + 21 migrations + 9 sqlite + 11
secrets + 5 outbox + audit; `@elias/auth` 31; `@elias/entities` 50; `@elias/audit` 16; `@elias/money` 22;
`@elias/rules` 13; iolta 18+16. `grep -c msh.team package-lock.json` = 0. Each `@elias/*` package's `dist/` is
gitignored (built by each consumer's `pretest` — billable's now builds money+audit+auth+entities).

**Gotchas (carried forward + new):**
- **NEW — the `--bill` gate is content-addressed, so a date-filtered `--bill` can fail after a whole-matter
  sign-off.** `billable signoff` signs the matter's *entire* current invoice (no date window); `report --bill` bills
  whatever `entries` the report resolved. If a future `--bill` narrows by `--from/--to`, the assembled invoice
  differs from the signed one and the gate correctly refuses (re-sign, or bill unfiltered). This is fail-closed by
  design — don't "fix" it by loosening `verifySignoff`.
- **NEW — `@elias/auth` + `@elias/entities` are ESM; billable is CommonJS.** `require(esm)` works on Node ≥ 22.5
  (CI is 24), same as books. Their `dist/` must be built before billable runs — billable's `pretest` now builds
  `money+audit+auth+entities`. If you run a billable test DIRECTLY after editing `packages/auth|entities/src/*`,
  rebuild first (`npm run build --workspace @elias/auth --workspace @elias/entities`).
- **NEW — the Write-tool NUL-byte gotcha bites CJS too.** Writing/Editing `bin/billable.js` injected literal NUL
  bytes where spaces were typed inside a `` `${...}` `` template — `git` then saw the file as binary and Edit
  couldn't match. Fix: `perl -i -pe 's/\x00/ /g' <file>` then confirm `tr -cd '\000' < file | wc -c` is 0. Also
  watch for **unescaped backticks inside the USAGE template literal** — they terminate the string (caused a
  `SyntaxError` this session; `node -c <file>` catches it fast).
- **`@elias/auth` sign-off is content-addressed.** `verifySignoff` hashes the CANONICALIZED output; change any
  field after signing → verification fails by design (re-sign). Array order significant; object key order not.
- **schema migrations (SQLite tables):** append `{version:N, up(db)}` to `SCHEMA_MIGRATIONS` in
  `apps/books/lib/sqlite.js` (bumps `PRAGMA user_version`). **doc shape:** append `{version:N, up(obj)}` to
  `COMPANY_/GLOBAL_MIGRATIONS` in `lib/migrations.js` + bump the matching `*_SCHEMA_VERSION`. Don't edit an
  existing step.
- **`@elias/entities` stays decoupled (zero inter-package deps).** Canonical role literals in `membership.ts` are
  kept in lock-step with `@elias/auth` ROLES by a pinning test, NOT a code import. No `@elias/*` package imports
  another — keep it that way to avoid build-order pain.
- **entity ids are OPAQUE + fail-closed.** Don't read structure out of the local part beyond the kind prefix.
  `makeEntityId` rejects spaces/slashes/pipes; pass free text through `slugifyLocalId` (legible) or `deriveLocalId`
  (hash) first. `deriveEntityId('matter', client, matter)` is the natural key two apps agree on without coordinating.
- **Do NOT `git checkout apps/billable/bin/billable.js`** to drop a mode diff — HEAD mode is `100755`. If a test run
  flips the bit, `chmod 755`, NOT 644. (This session's runs kept it 755.)
- **`npm ci` can install incompletely** (missing `@elias/*` symlink / `@types/node` → a TS build fails);
  **re-run `npm ci`** if a build fails. Keep `grep -c msh.team package-lock.json` = 0.
- **Raw `api.github.com` curl is blocked (403)** — use `mcp__github__*` tools. Pushing docs to the branch
  retriggers CI — merge only after the run on the **final** commit concludes success.
- **billable's `test/run.js` fires some async tests WITHOUT awaiting**; billable has no typecheck/lint in CI (plain
  JS) — lean on `node test/run.js` and `node -c` for syntax.
