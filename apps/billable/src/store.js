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

function appendEvent(event) {
  ensureHome();
  // Stamped with chain fields (seq/prevHash/hash) under a lockfile so
  // concurrent hook processes serialize instead of forking the chain.
  const { firstChainedWithLegacy } = audit.appendStampedEvent(ledgerPath(), event);
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
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip corrupt lines rather than losing the whole ledger.
    }
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
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  appendEvent,
  readEvents,
  readOverrides,
  writeOverride,
  matterFor,
};
