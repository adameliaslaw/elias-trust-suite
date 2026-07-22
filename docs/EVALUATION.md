# Elias Trust Suite — Evaluation & Remediation Plan

> Independent evaluation of the consolidated suite, 2026-07-22.
> Covers (1) a substantive assessment of functionality / uniqueness / ease of use / value,
> and (2) a defect inventory with a sequenced remediation plan.
> Verified locally: `npm ci` clean (0 vulns), `npm run typecheck` clean, full suite ~480 checks
> — **but the suite is not reliably green** (see H5 flaky test).

## Scope

npm-workspaces monorepo (Node 20+). **3 of 5** planned source apps migrated; **2 of 5** shared
packages built.

| Piece | Source | State |
|---|---|---|
| `packages/money` (`@elias/money`) | new | ✅ Exact bigint-cents; no float; no equality epsilon. Excellent. |
| `packages/audit` (`@elias/audit`) | new | ✅ Hash-chained JSONL; pure-TS SHA-256; verify-on-open. Excellent. |
| `apps/books` | quickbucks | Bookkeeping + payroll + tax engine. Deepest app. |
| `apps/iolta` | IOLTA-Reconciliation | React/Firebase three-way trust reconciliation. Core product. |
| `apps/billable` | Billable.ai | CLI/web time-tracking + LEDES/LawPay/Clio. |
| `apps/payroll` | Payroll | ❌ Not migrated. |
| `apps/bills` | plaid-bill-tracker | ❌ Not migrated. |
| `packages/auth`, `packages/plaid`, `packages/rules` | planned | ❌ Never built. |

---

## Part 1 — Substantive assessment

**Functionality is real, not demo-ware.** Across all three apps the features are genuinely
implemented and covered by tests, not stubbed.

- **books** is the standout: a zero-dependency Pub 15-T percentage-method payroll engine
  (FICA / FUTA / NJ GIT tables A–E / NJ UI-WF-TDI-FLI, §125 & 401(k) pre-tax, wage-base caps via
  prior-YTD accumulation), NACHA ACH files (PPD + CCD+/TXP), 941/940/NJ-927/WR-30 filings,
  ST-50/51 sales-tax trust accounting, household 1040/NJ-1040 planning, and an unusual
  depreciation→DTI ("Schedule Elias") analyzer. Uncommon depth for a solo tool.
- **iolta**'s three-way reconciliation is **correct and complete**: adjusted bank
  = statement − outstanding checks + deposits-in-transit; book balance = cumulative txns ≤ month-end;
  client-ledger total = sum of per-client balances ≤ month-end; exact-penny, zero-tolerance equality.
  Deposits-in-transit and outstanding checks are properly classified by clear date. AI statement
  ingestion (Gemini, **server-side key**, Firebase-token-gated) works end to end.
- **billable** turns Claude Code / claude.ai activity into attorney-reviewable, UTBMS-coded,
  LEDES-1998B time entries with an append-only tamper-evident ledger and ABA Op. 512 framing.

**Uniqueness:** medium-high. The differentiator is the *combination* — exact-cent money + a
tamper-evident hash chain + NJ-specific Rule 1:21-6 / RPC 1.15 framing — not any single feature.
Most novel individual pieces: the depreciation-to-DTI analyzer and the "evidence-grade AI timesheet."

**Ease of use:** good for a solo operator (single-password auth + PWA + one-tap backup in books;
Google sign-in + AI ingestion in iolta; local-only CLI in billable). Undercut by real breakage —
iolta's Manual Entry does nothing (H4).

**Value:** high as **planning + record-keeping** tooling. The suite's headline promise is
*defensible, tamper-evident trust records* — and that is exactly where the most serious bugs
cluster (Part 2). The value is real but currently over-claimed by the docs.

**Shared packages** (`@elias/money`, `@elias/audit`) are the best-engineered code here and a solid
foundation.

---

## Part 2 — Defect inventory

Severity: **H** high / **M** medium / **L** low. Items marked *(verified)* were reproduced locally.

### High — compliance & correctness

- **H1 — books: the audit screen shows the *forgeable* log, not the tamper-evident chain.**
  `GET /api/audit` (`apps/books/server.js:1987`) returns `db.auditLog`, a plain array inside the
  mutable `company-<id>.json`. The hash-chained `@elias/audit` file is only a pass/fail check at
  `GET /api/audit/chain` (`:1993`) and its entries are never displayed. A user trusting the
  "Audit log" screen is looking at the editable copy — undermining the suite's core value prop.
- **H2 — billable: the audit chain self-corrupts on any ledger line > 8 KB. *(verified)***
  `readLastLine` reads only the last 8192 bytes (`apps/billable/src/audit.js:78`). A LawPay request
  bundling a few hundred `entryIds` exceeds that → `parseLine` returns null → `tailState` resets
  `seq` to 0 with `GENESIS` prev-hash → `verifyLedger` permanently reports tampering that never
  occurred. Fix: read the whole file (or grow the window to file size) to find the last line.
- **H3 — iolta: `toCents` throws on scientific-notation numbers — the guard does the opposite of
  its own comment. *(verified)*** `dec()` throws on any `String(n)` containing `e`
  (`apps/iolta/src/money.ts:31`); the ledger-filter comment at `App.tsx:339` says balances like
  `1e-14` "must classify as zero," but `toCents(1e-14)` throws and crashes the `filteredClients` /
  `syncBalances` / `reconciliationSummary` memos for that user.
- **H4 — iolta: "Manual Entry" is completely non-functional dead code.** The button sets
  `isManualModalOpen` (`App.tsx:856`) but no modal ever reads it (`:406`); `handleManualSubmit` /
  `newTx` are never rendered. The only data-entry path is bulk AI upload.
- **H5 — the security-critical audit test is flaky, so CI is untrustworthy. *(verified — failed ~1
  in 8 runs)*** `apps/billable/test/audit.test.js:127` asserts the string `"300"` never appears in
  the serialized chain to prove the config *value* isn't logged — but it substring-searches 64-char
  hex SHA-256 hashes and timestamps, which contain `"300"` by coincidence. Effects: (a) CI randomly
  goes red on unrelated PRs; (b) the "secrets never logged" guarantee isn't actually pinned.
  The intent is right; the assertion should check payload structure, not a global substring.
- **H6 — books: editing a paid invoice retroactively restates prior-period income and sales-tax
  trust liability.** `salestax.paymentIncomeParts` splits historical payments using the invoice's
  *current* tax/total (`apps/books/lib/salestax.js:35`) with no snapshot at payment time — so
  editing a filed-period invoice silently changes the ST-50 trust balance for a closed period.

### Medium

- **M1 — money is float64 at the storage boundary in all three apps**, contradicting the suite's
  own "no float64 money anywhere" contract (`packages/money/src/money.ts:5`). The calc layer is
  exact via the bridges, but persisted amounts (`invoice.items[].rate`, Firestore balances, etc.)
  are JS floats, and raw float reductions exist outside the bridge — `apps/books/lib/tax1040.js:132`,
  `schedule-elias.js:192`, and **all** margin math in `apps/billable/src/economics.js`.
- **M2 — iolta: the sealed `reconciliation.completed` record is self-contradictory** — stores raw
  statement balance in `bankBalanceCents` but computes `differenceCents` from the *adjusted* bank
  (`App.tsx:564`), so a reconciled month shows `difference:"0"` with `book ≠ bank`. And these records
  are **auto-emitted on a 1.5 s debounce**, not a deliberate attested act — spamming the trail.
- **M3 — books: payroll net pay can go negative** — per-deduction cap but no aggregate cap
  (`apps/books/lib/payroll/engine.js:191`); negative checks are silently dropped from NACHA
  (`server.js:1410`) while still posted to the books.
- **M4 — books: NACHA payroll batch uses mixed service class 200 instead of credit-only 220**
  (`apps/books/lib/payroll/nacha.js:187`) — some ODFIs reject a 200 batch containing only credits.
- **M5 — billable: LEDES units hardcoded to tenths** (`apps/billable/src/ledes.js:96`) →
  quarter-hour billing fails LEDES validation (units × cost ≠ line total).
- **M6 — billable: `capturePrompts:false` is bypassed by the extension / `POST /api/log`**
  (`server.js`), which never checks the flag — PRIVACY.md promises prompt text stays out of the
  ledger; the web path writes it anyway.
- **M7 — books: data-store races.** One shared mutable `db` object per company, `save()` writes the
  whole file, async handlers yield mid-transaction with no locking (`apps/books/lib/store.js`).
- **M8 — GET endpoints mutate state** (books `generateRecurring` on dashboard/invoice reads); a
  tampered chain then 400s an otherwise read-only request.

### Low / cross-cutting

- **L1 — books & billable have no typecheck or lint in CI** (plain JS); only iolta is statically
  checked. Root `lint` script targets only iolta.
- **L2 — iolta `start: node server.ts` is broken** (no TS strip on the pinned toolchain); only
  `dev` (tsx) works. No server build step exists.
- **L3 — misc:** duplicate `<Chatbot/>` render (iolta `App.tsx:1118` & `:1231`); Clio OAuth has no
  `state`/PKCE and no callback timeout (`apps/billable/src/clio.js`); books session cookie missing
  `Secure` when bound to `0.0.0.0`.
- **L4 — `tables2026.js` bracket dollar values were not independently verified** against published
  2026 IRS / NJ tables. Code is correct *given* the table values; reconcile against official 2026
  releases before any real filing.
- **L5 — stale comments/branding:** books `tax1040.js` header says "no NIIT" but computes NIIT;
  "Billable.ai" / "Matterproof" / "quickbucks" strings remain post-migration.
- **L6 — redundancy:** `dec()` / `snapped()` helpers are copy-pasted across all three app money
  bridges — hoist into `@elias/money`.
- **L7 — owner-blocked, still open (per STATUS.md):** Plaid creds not rotated + git history not
  purged; `PAYROLL_ENCRYPTION_KEY` unset; iolta Firestore rules not deployed; lockfile dep-map not
  synced.

### Things that check out (verified correct)

`@elias/money` (bigint cents, exact rounding modes, no epsilon) and `@elias/audit` (hash chain,
hand-rolled SHA-256 with KAT cross-check, append serialization) are solid. iolta's three-way
reconciliation math is correct and complete. iolta's Gemini key is **not** exposed client-side
(server-side only, token-gated). billable's per-line half-up fee rounding is correct
(`1.5h × $13.35 = $20.03`) and its lockfile genuinely serializes concurrent appends.

---

## Part 3 — Remediation plan (sequenced)

Ordered by dependency and risk. Phase boundaries are natural review/commit points.

**Phase 0 — Make green trustworthy first.** Nothing else is safe to change until the test signal is
reliable. (a) H5 flaky test → structural payload assertion; (b) add typecheck + lint CI gates for
books & billable (L1); (c) fix iolta prod `start` (L2).

**Phase 1 — Restore the tamper-evidence promise (core value prop).** H1 (surface the real chain in
books' UI; stop presenting `db.auditLog` as "the audit log"); H2 (billable full-line read); M2
(iolta reconciliation-record fidelity + make reconciliation a deliberate attested action).

**Phase 2 — Fix crashes & broken core paths.** H3 (iolta scientific-notation throw); H4 (wire or
remove Manual Entry); H6 (books snapshot tax split at payment); M3 (payroll negative-net guard).

**Phase 3 — Money-at-storage consistency (DECISION REQUIRED).** Either migrate to integer cents at
rest (schema/data migration; fully honors the contract) **or** keep float-at-rest + exact calc and
document it as a deliberate boundary — then make books/billable/iolta consistent and remove the
stray raw-float reductions (M1).

**Phase 4 — Integration & hardening.** M5 LEDES units; M6 capturePrompts bypass; web-chat
overbilling; M4 NACHA class; M7 data-store locking; M8 GET-mutation; Clio PKCE (L3); L4
`tables2026` reconciliation before any real filing.

**Phase 5 — Scope completion (DECISION REQUIRED).** payroll + bills migration (after owner rotates
Plaid creds / sets `PAYROLL_ENCRYPTION_KEY`); build or drop `auth` / `plaid` / `rules`; deploy
Firestore rules; lockfile sync; branding cleanup.

## Open decisions (flagged, not blocking)

1. **Deliverable scope:** plan only, or begin implementing (and how far)?
2. **Audience:** personal-practice tooling vs. the "IOLTA-as-SaaS for NJ solos" direction — this
   reprioritizes multi-tenant isolation and compliance defensibility.
3. **Money-at-rest** (Phase 3): migrate to integer cents, or keep float-at-rest and document.
4. **Remaining apps** (Phase 5): still migrate payroll + bills, park, or drop.
