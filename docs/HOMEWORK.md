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

**Session that just ran:** Phase 3 (epic #22) — reconciliation lifecycle + 7-year retention. All #22
checklist items done; one PR opened off `main` (branch `claude/phase3-recon-lifecycle-kq9e8j`). Critical
#14 closed by the PR.

**Decision context:** #19 **Decision 3 (system of record) is still unratified** (no sign-off comment,
box unchecked). Phase 3 is decision-safe regardless: finalize/lock/retention is trust accounting, which
Decision 3 keeps with the suite under every option. No invoice/payment "system of record" object was built.

**What landed (with commit SHAs):**
- `a6a0dd7` — the whole Phase 3 lifecycle:
  - **#14 lifecycle** — new pure module `src/lifecycle.ts`: the state machine (`draft → resolve
    exceptions → attorney attest → finalize → immutable lock`; `reopenForAmendment` = reason + new
    version). `buildFinalizedPacket` freezes the bank/book/statement/match inputs + computed legs into a
    `FinalizedPacket` whose `contentHash = sha256(canonical(body))` (`@elias/audit/core`). It cites
    `RECON_AUTHORITY` (NJ Court Rule 1:21-6) and computes `retentionUntil` = finalizedAt + 7 years
    (TZ-independent). `canonicalizeInputs` sorts streams so the packet is byte-for-byte reproducible.
    `assertPeriodMutable` / `LockedPeriodError` reject any tx mutation dated within a locked month.
    `renderPacketDocument` is a deterministic CSV/text artifact.
  - **Seal only on finalize** — removed the 1.5s debounced auto-emit in `App.tsx`; the draft-persist
    effect now writes drafts only and **skips finalized months**. `reconciliation.completed` is sealed
    exclusively by `handleFinalizeMonth` (attorney attest + finalize).
  - **Payload fix (M2)** — `reconciliationCompletedPayload` sets `bankBalanceCents` = ADJUSTED bank
    balance, so `book − bank === difference` holds.
  - **Source retention** — `server.ts` content-hashes each upload and keeps a copy under
    `uploads/retained/{sha256}{ext}` (idempotent, content-addressed) instead of always unlinking;
    returns `sha256`+`bytes`. New `GET /api/source/:hash` serves the retained bytes (hex-validated).
    `App.tsx` records `sourceStatements` docs (name+hash+covered months) on import; finalize cites them.
  - **App wiring** — lock guards in edit/add/delete/clear/import handlers; `sourceStatements` &
    `reconciliationPackets` subscriptions; `lockedMonths` memo; Attest/Finalize + Reopen modal + UI.
  - **@elias/audit** — added `reconciliation.reopened` event (payload in `events.ts`, exports in
    `core.ts`/`index.ts`, listed in `AUDIT_EVENT_TYPES`).
  - **firestore.rules** — immutable `reconciliationPackets` (create-only), `sourceStatements`, and
    `periodFinalized()` lock enforcement on `transactions`/`statementBalances`. **Still UNDEPLOYED**
    (Phase 8 / #27) — client-side `lifecycle.ts` is the live enforcement today.
  - `src/types.ts` `Reconciliation` gained lifecycle fields; `src/reconciliation.ts` extracted
    `legacyStreams()` (exported) so the finalize path freezes the exact streams with no drift.
- New tests: `test/lifecycle.test.ts` (7 cases) wired into the iolta `test` script.

**State of the repo:** all suites green (`npm test` exit 0 across every workspace); typecheck clean; vite
build clean. Backlog: #14 closed by this PR; #11/#15 (Phase 2), #12/#13/#20 (Phase 1) closed. #19
unratified (decision memo).

**Next session → Phase 4 (epic #23): redesign Matterproof billing.** Unblocked (only depended on Phase 1,
which is done). Context: `docs/EVALUATION.md` (#17 Matterproof invents ~0.1h/prompt attorney time; #18
review gate bypassable — Phase 1 *contained* both: client-facing exports gated behind
`BILLABLE_ALLOW_CLIENT_EXPORTS=1`, docs de-claimed). Phase 4 is the real redesign: don't fabricate time,
make the review gate structural, and honor `capturePrompts:false` (M6). All money through `@elias/money`,
all compliance events through `@elias/audit`.

**Gotchas (carried forward + new):**
- `npm ci` then `npm run build --workspace @elias/money --workspace @elias/audit` before app tests
  (apps depend on built `dist/`). **After editing `packages/audit` types (e.g. a new event), rebuild it**
  or iolta typecheck fails against stale `dist/`.
- **Do NOT `git checkout apps/billable/bin/billable.js` to drop a `chmod +x` mode diff** — it also reverts
  content. Use `chmod 644` / `git update-index --chmod=-x`. HEAD mode is `100644`. (Hit again this session;
  `chmod 644` cleared it.)
- Lockfile must keep `grep -c msh.team package-lock.json` = 0.
- iolta lifecycle logic lives in `src/lifecycle.ts` (pure, browser-safe — imports only `@elias/audit/core`
  + the money bridge); reconciliation in `src/reconciliation.ts` (`reconcileStreams` core + `legacyStreams`
  adapter). Extend those pure modules, not the `App.tsx` effects.
- iolta Firestore rules (`firestore.rules`) — including the new lifecycle/lock rules — are written but
  **undeployed**; deployment is Phase 8 / #27.
- Retained sources live on local disk (`uploads/retained/`), local-first per #19 Decision 2 — do not add a
  cloud store.
