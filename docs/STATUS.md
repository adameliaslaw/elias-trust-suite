# Consolidation Status — elias-trust-suite

> Living handoff document. **A new session should read this file first.**
> Last updated: 2026-07-19 (money wired into ALL THREE apps — iolta PR #7; @elias/audit wiring is next)

## Product
Trust / finance / accounting suite for a NJ law practice.
npm workspaces: `apps/*`, `packages/*`. Node 20.

## ✅ Done
- [x] Repo scaffold (workspaces, tsconfig.base.json, ci.yml at ROOT — see Blocked)
- [x] `packages/money` (@elias/money) — bigint-cents money math; `equals()` has NO tolerance param by design. 22 tests green (PR #1)
- [x] `packages/audit` (@elias/audit) — hash-chained tamper-evident log, pure-TS SHA-256, single-writer, verify-on-open. 15 tests green (PR #1)
- [x] `apps/books` ← quickbucks (PR #2, merged `9c34a9f`)
  - Migration verified byte-exact (43/43 blob SHAs); full suite **372/372** (131 unit + 241 smoke)
  - Fixed during migration: `/api/reports/pnl` returned totalExpenses as netProfit (`ac650ea`)
  - Same bug filed upstream: quickbucks#36
  - quickbucks repo also has merged security PR #35 (setup gate, loopback bind, login throttle, session expiry, DoS fix)
- [x] `apps/iolta` ← IOLTA-Reconciliation (PR #3, merged `ae52ba8`)
  - Migration verified byte-exact (21/21 blob SHAs, source @ `984efed` incl. security PR #21)
  - Verified: `tsc --noEmit` clean, `vite build` green; full monorepo suite still green (books 372/372, money 22/22, audit 15/15)
  - Integration fixes (commit 2 of PR): dropped duplicate `vite` dep in app; root vitest ^2→^3 (vitest 2 pinned vite 5 → dual-vite type clash in vite.config.ts)
  - Follow-up: rename package `react-example` → `@elias/iolta`; bundle is 1.2MB — code-splitting candidate

- [x] `apps/billable` ← Billable.ai (PR #4, merged `2971284`)
  - Migration verified byte-exact (26/26 blob SHAs, source @ `0cfde67` incl. security PR #16)
  - Integration: package renamed `matterproof` → `@elias/billable`, marked private
  - Full monorepo suite green: billable 27/27, books 372/372, money 22/22, audit 15/15; typecheck clean
  - Fixed during migration: narrative singularization "1 inquirie" → "1 inquiry" (+ regression test)
  - Same bug filed upstream: Billable.ai#17

## ▶️ Next up — START HERE
- [ ] Wire apps to `@elias/audit` (money wiring COMPLETE in all three apps — billable #5, books #6, iolta #7)

## After migrations
- [x] `apps/billable` wired to `@elias/money` (PR #5, merged `b94517a`) — exact bigint-cents fees/totals in entries/lawpay/ledes; fixed half-cent undercharge (1.5h x $13.35 billed $20.02 -> $20.03); 28/28 green, CI green
- [x] `apps/books` wired to `@elias/money` (PR #6, merged `de19b8e`) — exact bigint-cents everywhere: invoices (per-LINE half-up rounding), time entries, sales-tax splits, payroll engine/NACHA/deposits/filings, P&L/dashboard/aging/1099. Fixed active misbilling: 1.5h x $13.35 billed $20.02 -> $20.03; `round2(1.005)` gave $1.00 -> $1.01. 383 checks green (11 new exact-money regressions), CI green first run
- [x] `apps/iolta` wired to `@elias/money` (PR #7, merged `9855311`) — typed ESM bridge `src/money.ts` (browser-safe: pure TS + bigint; all iolta ledger math is client-side, server.ts does none). Fixed residual half-cent class: `toCents(1.005)` 100 -> 101; `toCents(-1.005)` -100 -> -101 (sign-symmetric) — could false-positive/negative the zero-tolerance three-way reconciliation. Ledger filters now compare in exact cents (float-noise balances classify as zero). 16 new exact-money regressions (half-cent ties, float-noise self-heal, three-way identity); package renamed `react-example` -> `@elias/iolta`; `typecheck` script added so CI gates iolta types. 399 checks green, CI green, `vite build` green
- [x] Wire apps to `@elias/money` (kills float-cents bug class; ALL THREE apps done)
- [ ] Wire apps to `@elias/audit`
- [ ] Archive-notice on quickbucks, IOLTA-Reconciliation, Billable.ai repos pointing here

## ⛔ Blocked on owner
- [x] ~~ci.yml → `.github/workflows/ci.yml`~~ DONE (owner created via web UI `3a7ed99`; repo now **public** → Actions free; lockfile fix `ecf2970`)
- [ ] plaid-bill-tracker: rotate Plaid credentials + purge git history (creds were committed)
- [ ] Payroll: set `PAYROLL_ENCRYPTION_KEY` (merged PR #24 added AES-256-GCM at rest)
- [ ] plaid-bill-tracker + Payroll: not yet scheduled for migration — decide if they join this suite later

## Known issues filed
- IOLTA-Reconciliation#22 — toCents() half-cent mis-rounding (1.005 -> 100, -1.005 -> -100, sign-asymmetric); can false-positive/negative zero-tolerance three-way reconciliation; fixed here in PR #7, upstream optional
- quickbucks#36 — P&L netProfit bug (fixed here; upstream optional)
- quickbucks#38 — float money math actively misbills (1.5h x $13.35 -> $20.02; round2(1.005) -> $1.00); fixed here in PR #6, upstream optional
- Billable.ai#17 — narrative singularization "1 inquirie" (fixed here; upstream optional)

## Verification environment notes (for sandbox test runs)
- **Lockfile mirror poison (bit us 2026-07-19):** sandbox npm rewrites `resolved` URLs in package-lock.json to its internal mirror (`npm.mirrors.msh.team`). Any lockfile regenerated in the sandbox MUST have URLs rewritten back to `https://registry.npmjs.org/` before commit, or CI fails with ENOTFOUND (npm 10 masks it as "Exit handler never called"; npm 11 shows the real error). Verify: `grep -c msh.team package-lock.json` must be 0.
- CI: `.github/workflows/ci.yml` on Node 24 / npm 11 (Node 20's npm 10 has the masking bug above). First green run: `e7f1d8e`.
- Raw download_url tokens expire in ~1–2 min — fetch fresh via MCP `get_file_contents` and curl immediately, or fetch content via MCP directly
- Binary files (icons/PNGs) not fetchable via MCP — use placeholder + note; they ARE correct in the repo (user pushed via git)
- `push_files` fails on payloads ≳100KB; `create_or_update_file` handles ~82KB fine — but prefer plain git push from sandbox w/ PAT (no size limit, byte-exact by construction)
- `/mnt/agents/output` does NOT support symlinks — run `npm install` under /tmp
- Sandbox network to github.com is flaky — retry git clone/push 2–3× in a loop
- **Sandbox /tmp can be wiped BETWEEN turns** (happened 2026-07-19 mid-task, full rebuild needed): commit + push work-in-progress before ending a turn, and keep a patch backup under /mnt/agents/work
- Dual-vite type clash in vite.config.ts = two vite copies (root-hoisted vs app-local). Fixed by vitest ^3 at root (vite 6 hoisted once)
