'use strict';
// Ledger storage: append-only JSONL of captured events, plus JSON config.
// Everything lives in the billable home directory (default ~/.billable,
// override with BILLABLE_HOME for testing or per-firm setups).

const fs = require('fs');
const os = require('os');
const path = require('path');

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
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  tightenPerms(configPath());
}

function appendEvent(event) {
  ensureHome();
  fs.appendFileSync(ledgerPath(), JSON.stringify(event) + '\n', { mode: 0o600 });
  tightenPerms(ledgerPath());
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
  all[id] = { ...all[id], ...patch };
  ensureHome();
  fs.writeFileSync(overridesPath(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  tightenPerms(overridesPath());
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
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  appendEvent,
  readEvents,
  readOverrides,
  writeOverride,
  matterFor,
};
