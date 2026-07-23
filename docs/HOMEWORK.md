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

**Session that just ran:** Phase 5 (epic #24) — **finished the last item** (cross-app write-atomicity /
idempotency). New PR opened off `main` (branch `claude/phase5-outbox-atomicity-8wf9g4`); **#24 is now fully
checked and CLOSED**; Phase 5 marked ✅ done in STATUS. **Auto-merge is intentionally OFF** (money/security-
adjacent: crash-atomicity + external-side dedup are not fully covered by CI semantics) — human review
requested, per CONTRIBUTING's exception.

**What landed this session (each with a reproducing test):**
- **Clio push retry dedup (`apps/billable/src/clio.js#pushEntries`).** A Clio `POST /activities` that
  succeeded but died before `store.writeOverride({clioId})` would re-POST on retry and duplicate the Clio
  activity. Now `pushEntries` records a durable, hash-chained **pre-POST intent** (`clio.push_intent` ledger
  event via new `store.appendClioIntent`, mirroring LawPay's deterministic-reference dedup shape). On retry a
  dangling intent triggers `reconcilePush` — a `GET /activities` query matching the intended
  (matter, date, quantity, note) — that **adopts** the existing activity id instead of re-POSTing, POSTs only
  when the prior attempt never landed, and **fails closed** on an ambiguous (>1) match. New exports:
  `pushKey`, `reconcilePush`. Tests: 3 cases in `test/run.js` (`#24`).
- **books save()+audit crash-atomicity — transactional outbox (`apps/books/lib/outbox.js`, new).** The owed
  audit event now rides inside the atomically-saved company JSON (`db.outbox`), so it commits in the SAME
  tmp+rename as the money mutation — no more silent-gap window between `save()` and `audit.append()`. A relay
  (`outbox.flush`) delivers each owed event to the tamper-evident chain and clears it; boot-time
  `outbox.recoverAll` redelivers anything a crash interrupted. Delivery is **idempotent** on the outbox
  message id via new `audit.appendIdempotent` (carries `outboxId` in the payload; a replay after a crash
  between append and clear is a no-op). `store.commit`/`commitMany` replaced the non-atomic
  `save(db); await audit.append(...)` pattern in EVERY money handler (invoices, expenses, time, sales/bank
  imports, payroll run/finalize/deposit, salestax, settings, recurring). Auth events and the best-effort
  post-response `http.write` Layer A path (no company-JSON mutation) stay as plain `audit.append`. Tests:
  `test/outbox.test.js` (4 cases, wired into `package.json`).

**Design notes for the reviewer:**
- The Clio reconcile is natural-key matching (no Clio-side idempotency field exists in v4), so it fails closed
  on ambiguity rather than guessing — a money-safe posture. It sends no speculative idempotency header.
- The books outbox rides *inside* the company JSON deliberately: that's what makes "mutation + owed audit
  event" a single atomic write. `secrets.applyToSecrets` is an allowlist, so `db.outbox` passes through
  sealing untouched (plaintext operational state, no secrets).
- `outboxId` is additive audit-payload metadata (documented in `packages/audit/src/events.ts`); verify()
  hashes the payload verbatim, so a payload with or without it verifies identically. books is plain JS (not
  typechecked), so no interface edits were needed.

**State of the repo:** all suites green (`npm test` exit 0 across every workspace — books 252 + audit 11 +
outbox 4, billable 56, iolta 18 + 13, audit 16, money 22); `npm run typecheck` clean. Backlog: **#24 CLOSED**
by this session; #16/#17/#18 (P4/5), #14 (P3), #11/#15 (P2), #12/#13/#20 (P1) closed. #19 unratified (gates
Phases 6–7 only).

**UPDATE (2026-07-23, same session): Phase 5 PR #34 MERGED, and Phase 0 (#19) RATIFIED by owner** —
D1=C (internal-first, multi-tenant-capable), D2=B (hosting as-is), **D3=C (split by domain: suite owns
trust/time/matters, integrates with a real general ledger for invoices/AR — NOT the firm's GL itself)**,
D4=B (Payroll/Bills migrations paused). Recorded in CONSOLIDATION_PLAN.md (Product decisions) + STATUS.md;
#19 closed. Phase 2's schema needed no change (already built on D3=C).

**Next session → two unblocked options; pick per owner priority:**
- **Phase 6 (#25) — Books role + `packages/rules`** — now UNBLOCKED (Phase 0 done). The versioned, cited
  rule engine (every tax/compliance constant → its N.J.S.A./N.J.A.C./IRS source, parameterized by effective
  date) is the estate suite's proven moat, and it resolves the Books↔Matterproof timekeeping overlap. Under
  D3=C, Books stays the internal financial OS but is NOT positioned as the firm's authoritative general
  ledger — trust/time/matters are first-class; invoice/payment objects stay thin + integration-oriented.
- **Phase 8 (#27) — release engineering** — parallelizable; the app-level slice is safe now (iolta
  `firebase deploy --only firestore:rules`; iolta's `xlsx`-from-CDN-tarball fragility; deploy/runtime config
  PORT/env). **Caveat:** #27 is tagged "finalize last" — do the deploy-unblocking infra, but NOT the final
  *integrated-suite* release cut, which should wait until Phase 7 lands.

Phase 7 (#26) still needs 6. All money through `@elias/money`, all compliance events through `@elias/audit`.

**Gotchas (carried forward + new):**
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
