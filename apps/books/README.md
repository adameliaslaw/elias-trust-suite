# QuickBucks

A self-hosted, QuickBooks-style accounting web app for small businesses — invoices, expenses, banking, payroll, sales tax, and household tax planning. Zero dependencies: plain Node.js (18+) with a JSON file datastore — no npm install, no build step. Data lives in `data/` (one JSON file per company, plus `global.json` for the household), human-readable and easy to back up.

## Quick start

```bash
node server.js
# open http://127.0.0.1:3000
```

First launch walks you through creating the app password — that **is** the setup.

## Security model

QuickBucks is designed for a single machine or a private network, and the defaults are closed:

- **A password is required from first run.** Until you create one, the API answers `401 setupRequired` for everything except the setup/login routes — nothing is reachable anonymously.
- The server binds **loopback only** (`127.0.0.1`). Other machines can't reach it unless you set `QUICKBUCKS_HOST=0.0.0.0` — do that only with a password set.
- Sessions are HttpOnly cookies, expire server-side (7 days idle, 30 days absolute), and **all sessions are invalidated when the password changes**. Login attempts are rate-limited (5 failures → 15-minute lockout) and written to the audit log (bodies are never logged).
- The backup download exports everything (Plaid tokens, bank details, receipts), so it requires a session whenever a password exists — even in the opt-out mode below.
- `QUICKBUCKS_DISABLE_AUTH=1` runs the app without a password for a trusted network. A startup warning is printed; use it deliberately.

## Multiple companies

One household, several books. Create companies from the switcher in the top bar; each gets its own invoices, expenses, payroll, and banking. The **Household** tab aggregates all companies for 1040/NJ-1040 planning. The password is shared across companies.

## Features

- **Invoicing** — customers, draft → sent → partial → paid lifecycle, PDF-friendly print view
- **Recurring invoices** — weekly/monthly/quarterly templates that catch up missed periods on their anchor day
- **Billable time** — per-client time logs, WIP by customer, one-click conversion to invoice lines (non-taxable)
- **Expenses** — categories, payment methods, photo/PDF receipt attachments stored outside the JSON
- **1099-NEC tracker** — per-vendor totals with card payments split out; tracked vendors flagged at the $600 threshold
- **Banking** — Plaid linking *or* CSV import; review feed to categorize outflows as expenses and match inflows to invoices; "always categorize X as Y" rules
- **Household taxes** — a 1040 estimator across all companies plus W-2 wages: self-employment tax with the Social Security wage base, QBI with SSTB phase-outs and the wage limit, NIIT, safe-harbor 1040-ES quarterly plan, and a what-if scenario tool (income/expense/depreciation deltas → tax AND borrowing outcomes). Multi-year: 2024–2026 tables, per-year profiles, closed prior years. The **NJ-1040** estimate applies NJ's category floors (a business loss never offsets wages), exemptions, the property-tax deduction-vs-$50-credit choice, and its own NJ-ES plan.
- **Schedule Elias (rental portfolio + borrowing power)** — per-property lender worksheets: Schedule E net for taxes vs. adjusted income (add back depreciation, interest, taxes, insurance) minus PITIA for lenders, with the 75%-of-gross shortcut alongside. Depreciation strategies (conservative/balanced/aggressive) with **MACRS mid-month** and **cost-seg/100% bonus** modeled per component; **Form 8582-lite §469** (special-allowance phase-out, carryforwards, real-estate-professional status); a **sell-vs-hold recapture preview** (unrecaptured §1250 at ≤25%, LTCG, NIIT, freed suspended losses); SEB from the books with the meals subtraction and two-year trend rules; DTI bands and a max-purchase solver. Tax scenarios and borrowing outcomes are always shown together — depreciation strategy moves tax income, not lender income.
- **Payroll (NJ)** — full paycheck computation for W-2 employees paid in New Jersey, with the tax engine ported from (and test-verified against) the firm payroll app: 2026 federal withholding (IRS Pub 15-T percentage method, every field of the 2020+ W-4), FICA with the Social Security wage-base cap and Additional Medicare Tax, FUTA, NJ gross income tax (NJ-WT tables A–E with NJ-W4 allowances), NJ UI/WF/SWF, TDI, and FLI with their wage bases, plus employer UI/TDI at your assigned rates. Salary or hourly with overtime at 1.5×, card tips, bonuses, non-taxable reimbursements, §125 health and 401(k) deductions with correct tax treatment, and opening YTD balances for a mid-year switch. Draft runs are editable and recomputed live; finalizing freezes every check, posts net pay to your books, and accrues withheld + employer taxes in a liabilities ledger you clear as you make deposits (each deposit books a Payroll Taxes expense). Printable pay stubs per employee. **Money movement** (ported from the firm payroll app): a **deposit calendar** groups obligations by rule — federal 941 monthly/semiweekly schedules with the $100,000 next-day warning, NJ GIT weekly/monthly/quarterly payer schedules, NJ-927 contributions, and FUTA's $500 roll-forward — with due dates and per-obligation payment tracking. Each outstanding obligation generates a **bank-ready NACHA CCD+/TXP file** (federal deposits to the Treasury's EFTPS account with the Social Security / Medicare / withholding subcategory breakdown; NJ payments with NJ's TXP addendum), and finalized runs generate a **PPD direct-deposit file** for employees with bank details on file. Upload the file to your bank's ACH origination portal — that is the payment — then record the deposit so ledger and books agree. One-time enrollments required: ACH origination at your bank, EFTPS (ACH credit), and NJ Form EFT1-C. The **Filings tab** computes every figure for the quarterly returns from finalized runs: **Form 941** line by line (including the fractions-of-cents adjustment, line 16 monthly liability or Schedule B by payday, and deposits attributed from the calendar), **NJ-927** (GIT by month plus UI/WF/SWF, TDI, and FLI contributions) with the **WR-30** per-employee wage detail, and the annual **Form 940** FUTA return — transcribe into the IRS form or NJ portal, or hand to your e-file provider.
- **NJ sales tax** — enable per company (Eliaspresso, not the law practice): invoices get per-line taxable flags at the company's rate (6.625% statewide / 3.3125% UEZ, snapshot per invoice), and collected tax is treated as what it is — **money held in trust for the State**, excluded from income on a cash-basis proportional split of every payment, so the P&L, Schedule C, and 1040 stay right automatically. A remittance calendar on the Reports page implements the ST-50/ST-51 rules (quarterly returns due the 20th after quarter end; monthly ST-51s for months 1–2 when over the $500/month and prior-year thresholds; month 3 settles with the ST-50). Remittances are recorded without ever touching income or expenses.
- **Backups** — one-tap download of the whole data directory as a plain POSIX ustar tarball (no dependencies, readable by any untar tool), and the server snapshots the same tarball daily into `data/backups/`, keeping the newest 7. Restore = stop the server, untar over the data directory, start it again.
- **Receipts on expenses** — snap a photo from your phone (the file picker opens the camera) or attach a PDF to any expense; a 📎 on the expense list opens it. Photos (JPEG/PNG/WebP/HEIC) and PDFs up to 10 MB; the bytes live as plain files under `data/receipts/` next to the JSON books, so copying the data directory is still a complete backup. Deleting an expense (or replacing its receipt) cleans up the file.
- **POS imports (Dripos-friendly)** — no developer API needed: upload the POS exports. **Timecards** (ported from the firm payroll app, test-verified against it): the Time Card CSV fills each draft paycheck's hours, weekly overtime (computed >40h Sun–Sat per FLSA/NJ when the export lacks an OT column), and card tips, matching employees by email then name. **Daily sales**: the sales CSV books each day as a paid, taxable invoice for a walk-in customer (flexible headers, net or gross columns, safe to re-import — duplicates skip), so the P&L and the sales-tax trust ledger flow from the same books; tips are excluded from income (they reach staff through payroll) and totaled for the next pay run, and the import warns if the POS-reported tax disagrees with the configured rate.
- **Recurring invoices** — turn any invoice into a template with *Repeat…* (weekly/monthly/quarterly, anchor-day aware so the 31st bills correctly in short months). Due templates bill themselves whenever the app is opened, catching up missed periods on their original dates — built for retainer clients and monthly card-sales batches. Manage (pause/resume/delete) from the Invoices page.
- **Expenses** — categorized expense tracking by vendor, with payment methods and notes.
- **Customers** — contact info plus live open-balance and total-billed figures. Customers with invoices can't be accidentally deleted.
- **Reports** — cash-basis Profit & Loss (by customer and expense category) with date-range presets, and an accounts-receivable aging report (current / 1–30 / 31–60 / 61–90 / 90+ days).
- **Company settings** — click the company name in the top bar to set your business name, currency, and invoice number prefix.

## How it works

| Piece | What it is |
|---|---|
| `server.js` | Node `http` server: REST API + static file serving |
| `lib/store.js` | JSON-file datastore (`data/db.json`, atomic writes) |
| `lib/seed.js` | Demo data seeding on first run |
| `public/` | Single-page app (vanilla JS, no frameworks) |

Income is recognized on a **cash basis** — when a payment is recorded, not when the invoice is issued. Invoice status is derived from payments and due dates, so it's always consistent.

## API

All data is available over a JSON REST API under `/api`:

```
GET                /api/auth-status      POST /api/login · /api/logout · /api/password
GET/PUT            /api/settings
GET                /api/categories
GET/POST           /api/customers        PUT/DELETE /api/customers/:id
GET/POST           /api/invoices         GET/PUT/DELETE /api/invoices/:id
POST               /api/invoices/:id/payments
POST               /api/invoices/:id/send
GET/POST           /api/expenses         PUT/DELETE /api/expenses/:id
GET                /api/dashboard
GET                /api/reports/pnl?from=YYYY-MM-DD&to=YYYY-MM-DD
GET                /api/reports/aging
```

Banking endpoints:

```
GET                /api/bank/status
PUT/DELETE         /api/bank/config                  (Plaid API keys)
POST               /api/bank/link-token · /api/bank/exchange · /api/bank/sync
DELETE             /api/bank/connections/:id
POST               /api/bank/import-csv
GET                /api/bank/transactions?status=new|added|matched|excluded
POST               /api/bank/transactions/:id/expense | /match | /exclude | /restore
```

Company & household endpoints:

```
GET/POST           /api/companies                    POST /api/companies/:id/select
GET                /api/household/tax                PUT /api/household/tax-profile
POST               /api/household/scenario
PUT                /api/household/schedule-elias     (strategy, §469, QBI safe harbor, borrower, SEB add-backs)
POST               /api/household/properties         PUT/DELETE /api/household/properties/:id
```

The active company comes from the `qb_company` cookie (set by `select`); all other endpoints operate on the active company's books. Data layout: `data/global.json` (companies registry, password, tax profile) + `data/company-<id>.json` per company. Pre-multi-company `data/db.json` files are migrated automatically on first start.

Payroll endpoints:

```
GET/PUT            /api/payroll/settings             (NJ employer UI/TDI rates)
GET/POST           /api/payroll/employees            PUT/DELETE /api/payroll/employees/:id
GET/POST           /api/payroll/runs                 GET/PUT/DELETE /api/payroll/runs/:id
POST               /api/payroll/runs/:id/finalize
GET                /api/payroll/liabilities          POST /api/payroll/liabilities/deposit
GET                /api/payroll/filings?year=&quarter=
GET/POST           /api/time                         PUT/DELETE /api/time/:id
GET                /api/time/wip                     POST /api/time/invoice
POST               /api/sales/import-csv             POST /api/payroll/runs/:id/import-timecards
GET/POST/DELETE    /api/expenses/:id/receipt         GET /api/backup
GET/POST           /api/vendors/1099                 GET /api/audit
```

When a password is set, every endpoint except `/api/auth-status` and `/api/login` requires the session cookie.

## Payroll notes

- The tax math lives in `lib/payroll/engine.js` + `lib/payroll/tables2026.js`, a line-for-line port of the firm payroll app's engine; `test/payroll.test.js` carries that repo's hand-computed expected values, so the two implementations can't silently drift.
- Tax tables are per-year data files. Each December/January, copy `tables2026.js` to the new year, update the values from the official sources listed at the top of the file, and register the year in `engine.js`. The app refuses to run payroll for a year it has no tables for.
- Scope matches the source app: NJ-resident W-2 employees of a NJ employer, aggregate-method bonus withholding, no contractors or other states. W-2/W-3 year-end forms and direct e-filing (TaxBandits) stay in the dedicated payroll app for now.
- Have your accountant shadow the first run or two. This software is provided as-is and is not tax advice.

## Connecting bank accounts

Two ways to get bank data in:

1. **Plaid (live connections).** Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com), grab your client ID and secret, and paste them into the Banking page (or set `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` env vars — env wins). **Sandbox** keys work immediately with fake banks for testing (user `user_good`, password `pass_good`); request **Production** access from Plaid to link your real accounts. Then click *Connect a bank*, log in through Plaid's secure widget, and use *Sync now* to pull transactions. Access tokens never leave your local data file, and the API never returns them.

2. **CSV import (no signup).** Export a statement from your bank's website and upload it on the Banking page. The parser handles quoted fields, US and ISO dates, `$1,234.56` and `(45.00)` amounts, and single-amount or debit/credit column layouts. Re-importing the same file is safe — duplicates are detected and skipped.

Either way, transactions land in the **For review** feed: money out becomes a categorized expense in one click, deposits are matched to open invoices as payments, and anything irrelevant can be excluded (and restored later).

## Tests

```bash
npm test
```

Runs an end-to-end smoke test that boots the server against a temp data directory and exercises every route.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `QUICKBUCKS_HOST` | `127.0.0.1` | Bind address — loopback by default; set `0.0.0.0` to reach the app from other machines (set a password first) |
| `QUICKBUCKS_DISABLE_AUTH` | unset | Set to `1` to run without a password on a trusted network (the only way to run unauthenticated) |
| `QUICKBUCKS_DATA_DIR` | `./data` | Where `db.json` lives |
| `QUICKBUCKS_NO_SEED` | unset | Set to `1` to skip demo data |
