// Billable time tracking unit tests.
const assert = require('assert');
const T = require('../lib/timetracking');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const db = () => ({
  customers: [{ id: 'c1', name: 'Acme', company: 'Acme LLC' }, { id: 'c2', name: 'Beta' }],
  timeEntries: []
});

check('sanitize validates customer, date, hours, description', () => {
  const d = db();
  assert.ok(T.sanitizeEntry({ customerId: 'nope', date: '2026-07-01', hours: 1, rate: 350, description: 'x' }, d).error);
  assert.ok(T.sanitizeEntry({ customerId: 'c1', date: 'July 1', hours: 1, rate: 350, description: 'x' }, d).error);
  assert.ok(T.sanitizeEntry({ customerId: 'c1', date: '2026-07-01', hours: 0, rate: 350, description: 'x' }, d).error);
  assert.ok(T.sanitizeEntry({ customerId: 'c1', date: '2026-07-01', hours: 25, rate: 350, description: 'x' }, d).error);
  assert.ok(T.sanitizeEntry({ customerId: 'c1', date: '2026-07-01', hours: 1, rate: 350, description: '  ' }, d).error);
  const { entry } = T.sanitizeEntry({ customerId: 'c1', date: '2026-07-01', hours: 2.5, rate: 350, description: 'Draft brief' }, d);
  assert.strictEqual(entry.billable, true);
  assert.strictEqual(entry.invoiceId, null);
});

check('decorate computes amount and derives status', () => {
  const t = { hours: 1.2, rate: 350, billable: true, invoiceId: null };
  assert.strictEqual(T.decorateEntry(t).amount, 420);
  assert.strictEqual(T.decorateEntry(t).status, 'unbilled');
  assert.strictEqual(T.decorateEntry({ ...t, invoiceId: 'i1' }).status, 'billed');
  assert.strictEqual(T.decorateEntry({ ...t, billable: false }).status, 'non-billable');
});

check('WIP groups unbilled billable time by customer', () => {
  const d = db();
  d.timeEntries = [
    { customerId: 'c1', date: '2026-07-02', hours: 2.5, rate: 350, billable: true, invoiceId: null },
    { customerId: 'c1', date: '2026-07-01', hours: 1.2, rate: 350, billable: true, invoiceId: null },
    { customerId: 'c1', date: '2026-07-03', hours: 4, rate: 350, billable: true, invoiceId: 'already' },
    { customerId: 'c1', date: '2026-07-03', hours: 1, rate: 350, billable: false, invoiceId: null },
    { customerId: 'c2', date: '2026-07-04', hours: 0.5, rate: 200, billable: true, invoiceId: null }
  ];
  const wip = T.wipByCustomer(d);
  assert.strictEqual(wip.length, 2);
  assert.strictEqual(wip[0].customerName, 'Acme LLC');   // largest amount first
  assert.strictEqual(wip[0].hours, 3.7);
  assert.strictEqual(wip[0].amount, 1295);
  assert.strictEqual(wip[0].entries, 2);
  assert.strictEqual(wip[0].oldest, '2026-07-01');
});

check('invoice items: one chronological non-taxable line per entry', () => {
  const items = T.invoiceItems([
    { date: '2026-07-02', matter: 'Smith v. Jones', description: 'Hearing prep', hours: 2.5, rate: 350 },
    { date: '2026-07-01', matter: '', description: 'Intake call', hours: 0.5, rate: 350 }
  ]);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].description, '2026-07-01 — Intake call');
  assert.strictEqual(items[1].description, '2026-07-02 — Smith v. Jones — Hearing prep');
  assert.strictEqual(items[1].qty, 2.5);
  assert.strictEqual(items[1].rate, 350);
  assert.ok(items.every(i => i.taxable === false));
});

check('billableEntries narrows to unbilled, billable, optional ids', () => {
  const d = db();
  d.timeEntries = [
    { id: 't1', customerId: 'c1', billable: true, invoiceId: null },
    { id: 't2', customerId: 'c1', billable: true, invoiceId: null },
    { id: 't3', customerId: 'c1', billable: false, invoiceId: null },
    { id: 't4', customerId: 'c1', billable: true, invoiceId: 'inv' },
    { id: 't5', customerId: 'c2', billable: true, invoiceId: null }
  ];
  assert.deepStrictEqual(T.billableEntries(d, 'c1').map(t => t.id), ['t1', 't2']);
  assert.deepStrictEqual(T.billableEntries(d, 'c1', ['t2', 't3', 't4']).map(t => t.id), ['t2']);
});

console.log(`\nAll ${passed} time tracking checks passed.`);
