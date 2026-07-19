'use strict';
// Attorney-style billing rules: UTBMS-inspired activity codes, 6-minute
// increment rounding, and billing-narrative generation from raw Claude steps.

// Map Claude tools to standard UTBMS activity codes so exports drop straight
// into legal billing systems.
const TOOL_ACTIVITIES = [
  { match: /^(Read|Glob|Grep|Explore|LS|NotebookRead)$/i, code: 'A104', verb: 'Reviewed and analyzed', noun: 'files' },
  { match: /^(Edit|Write|MultiEdit|NotebookEdit)$/i, code: 'A103', verb: 'Drafted and revised', noun: 'documents' },
  { match: /^(WebSearch|WebFetch|firecrawl|.*search.*)$/i, code: 'A102', verb: 'Researched', noun: 'sources' },
  { match: /^(Bash|BashOutput|KillShell)$/i, code: 'A110', verb: 'Executed and verified', noun: 'operations' },
  { match: /^(Agent|Task|Workflow)$/i, code: 'A101', verb: 'Planned and delegated', noun: 'workstreams' },
  { match: /^(AskUserQuestion)$/i, code: 'A106', verb: 'Conferred with client', noun: 'inquiries' },
];

const FALLBACK_ACTIVITY = { code: 'A111', verb: 'Performed', noun: 'other steps' };

function classifyTool(toolName) {
  const name = String(toolName || '');
  for (const a of TOOL_ACTIVITIES) {
    if (a.match.test(name)) return a;
  }
  return FALLBACK_ACTIVITY;
}

// Round up to the billing increment with a minimum charge, the way a
// timekeeper records 0.1 hr for any task, however small.
function roundHours(seconds, incrementHours, minimumHours) {
  const inc = incrementHours > 0 ? incrementHours : 0.1;
  const min = minimumHours > 0 ? minimumHours : inc;
  if (!(seconds > 0)) return min;
  const hours = seconds / 3600;
  const rounded = Math.ceil(hours / inc - 1e-9) * inc;
  return Math.max(min, Number(rounded.toFixed(4)));
}

// Sum billable duration across ordered timestamps, capping gaps between
// steps so idle time (user stepped away) isn't billed.
function activeSeconds(timestamps, idleCapMinutes) {
  const cap = (idleCapMinutes > 0 ? idleCapMinutes : 5) * 60;
  let total = 0;
  for (let i = 1; i < timestamps.length; i++) {
    const gap = (new Date(timestamps[i]) - new Date(timestamps[i - 1])) / 1000;
    if (gap > 0) total += Math.min(gap, cap);
  }
  return total;
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

// Build an attorney-style narrative, e.g.:
// "Reviewed and analyzed 6 files; drafted and revised 3 documents;
//  executed and verified 2 operations re: fix login bug."
function narrative(entry) {
  const counts = new Map();
  for (const tool of entry.tools) {
    const a = classifyTool(tool);
    const key = a.code + '|' + a.verb + '|' + a.noun;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const parts = [];
  for (const [key, n] of counts) {
    const [, verb, noun] = key.split('|');
    parts.push(`${verb.toLowerCase()} ${n} ${n === 1 ? noun.replace(/ies$/, 'y').replace(/s$/, '') : noun}`);
  }
  let text = parts.length
    ? parts.join('; ')
    : 'attended to matter';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (entry.subject) text += ` re: ${truncate(entry.subject, 100)}`;
  return text + '.';
}

// Dominant activity code for the entry (most frequent tool category).
function activityCode(entry) {
  if (!entry.tools.length) return 'A105';
  const counts = new Map();
  for (const tool of entry.tools) {
    const code = classifyTool(tool).code;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

module.exports = { classifyTool, roundHours, activeSeconds, narrative, activityCode, truncate };
