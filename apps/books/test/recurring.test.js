// Recurring invoice engine tests.
const assert = require('assert');
const R = require('../lib/recurring');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

check('monthly anchor day survives short months (31st → Feb 28 → Mar 31)', () => {
  assert.strictEqual(R.nextOccurrence('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.strictEqual(R.nextOccurrence('2026-02-28', 'monthly', 31), '2026-03-31');
});

check('quarterly and weekly stepping', () => {
  assert.strictEqual(R.nextOccurrence('2026-03-31', 'quarterly', 31), '2026-06-30');
  assert.strictEqual(R.nextOccurrence('2026-11-15', 'quarterly', 15), '2027-02-15');
  assert.strictEqual(R.nextOccurrence('2026-07-10', 'weekly'), '2026-07-17');
});

function fakeCreate(db, data) {
  if (!data.customerId) throw new Error('A valid customer is required');
  const inv = { id: 'inv' + (db.invoices.length + 1), ...data };
  db.invoices.push(inv);
  return inv;
}

check('generateDue catches up every missed period on its original date', () => {
  const tpl = R.sanitizeTemplate({
    customerId: 'c1', items: [{ description: 'Retainer', qty: 1, rate: 1500 }],
    frequency: 'monthly', nextDate: '2026-05-10', termsDays: 30
  });
  const db = { recurringInvoices: [tpl], invoices: [] };
  const created = R.generateDue(db, fakeCreate, '2026-07-15');
  assert.strictEqual(created.length, 3);
  assert.deepStrictEqual(created.map(i => i.date), ['2026-05-10', '2026-06-10', '2026-07-10']);
  assert.strictEqual(created[0].dueDate, '2026-06-09');       // +30 days terms
  assert.ok(created.every(i => i.recurringId === tpl.id));
  assert.strictEqual(tpl.nextDate, '2026-08-10');
  assert.strictEqual(tpl.lastGenerated, '2026-07-10');
  // idempotent: nothing more due today
  assert.strictEqual(R.generateDue(db, fakeCreate, '2026-07-15').length, 0);
});

check('paused templates are skipped; broken templates pause themselves', () => {
  const paused = R.sanitizeTemplate({ customerId: 'c1', items: [{ qty: 1, rate: 5 }], nextDate: '2026-01-01', active: false });
  const broken = R.sanitizeTemplate({ customerId: '', items: [{ qty: 1, rate: 5 }], nextDate: '2026-01-01' });
  const db = { recurringInvoices: [paused, broken], invoices: [] };
  const created = R.generateDue(db, fakeCreate, '2026-07-15');
  assert.strictEqual(created.length, 0);
  assert.strictEqual(broken.active, false);   // paused instead of retrying forever
  assert.strictEqual(paused.nextDate, '2026-01-01');
});

console.log(`\nAll ${passed} recurring invoice checks passed.`);
