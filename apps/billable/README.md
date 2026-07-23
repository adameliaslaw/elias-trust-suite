# Matterproof

**A contemporaneous record of AI work on client matters.** An evidence-grade
ledger, kept like a timesheet.

> **Status: alpha — billing is now safe by structure (Phase 4 / #23).** AI
> runtime is captured as **cost and provenance metadata only**: inferred
> attorney time defaults to **zero**, and a billable minute exists only once an
> attorney enters/confirms the human minutes actually worked (#17). Client
> billing is gated by the data itself, not an env stopgap — LEDES/HTML invoices,
> LawPay links, and Clio pushes include an entry only when it is **reviewed**,
> **attorney-confirmed**, and **not already billed**, and each entry bills to a
> single destination exactly once (#18). The old
> `BILLABLE_ALLOW_CLIENT_EXPORTS` switch has been removed.

AI now does real work on client matters — drafting, research, analysis — and
that creates a bookkeeping problem the billing stack can't see: *what did the
AI do, on whose matter, for how long, and who reviewed it?* Matterproof
records every step Claude takes, contemporaneously, so an attorney can review
it and decide what — if anything — becomes a time entry:

- **AI runtime is provenance, not time** — captured elapsed activity (idle gaps
  capped) becomes a *suggestion* the dashboard shows the attorney; it is never
  billable on its own. A billable hour appears only when the attorney enters or
  confirms the human minutes worked. **ABA Formal Op. 512** requires billing
  actual time, never time "saved"; nothing reaches a client bill until it is
  attorney-confirmed and reviewed. See [ETHICS.md](ETHICS.md).
- **Attorney review workflow** — a local web dashboard where you approve,
  adjust, or write off every entry before billing. Review decisions are
  stored apart from the raw ledger, preserving the underlying record as your
  supervision/audit trail.
- **UTBMS activity codes & generated narratives** — *"Reviewed and analyzed
  6 files; drafted and revised 3 documents re: fix login bug."*
- **Client/matter routing** by project directory.
- **AI cost pass-through** — disclosed as a separate expense computed from
  unrounded runtime, never blended into fees.
- **Exports** — terminal timesheet and CSV (internal) are always available. The
  client-facing formats (**LEDES 1998B**, printable HTML statement, LawPay
  links, Clio push) include only reviewed, attorney-confirmed, unbilled work,
  and mark each entry billed so no entry is double-billed. LEDES units are exact
  at any increment (quarter-hour billing validates), and multi-matter files
  group into one invoice per matter. `billable report --format ledes --bill`
  records the invoice as issued.
- **Local-only by design** — no cloud, no telemetry; the dashboard binds to
  127.0.0.1. See [PRIVACY.md](PRIVACY.md).

Zero dependencies. Node 18+.

## Quick start

```bash
git clone https://github.com/adameliaslaw/billable.ai
cd billable.ai
npm link                      # puts `billable` on your PATH

cd ~/my-project
billable init                 # install Claude Code capture hooks here
billable init --global        # ...or once for every project

billable config rate 250      # hourly rate (optional; omit to track hours only)
billable config aiCostPerHour 6   # optional AI cost pass-through
billable matter ~/my-project "Acme Corp" "ACME-001 Website Dispute"
```

Every Claude Code session is now recorded automatically. Then:

```bash
billable serve                # review dashboard at http://127.0.0.1:4321
billable status               # today's totals + unreviewed count
billable report               # timesheet in the terminal
billable report --from 2026-07-01 --to 2026-07-31 --format ledes --out july.ledes.txt
billable report --format html --out statement.html
```

## The dashboard

`billable serve` opens a local review queue: filter by period and client,
edit hours and narratives inline, mark entries **Reviewed** or **No charge**,
generate/settle payment requests, and export CSV / LEDES / statements — the
attorney-facing surface for the whole system. It also exposes a localhost
capture API (`POST /api/log`) that capture surfaces (the browser extension,
desktop agents) write to.

**From your phone:** `billable serve --lan` binds to your network and prints
a tokenized URL — open it once on your phone and a cookie keeps you signed
in. Loopback capture (hooks, extension) needs no token; everything
off-machine does. Rotate the token with `--new-token`. Plain HTTP on your
LAN, so trusted networks only — see [PRIVACY.md](PRIVACY.md).

## Capture surfaces

| Surface | How |
|---|---|
| **Claude Code** | Automatic, via hooks installed by `billable init` |
| **claude.ai chat — live** | The [Matterproof Capture browser extension](extension/) posts activity to your local ledger as you chat, tagged to a client/matter you pick in the popup |
| **claude.ai chat — retroactive** | `billable import conversations.json` — parses your claude.ai data export into per-sitting entries reconstructed from message timestamps (re-import safe; deduplicated) |
| **Anything else** | `billable add --minutes 18 --desc "..." --client "Acme"` or `POST http://127.0.0.1:4321/api/log` |

## Clio sync

Push attorney-reviewed entries into Clio Manage as time entries, so
Matterproof feeds your billing system of record instead of replacing it.
Only entries that are **reviewed**, **not written off**, **mapped to a Clio
matter**, and **not already pushed** go out — the review workflow is the
gate. (Experimental: exercised against mocked API responses, not yet a live
Clio account.)

```bash
# One-time: create an app at Clio → Settings → Developer Applications
# with redirect URI http://127.0.0.1:53682/callback
billable config clioClientId <id>
billable config clioClientSecret <secret>
billable clio connect
billable clio matters                          # list Clio matters + ids
billable clio map "Acme Corp" "ACME-001" 12345
billable clio push --from 2026-07-01 --dry-run # then again without --dry-run
```

## LawPay payment links

Turn a period of reviewed entries into a pre-filled LawPay payment link —
and a client-ready statement with a **Pay Now** button. Uses LawPay's
Payment Page URL parameters, so there are **no API keys and no OAuth**:
just the public page URL from LawPay → Payment Pages.

```bash
billable config lawpayPageUrl https://secure.lawpay.com/pages/<yourfirm>/operating

billable lawpay link --from 2026-07-01 --to 2026-07-31 --client "Acme Corp" \
                     --email client@example.com --out statement.html
```

This prints the payment URL (amount in cents, locked description, unique
`MP-` reference) and writes an HTML statement whose Pay Now button opens it.
Only entries that are **reviewed, not written off, and not already on a
previous payment request** are included; included entries are stamped with
the request reference so work is never double-billed, and each request is
logged to the ledger as an audit record. Use `--dry-run` to preview without
marking. The `MP-` reference round-trips through LawPay, so receipts
reconcile to the exact entries they paid for.

Add `--send` to email the request to the client — a firm-branded payment
email with a Pay Now button, sent via SendGrid:

```bash
billable config sendgridApiKey <key>       # kept out of the dashboard API
billable config firmEmail adam@yourfirm.com
billable lawpay link --client "Acme Corp" --email client@example.com --send
```

Track what's owed and settle it when you see the payment land in LawPay:

```bash
billable lawpay requests        # every request + outstanding balance
billable lawpay paid MP-abc123  # record a payment (append-only audit event)
```

The dashboard has the same loop under **Payments**: generate a link from the
filtered entries (optionally emailing it), see outstanding requests with an
A/R tile in the summary, and mark them paid — all phone-friendly, so you can
review entries and send a payment request from your pocket.

## Unit economics (flat-fee pricing)

For flat-fee and hybrid practices, the same ledger answers the pricing
question: what does each matter actually cost to produce?

```bash
billable fee "Acme Corp" "ACME-001" 5000   # record the flat fee
billable economics --from 2026-07-01
```

Shows per-matter **actual (unrounded) hours**, billed hours, fees, AI cost,
the **effective realized rate per actual hour**, and flat-fee margin —
written-off time still counts as production cost, because it was.

## How time is computed

A **task** runs from your prompt until Claude stops. Its duration is the span
of recorded activity with gaps capped (default 5 min), rounded **up** to the
billing increment with a per-task minimum — exactly how a timekeeper records
tenths. Every derived entry then awaits your review.

| Setting | Default | Meaning |
|---|---|---|
| `rate` | `0` | Hourly rate; `0` reports hours only |
| `aiCostPerHour` | `0` | Disclosed AI cost pass-through per runtime hour |
| `incrementHours` | `0.1` | Billing increment (`0.25` for quarter-hour billing) |
| `minimumHours` | `0.1` | Minimum per task |
| `idleCapMinutes` | `5` | Max billable gap between recorded steps |
| `capturePrompts` | `true` | `false` keeps prompt text out of the ledger entirely |
| `firmName`, `firmId`, `timekeeperId`, `timekeeperClass` | — | Used in LEDES export |

`billable config <key> <value>` sets any of them. Data lives in `~/.billable/`
(override with `BILLABLE_HOME`).

## Activity codes

| Claude activity | Code | Billed as |
|---|---|---|
| Reading / searching files | A104 | Review/analyze |
| Editing / writing files | A103 | Draft/revise |
| Web search & research | A102 | Research |
| Running commands & tests | A110 | Manage data/files |
| Delegating to subagents | A101 | Plan and prepare |
| Asking you questions | A106 | Communicate (client) |

## Commands

```
billable init [--global]        Install Claude Code capture hooks + create config
billable serve [--port 4321]    Review dashboard + capture API (local only)
               [--lan]          ...or token-gated on your LAN (phone access)
billable log                    (called by hooks) record one event from stdin
billable add                    Record a manual time entry
billable import <file>          Import a claude.ai data export
billable status                 Today's totals
billable report                 Timesheet (text | csv | html | ledes)
billable economics              Per-matter unit economics / flat-fee margins
billable fee <c> <m> <amount>   Record a flat fee for a matter
billable clio <subcommand>      connect | matters | map | push
billable lawpay link            Payment link + statement/email from reviewed entries
billable lawpay requests        List payment requests + outstanding balance
billable lawpay paid <ref>      Record that a payment request was paid
billable config [key value]     Show or set configuration
billable matter <dir> <c> <m>   Bill a project directory to a client/matter
```

## Development

```bash
npm test    # zero-dependency test suite
```

## Disclaimer

Matterproof records AI activity and formats it like legal time entries.
Whether and how AI-assisted work may be billed is governed by your
jurisdiction's rules of professional conduct and your engagement agreements —
review every entry before billing, and read [ETHICS.md](ETHICS.md).
