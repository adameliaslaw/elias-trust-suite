// Backup tarball tests: valid ustar structure, snapshot rotation.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

process.env.QUICKBUCKS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-backup-'));
const DATA = process.env.QUICKBUCKS_DATA_DIR;
const B = require('../lib/backup');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

fs.writeFileSync(path.join(DATA, 'global.json'), JSON.stringify({ companies: [] }));
fs.writeFileSync(path.join(DATA, 'company-abc.json'), JSON.stringify({ invoices: [] }));
fs.mkdirSync(path.join(DATA, 'receipts'));
fs.writeFileSync(path.join(DATA, 'receipts', 'abc-exp1.png'), Buffer.from([137, 80, 78, 71, 13]));

check('tarball lists every data file under a stable prefix', () => {
  const names = B.entryNames(B.tarball());
  assert.ok(names.includes('quickbucks-data/global.json'));
  assert.ok(names.includes('quickbucks-data/company-abc.json'));
  assert.ok(names.includes('quickbucks-data/receipts/abc-exp1.png'));
});

check('system tar can read the archive and round-trip the contents', () => {
  const tarFile = path.join(DATA, 'test.tar');
  fs.writeFileSync(tarFile, B.tarball());
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickbucks-extract-'));
  execFileSync('tar', ['-xf', tarFile, '-C', extractDir]);
  const global2 = fs.readFileSync(path.join(extractDir, 'quickbucks-data', 'global.json'), 'utf8');
  assert.strictEqual(global2, JSON.stringify({ companies: [] }));
  const png = fs.readFileSync(path.join(extractDir, 'quickbucks-data', 'receipts', 'abc-exp1.png'));
  assert.deepStrictEqual([...png], [137, 80, 78, 71, 13]);
  fs.unlinkSync(tarFile);
});

check('snapshots write into data/backups and are excluded from the tar', () => {
  const file = B.writeSnapshot();
  assert.ok(fs.existsSync(file));
  const names = B.entryNames(B.tarball());
  assert.ok(!names.some(n => n.includes('backups/')));
});

check('snapshot rotation keeps only the newest', () => {
  for (let i = 1; i <= B.KEEP_SNAPSHOTS + 3; i++) {
    fs.writeFileSync(path.join(B.SNAPSHOT_DIR, `quickbucks-2026-01-${String(i).padStart(2, '0')}.tar`), 'x');
  }
  B.writeSnapshot();
  const left = fs.readdirSync(B.SNAPSHOT_DIR).filter(f => f.endsWith('.tar'));
  assert.strictEqual(left.length, B.KEEP_SNAPSHOTS);
});

console.log(`\nAll ${passed} backup checks passed.`);
