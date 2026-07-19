# Privacy & Confidentiality

Matterproof handles data that may be protected by attorney-client privilege
and the duty of confidentiality (Model Rule 1.6). The design is accordingly
blunt: **everything stays on your machine.**

## Where data lives

All data is stored locally in `~/.billable/` (or `$BILLABLE_HOME`):

| File | Contents |
|---|---|
| `ledger.jsonl` | Append-only event log: timestamps, session ids, tool names, project paths, and (optionally) the first 500 characters of each prompt |
| `overrides.json` | Your review decisions: reviewed flags, edited hours/narratives, write-offs |
| `config.json` | Rates, firm identifiers, client/matter mappings — and, if you connect Clio, your OAuth tokens (treat this file like a credential) |

There is no cloud component, no telemetry, and no analytics. The dashboard
server binds to `127.0.0.1` by default — not reachable from other machines.
Loopback is still hardened against your own browser: the server only answers
requests addressed to it by a local hostname (blocking DNS rebinding),
refuses cross-site requests, and accepts POSTs only as JSON — so a web page
you visit cannot drive the API.

**LAN mode** (`billable serve --lan`) is opt-in and serves the dashboard to
your local network so you can use it from a phone. Off-machine requests must
present a random 128-bit access token (embedded in the printed URL, then
carried by an HttpOnly cookie); loopback traffic — Claude Code hooks and the
browser extension — stays exempt. The token lives in `config.json`
(`serveToken`), is compared in constant time, and is never exposed through
the config API; rotate it with `billable serve --lan --new-token`. Traffic
is plain HTTP on your LAN, so use it only on networks you trust — on
untrusted networks, prefer a WireGuard/Tailscale tunnel to the machine and
keep the default loopback bind.
The only outbound network calls in the codebase are the ones you explicitly
invoke with `billable clio ...`, which send reviewed time entries (dates,
hours, narratives) to your own Clio account over TLS. The browser extension
posts only to `127.0.0.1`, and keeps its settings (including client/matter
names) in `chrome.storage.local` — nothing is synced to a browser account.

## What is captured, and how to narrow it

- **Tool steps**: tool names and timestamps only — never file contents,
  command output, or AI responses.
- **Prompts**: the first 500 characters of each prompt are captured by
  default to seed billing narratives ("re: draft motion to dismiss").
  If prompts themselves are too sensitive to store, disable capture:

  ```bash
  billable config capturePrompts false
  ```

  Entries will then carry activity-only narratives, and you can supply the
  subject line during review.
- **Project paths**: working directories are recorded to route work to the
  right client/matter.

## Things you should still do

- Ledger files are written owner-only (`0600`, and the data directory is
  `0700`). Use full-disk encryption and OS user separation as you would for
  any client file.
- Exports (CSV, LEDES, HTML statements) contain narratives — once exported,
  their handling is up to you and your billing system's security.
- Deleting a ledger line deletes the record; the ledger is yours. For an
  evidence-grade trail, don't edit `ledger.jsonl` — make adjustments through
  the review workflow, which keeps corrections separate from the record.
- Your separate obligations for the *content* you share with an AI provider
  (what you type into Claude) are governed by that provider's terms and your
  informed-consent analysis under Op. 512 — Matterproof only records that
  work happened, locally.
