# Consolidation Status — elias-trust-suite

> Living handoff document. **A new session should read this file first.**
> Last updated: 2026-07-19

## Product
Trust / finance / accounting suite for a NJ law practice.
npm workspaces: `apps/*`, `packages/*`. Node 20.

## ✅ Done
- [x] Repo scaffold (workspaces, tsconfig.base.json, ci.yml at ROOT — see Blocked)
- [x] `packages/money` (@elias/money) — bigint-cents money math; `equals()` has NO tolerance param by design. 37 tests green (PR #1)
- [x] `packages/audit` (@elias/audit) — hash-chained tamper-evident log, pure-TS SHA-256, single-writer, verify-on-open (PR #1)
- [x] `apps/books` ← quickbucks (PR #2, merged `9c34a9f`)
  - Migration verified byte-exact (43/43 blob SHAs); full suite **372/372** (131 unit + 241 smoke)
  - Fixed during migration: `/api/reports/pnl` returned totalExpenses as netProfit (`ac650ea`)
  - Same bug filed upstream: quickbucks#36
  - quickbucks repo also has merged security PR #35 (setup gate, loopback bind, login throttle, session expiry, DoS fix)

## ▶️ Next up — START HERE
- [ ] `apps/iolta` ← IOLTA-Reconciliation (small repo; merged security PR #21: uid-scoped rules, cents math, deposits-in-transit leg, server-side Gemini proxy, xlsx 0.20.3)
  - Playbook (proven twice): inventory files → user pushes big/binary files via local git (fine-grained PAT, Contents R/W, select repos) → verify byte-exact via blob SHAs → run test suite in sandbox → merge PR → file upstream issues for any bugs found
- [ ] `apps/billable` ← Billable.ai (merged security PR #16)

## After migrations
- [ ] Wire apps to `@elias/money` (kills float-cents bug class; books/iolta/billable)
- [ ] Wire apps to `@elias/audit`
- [ ] Archive-notice on quickbucks, IOLTA-Reconciliation, Billable.ai repos pointing here

## ⛔ Blocked on owner
- [ ] Move `ci.yml` → `.github/workflows/ci.yml` (agent token lacks `workflow` scope; drag in web UI or push locally)
- [ ] plaid-bill-tracker: rotate Plaid credentials + purge git history (creds were committed)
- [ ] Payroll: set `PAYROLL_ENCRYPTION_KEY` (merged PR #24 added AES-256-GCM at rest)
- [ ] plaid-bill-tracker + Payroll: not yet scheduled for migration — decide if they join this suite later

## Known issues filed
- quickbucks#36 — P&L netProfit bug (fixed here; upstream optional)

## Verification environment notes (for sandbox test runs)
- Raw download_url tokens expire in ~1–2 min — fetch fresh via MCP `get_file_contents` and curl immediately, or fetch content via MCP directly
- Binary files (icons/PNGs) not fetchable via MCP — use placeholder + note; they ARE correct in the repo (user pushed via git)
- `push_files` fails on payloads ≳100KB; `create_or_update_file` handles ~82KB fine
- `/mnt/agents/output` does NOT support symlinks — run `npm install` under /tmp
