// NJ sales tax tests: trust-fund accounting and the ST-50/ST-51 calendar.
const assert = require('assert');
const { decorateInvoice } = require('../lib/store');
const S = require('../lib/salestax');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// Fixture: $1,000 taxable (prepared food/drink) + $200 non-taxable line at
// the 6.625% statewide rate → tax 66.25, total 1,266.25.
const invoice = (payments = []) => ({
  items: [
    { description: 'Card sales', qty: 1, rate: 1000, taxable: true },
    { description: 'Whole-bean retail (exempt example)', qty: 1, rate: 200, taxable: false }
  ],
  taxRate: 6.625,
  payments
});

check('invoice tax computed on taxable lines only', () => {
  const d = decorateInvoice(invoice());
  assert.strictEqual(d.subtotal, 1200);
  assert.strictEqual(d.tax, 66.25);
  assert.strictEqual(d.total, 1266.25);
});

check('untaxed invoices are unchanged (no snapshot rate)', () => {
  const d = decorateInvoice({ items: [{ qty: 10, rate: 150 }], payments: [] });
  assert.strictEqual(d.tax, 0);
  assert.strictEqual(d.total, 1500);
});

check('full payment splits income/tax exactly', () => {
  const d = decorateInvoice(invoice());
  const parts = S.paymentIncomeParts(d, { amount: 1266.25 });
  assert.strictEqual(parts.income, 1200);
  assert.strictEqual(parts.tax, 66.25);
});

check('partial payment splits proportionally (cash basis)', () => {
  const d = decorateInvoice(invoice());
  const parts = S.paymentIncomeParts(d, { amount: 506.50 });   // 40% of total
  assert.strictEqual(parts.tax, 26.50);
  assert.strictEqual(parts.income, 480);
});

check('editing a paid invoice does NOT restate a prior payment (snapshot at payment time)', () => {
  // Money comes in against the taxable invoice: snapshot the split as it stands.
  const inv = invoice();
  const atPayment = decorateInvoice(inv);
  const payment = {
    amount: 1266.25, date: '2026-04-05',
    taxSnapshot: S.taxSplitSnapshot(atPayment)   // { tax: 66.25, total: 1266.25 }
  };
  const before = S.paymentIncomeParts(atPayment, payment);
  assert.strictEqual(before.income, 1200);
  assert.strictEqual(before.tax, 66.25);

  // Later, someone retroactively edits the invoice — drops the tax entirely.
  inv.taxRate = 0;
  inv.items[0].taxable = false;
  const afterEdit = decorateInvoice(inv);
  assert.strictEqual(afterEdit.tax, 0);   // the invoice now shows no tax

  // The already-received payment keeps its frozen split — the $66.25 of
  // trust-fund sales tax is NOT retroactively reclassified as income.
  const after = S.paymentIncomeParts(afterEdit, payment);
  assert.strictEqual(after.tax, 66.25);
  assert.strictEqual(after.income, 1200);

  // Without a snapshot (legacy payment), the same edit WOULD restate it —
  // this is the exact behavior the snapshot prevents.
  const legacy = S.paymentIncomeParts(afterEdit, { amount: 1266.25 });
  assert.strictEqual(legacy.tax, 0);
  assert.strictEqual(legacy.income, 1266.25);
});

const fixtureDb = (payments, remittances = []) => ({
  invoices: [invoice(payments)],
  salesTaxRemittances: remittances
});

check('quarterly payer: ST-50 due the 20th after quarter end', () => {
  const db = fixtureDb([{ amount: 1266.25, date: '2026-04-05' }]);
  const entries = S.schedule(db, 2026, { monthlyRemitter: false }, '2026-07-15');
  const q2 = entries.find(e => e.key === '2026-Q2');
  assert.strictEqual(q2.type, 'ST-50');
  assert.strictEqual(q2.collected, 66.25);
  assert.strictEqual(q2.due, '2026-07-20');
  assert.strictEqual(q2.outstanding, 66.25);
  assert.ok(!entries.some(e => e.type === 'ST-51'));   // not a monthly remitter
});

check('ST-51 under $500 rides with the ST-50', () => {
  const db = fixtureDb([{ amount: 1266.25, date: '2026-04-05' }]);
  const entries = S.schedule(db, 2026, { monthlyRemitter: true }, '2026-07-15');
  const april = entries.find(e => e.key === '2026-04');
  assert.strictEqual(april.type, 'ST-51');
  assert.strictEqual(april.collected, 66.25);
  assert.strictEqual(april.required, false);      // ≤ $500 in the month
  assert.strictEqual(april.outstanding, 0);
});

check('ST-51 required over $500 and counts toward the quarter', () => {
  // ~$9.6k of taxable sales in April → 636 of tax collected
  const db = fixtureDb([{ amount: 12153.65, date: '2026-04-05' }]);
  db.invoices[0].items[0].rate = 9600;   // tax = 636.00; total = 9600+200+636 = 10,436... keep payment = total
  const d = decorateInvoice(db.invoices[0]);
  db.invoices[0].payments = [{ amount: d.total, date: '2026-04-05' }];
  const entries = S.schedule(db, 2026, { monthlyRemitter: true }, '2026-07-15');
  const april = entries.find(e => e.key === '2026-04');
  assert.strictEqual(april.collected, 636);
  assert.strictEqual(april.required, true);
  assert.strictEqual(april.outstanding, 636);
  // remit the ST-51; the quarter's ST-50 balance reflects it
  db.salesTaxRemittances.push({ periodKey: '2026-04', amount: 636, date: '2026-05-18' });
  const after = S.schedule(db, 2026, { monthlyRemitter: true }, '2026-07-15');
  assert.strictEqual(after.find(e => e.key === '2026-04').outstanding, 0);
  assert.strictEqual(after.find(e => e.key === '2026-Q2').outstanding, 0);
});

check('Q4 ST-50 due January 20 of the next year', () => {
  const db = fixtureDb([{ amount: 1266.25, date: '2026-11-10' }]);
  const q4 = S.schedule(db, 2026, { monthlyRemitter: false }, '2027-01-05')
    .find(e => e.key === '2026-Q4');
  assert.strictEqual(q4.due, '2027-01-20');
});

check('year summary: collected − remitted = held in trust', () => {
  const db = fixtureDb([{ amount: 1266.25, date: '2026-04-05' }],
    [{ periodKey: '2026-Q2', amount: 40, date: '2026-07-10' }]);
  const sum = S.summary(db, 2026, { monthlyRemitter: false, ratePct: 6.625, enabled: true }, '2026-07-15');
  assert.strictEqual(sum.collected, 66.25);
  assert.strictEqual(sum.remitted, 40);
  assert.strictEqual(sum.balance, 26.25);
});

console.log(`\nAll ${passed} sales tax checks passed.`);
