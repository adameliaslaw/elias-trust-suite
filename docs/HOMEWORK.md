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

**Session that just ran:** Phase 7 (epic #26), PR C — **wired the attorney sign-off primitive into TWO apps'
compliance outputs: the billable client invoice AND the iolta reconciliation packet.** This finishes the checklist
sub-item "wire the sign-off into each app's compliance outputs" for billable + iolta. Also did the standing
bookkeeping flip: **PR B (#50) is MERGED** (`91731ef`) — recorded in STATUS.md header + phase-tracker + Done/
Not-yet-built lists. Branch `claude/phase-7-suite-integration-ep0brc` (this is the session's designated branch; both
increments ride **one open PR, #51**). `Refs #26`.

**Merge posture — SECURITY-SENSITIVE, leave for human review.** Both increments gate money-at-rest / trust-fund
compliance deliverables on a signature check. Additive (each only *adds* a precondition) and fully test-covered, but
they touch "can this invoice/packet be issued," so per CONTRIBUTING they should NOT auto-merge. Auto-merge is
disabled repo-wide; **PR #51 is left open for the owner.** **If it gets merged, the NEXT session must flip PR #51's
label to MERGED with its squash SHA** in STATUS.md's header + phase-tracker.

### What landed — increment 1: billable client invoice (CommonJS, `node test/run.js`)
- **`apps/billable/src/signoff.js`** (pure) — `invoiceOutput(entries, client, matter)` → an `@elias/auth`
  `ComplianceOutput` keyed on the canonical `@elias/entities` matter id (`deriveEntityId('matter', client, matter)`);
  `assertInvoiceSignedOff` throws unless a present, **approved**, content-matching sign-off covers the invoice.
- **`apps/billable/src/store.js`** — `signoffsPath`/`readSignoffs`/`readSignoff`/`recordSignoff` (persists
  `signoffs.json` 0600 keyed by canonical id; chains `compliance.signoff` via `audit.appendSemantic`).
- **`apps/billable/bin/billable.js`** — new `signoff <client> <matter> --attorney "…" [--reject --note W]
  [--status]` command; `report --format ledes --bill` calls `assertInvoiceSignedOff` per invoice **before** stamping
  any billed marker (all-or-nothing). **`package.json`** adds `@elias/auth`+`@elias/entities` deps + pretest builds.
- **`apps/billable/test/signoff.test.js`** (6 checks) registered in `run.js`. billable 56 → 62.

### What landed — increment 2: iolta reconciliation packet (TS/ESM browser app, `tsx` tests)
- **`apps/iolta/src/signoff.ts`** (pure, **browser-safe**) — `packetOutput(packet)` → an `@elias/auth`
  `ComplianceOutput` keyed on the packet's `account__month__vN` doc id, content bound to the packet's sealed
  `contentHash`; `signPacket`/`verifyPacketSignoff`/`assertPacketSignedOff`/`packetSignoffAuditEvent`.
  **THE WRINKLE + HOW IT'S SOLVED:** `@elias/auth` hashes with `node:crypto`, which a Vite browser bundle can't
  load, and iolta finalizes in the browser (`App.tsx`). So signoff.ts recomputes the **identical** digest with
  `@elias/audit/core`'s portable `sha256Hex`+`stableStringify` (already the packet's hashing) and imports **only
  `@elias/auth` TYPES** (`import type`, erased at build → no `node:crypto` in the bundle; verified: `grep node:crypto
  dist/assets` is empty). `stableStringify` === `@elias/auth.canonicalize` for JSON-safe input, so the digests match.
- **`apps/iolta/src/App.tsx`** — the attest-and-finalize handler now creates the sign-off (`signPacket`, attorney =
  the attesting actor), **gates the retained deliverable** on `assertPacketSignedOff`, stores `signoff` on the
  packet doc, and chains a `compliance.signoff` event via `appendAuditEvent`.
- **`apps/iolta/test/signoff.test.ts`** (9 checks) — the **pinning test**: proves `packetOutputDigest` is
  byte-identical to the REAL `@elias/auth.outputDigest`, and `verifySignoff` agrees in BOTH directions (auth accepts
  iolta's Signoff; iolta accepts auth's) — so the browser-safe reimplementation stays lock-step with the shared
  primitive. Plus content-addressing (amend invalidates), fail-closed, event shape. **`package.json`** adds
  `@elias/auth` dep + build lists + the test.
- **`packages/audit/src/events.ts` (+core.ts/index.ts)** — `compliance.signoff` + `ComplianceSignoffPayload` added
  to the closed audit vocabulary, so iolta's typed `appendAuditEvent('compliance.signoff', …)` typechecks and the
  event is uniform suite-wide (billable emits the same shape via a loose API).

**Next session → keep working epic #26 (four items remain). Highest-leverage next steps, roughly in order:**
1. **Retrofit iolta + billable auth onto `@elias/auth`** (one sign-in model, the way books already is). This is the
   other half of the "Build packages/auth" checklist item. iolta auth is Firebase-based (`server.ts` verifies
   Firebase ID tokens) — reconcile that with `@elias/auth`'s password/session model, or scope to sharing the role
   model (`normalizeMembershipRole` from `@elias/entities` is the iolta owner/admin/member → canonical bridge).
   billable has no real auth yet (local CLI + a LAN token). **Security-sensitive → human review.** Same browser-
   safety wrinkle applies to iolta: `@elias/auth`'s password/session code is `node:crypto` and server-only — keep it
   out of the browser bundle (it belongs in `server.ts`, which is Node).
2. **One suite nav shell + firm profile + home page.** `canonicalId` from books' `GET /api/companies` is ready to
   key it. **Lower-risk / eligible for in-session merge** — good pick for an additive, non-security increment.
3. **End-to-end workflow:** Matterproof evidence → confirmed time → ONE client invoice → payment → operating books;
   earned IOLTA disbursements → operating books, trust funds firewalled. The `EntityRegistry` is the join layer.
4. **Surface-trio parity** (REST + CLI + accessible web UI) across apps.

**Also available (correctness/moat, parallel, not a #26 blocker):** migrate more domains into `@elias/rules`
(sales-tax rate + ST-50/51 calendar, LEDES units, 1040 planner brackets). **Phase 8 (#27)** parallelizable, "finalize
last."

**State of the repo:** all suites green (`npm ci` clean; `npm run typecheck` exit 0; full `npm test` exit 0; Vite
`npm run build --workspace @elias/iolta` clean, no `node:crypto` in bundle). billable **62** (was 56); iolta signoff
**9** (iolta total 18+16+7+…+9); `@elias/audit` **16** (new event type, still green); `@elias/auth` 31;
`@elias/entities` 50; `@elias/money` 22; `@elias/rules` 13; books 252 smoke + 30 + 6 + 21 + 9 + 11 + 5 + audit.
`grep -c msh.team package-lock.json` = 0. Each `@elias/*` package's `dist/` is gitignored (built by each consumer's
`pretest`; iolta's now builds money+audit+auth).

**Gotchas (carried forward + new):**
- **NEW — the browser-safety pattern for `@elias/auth` in iolta.** `@elias/auth` (and `@elias/entities`) hash with
  `node:crypto` → NOT importable at VALUE level in the Vite browser bundle. iolta's `signoff.ts` reimplements the
  digest browser-safe via `@elias/audit/core` and imports auth only as `import type`. If you extend iolta with more
  `@elias/auth` behavior, either (a) keep it type-only + reimplement via `@elias/audit/core` with a Node pinning test
  (the sign-off pattern), or (b) put the value-level `@elias/auth` use in `server.ts` (Node), never in `src/*` that
  App.tsx imports. Verify after: `grep -rl "node:crypto\|createHash\|scryptSync" apps/iolta/dist/assets` must be empty.
- **NEW — `stableStringify` (@elias/audit/core) === `canonicalize` (@elias/auth) for JSON-safe input** (both
  recursively key-sort + drop `undefined`; SHA-256 is deterministic), which is WHY the browser-safe digest matches.
  If either serializer changes, the iolta pinning test (`test/signoff.test.ts`) breaks — that's the guardrail; fix
  the reimplementation, don't skip the test.
- **NEW — adding an audit event type:** append the `*Payload` interface + an `AuditEventPayloads` entry + an
  `AUDIT_EVENT_TYPES` entry in `packages/audit/src/events.ts`, and export the type from BOTH `core.ts` and `index.ts`.
  No test pins the list length, so it's additive. Rebuild `@elias/audit` (consumers rebuild it in their pretest).
- **`@elias/auth` sign-off is content-addressed.** `verifySignoff`/`verifyPacketSignoff` recompute the hash; change
  any field after signing → verification fails by design (re-sign). Array order significant; object key order not.
- **NEW — the Write-tool NUL-byte gotcha bit the billable `bin` last increment** (injected NUL where a space was
  typed inside a `` `${...}` `` template; `git` saw the file binary). Fix: `perl -i -pe 's/\x00/ /g' <file>`, confirm
  `tr -cd '\000' < file | wc -c` is 0. Also watch **unescaped backticks inside a template literal** (USAGE string) —
  they terminate the string; `node -c <file>` catches it.
- **schema migrations (SQLite tables):** append `{version:N, up(db)}` to `SCHEMA_MIGRATIONS` in
  `apps/books/lib/sqlite.js`; **doc shape:** `COMPANY_/GLOBAL_MIGRATIONS` in `lib/migrations.js` + bump the matching
  `*_SCHEMA_VERSION`. Don't edit an existing step.
- **`@elias/entities` stays decoupled** — canonical role literals pinned to `@elias/auth` ROLES by a test, not an
  import. No `@elias/*` package imports another — keep it that way.
- **Do NOT `git checkout apps/billable/bin/billable.js`** to drop a mode diff — HEAD mode is `100755`; if a run flips
  it, `chmod 755`.
- **`npm ci` can install incompletely** (missing `@elias/*` symlink / `@types/node` → a TS build fails); **re-run
  `npm ci`** if a build fails. Keep `grep -c msh.team package-lock.json` = 0.
- **Raw `api.github.com` curl is blocked (403)** — use `mcp__github__*` tools. Pushing docs to the branch retriggers
  CI — merge only after the run on the **final** commit concludes success. `actions_list` output is huge — parse it
  with a python/jq one-liner from the saved tool-result file, not a raw Read.
- **iolta tests run via `tsx`** (Node), so they CAN use `@elias/auth`/`node:crypto` — only the browser BUNDLE can't.
  billable's `test/run.js` fires some async tests without awaiting; billable has no typecheck in CI (plain JS) — lean
  on `node test/run.js` + `node -c`.