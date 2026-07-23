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
const { feeCents, sumCents, centsToDollars } = require('./money');
const { billedMarker } = require('./client-billing');

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
    // A manual entry IS the attorney entering human minutes — confirmed by
    // construction (#17). Its hours are billable time, not a machine estimate.
    const minutes = ev.minutes || 0;
    const hours = roundHours(minutes * 60, config.incrementHours, config.minimumHours);
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
      seconds: Math.round(minutes * 60),
      suggestedHours: hours,
      hours,
      confirmed: true,
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
  // The AI runtime is COST/PROVENANCE metadata only (#17). It yields a
  // *suggestion* the attorney can start from, never billable time. Inferred
  // attorney time defaults to zero: a billable minute exists only once an
  // attorney enters/confirms human minutes (via an override).
  const suggestedHours = roundHours(seconds, config.incrementHours, config.minimumHours);
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
    seconds: Math.round(seconds), // AI runtime — provenance / AI-cost basis only
    suggestedHours,               // machine estimate offered to the attorney; NOT billable
    hours: 0,                     // billable hours: zero until an attorney confirms minutes
    confirmed: false,
    manual: false,
    source: task.source,
  };
}

// Apply attorney review decisions and compute money fields. Overrides win
// over derived values; the amount is always recomputed last so edited hours
// and write-offs price correctly.
function applyOverride(entry, o, config) {
  // Rate is FROZEN onto the entry when the attorney reviews it (snapshot at
  // review time), so later edits to the rate table never reprice historical
  // work. Until an entry carries a snapshot it prices at the live rate.
  const snap = o && o.rateSnapshot != null ? Number(o.rateSnapshot) : NaN;
  const rate = Number.isFinite(snap) && snap >= 0 ? snap : config.rate || 0;
  if (o) {
    // Defense in depth: ignore a poisoned hours override rather than
    // letting NaN/negative amounts flow into invoices and payment links.
    if (o.hours != null) {
      const hours = Number(o.hours);
      // An attorney-entered hours value IS the confirmation of human minutes.
      if (Number.isFinite(hours) && hours >= 0) {
        entry.hours = hours;
        entry.confirmed = true;
      }
    }
    if (o.description) entry.description = String(o.description);
    if (o.client) entry.client = String(o.client);
    if (o.matter) entry.matter = String(o.matter);
    if (o.code) entry.code = String(o.code);
    entry.reviewed = !!o.reviewed;
    entry.writeOff = !!o.writeOff;
    entry.billed = billedMarker(o);
  } else {
    entry.reviewed = false;
    entry.writeOff = false;
    entry.billed = null;
  }
  // #17: a billable minute exists only where an attorney confirmed human
  // minutes. Machine-inferred AI runtime never becomes billable time by itself.
  entry.billable = !entry.writeOff && !!entry.confirmed && entry.hours > 0;
  entry.rate = rate;
  entry.amount = entry.billable ? centsToDollars(feeCents(entry.hours, rate)) : 0;
  // AI usage cost pass-through is based on unrounded actual runtime, not
  // billed tenths — it's a disclosed expense, not a fee (ABA Op. 512).
  entry.aiCost =
    !entry.manual && (config.aiCostPerHour || 0) > 0 && !entry.writeOff
      ? centsToDollars(feeCents(entry.seconds / 3600, config.aiCostPerHour))
      : 0;
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
  let steps = 0;
  let unreviewed = 0;
  let unconfirmed = 0;
  let billableCount = 0;
  const amounts = [];
  const aiCosts = [];
  for (const e of entries) {
    if (!e.writeOff) {
      hours += e.hours;
      amounts.push(e.amount);
    }
    steps += e.steps;
    aiCosts.push(e.aiCost || 0);
    if (!e.reviewed) unreviewed++;
    // Captured-but-unconfirmed work: measured by the machine, not yet turned
    // into billable minutes by an attorney (#17).
    if (!e.writeOff && !e.confirmed) unconfirmed++;
    if (e.billable) billableCount++;
  }
  return {
    hours: Number(hours.toFixed(2)),
    amount: centsToDollars(sumCents(...amounts)),
    aiCost: centsToDollars(sumCents(...aiCosts)),
    steps,
    unreviewed,
    unconfirmed,
    billableCount,
    count: entries.length,
  };
}

module.exports = { buildEntries, filterEntries, totals, entryId, truncate, applyOverride };
