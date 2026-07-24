// Encryption-at-rest tests (#24, re-derived for SQLite in Phase 6 / #25):
// Plaid/ACH/employee-bank secrets are ciphertext in books.db and in backups; the
// in-memory db round-trips to plaintext; the key is never packed into a backup.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-secrets-'));
process.env.QUICKBUCKS_NO_SEED = '1';
delete process.env.QUICKBUCKS_ENCRYPTION_KEY; // exercise the keyfile path

const DATA = process.env.QUICKBUCKS_DATA_DIR;
const store = require('../lib/store');
const secrets = require('../lib/secrets');
const backup = require('../lib/backup');
const sqlite = require('../lib/sqlite');

// The company doc as persisted (the row's TEXT blob) — the SQLite equivalent of
// reading the old company-<id>.json file.
function storedDoc(companyId) {
  return sqlite.connect().prepare('SELECT doc FROM company WHERE id=?').get(companyId).doc;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// Distinctive secret values we can grep the raw bytes for.
const PLAID_SECRET = 'plaid-secret-9Z8Y7X';
const ACCESS_TOKEN = 'access-sandbox-TOKEN-abc123';
const FIRM_ROUTING = '021000021';
const EMP_ACCOUNT = 'EMPLOYEE-ACCT-55501234';

function main() {
  // --- pure round-trip ---
  check('encryptValue/decryptValue round-trips and is authenticated', () => {
    const t = secrets.encryptValue(PLAID_SECRET);
    assert.ok(secrets.isEncrypted(t) && !t.includes(PLAID_SECRET));
    assert.strictEqual(secrets.decryptValue(t), PLAID_SECRET);
    // GCM auth tag rejects tampered ciphertext.
    const bad = t.slice(0, -4) + (t.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    assert.throws(() => secrets.decryptValue(bad));
  });

  check('empty/absent values are left alone; plaintext passes decrypt through', () => {
    assert.strictEqual(secrets.encryptValue(''), '');
    assert.strictEqual(secrets.encryptValue(undefined), undefined);
    assert.strictEqual(secrets.decryptValue('not-encrypted'), 'not-encrypted'); // pre-encryption data
  });

  // --- store integration ---
  const company = store.createCompany('Secrets Co');
  const db = store.load(company.id);
  db.settings.plaid = { clientId: 'client-abc', secret: PLAID_SECRET, env: 'sandbox' };
  db.settings.payroll = {
    ach: { bankRouting: FIRM_ROUTING, bankAccount: '123456789', immediateDestination: '111000025', immediateOrigin: '1234567890' },
    njAch: { routing: '031201360', account: 'NJ-ACCT-1' },
  };
  db.bankConnections.push({ id: 'c1', accessToken: ACCESS_TOKEN, accounts: [] });
  db.employees.push({ id: 'e1', name: 'Jane', bankRouting: '011401533', bankAccount: EMP_ACCOUNT });
  store.save(db);

  const rawDoc = storedDoc(company.id);
  // The raw bytes of the whole db file — nothing plaintext should appear here.
  const dbBytes = fs.readFileSync(sqlite.DB_FILE, 'latin1');
  check('no plaintext secret survives in the stored doc', () => {
    for (const secret of [PLAID_SECRET, ACCESS_TOKEN, EMP_ACCOUNT, '123456789', 'NJ-ACCT-1']) {
      assert.ok(!rawDoc.includes(secret), `plaintext secret leaked to the stored doc: ${secret}`);
    }
  });

  check('no plaintext secret survives in the raw books.db file bytes', () => {
    for (const secret of [PLAID_SECRET, ACCESS_TOKEN, EMP_ACCOUNT]) {
      assert.ok(!dbBytes.includes(secret), `plaintext secret leaked into books.db: ${secret}`);
    }
  });

  check('secret leaves are enc:v1: ciphertext in the stored doc', () => {
    const onDisk = JSON.parse(rawDoc);
    assert.ok(secrets.isEncrypted(onDisk.settings.plaid.secret));
    assert.ok(secrets.isEncrypted(onDisk.settings.payroll.ach.bankAccount));
    assert.ok(secrets.isEncrypted(onDisk.settings.payroll.njAch.account));
    assert.ok(secrets.isEncrypted(onDisk.bankConnections[0].accessToken));
    assert.ok(secrets.isEncrypted(onDisk.employees[0].bankAccount));
    // Non-secret fields stay readable.
    assert.strictEqual(onDisk.settings.payroll.ach.destinationName, undefined);
    assert.strictEqual(onDisk.employees[0].name, 'Jane');
  });

  check('the in-memory db kept plaintext (callers unchanged)', () => {
    assert.strictEqual(db.settings.plaid.secret, PLAID_SECRET);
    assert.strictEqual(db.employees[0].bankAccount, EMP_ACCOUNT);
  });

  check('openFromStorage round-trips the stored ciphertext back to plaintext', () => {
    const reopened = secrets.openFromStorage(JSON.parse(rawDoc));
    assert.strictEqual(reopened.settings.plaid.secret, PLAID_SECRET);
    assert.strictEqual(reopened.settings.payroll.ach.bankRouting, FIRM_ROUTING);
    assert.strictEqual(reopened.bankConnections[0].accessToken, ACCESS_TOKEN);
    assert.strictEqual(reopened.employees[0].bankAccount, EMP_ACCOUNT);
  });

  check('books.db is written 0600', () => {
    const mode = fs.statSync(sqlite.DB_FILE).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  check('the keyfile exists 0600', () => {
    assert.ok(fs.existsSync(secrets.KEY_FILE));
    const mode = fs.statSync(secrets.KEY_FILE).mode & 0o777;
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  // --- backups are ciphertext-only and never contain the key ---
  const tar = backup.tarball();
  check('backup tarball excludes the encryption keyfile but includes books.db', () => {
    const names = backup.entryNames(tar);
    assert.ok(!names.some(n => n.endsWith('.secret.key')), `keyfile leaked into backup: ${names.join(', ')}`);
    assert.ok(names.some(n => n.endsWith('books.db')), `books.db missing from backup: ${names.join(', ')}`);
  });

  check('backup bytes contain no plaintext secret', () => {
    const text = tar.toString('latin1');
    for (const secret of [PLAID_SECRET, ACCESS_TOKEN, EMP_ACCOUNT]) {
      assert.ok(!text.includes(secret), `plaintext secret leaked into backup: ${secret}`);
    }
  });

  console.log(`\nsecrets.test.js: ${passed} passed`);
}

main();
