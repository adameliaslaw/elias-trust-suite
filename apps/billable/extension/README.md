# Matterproof Capture — browser extension

Captures your Claude chat activity on claude.ai and records it to your local
Matterproof ledger, live — no export/import step. Each message you send
becomes a timestamped prompt event; the Matterproof engine turns spans of
activity into reviewable time entries with idle gaps capped, exactly like
Claude Code sessions.

**Privacy:** events are posted only to `http://127.0.0.1:<port>` on your own
machine. The extension makes no other network requests. If the local server
isn't running, events are dropped (the toolbar icon shows `!`) — nothing is
queued or sent elsewhere. Settings — including the client/matter you choose
in the popup — are kept in `chrome.storage.local` on this machine only,
never `chrome.storage.sync`, so they are not uploaded to your Google
account.

## Install (Chrome / Edge / Brave)

1. Run the ledger: `billable serve`
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Click the Matterproof toolbar icon and set the client/matter the chat
   work should bill to (change it as you switch matters)

## How it maps to entries

- Each conversation becomes a session (`web-<conversation-id>`)
- Each message you send is a prompt event carrying the conversation title
- Time between your messages in a sitting is counted (idle-capped), and each
  span is rounded to billing increments — then reviewed by you in the
  dashboard before it reaches a bill

The content script uses deliberately loose DOM heuristics; if claude.ai's
markup changes, the failure mode is "no capture," never a broken page.
Check the popup's connection indicator if entries stop appearing.
