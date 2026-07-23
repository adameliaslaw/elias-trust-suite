# Status — Elias Trust Suite

> **Living handoff. A new session should read this file first,** then
> [HOMEWORK.md](HOMEWORK.md) for exactly where to start, then the epic issue for the phase.
> Canonical plan: [CONSOLIDATION_PLAN.md](CONSOLIDATION_PLAN.md) · Findings narrative:
> [EVALUATION.md](EVALUATION.md) · Backlog: GitHub Issues **#11–#27**.
> Last updated: 2026-07-23 — **Phase 5 (#24) ✅ done + MERGED (PR #34); Phase 0 (#19) ✅ ratified by owner
> (D1=C, D2=B, D3=C split-by-domain, D4=B) → Phase 6 (#25) now unblocked.** Phase 5 = data + audit hardening; all 8 checklist
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
| 6 — Books role + `packages/rules` | #25 | ⬜ **Unblocked** (Phase 0 ratified) — next engineering phase |
| 7 — Suite integration + `packages/auth` | #26 | ⬜ Blocked on 2–6 (needs 6) |
| 8 — Release engineering | #27 | ⬜ Parallelizable; finalize last |

## Done (real, keep)

- Repo scaffold (workspaces, tsconfig.base.json, CI on push/PR, repo public).
- `packages/money` (`@elias/money`) — exact bigint-cents; no float; no equality epsilon. 22 tests.
- `packages/audit` (`@elias/audit`) — hash-chained JSONL, pure-TS SHA-256, verify-on-open. 16 tests.
- `apps/books` ← quickbucks; `apps/iolta` ← IOLTA-Reconciliation; `apps/billable` ← Billable.ai —
  all migrated, money + audit wired at the calc layer.

## Blocked on owner

- ✅ **RESOLVED — Product-definition decisions (#19) ratified 2026-07-23.** D1=C (internal-first,
  multi-tenant-capable), D2=B (hosting as-is), **D3=C (split by domain — suite owns trust/time/matters,
  integrates with a real GL for invoices/AR)**, D4=B (Payroll/Bills migrations paused). Recorded in
  CONSOLIDATION_PLAN.md (Product decisions). Phase 2's schema needed no change (already built on D3=C).
  **Phase 6 (#25) is now unblocked;** Phase 7 (#26) still needs 6.
- iolta `firebase deploy --only firestore:rules` (rules still undeployed). (#27)
- Payroll: set `PAYROLL_ENCRYPTION_KEY`. plaid-bill-tracker: rotate Plaid creds + purge git history.
  Both migrations **paused** pending #19.

## Not yet built (planned packages)

`packages/rules` (versioned, cited — Phase 6 / #25) · `packages/auth` (Phase 7 / #26) ·
`packages/plaid` (deferred with bill-tracker migration).

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
