// Schema-versioning + migration-runner round trips (Phase 6 / #25).
//
// Proves:
//   - the pure runner upgrades a legacy (unversioned) object to the current
//     version, backfilling/transforming shape without dropping existing data,
//     and is idempotent (a second run is a no-op);
//   - on disk, store.load() and loadGlobal() upgrade a legacy file IN MEMORY
//     and write the upgraded file back atomically at the new version (0600),
//     never lossily.
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-migrate-'));
process.env.QUICKBUCKS_NO_SEED = '1';
process.env.QUICKBUCKS_DISABLE_AUTH = '1';
// Fixed key so the hand-written legacy file needs no keyfile dance.
process.env.QUICKBUCKS_ENCRYPTION_KEY = 'migrate-test-key';

const DATA = process.env.QUICKBUCKS_DATA_DIR;
const migrations = require('../lib/migrations');

let passed = 0;
const check = (name, cond) => { assert.ok(cond, name); passed++; console.log('  ✓', name); };

function mode(file) {
  return fs.statSync(path.join(DATA, file)).mode & 0o777;
}

async function main() {
  // ---- pure company runner ----
  const legacy = {
    settings: { companyName: 'Legacy X' },
    expenseCategories: ['Payroll', 'Other'],
    customers: [{ id: 'k1', name: 'Keep Me' }], invoices: [], expenses: []
  };
  let changed = migrations.migrateCompany(legacy, 'c1');
  check('company runner reports changed on a v0 object', changed === true);
  check('company runner stamps the current schemaVersion', legacy.schemaVersion === migrations.COMPANY_SCHEMA_VERSION);
  check('company runner backfills missing collections',
    Array.isArray(legacy.timeEntries) && Array.isArray(legacy.outbox) && Array.isArray(legacy.bankConnections) && Array.isArray(legacy.payRuns));
  check('company runner inserts Payroll Taxes right after Payroll',
    legacy.expenseCategories.indexOf('Payroll Taxes') === legacy.expenseCategories.indexOf('Payroll') + 1);
  check('company runner is not lossy — existing data preserved',
    legacy.settings.companyName === 'Legacy X' && legacy.customers.length === 1 && legacy.customers[0].name === 'Keep Me');
  check('company runner is idempotent (no change on a 2nd run)', migrations.migrateCompany(legacy, 'c1') === false);

  // ---- pure global runner ----
  const g = { companies: [{ id: 'c1', name: 'X' }], passwordHash: 'salt:hash', taxProfile: { wages: 100 } };
  changed = migrations.migrateGlobal(g);
  check('global runner reports changed on a v0 object', changed === true);
  check('global runner stamps the current schemaVersion', g.schemaVersion === migrations.GLOBAL_SCHEMA_VERSION);
  check('global runner seeds an empty principals list (roles)', Array.isArray(g.principals) && g.principals.length === 0);
  check('global runner preserves the household password (the default owner)', g.passwordHash === 'salt:hash');
  check('global runner folds the legacy single taxProfile into 2026',
    g.taxProfiles && g.taxProfiles['2026'] && g.taxProfiles['2026'].wages === 100 && !('taxProfile' in g));
  check('global runner is idempotent', migrations.migrateGlobal(g) === false);

  // A file already at the current version is left untouched (no spurious write).
  const current = { schemaVersion: migrations.COMPANY_SCHEMA_VERSION, expenseCategories: ['Payroll', 'Payroll Taxes'], outbox: [] };
  check('runner is a no-op on an already-current object', migrations.migrateCompany(current, 'c2') === false);

  // ---- on-disk round trip via the store ----
  const id = 'legacyco';
  // Hand-write a legacy household file (no schemaVersion, no principals) and a
  // legacy company file (no schemaVersion, missing later collections).
  fs.writeFileSync(path.join(DATA, 'global.json'),
    JSON.stringify({ companies: [{ id, name: 'Legacy Co', createdAt: '2026-01-01' }], passwordHash: null }));
  fs.writeFileSync(path.join(DATA, `company-${id}.json`),
    JSON.stringify({
      settings: { companyName: 'Legacy Co', nextInvoiceNumber: 1001, invoicePrefix: 'INV-' },
      expenseCategories: ['Payroll', 'Other'],
      customers: [{ id: 'keep', name: 'Persisted Customer' }], invoices: []
    }));

  const store = require('../lib/store');
  const db = store.load(id);
  check('store.load upgrades a legacy company file in memory',
    db.schemaVersion === migrations.COMPANY_SCHEMA_VERSION && Array.isArray(db.timeEntries) && Array.isArray(db.outbox));
  check('store.load does not drop legacy customer data',
    db.customers.length === 1 && db.customers[0].name === 'Persisted Customer');
  const coDisk = JSON.parse(fs.readFileSync(path.join(DATA, `company-${id}.json`), 'utf8'));
  check('store.load writes the upgraded company file back to disk',
    coDisk.schemaVersion === migrations.COMPANY_SCHEMA_VERSION && Array.isArray(coDisk.outbox) && coDisk.customers[0].name === 'Persisted Customer');
  check('upgraded company file is written 0600', mode(`company-${id}.json`) === 0o600);

  const { loadGlobal } = require('../lib/global');
  const gl = loadGlobal();
  check('loadGlobal upgrades global.json to the current version',
    gl.schemaVersion === migrations.GLOBAL_SCHEMA_VERSION && Array.isArray(gl.principals));
  const glDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'global.json'), 'utf8'));
  check('global.json is written back at the new version with principals seeded',
    glDisk.schemaVersion === migrations.GLOBAL_SCHEMA_VERSION && Array.isArray(glDisk.principals));

  console.log(`\nAll ${passed} migration checks passed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
