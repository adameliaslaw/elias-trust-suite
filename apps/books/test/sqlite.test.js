// SQLite durable-storage engine tests (Phase 6 / #25).
//
// Proves:
//   - the schema is created + versioned via PRAGMA user_version;
//   - the one-time JSON -> SQLite import is LOSSLESS: legacy global.json +
//     company-<id>.json data lands in the DB intact, the in-doc outbox is
//     drained into the real outbox table, already-sealed secret strings survive
//     verbatim (and still decrypt), and each imported file is renamed aside so a
//     restart never re-imports.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-sqlite-'));
process.env.QUICKBUCKS_NO_SEED = '1';
process.env.QUICKBUCKS_DISABLE_AUTH = '1';
// Fixed key so we can pre-seal a secret value and prove it survives the import.
process.env.QUICKBUCKS_ENCRYPTION_KEY = 'sqlite-import-test-key';

const DATA = process.env.QUICKBUCKS_DATA_DIR;
const secrets = require('../lib/secrets');
const sqlite = require('../lib/sqlite');

let passed = 0;
const check = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓', name); };

// A distinctive secret we can grep for, pre-sealed as it would be on disk.
const PLAID_SECRET = 'plaid-secret-IMPORT-7QW';
const SEALED_SECRET = secrets.encryptValue(PLAID_SECRET);
const COID = 'legacyco1';

function main() {
  // Hand-write the legacy JSON-file store: a household file and one company
  // file that carries an already-sealed secret AND a pending in-doc outbox
  // event (as the #24 JSON era left them).
  fs.writeFileSync(path.join(DATA, 'global.json'), JSON.stringify({
    companies: [{ id: COID, name: 'Legacy Co', createdAt: '2026-01-01' }],
    passwordHash: 'salt:hash', taxProfiles: {}
  }));
  fs.writeFileSync(path.join(DATA, `company-${COID}.json`), JSON.stringify({
    settings: { companyName: 'Legacy Co', nextInvoiceNumber: 1001, invoicePrefix: 'INV-', plaid: { secret: SEALED_SECRET } },
    customers: [{ id: 'keep', name: 'Persisted Customer' }],
    invoices: [{ id: 'inv-1', customerId: 'keep', items: [], payments: [] }],
    outbox: [{ id: 'owed-1', type: 'invoice.created', payload: { invoiceId: 'inv-1', totalCents: '5000' } }]
  }));

  // First DB access triggers connect() -> schema + import.
  const store = require('../lib/store');
  const { loadGlobal } = require('../lib/global');
  const conn = sqlite.connect();

  check('PRAGMA user_version is stamped to the current schema version',
    conn.prepare('PRAGMA user_version').get().user_version === sqlite.SCHEMA_MIGRATIONS.length);
  check('the core tables exist', ['global', 'company', 'outbox'].every(t =>
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)));

  // -- lossless import: household --
  const g = loadGlobal();
  check('household registry imported losslessly',
    g.companies.length === 1 && g.companies[0].id === COID && g.passwordHash === 'salt:hash');

  // -- lossless import: company doc --
  const db = store.load(COID);
  check('company data imported losslessly (customers + invoices preserved)',
    db.customers.length === 1 && db.customers[0].name === 'Persisted Customer' &&
    db.invoices.length === 1 && db.invoices[0].id === 'inv-1');
  check('pre-sealed secret survived the import and decrypts back to plaintext',
    db.settings.plaid.secret === PLAID_SECRET);

  // -- the in-doc outbox event was drained into the real table --
  const owed = conn.prepare('SELECT msg_id, type, payload FROM outbox WHERE company_id=?').all(COID);
  check('pending in-doc outbox event moved into the outbox table (not lost)',
    owed.length === 1 && owed[0].msg_id === 'owed-1' && owed[0].type === 'invoice.created');
  check('the imported doc no longer carries an in-doc outbox array',
    !('outbox' in JSON.parse(conn.prepare('SELECT doc FROM company WHERE id=?').get(COID).doc)));

  // -- files renamed aside; a restart does not re-import --
  check('legacy files renamed to *.migrated after import',
    fs.existsSync(path.join(DATA, 'global.json.migrated')) &&
    fs.existsSync(path.join(DATA, `company-${COID}.json.migrated`)) &&
    !fs.existsSync(path.join(DATA, 'global.json')) &&
    !fs.existsSync(path.join(DATA, `company-${COID}.json`)));

  sqlite._reset();
  const conn2 = sqlite.connect();
  check('re-open is idempotent: no double import, outbox row still single',
    conn2.prepare('SELECT count(*) c FROM outbox WHERE company_id=?').get(COID).c === 1);

  console.log(`\nAll ${passed} sqlite checks passed.`);
}

main();
