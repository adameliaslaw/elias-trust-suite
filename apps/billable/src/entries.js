'use strict';
// Turn the raw event ledger into billable time entries.
//
// A "task" runs from a user prompt until the assistant stops (or the next
// prompt begins). Each task becomes one time entry, like a line on a
// timesheet: date, client/matter, narrative, hours, amount.
//
// Entries carry a stable id (hash of session + start time) so attorney
// review decisions — reviewed, edited hours/narrative, write-offs — can be
// stored as overrides without ever mutating the append-only ledger.

const crypto = require('crypto');
const { roundHours, activeSeconds, narrative, activityCode, truncate } = require('./billing');
const { matterFor } = require('./store');

function entryId(session, ts) {
  return crypto.createHash('sha1').update(`${session}|${ts}`).digest('hex').slice(0, 12);
}

function buildEntries(events, config, overrides = {}) {
  // Group events by Claude session, then split each session into tasks.
  const sessions = new Map();
  const manual = [];
  for (const ev of events) {
    if (ev.type === 'manual') {
      manual.push(ev);
      continue;
    }
    // Only activity events become time; audit records (payment_request, ...)
    // live in the ledger but are never billable.
    if (!['prompt', 'tool', 'stop'].includes(ev.type)) continue;
    const key = ev.session || 'unknown';
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(ev);
  }

  const entries = [];
  for (const [session, evs] of sessions) {
    let task = null;
    const flush = () => {
      if (task && task.timestamps.length) entries.push(finishTask(task, config));
      task = null;
    };
    for (const ev of evs) {
      if (ev.type === 'prompt') {
        flush();
        task = newTask(session, ev);
      } else {
        if (!task) task = newTask(session, ev); // tool events without a seen prompt
        task.timestamps.push(ev.ts);
        if (ev.type === 'tool' && ev.tool) task.tools.push(ev.tool);
        if (ev.cwd && !task.cwd) task.cwd = ev.cwd;
        if (ev.type === 'stop') flush();
      }
    }
    flush();
  }

  for (const ev of manual) {
    const m = {
      id: entryId('manual', `${ev.ts}|${ev.minutes}|${ev.description || ''}`),
      date: (ev.ts || '').slice(0, 10),
      ts: ev.ts,
      session: 'manual',
      client: ev.client || config.defaultClient,
      matter: ev.matter || config.defaultMatter,
      code: ev.code || 'A111',
      description: ev.description || 'Attended to matter.',
      steps: 0,
      seconds: Math.round((ev.minutes || 0) * 60),
      hours: roundHours((ev.minutes || 0) * 60, config.incrementHours, config.minimumHours),
      manual: true,
      source: ev.source || 'manual',
    };
    entries.push(m);
  }

  for (const e of entries) applyOverride(e, overrides[e.id], config);
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}

function newTask(session, ev) {
  return {
    session,
    subject: ev.type === 'prompt' ? ev.detail : '',
    cwd: ev.cwd || '',
    client: ev.client || '',
    matter: ev.matter || '',
    source: ev.source || 'claude-code',
    timestamps: [ev.ts],
    tools: [],
  };
}

function finishTask(task, config) {
  const seconds = activeSeconds(task.timestamps, config.idleCapMinutes);
  const hours = roundHours(seconds, config.incrementHours, config.minimumHours);
  // Explicit client/matter (web capture) beats directory routing; an
  // explicit client without a matter bills to a matter named after it.
  const routed = matterFor(config, task.cwd);
  const client = task.client || routed.client;
  const matter = task.matter || (task.client ? task.client : routed.matter);
  return {
    id: entryId(task.session, task.timestamps[0]),
    date: task.timestamps[0].slice(0, 10),
    ts: task.timestamps[0],
    session: task.session,
    client,
    matter,
    code: activityCode(task),
    description: narrative(task),
    steps: task.tools.length,
    seconds: Math.round(seconds),
    hours,
    manual: false,
    source: task.source,
  };
}

// Apply attorney review decisions and compute money fields. Overrides win
// over derived values; the amount is always recomputed last so edited hours
// and write-offs price correctly.
function applyOverride(entry, o, config) {
  if (o) {
    // Defense in depth: ignore a poisoned hours override rather than
    // letting NaN/negative amounts flow into invoices and payment links.
    if (o.hours != null) {
      const hours = Number(o.hours);
      if (Number.isFinite(hours) && hours >= 0) entry.hours = hours;
    }
    if (o.description) entry.description = String(o.description);
    if (o.client) entry.client = String(o.client);
    if (o.matter) entry.matter = String(o.matter);
    if (o.code) entry.code = String(o.code);
    entry.reviewed = !!o.reviewed;
    entry.writeOff = !!o.writeOff;
  } else {
    entry.reviewed = false;
    entry.writeOff = false;
  }
  entry.amount = entry.writeOff ? 0 : round2(entry.hours * (config.rate || 0));
  // AI usage cost pass-through is based on unrounded actual runtime, not
  // billed tenths — it's a disclosed expense, not a fee (ABA Op. 512).
  entry.aiCost =
    !entry.manual && (config.aiCostPerHour || 0) > 0 && !entry.writeOff
      ? round2((entry.seconds / 3600) * config.aiCostPerHour)
      : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function filterEntries(entries, { from, to, client, matter } = {}) {
  return entries.filter((e) => {
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    if (client && e.client.toLowerCase() !== client.toLowerCase()) return false;
    if (matter && e.matter.toLowerCase() !== matter.toLowerCase()) return false;
    return true;
  });
}

function totals(entries) {
  let hours = 0;
  let amount = 0;
  let steps = 0;
  let aiCost = 0;
  let unreviewed = 0;
  for (const e of entries) {
    if (!e.writeOff) {
      hours += e.hours;
      amount += e.amount;
    }
    steps += e.steps;
    aiCost += e.aiCost || 0;
    if (!e.reviewed) unreviewed++;
  }
  return {
    hours: Number(hours.toFixed(2)),
    amount: round2(amount),
    aiCost: round2(aiCost),
    steps,
    unreviewed,
    count: entries.length,
  };
}

module.exports = { buildEntries, filterEntries, totals, entryId, truncate };
