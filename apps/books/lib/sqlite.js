'use strict';
// Durable storage engine for books: SQLite via node:sqlite (Phase 6 / #25).
//
// ─── Why node:sqlite (the dependency call-out) ───────────────────────────────
// The suite keeps a zero-dependency ethos and the owner's D2=B "host as-is"
// decision. Two SQLite paths exist on this stack and only one honors both:
//   • better-sqlite3 — a native node-gyp addon. Needs a C toolchain at install
//     time, so a bare `npm ci` on a fresh host can fail, and it is a real
//     third-party runtime dependency. REJECTED: the opposite of host-as-is +
//     zero-dep.
//   • node:sqlite — built INTO Node itself (since v22.5). No npm dependency, no
//     native compile. It is still flagged experimental (one stderr warning,
//     silenced below), but it loads WITHOUT a flag on v22.5+, and CI runs Node
//     24. CHOSEN: it is the zero-dependency realization of "SQLite".
// Cost of the choice: the Node floor moves from 20 to 22.5 (see package.json
// `engines`). CI already runs 24, so this is honest and covered.
//
// ─── Storage model (deliberate: a DOCUMENT store on SQLite) ──────────────────
// Each company's books stay ONE in-memory JSON document, so every route handler
// is unchanged and the 252-check smoke suite passes byte-for-byte. Persistence
// is one row per company (`company.doc` = the sealed JSON). This is NOT a full
// relational rewrite of the eleven route groups — that risk buys nothing while
// there is no real data. What SQLite buys us is REAL transactions: a money
// mutation and its owed audit event now commit in ONE transaction (lib/outbox.js)
// instead of a tmp-file+rename swap. The outbox is promoted to a first-class
// TABLE because that is exactly where transactional exactly-once matters.
//
// ─── Two migration layers, kept distinct ─────────────────────────────────────
//   • SCHEMA (this file): the TABLE structure, versioned by PRAGMA user_version,
//     applied as ordered DDL steps. Bumps only when the tables themselves change.
//   • DOCUMENT (lib/migrations.js): the shape of a company/global JSON doc,
//     versioned by the doc's own `schemaVersion`. Engine-agnostic — carried over
//     unchanged from the JSON-file era, and still run on every load().
//
// ─── Durability + backups ────────────────────────────────────────────────────
// journal_mode=DELETE (the default) + synchronous=FULL: fully crash-atomic, and
// after every committed transaction the on-disk state is a SINGLE self-contained
// books.db file (the rollback journal is deleted on commit). That keeps the
// dependency-free tar backup (lib/backup.js) trivially correct — it tars one
// file. WAL would add -wal/-shm sidecars a naive tar could miss mid-checkpoint,
// so it is deliberately NOT used here.
const path = require('path');
const fs = require('fs');
const migrations = require('./migrations');

// Silence ONLY node:sqlite's experimental-feature warning. It is genuinely
// experimental (called out in the PR); we do not want it printed once per test
// process, but every OTHER warning must still surface — so filter by message.
const _origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : (warning && warning.message);
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental feature')) return;
  return _origEmitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');

// Computed identically to lib/global.js's DATA_DIR (kept independent to avoid a
// require cycle: global.js → sqlite.js). Both read the same env, same fallback.
const DATA_DIR = process.env.QUICKBUCKS_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'books.db');

let conn = null;

// ─── SQLite schema (table structure), versioned by PRAGMA user_version ───────
// To change tables: append a { version: N, up(db) } step (N = next integer). Do
// NOT edit an existing step — a db already at that user_version will not re-run
// it. This is separate from the per-document schemaVersion (lib/migrations.js).
const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        -- Household-shared data (companies registry, password, principals, tax
        -- profiles, Schedule Elias). Single row, id pinned to 0.
        CREATE TABLE IF NOT EXISTS global (
          id  INTEGER PRIMARY KEY CHECK (id = 0),
          doc TEXT NOT NULL
        );
        -- One company's books = one JSON document (secrets sealed within).
        CREATE TABLE IF NOT EXISTS company (
          id  TEXT PRIMARY KEY,
          doc TEXT NOT NULL
        );
        -- Transactional outbox (#24), now a real table. A money mutation writes
        -- the company doc AND inserts its owed audit event(s) here in ONE
        -- transaction; a relay delivers them to the tamper-evident chain and
        -- deletes the rows. msg_id is the idempotency key the chain dedups on.
        CREATE TABLE IF NOT EXISTS outbox (
          msg_id     TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          type       TEXT NOT NULL,
          payload    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS outbox_company ON outbox(company_id);
      `);
    }
  }
];

function migrateSchema(db) {
  const from = db.prepare('PRAGMA user_version').get().user_version;
  let v = from;
  for (const m of SCHEMA_MIGRATIONS) {
    if (m.version > v) {
      m.up(db);
      v = m.version;
      console.log(`[sqlite] schema v${from} -> v${m.version}`);
    }
  }
  // PRAGMA can't be parameterized; v is our own integer, safe to interpolate.
  if (v !== from) db.exec(`PRAGMA user_version = ${v}`);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── One-time, lossless JSON → SQLite import ─────────────────────────────────
// Runs inside connect(), after the schema exists. For each legacy JSON file
// present in the data dir it imports the data and renames the file to
// *.migrated so it never re-imports (idempotent across restarts). Secrets are
// already sealed (enc:v1:) in the on-disk company files — we move that doc text
// verbatim, so nothing is decrypted/re-encrypted here; the keyfile stays put and
// still opens them on the next load(). The one transform: any pending in-doc
// `outbox` array (the #24 JSON-era design) is drained into the real outbox
// table so no owed audit event is lost across the cutover.
function importLegacyJson(db) {
  if (!fs.existsSync(DATA_DIR)) return;
  const secrets = require('./secrets'); // lazy: avoid a load-time require cycle
  const insertGlobal = db.prepare('INSERT OR REPLACE INTO global(id, doc) VALUES(0, ?)');
  const insertCompany = db.prepare('INSERT OR REPLACE INTO company(id, doc) VALUES(?, ?)');
  const insertOutbox = db.prepare(
    'INSERT OR IGNORE INTO outbox(msg_id, company_id, type, payload) VALUES(?, ?, ?, ?)'
  );

  const globalFile = path.join(DATA_DIR, 'global.json');
  let globalDoc = fs.existsSync(globalFile)
    ? JSON.parse(fs.readFileSync(globalFile, 'utf8'))
    : null;

  // Ancient single-company era: data/db.json → the first company (+ its password
  // moves to the household doc), mirroring the old store.migrateLegacy().
  const legacyDb = path.join(DATA_DIR, 'db.json');
  if (fs.existsSync(legacyDb)) {
    if (!globalDoc) globalDoc = { companies: [] };
    globalDoc.companies = globalDoc.companies || [];
    if (!globalDoc.companies.length) {
      const doc = JSON.parse(fs.readFileSync(legacyDb, 'utf8'));
      const id = uid();
      if (doc.settings && doc.settings.passwordHash) {
        globalDoc.passwordHash = doc.settings.passwordHash;
        delete doc.settings.passwordHash;
      }
      const name = (doc.settings && doc.settings.companyName) || 'My Company';
      globalDoc.companies.push({ id, name, createdAt: new Date().toISOString().slice(0, 10) });
      migrations.migrateCompany(doc, id);
      delete doc.outbox; // outbox is the table now, not part of the doc
      // db.json held PLAINTEXT secrets (pre-#24), so seal on the way in.
      insertCompany.run(id, JSON.stringify(secrets.sealForStorage(doc)));
    }
    fs.renameSync(legacyDb, legacyDb + '.migrated');
  }

  if (globalDoc) {
    migrations.migrateGlobal(globalDoc);
    insertGlobal.run(JSON.stringify(globalDoc));
    if (fs.existsSync(globalFile)) fs.renameSync(globalFile, globalFile + '.migrated');
  }

  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = /^company-(.+)\.json$/.exec(f);
    if (!m) continue;
    const id = m[1];
    const full = path.join(DATA_DIR, f);
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    // Drain any pending in-doc outbox into the real table (lossless). These
    // files are already sealed on disk — the sealed strings round-trip as-is.
    for (const msg of Array.isArray(doc.outbox) ? doc.outbox : []) {
      if (msg && msg.id) insertOutbox.run(msg.id, id, msg.type, JSON.stringify(msg.payload ?? null));
    }
    // Migrate first (the doc runner backfills an empty outbox), THEN drop it —
    // the outbox is the table now, never part of the stored doc.
    migrations.migrateCompany(doc, id);
    delete doc.outbox;
    insertCompany.run(id, JSON.stringify(doc));
    fs.renameSync(full, full + '.migrated');
  }
}

// Open (once) the durable connection, apply schema migrations, and import any
// legacy JSON. Idempotent — every store/global call routes through here.
function connect() {
  if (conn) return conn;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  conn = new DatabaseSync(DB_FILE);
  conn.exec('PRAGMA journal_mode = DELETE'); // self-contained file after commit
  conn.exec('PRAGMA synchronous = FULL');    // money at rest: durable on commit
  // 0600: the db holds the firm's books (secrets sealed, everything else plain).
  try { fs.chmodSync(DB_FILE, 0o600); } catch { /* platform without POSIX modes */ }
  migrateSchema(conn);
  importLegacyJson(conn);
  return conn;
}

// Test hook: close + forget the connection so the next connect() re-opens the
// file (simulates a process restart / cold boot against the durable store).
function _reset() {
  if (conn) { try { conn.close(); } catch { /* already closed */ } }
  conn = null;
}

module.exports = { connect, migrateSchema, DATA_DIR, DB_FILE, SCHEMA_MIGRATIONS, uid, _reset };
