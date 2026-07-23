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

**Session that just ran:** Phase 5 (epic #24) — data + audit hardening. **7 of 8** checklist items landed with
reproducing tests; one PR opened off `main` (branch `claude/phase-5-kickoff-tintze`). Critical #16 closed.
**Auto-merge is intentionally OFF** (money-at-rest + security: encryption, cookies, store locking are not
fully covered by CI semantics) — request human review, per CONTRIBUTING's exception.

**What landed this session (each with a reproducing test):**
- **#16 (critical) — iolta fail-closed verify.** `src/audit-chain.ts` gains `verifyChainState(docs, head,
  pendingCount)`; `src/audit.ts#verifyAuditChain` now fetches the CAS head (`auditMeta/{uid}`) + reads the
  offline queue and reconciles all three. Dropped tail entries, a missing/rewound head, or unflushed queued
  events fail closed (before, a truncated chain verified "ok"). 7 new cases in `test/audit.test.ts`.
- **H2 — billable `readLastLine`** (`src/audit.js`) scans backward in chunks to read the WHOLE last line, so a
  >8 KB ledger line no longer resets seq to 0 and self-corrupts the chain.
- **H1 — books `/api/audit`** returns `{ verified, entries }` from the hash-chained file via new
  `audit.entries()`, not the forgeable `db.auditLog`. Frontend audit card renders the chain + a verified badge.
- **#24 — books secrets at rest.** New `lib/secrets.js` (AES-256-GCM) seals known secret leaves at the store
  boundary (`store.save`→`sealForStorage`, `store.load`→`openFromStorage`); in-memory db stays plaintext.
  Key: `QUICKBUCKS_ENCRYPTION_KEY` or a 0600 `data/.secret.key` **excluded from backups**; company files +
  global.json written 0600. Plaintext (pre-encryption) passes through decrypt and seals on next save.
- **M8 + L3 — books.** `generateRecurring` removed from GET handlers → new `scheduleRecurring()` (startup +
  daily) + the recurring write path; a tampered chain no longer 400s a read. Cookies get `; Secure` over TLS
  (`secureAttr(req)`).
- **M7 — books.** Per-company `withCompanyLock` serializes each non-GET request's read-modify-save-append.
- **LawPay idempotency (partial of the outbox item).** `lawpay.markRequested` is now idempotent on its
  deterministic reference (a retry appends no duplicate `payment_request`; A/R counts it once).

**Remaining Phase 5 item (defer to a follow-up, keep #24 open):** the BROAD *non-atomic financial+audit
writes across apps* + *Clio external-side dedup* / transactional-outbox. What's genuinely left:
  - **Clio push retry safety (`apps/billable/src/clio.js#pushEntries`)** — if the Clio POST succeeds but the
    process dies before `store.writeOverride({clioId})`, a retry re-POSTs and duplicates the Clio activity.
    Needs an idempotency key sent to Clio (external-API dependent) or a pre-POST outbox intent record. LawPay
    is already safe (deterministic reference + this session's duplicate guard).
  - **books crash-atomicity of save()+audit.append** — M7 removes the *interleave* race, but the JSON `save()`
    and the separate audit JSONL append are still two writes; a crash between them can leave them out of step.
    A true transactional outbox (write intent → apply → mark done) would close this. Medium/large; design it
    deliberately, don't rush.
Prior session: Phase 4 (epic #23) — all items done; criticals #17/#18 closed.

**Decision context:** #19 **Decision 3 (system of record) is still unratified** (no sign-off comment, box
unchecked as of this session). Phase 4 is decision-safe under the recommended default C: time capture with
attorney-confirmed provenance and a reviewed-once export is squarely the suite's own time-capture domain. No
invoice/payment/AR "system of record" object was built — LEDES/Clio/LawPay stay integration *destinations*,
not a general ledger.

**What landed (commit SHA `dc598c2`):**
- **#17 — inferred time = zero (`apps/billable/src/entries.js`).** `finishTask` records the machine estimate
  as `suggestedHours` and sets billable `hours: 0`, `confirmed: false`; AI runtime stays as `seconds`
  (cost/provenance). A manual entry is attorney-entered, so it's `confirmed: true` by construction.
  `applyOverride` marks `entry.confirmed` when an attorney supplies hours, computes `entry.billable`
  (`!writeOff && confirmed && hours>0`), and prices the fee only for billable entries. `totals` gained
  `unconfirmed`/`billableCount`.
- **#18 — reviewed-only, mutually-exclusive, idempotent billing (new `apps/billable/src/client-billing.js`).**
  A single `billed` marker (`{destination, reference, at}`; legacy `lawpayRef`/`clioId` still count).
  `isClientBillable`/`classifyForClient` require reviewed + confirmed + not-written-off + not-already-billed,
  applied on EVERY client path: `ledes.js` and `report.js#htmlInvoice` filter internally; `lawpay.js`
  `classifyForBilling` and `clio.js` `classifyForPush` classify against the unified marker. `store.markBilled`
  + CLI `report --format ledes --bill` record a LEDES invoice as issued. Second export of an entry = no-op.
- **Rate snapshot at review** — `client-billing.reviewRateSnapshot` freezes `config.rate` onto the override
  the first time `reviewed` flips true (wired into `server.js` `/api/override`); `applyOverride` prices from
  `entry.rate` (snapshot), so the rate table never reprices historical entries.
- **M5 LEDES (`ledes.js`)** — `formatUnits` emits exact units (no hardcoded tenths); unit cost = the entry's
  snapshot rate; `units × unit-cost === line total` at tenths and quarter-hours. Multi-matter files group
  into one invoice per client/matter (`matterInvoiceNumber`), each with its own INVOICE_NUMBER/INVOICE_TOTAL
  and per-invoice line numbering.
- **M6 (`store.js`)** — `scrubForPrivacy` in `store.appendEvent` blanks prompt `detail` when
  `capturePrompts:false`, at the single choke point every writer (CLI `log`, POST /api/log, extension) passes
  through.
- **Fail-loud JSONL (`store.js`)** — `readEvents` throws (naming the line number) on a malformed record
  instead of silently dropping it.
- **Clio OAuth (`clio.js`)** — `buildAuthRequest` adds `state` + PKCE (S256); `waitForCode({expectedState,
  timeoutMs, onListening})` validates state (CSRF) and enforces a callback timeout; `exchangeToken` sends the
  `code_verifier`.
- **Stopgap removed** — deleted `src/exports-gate.js` + `test/exports-gate.test.js` and every
  `BILLABLE_ALLOW_CLIENT_EXPORTS` reference (server, CLI, run.js). Dashboard shows the confirm-minutes UX
  (est vs confirmed, unconfirmed count); README/ETHICS de-claimed accordingly.
- New tests: `test/phase4.test.js` (16 cases) wired into `test/run.js`; several existing run.js tests updated
  to the new confirmed-minutes contract (no tests deleted to go green — the removed exports-gate test pinned a
  deliberately-superseded stopgap and was replaced by stronger structural tests).

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books 252, billable 53,
iolta 18, audit 16, money 22); typecheck clean. Backlog: #16 closed by this PR; #24 stays OPEN for the
remaining cross-app outbox/Clio item; #17/#18 (Phase 4), #14 (Phase 3), #11/#15 (Phase 2), #12/#13/#20
(Phase 1) closed. #19 unratified (gates Phases 6–7 only).

**Next session → finish Phase 5's last item, then Phase 6 (epic #25, blocked on #19).** For the Phase 5 tail
see "Remaining Phase 5 item" above. All money through `@elias/money`, all compliance events through
`@elias/audit`.

**Gotchas (carried forward + new):**
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
