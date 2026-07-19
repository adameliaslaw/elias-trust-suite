'use strict';
// Install Billable.ai capture hooks into Claude Code settings so every
// prompt, tool step, and stop event lands in the ledger automatically.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop'];

function logCommand() {
  const bin = path.resolve(__dirname, '..', 'bin', 'billable.js');
  return `node ${JSON.stringify(bin)} log`;
}

function settingsPath({ global } = {}) {
  return global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');
}

// Merge our hooks into an existing settings file without disturbing
// anything else in it. Idempotent: re-running install changes nothing.
function installHooks(file) {
  let settings = {};
  if (fs.existsSync(file)) {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  settings.hooks = settings.hooks || {};
  const command = logCommand();
  const added = [];
  for (const event of HOOK_EVENTS) {
    const groups = (settings.hooks[event] = settings.hooks[event] || []);
    const present = groups.some((g) => (g.hooks || []).some((h) => h.command === command));
    if (present) continue;
    const group = { hooks: [{ type: 'command', command }] };
    if (event === 'PostToolUse') group.matcher = '*';
    groups.push(group);
    added.push(event);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return added;
}

// Translate a Claude Code hook payload (JSON on stdin) into a ledger event.
// Web-capture sources (browser extension) send the same shape plus optional
// client/matter, since chat sessions have no project directory to route by.
function eventFromHookPayload(payload, now = new Date()) {
  const base = {
    ts: now.toISOString(),
    session: payload.session_id || 'unknown',
    cwd: payload.cwd || '',
  };
  if (typeof payload.client === 'string' && payload.client) base.client = payload.client.slice(0, 200);
  if (typeof payload.matter === 'string' && payload.matter) base.matter = payload.matter.slice(0, 200);
  if (typeof payload.source === 'string' && payload.source) base.source = payload.source.slice(0, 40);
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return { ...base, type: 'prompt', detail: String(payload.prompt || '').slice(0, 500) };
    case 'PostToolUse':
      return { ...base, type: 'tool', tool: payload.tool_name || 'unknown' };
    case 'Stop':
    case 'SubagentStop':
      return { ...base, type: 'stop' };
    default:
      return null; // ignore events we don't bill
  }
}

module.exports = { installHooks, eventFromHookPayload, settingsPath, logCommand, HOOK_EVENTS };
