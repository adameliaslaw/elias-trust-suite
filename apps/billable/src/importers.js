'use strict';
// Import time from a claude.ai data export (Settings → Privacy → Export data
// → conversations.json). Claude's web chat and Cowork have no hooks, so this
// reconstructs sittings from message timestamps instead — the same
// contemporaneous-record standard, applied retroactively.

const { activeSeconds } = require('./billing');

const SITTING_BREAK_MINUTES = 60; // a gap longer than this starts a new sitting

// Accepts the export's conversations.json shape (an array of conversations,
// or an object wrapping one) and tolerates minor format drift.
function conversationsFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.conversations)) return data.conversations;
  return [];
}

function messagesFrom(conv) {
  const msgs = conv.chat_messages || conv.messages || [];
  return msgs
    .map((m) => m.created_at || m.create_time || m.ts)
    .filter(Boolean)
    .map((t) => new Date(t))
    .filter((d) => !isNaN(d))
    .sort((a, b) => a - b);
}

// Returns ledger-ready manual events, one per sitting per conversation.
// Each carries an importKey so re-importing the same export is a no-op.
function parseClaudeExport(data, { client, matter, code } = {}, config) {
  const events = [];
  for (const conv of conversationsFrom(data)) {
    const times = messagesFrom(conv);
    if (!times.length) continue;
    const name = String(conv.name || conv.summary || 'Untitled conversation').trim() || 'Untitled conversation';
    const convKey = conv.uuid || conv.id || name;

    // Split the conversation into sittings at long gaps.
    const sittings = [[times[0]]];
    for (let i = 1; i < times.length; i++) {
      const gapMin = (times[i] - times[i - 1]) / 60000;
      if (gapMin > SITTING_BREAK_MINUTES) sittings.push([]);
      sittings[sittings.length - 1].push(times[i]);
    }

    sittings.forEach((sitting, index) => {
      const iso = sitting.map((d) => d.toISOString());
      const seconds = activeSeconds(iso, config.idleCapMinutes * 2 || 10);
      const minutes = Math.max(1, Math.round(seconds / 60));
      events.push({
        ts: iso[0],
        type: 'manual',
        minutes,
        description: `Claude chat (${sitting.length} messages) re: ${name}`,
        client,
        matter,
        code: code || 'A111',
        source: 'claude-import',
        importKey: `${convKey}#${index}`,
      });
    });
  }
  return events;
}

function dedupe(newEvents, existingEvents) {
  const seen = new Set(existingEvents.map((e) => e.importKey).filter(Boolean));
  return newEvents.filter((e) => !seen.has(e.importKey));
}

module.exports = { parseClaudeExport, dedupe, SITTING_BREAK_MINUTES };
