# Status — Elias Trust Suite

> **Living handoff. A new session should read this file first,** then
> [HOMEWORK.md](HOMEWORK.md) for exactly where to start, then the epic issue for the phase.
> Canonical plan: [CONSOLIDATION_PLAN.md](CONSOLIDATION_PLAN.md) · Findings narrative:
> [EVALUATION.md](EVALUATION.md) · Backlog: GitHub Issues **#11–#27**.
> Last updated: 2026-07-24 — **Phase 7 (#26) IN PROGRESS: `@elias/auth` MERGED (PR #49 → `63ea43e`); `@elias/entities`
> MERGED (PR #50 → `91731ef`); this session wired the **attorney sign-off gate onto the billable client invoice**
> (PR C, open). Phase 6 (#25) is
> fully CLOSED — its last PR is MERGED: PR 13 (#48) squash-merged to `main` as `31771a9` (durable storage on
> SQLite via built-in `node:sqlite`; secrets-at-rest + transactional outbox re-derived against SQLite
> transactions).** Phase 7's first PR is **MERGED: PR A (#49) squash-merged to `main` as `63ea43e`** —
> **`@elias/auth`** — the per-principal identity + 3-role model that first landed in books' dispatcher is lifted
> into a shared, tested package so every app authorizes against ONE definition. It provides the transport-agnostic
> primitives (scrypt password hash/verify, a server-side `SessionStore` with sliding-idle + absolute caps, a
> `LoginThrottle`, the canonical `owner/bookkeeper/read-only` role SET + `roleAllows(role,method,path,policy)`
> decision + `isRole` guard, `parseCookieHeader`) plus a NEW uniform **attorney sign-off** primitive: a
> content-addressed `reviewSignoff`/`verifySignoff` (SHA-256 of the canonicalized compliance output) so a stale
> approval can never cover later edits, with `signoffAuditEvent` for the app's tamper-evident chain. 31 vitest
> checks. **books CONSUMES it** (not shelf-ware): `lib/auth.js` is now a thin HTTP adapter delegating
> password/sessions/throttle/cookies to `@elias/auth` (exported surface unchanged → server.js, route groups, tests
> untouched); the dispatcher role gate calls the shared `roleAllows` with books' owner-only + logout policy
> injected; the principals route validates via shared `isRole`. All books suites unchanged and green (252 smoke +
> 30 roles + …). Earlier Phase-6 PRs (all MERGED): PR 12 (#47, `5a94a6f`) migration runner + 3-role identity;
> PR 1 (#36, `361e900`) `packages/rules` moat + payroll retrofit + tax fixes; PR 2–11 (#37–#46) the incremental
> server split. Phase 7's second PR is **MERGED: PR B (#50 → `91731ef`)** — `@elias/entities` (canonical
> firm/client/matter/user IDs + `EntityRegistry` + role reconciliation; books consumes it). **This session (PR C,
> open):** the first integration of the sign-off primitive — the **billable client invoice is now gated on a
> content-addressed attorney sign-off**. `apps/billable/src/signoff.js` assembles the exact invoice for one
> (client, matter) as an `@elias/auth` `ComplianceOutput` keyed on the canonical `@elias/entities` matter id
> (`deriveEntityId('matter', client, matter)`); `report --format ledes --bill` refuses to stamp the
> mutually-exclusive billed marker unless a matching, APPROVED `reviewSignoff` is on record, and a new
> `billable signoff <client> <matter> --attorney …` command records it (persisted in `signoffs.json`, keyed by
> canonical id, with a `compliance.signoff` event chained into billable's tamper-evident trail via
> `signoffAuditEvent`). Editing the invoice after sign-off changes the content hash, so a stale approval can never
> cover mutated numbers. 6 new reproducing tests (billable 56 → 62).**
> Phase 5 (#24) ✅ done + MERGED (PR #34); Phase 0 (#19) ✅ ratified
> (D1=C, D2=B, D3=C split-by-domain, D4=B). Phase 5 = data + audit hardening; all 8 checklist
> items landed with reproducing tests: fail-closed iolta verify against the recorded head + surfaced offline
> queue (#16); billable ledger reads the full last line so a >8 KB line no longer self-corrupts the chain (H2);
> books `/api/audit` now serves the tamper-evident chain, not the forgeable `db.auditLog` (H1); books secrets
> (Plaid/ACH/employee-bank) are AES-256-GCM encrypted at rest with the key kept out of backups + 0600 files
> (#24); books GETs no longer mutate state and a tampered chain no longer 400s a read (M8); session cookies
> gain `Secure` over TLS (L3); per-company mutation serialization (M7); LawPay `markRequested` idempotent on
> retry. **The last item now closed:** Clio `pushEntries` records a durable pre-POST intent and reconciles a
> dangling one instead of re-POSTing (no duplicate Clio activity on retry); books money mutations commit
> atomically with their audit append via a transactional outbox (owed event rides in the company JSON,
> delivered idempotently, recovered on boot).
> Prior: Phase 4 (#23) complete: Matterproof billing redesign. AI runtime is
> cost/provenance metadata only — inferred attorney time defaults to **zero**; a billable minute exists only
> once an attorney confirms human minutes (#17). Client exports are reviewed-only, mutually exclusive, and
> idempotent — one `billed` marker, a second export is a no-op (#18). Rate is snapshotted at review (no
> retroactive repricing); LEDES units are exact at any increment with correct multi-matter grouping (M5);
> `capturePrompts:false` is enforced on every write path (M6); malformed JSONL fails loud; Clio OAuth adds
> state + PKCE + callback timeout. The Phase 1 `BILLABLE_ALLOW_CLIENT_EXPORTS` stopgap is removed — billing is
> safe by structure now. All with reproducing tests. Phases 1–3 (#20/#21/#22) landed before it.

## Product

Trust / finance / accounting suite for a solo NJ law practice. npm workspaces: `apps/*`,
`packages/*`. Node 20+. **Current stage: pre-product** — three apps + two shared libs, not yet one
integrated product.

## Maturity (honest)

| Surface | Functionality | Differentiation | Ease of use | Value today |
|---|---|---|---|---|
| **Books** | Internal beta; broad, useful | High for Schedule Elias; ordinary elsewhere | Moderate | High for owner; moderate externally |
| **IOLTA** | Alpha; foundational reconciliation flaws | Moderate now; high as NJ audit-readiness product | Approachable UI, incomplete workflow | High potential, unreliable today |
| **Matterproof** | Alpha; billing safe by structure | Very high conceptually | Developer-oriented | High potential; client bills now gated on attorney-confirmed minutes + review |
| **Suite** | Pre-product | Strong collection of ideas | Low — three setups/identities | High internal potential, low current sellability |

## Reality check on prior claims

The previous STATUS asserted "480 checks green" and a sound audit/reconciliation story. Verified
2026-07-22; Phase 1 (#20) has since fixed the items marked **FIXED** below:
- ✅ `npm ci` clean (0 vulns); typecheck clean; suites pass.
- ✅ **FIXED (#20)** — billable `test/audit.test.js:127` flake removed (structural leaf-value check,
  not a `"300"` substring). Verified green 10/10 runs → **CI is now deterministic.**
- ✅ **FIXED (#12)** — IOLTA PDF import uses the `pdf-parse` v2 `PDFParse` class; covered by a
  real-PDF fixture test.
- ✅ **FIXED (#11)** — IOLTA reconciliation now reconciles four independent streams (bank / book /
  statement / match); a bank line never booked surfaces as a discrepancy. Reproducing test added.
- ✅ **FIXED (#13)** — a month with no statement balance is now `incomplete`, never "Reconciled";
  only a genuinely reconciled month seals `reconciliation.completed`. Reproducing test added.
- ✅ **FIXED (#14, Phase 3)** — reconciliation now has a real lifecycle: draft → resolve exceptions →
  attorney attest → finalize → immutable lock. A finalized month freezes bank/book/statement/match inputs +
  computed legs into a hash-chained packet (`src/lifecycle.ts`), retained 7 years (Rule 1:21-6), reproducible
  byte-for-byte; a locked month rejects edits/adds/deletes to any transaction dated within it. Amend/reopen
  requires a reason + new version. Reproducing tests in `test/lifecycle.test.ts`.
- ✅ **FIXED (M2, Phase 3)** — `reconciliation.completed` is sealed ONLY on the deliberate attested finalize
  (debounced auto-emit removed), and its `bankBalanceCents` now carries the adjusted bank balance so
  `book − bank === difference` (was self-contradictory). Reproducing test added.
- ✅ **FIXED (Phase 3)** — uploaded source statements are retained (content-hashed copy under
  `uploads/retained/`), not always deleted, so a finalized packet reproduces from the exact source.
- ✅ **FIXED (#16, Phase 5)** — iolta `verifyAuditChain` now reconciles the sealed entries against the
  recorded CAS head (`auditMeta/{uid}`) and the offline queue: dropped tail entries, a rewound/missing head,
  or any unflushed localStorage events fail closed (`verifyChainState` in `src/audit-chain.ts`). Reproducing
  tests in `test/audit.test.ts`.
- ✅ **FIXED (#15)** — firms→memberships→trust-accounts hierarchy; period doc IDs are account/uid-scoped
  (`{accountId}__{month}`), no hardcoded `iolta-trust`. Two firms/accounts coexist without collision
  (reproducing test). Rules written; deployment deferred (Phase 8 / #27).
- ✅ **FIXED (#24, Phase 5)** — books secrets (Plaid client secret + access tokens, firm/NJ ACH bank details,
  employee direct-deposit routing/account) are AES-256-GCM encrypted at the store boundary (`lib/secrets.js`);
  the in-memory db stays plaintext so callers are unchanged. Key from `QUICKBUCKS_ENCRYPTION_KEY` or a 0600
  `data/.secret.key` **excluded from backups** (ciphertext-only tarballs); company files + global.json written
  0600. Also H1 (`/api/audit` shows the tamper-evident chain), H2 (billable >8 KB line), M7 (per-company
  mutation lock), M8 (GETs read-only), L3 (Secure cookie over TLS). Reproducing tests throughout.
- ✅ **FIXED (#24, Phase 5 — atomicity/idempotency, final item)** — the cross-app write-atomicity work.
  billable Clio `pushEntries` (`apps/billable/src/clio.js`) records a durable, hash-chained pre-POST intent
  (`clio.push_intent` ledger event, mirroring LawPay's deterministic-reference dedup); on retry a dangling
  intent triggers a reconcile query that adopts the existing Clio activity instead of re-POSTing (POSTs only
  when the prior attempt never landed, fails closed on ambiguity), so a crash between a successful POST and
  `store.writeOverride({clioId})` no longer duplicates the Clio activity. books money mutations now commit
  atomically with their audit append via a transactional outbox (`apps/books/lib/outbox.js`): the owed audit
  event rides inside the atomically-saved company JSON, a relay delivers it to the tamper-evident chain
  idempotently (`audit.appendIdempotent`, keyed on the outbox message id), and boot-time `recoverAll`
  redelivers anything a crash interrupted — closing the silent-gap window between `save()` and
  `audit.append()`. `store.commit`/`commitMany` replaced the non-atomic pattern in every money handler.
  Reproducing tests in `apps/billable/test/run.js` and `apps/books/test/outbox.test.js`.
- ✅ **FIXED (#17, #18, Phase 4)** — Matterproof no longer invents attorney time. AI runtime is
  cost/provenance metadata only; billable `hours` default to zero and become non-zero solely when an
  attorney confirms human minutes (`entries.js`; `finishTask` records `suggestedHours`, `applyOverride`
  computes `billable`). Client exports (LEDES/HTML/LawPay/Clio) are structurally reviewed-only,
  attorney-confirmed, and mutually-exclusive with a single idempotent `billed` marker
  (`src/client-billing.js`); a second export of an entry is a no-op. Rate is snapshotted at review
  (`reviewRateSnapshot`), so the rate table never reprices historical entries. The Phase 1
  `BILLABLE_ALLOW_CLIENT_EXPORTS` env stopgap is removed. Reproducing tests in `test/phase4.test.js`.
- ✅ **FIXED (M5, M6, JSONL, Clio, Phase 4)** — LEDES units exact at any increment + multi-matter
  grouping (`ledes.js`); `capturePrompts:false` enforced at the single write choke point
  (`store.appendEvent`); malformed ledger records fail loud (`store.readEvents`); Clio OAuth adds
  state + PKCE + callback timeout (`clio.js`). Reproducing tests added.

The tests are valuable but largely do not cover these paths.

## Phase tracker

| Phase | Epic | Status |
|---|---|---|
| 0 — Define the product | #19 | ✅ Done — decision memo ratified by owner (D1=C, D2=B, D3=C, D4=B) 2026-07-23 |
| 1 — Contain risk + regression tests | #20 | ✅ Done — CI deterministic |
| 2 — Rebuild IOLTA accounting model | #21 | ✅ Done (#11, #15 closed) |
| 3 — Reconciliation lifecycle + retention | #22 | ✅ Done (#14 closed) |
| 4 — Redesign Matterproof billing | #23 | ✅ Done (#17, #18 fixed) |
| 5 — Data + audit hardening | #24 | ✅ Done — PR #34 merged (8/8; Clio retry dedup + books transactional outbox) |
| 6 — Books role + `packages/rules` | #25 | ✅ **Done** (exit criteria met; epic closed by owner). PR 1 MERGED (#36): `@elias/rules` + payroll retrofit + tax fixes. PR 2–11 MERGED (#37–#46): full `server.js` split (all 11 route groups in `lib/routes/*`). PR 12 MERGED (#47, `5a94a6f`): schema-version + migration runner + 3-role household identity. **PR 13 MERGED (#48, `31771a9`): durable storage — SQLite (`node:sqlite`) replaces the JSON file store; secrets-at-rest + transactional outbox re-derived against SQLite transactions.** All three sub-items (migrations + roles + durable storage) done → the migrations/roles/storage box closed. Remaining rules-domain migrations (sales-tax/LEDES/1040) tracked as correctness follow-ups, not #25 blockers. |
| 7 — Suite integration + `packages/auth` | #26 | 🟨 **In progress** — PR A MERGED (#49, `63ea43e`): **`@elias/auth` built** (shared identity core: password/sessions/throttle/roles/cookies + attorney sign-off; 31 tests) and books retrofitted to consume it. PR B MERGED (#50, `91731ef`): **`@elias/entities` built** — canonical firm/client/matter/user ID model (typed prefixed opaque IDs + parse/format/validate + `EntityRegistry` cross-app lookup + role reconciliation); books consumes it. PR C (this session, open): **attorney sign-off wired into the billable client invoice** — `report --format ledes --bill` is gated on a content-addressed `reviewSignoff` keyed on the canonical matter id, with a `billable signoff` command + a `compliance.signoff` audit event (6 tests, billable 56→62). Remaining #26 checklist: the same sign-off gate on the iolta reconciliation packet, iolta/billable auth retrofit, a suite nav shell + home, the end-to-end Matterproof→invoice→payment→books workflow, and surface-trio parity. |
| 8 — Release engineering | #27 | ⬜ Parallelizable; finalize last |

## Done (real, keep)

- Repo scaffold (workspaces, tsconfig.base.json, CI on push/PR, repo public).
- `packages/money` (`@elias/money`) — exact bigint-cents; no float; no equality epsilon. 22 tests.
- `packages/audit` (`@elias/audit`) — hash-chained JSONL, pure-TS SHA-256, verify-on-open. 16 tests.
- `packages/rules` (`@elias/rules`) — versioned, effective-date-keyed, **cited** rule sets (every constant
  → its primary source); payroll retrofitted, engine consumes `payrollValues(year)`. 13 tests. (Phase 6 / #25)
- `packages/auth` (`@elias/auth`) — the suite's shared identity core (Phase 7 / #26): scrypt password
  hash/verify, a server-side `SessionStore` (sliding-idle + absolute caps, invalidate-all), a `LoginThrottle`,
  the canonical `owner/bookkeeper/read-only` role SET + `roleAllows(role,method,path,policy)` decision +
  `isRole`, `parseCookieHeader`, and a content-addressed attorney **sign-off** (`reviewSignoff`/`verifySignoff`/
  `signoffAuditEvent`). Zero runtime deps; 31 tests. books consumes it (its `lib/auth.js` is now a thin HTTP
  adapter; the dispatcher role gate + principals route call the shared policy).
- `packages/entities` (`@elias/entities`) — the suite's canonical firm/client/matter/user identity (Phase 7 /
  #26): typed, prefixed, opaque ids (`firm_`/`clnt_`/`mtr_`/`usr_`) with `makeEntityId`/`parseEntityId`/
  `isEntityId`/`entityKindOf` + `slugifyLocalId` (free text → legible id) and content-addressed `deriveLocalId`
  (a natural key two apps can agree on → the SAME id); minimal `CanonicalEntity` records
  (`firmEntity`/`clientEntity`/`matterEntity`/`userEntity`); an `EntityRegistry` that links each app's local id
  to a canonical one (`register`/`link`/`resolve`, JSON-serializable); and the firm-membership role
  reconciliation (`normalizeMembershipRole`/`toMembershipRole` — iolta's owner/admin/member ↔ the canonical
  owner/bookkeeper/read-only, resolving the fork the survey flagged). Zero runtime deps; 50 tests. books consumes
  it (`lib/entities.js` adapter maps company→firm / customer→client / principal→user ids; `GET /api/companies`
  now surfaces each firm's `canonicalId`).
- billable client-invoice attorney sign-off gate (Phase 7 / #26, PR C): `apps/billable/src/signoff.js` assembles
  the exact LEDES invoice for one (client, matter) as an `@elias/auth` `ComplianceOutput` keyed on the canonical
  `@elias/entities` matter id (`deriveEntityId('matter', client, matter)`). `report --format ledes --bill` is gated
  on a matching, **approved**, content-addressed `reviewSignoff` (`assertInvoiceSignedOff`) — an unsigned,
  rejected, or stale-signed invoice can't be billed; editing the invoice after sign-off invalidates it. The
  `billable signoff <client> <matter> --attorney …` command records the decision (`signoffs.json`, keyed by
  canonical id) and chains a `compliance.signoff` event into the tamper-evident trail via `signoffAuditEvent`.
  6 reproducing tests (`test/signoff.test.js`); billable 56 → 62.
- `apps/books` ← quickbucks; `apps/iolta` ← IOLTA-Reconciliation; `apps/billable` ← Billable.ai —
  all migrated, money + audit wired at the calc layer.
- books schema-version + migration runner (`apps/books/lib/migrations.js`, Phase 6 / #25): every store file
  carries a `schemaVersion`; ordered forward migrations run on load, idempotent + logged + never-lossy, with
  atomic write-back. Round-trip tested (`test/migrations.test.js`, 19 checks).
- books 3-role household identity (Phase 6 / #25): owner / bookkeeper / read-only. Shared password = implicit
  default owner; named principals in `global.json` (seeded empty by global schema migration v2); enforced in the
  dispatcher auth gate; actor surfaced through `audit.actor`. Role-enforcement tested (`test/roles.test.js`,
  30 checks).
- books durable storage on SQLite (Phase 6 / #25, PR 13 / #48): the JSON-per-company file store is replaced by
  `data/books.db` via the built-in `node:sqlite` (`lib/sqlite.js`) — **zero runtime dependency, no node-gyp**
  (better-sqlite3 rejected; Node floor moved 20→22.5, CI is 24). Each company is one JSON doc in a `company` row,
  household in a single `global` row; the in-memory model is unchanged so all handlers + the 252-check smoke suite
  are untouched. Secrets-at-rest still seal known leaves before write (ciphertext inside `books.db`, 0600, keyfile
  out of backups). The transactional outbox is now a real `outbox` TABLE committed in ONE SQLite transaction with
  the mutation — exactly-once delivery + crash recovery + rollback atomicity proven. Two migration layers: SQLite
  tables by `PRAGMA user_version`, doc shape by the carried-over `schemaVersion` runner. Lossless JSON→SQLite
  import on first boot (renames legacy files aside; drains any pending in-doc outbox into the table). Tests:
  `test/sqlite.test.js` (9), re-derived `test/outbox.test.js` (5), `test/secrets.test.js` (11),
  `test/migrations.test.js` (21).

## Blocked on owner

- ✅ **RESOLVED — Product-definition decisions (#19) ratified 2026-07-23.** D1=C (internal-first,
  multi-tenant-capable), D2=B (hosting as-is), **D3=C (split by domain — suite owns trust/time/matters,
  integrates with a real GL for invoices/AR)**, D4=B (Payroll/Bills migrations paused). Recorded in
  CONSOLIDATION_PLAN.md (Product decisions). Phase 2's schema needed no change (already built on D3=C).
  **Phase 6 (#25) DONE; Phase 7 (#26) now unblocked.**
- iolta `firebase deploy --only firestore:rules` (rules still undeployed). (#27)
- Payroll: set `PAYROLL_ENCRYPTION_KEY`. plaid-bill-tracker: rotate Plaid creds + purge git history.
  Both migrations **paused** pending #19.

## Not yet built (planned packages)

`packages/auth` (Phase 7 / #26) — ✅ **built + MERGED** (PR #49 → `63ea43e`; the per-principal identity + 3-role
model started in books is lifted into `@elias/auth`; books consumes it). `packages/entities` (Phase 7 / #26) —
✅ **built + MERGED** (PR #50 → `91731ef`; canonical firm/client/matter/user IDs + `EntityRegistry` + role
reconciliation; books consumes it). Still to do under #26: wire the attorney sign-off into the **iolta**
reconciliation packet (the **billable** client invoice is now gated — PR C, this session); retrofit iolta +
billable auth onto `@elias/auth`; a suite nav shell + home; the end-to-end workflow; surface-trio parity. ·
`packages/plaid` (deferred with bill-tracker migration).
`packages/rules` (`@elias/rules`) now **built** (Phase 6 / #25): versioned, effective-date-keyed, cited;
payroll retrofitted. Remaining Phase 6 domains to migrate into it in later PRs: sales-tax rate + ST-50/51
calendar, LEDES units, and the 1040 planner brackets.

**Books durable-storage direction (Phase 6 / #25): DONE (PR 13 / #48, this session).** SQLite (built-in `node:sqlite`)
replaced the JSON-per-company file store while there was no real data. The #24 secrets-at-rest + transactional-
outbox boundaries were re-derived against SQLite transactions (not mechanically ported): secrets seal before the
doc is written; the outbox is a real table committed in one transaction. The engine-agnostic `schemaVersion`
runner carried over as the doc-shape layer; SQLite tables are versioned by `PRAGMA user_version`. Left for
**human review** (money-at-rest), auto-merge OFF. This closes the last sub-item of the migrations/roles/storage
box.

## Verification environment notes

- `npm ci` works cleanly here (no puppeteer/Chromium trap). Lockfile is clean
  (`grep -c msh.team package-lock.json` = 0).
- iolta pulls `xlsx` from a CDN tarball (fragile — Phase 8 / #27).
- iolta `start` now runs `NODE_ENV=production tsx server.ts` (with a `prestart` build) — `node
  server.ts` couldn't run TypeScript under Node 20. Full deploy config (PORT/env loading) is Phase 8.
- Matterproof client exports are no longer gated by an env var (Phase 4 removed the
  `BILLABLE_ALLOW_CLIENT_EXPORTS` stopgap). They are gated structurally: only reviewed,
  attorney-confirmed, unbilled entries can reach a client, and each bills once.
- Test runs may `chmod +x` `apps/billable/bin/billable.js` (mode-only diff) — discard it.
