'use strict';
// Ledger storage: append-only JSONL of captured events, plus JSON config.
// Everything lives in the billable home directory (default ~/.billable,
// override with BILLABLE_HOME for testing or per-firm setups).

const fs = require('fs');
const os = require('os');
const path = require('path');
const audit = require('./audit');

// Everything under the home directory is client-confidential, and
// config.json holds API keys and OAuth tokens: write files owner-only and
// keep the directory user-only, including files created before this
// hardening landed (plain writeFileSync would respect the umask, typically
// leaving 0644 world-readable files).
function ensureHome() {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(homeDir(), 0o700); } catch { /* best effort (Windows) */ }
}

function tightenPerms(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* best effort (Windows) */ }
}

function homeDir() {
  return process.env.BILLABLE_HOME || path.join(os.homedir(), '.billable');
}

function ledgerPath() {
  return path.join(homeDir(), 'ledger.jsonl');
}

function configPath() {
  return path.join(homeDir(), 'config.json');
}

function overridesPath() {
  return path.join(homeDir(), 'overrides.json');
}

function auditPath() {
  return path.join(homeDir(), 'audit.jsonl');
}

// Attorney sign-offs on client invoices (Phase 7 / #26), keyed by the canonical
// @elias/entities matter id. Kept outside the append-only ledger (like
// overrides) — the raw activity record stays evidence-grade; the sign-off is a
// separate, audited attestation.
function signoffsPath() {
  return path.join(homeDir(), 'signoffs.json');
}

const DEFAULT_CONFIG = {
  timekeeper: 'Claude (AI assistant)',
  timekeeperId: 'AI1', // LEDES timekeeper id
  timekeeperClass: 'OT', // LEDES classification (PT partner, AS associate, PL paralegal, OT other)
  firmName: '',
  firmId: '',
  rate: 0, // hourly rate in dollars; 0 = report hours only
  aiCostPerHour: 0, // AI usage cost passed through as a disclosed expense (ABA Op. 512)
  capturePrompts: true, // set false to keep prompt text out of the ledger entirely
  currency: 'USD',
  incrementHours: 0.1, // bill in 6-minute increments, attorney style
  minimumHours: 0.1, // minimum charge per task
  idleCapMinutes: 5, // cap gaps between steps so away-from-keyboard time isn't billed
  defaultClient: 'General',
  defaultMatter: 'General',
  // Map a project directory to a client/matter so work is billed to the right file.
  // e.g. { "/home/me/acme-app": { "client": "Acme Corp", "matter": "ACME-001 Website" } }
  projects: {},
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(config) {
  ensureHome();
  // Chain which keys changed (keys only — config holds API keys and OAuth
  // tokens, values must never reach the audit trail).
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* first write */ }
  const changed = [...new Set([...Object.keys(prev), ...Object.keys(config)])]
    .filter(k => JSON.stringify(prev[k]) !== JSON.stringify(config[k]));
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  tightenPerms(configPath());
  if (changed.length) {
    audit.appendSemantic(auditPath(), ledgerPath(), 'config.changed', { keys: changed.sort(), actor: 'local' });
  }
}

// Enforce capturePrompts:false on EVERY write path (M6). PRIVACY.md promises
// that with capture off, prompt text never lands in the ledger — but the
// promise has to live at the single choke point every writer passes through
// (CLI `log`, the dashboard's POST /api/log, the browser extension), not in
// any one caller. Only prompt `detail` is stripped; a manual entry's
// description is attorney-authored text, not captured prompt text, and stays.
function scrubForPrivacy(event, config) {
  if (event && event.type === 'prompt' && config.capturePrompts === false && event.detail) {
    return { ...event, detail: '' };
  }
  return event;
}

function appendEvent(event) {
  ensureHome();
  const safe = scrubForPrivacy(event, readConfig());
  // Stamped with chain fields (seq/prevHash/hash) under a lockfile so
  // concurrent hook processes serialize instead of forking the chain.
  const { firstChainedWithLegacy } = audit.appendStampedEvent(ledgerPath(), safe);
  tightenPerms(ledgerPath());
  if (firstChainedWithLegacy) {
    // Bind the pre-chain events before anything else touches the semantic log.
    audit.ensureLegacyAnchor(ledgerPath(), auditPath());
  }
}

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath(), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  const badLines = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Fail LOUD: a corrupt ledger record is evidence of a partial write or
      // tampering, and silently dropping it hides missing billable time and
      // breaks the append-only guarantee. Surface it (with the line number) so
      // it is quarantined by a human, never billed around.
      badLines.push(i + 1);
    }
  }
  if (badLines.length) {
    throw new Error(
      `ledger.jsonl: ${badLines.length} malformed record(s) at line ${badLines.join(', ')} — ` +
      `refusing to silently skip them. Repair or quarantine ${ledgerPath()} (a backup copy is ` +
      `safe; the audit chain will flag any alteration) before continuing.`
    );
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events;
}

// Per-entry attorney adjustments (review status, edited hours/narrative,
// write-offs) live outside the append-only ledger, keyed by entry id, so the
// raw activity record is never altered — the ledger stays evidence-grade.
function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(overridesPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeOverride(id, patch) {
  const all = readOverrides();
  const prev = all[id] || {};
  all[id] = { ...prev, ...patch };
  ensureHome();
  fs.writeFileSync(overridesPath(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  tightenPerms(overridesPath());
  // Attorney edits to evidence-grade entries are the highest tamper
  // incentive in the app — every one is chained with before/after context.
  // Integration stamps (clioId, lawpayRef) get their own event types.
  if ('clioId' in patch) {
    audit.appendSemantic(auditPath(), ledgerPath(), 'clio.entry_synced', {
      entryId: id, clioId: String(patch.clioId), actor: 'local'
    });
  } else if (!('lawpayRef' in patch && Object.keys(patch).length === 1)) {
    const payload = { entryId: id, fields: Object.keys(patch).sort(), actor: 'local' };
    if ('hours' in patch) {
      if (prev.hours !== undefined) payload.hoursBefore = String(prev.hours);
      payload.hoursAfter = String(patch.hours);
    }
    if ('writeOff' in patch) payload.writeOff = !!patch.writeOff;
    audit.appendSemantic(auditPath(), ledgerPath(), 'entry.override_written', payload);
  }
  return all[id];
}

// Record a Clio push INTENT before the external POST (transactional outbox).
// A Clio `POST /activities` that succeeds but dies before the clioId override
// commits would otherwise re-POST on retry and duplicate the Clio activity.
// The intent is a durable, hash-chained ledger event (mirroring LawPay's
// deterministic-reference dedup shape); on retry `clio.pushEntries` sees the
// dangling intent and reconciles against Clio instead of blindly re-POSTing.
// `key` is the deterministic idempotency key for this entry's activity.
function appendClioIntent(key, entryId, clioMatterId) {
  appendEvent({
    ts: new Date().toISOString(),
    type: 'clio.push_intent',
    key,
    entryId,
    clioMatterId,
  });
}

// Stamp the single, mutually-exclusive billed marker onto an entry (#18).
// Once set, every client-facing destination treats the entry as billed, so a
// second export is a no-op. The write is chained as an override_written audit
// event (the `billed` field shows in its `fields` list).
function markBilled(id, destination, reference) {
  return writeOverride(id, {
    billed: { destination: String(destination), reference: String(reference), at: new Date().toISOString() },
  });
}

// Read the persisted sign-offs map (canonical matter id -> Signoff record).
function readSignoffs() {
  try {
    return JSON.parse(fs.readFileSync(signoffsPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** The recorded sign-off for a canonical matter id, or null. */
function readSignoff(matterId) {
  return readSignoffs()[matterId] || null;
}

// Persist an attorney sign-off keyed by canonical matter id and chain its
// compliance.signoff event into the tamper-evident audit trail. The stored
// record is the single source the billing gate consults; the audit event is
// the immutable proof it happened. Latest sign-off per matter wins (a re-sign
// after an edit overwrites a now-stale one) — the audit chain retains every
// signature, so the history is never lost.
function recordSignoff(matterId, signoff, event) {
  const all = readSignoffs();
  all[matterId] = signoff;
  ensureHome();
  fs.writeFileSync(signoffsPath(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  tightenPerms(signoffsPath());
  audit.appendSemantic(auditPath(), ledgerPath(), event.type, event.payload);
  return signoff;
}

function matterFor(config, cwd) {
  if (cwd) {
    // Longest-prefix match so nested projects resolve to the most specific matter.
    let best = null;
    for (const [dir, m] of Object.entries(config.projects || {})) {
      if ((cwd === dir || cwd.startsWith(dir + path.sep)) && (!best || dir.length > best.dir.length)) {
        best = { dir, ...m };
      }
    }
    if (best) {
      return {
        client: best.client || config.defaultClient,
        matter: best.matter || config.defaultMatter,
      };
    }
  }
  return { client: config.defaultClient, matter: config.defaultMatter };
}

module.exports = {
  homeDir,
  ledgerPath,
  configPath,
  overridesPath,
  auditPath,
  signoffsPath,
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  appendEvent,
  readEvents,
  readOverrides,
  writeOverride,
  appendClioIntent,
  markBilled,
  readSignoffs,
  readSignoff,
  recordSignoff,
  matterFor,
};
