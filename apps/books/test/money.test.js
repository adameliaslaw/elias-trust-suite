// Exact-money regression tests (@elias/money wiring).
//
// Every test here FAILED against the legacy float64 implementation
// (Math.round(n * 100) / 100 and float products/sums). They pin the
// boundary behavior: per-entry/per-line half-up rounding, exact-cent
// accumulation, and exact proportional sales-tax splits.
const assert = require('assert');

const money = require('../lib/money');
const { invoiceSubtotal, invoiceTax, invoiceTotal, decorateInvoice, round2 } = require('../lib/store');
const { paymentIncomeParts } = require('../lib/salestax');
const { decorateEntry, wipByCustomer } = require('../lib/timetracking');
const engine = require('../lib/payroll/engine');
const nacha = require('../lib/payroll/nacha');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

test('half-cent boundary: 1.5h x $13.35 = $20.03 (was $20.02 undercharge)', () => {
  assert.strictEqual(money.mul(13.35, 1.5), 20.03);
  // the same boundary through the time-entry decorator
  assert.strictEqual(decorateEntry({ hours: 1.5, rate: 13.35, billable: true }).amount, 20.03);
  // ...and through an invoice line
  assert.strictEqual(invoiceSubtotal({ items: [{ qty: 1.5, rate: 13.35 }] }), 20.03);
});

test('round2 is exact half-up on clean decimals: 1.005 -> 1.01 (was 1.00)', () => {
  assert.strictEqual(round2(1.005), 1.01);
  assert.strictEqual(round2(2.675), 2.68);
  assert.strictEqual(round2(0.125), 0.13);
  // away from zero on negatives (Decimal ROUND_HALF_UP)
  assert.strictEqual(round2(-1.005), -1.01);
});

test('per-line rounding: lines round half-up before the subtotal sums', () => {
  const inv = { items: [{ qty: 1, rate: 0.105 }, { qty: 1, rate: 0.105 }] };
  // legacy aggregate-then-round gave 0.21; per-line half-up gives 0.11 + 0.11
  assert.strictEqual(invoiceSubtotal(inv), 0.22);
});

test('sums accumulate in integer cents: no 0.1 + 0.2 drift, ever', () => {
  assert.strictEqual(money.sum(0.1, 0.2), 0.3);
  let t = 0;
  for (let i = 0; i < 100; i++) t = money.add(t, 0.1);
  assert.strictEqual(t, 10);
  // stored float noise self-heals to the intended cents
  assert.strictEqual(money.sum(20.029999999999998, 0.01), 20.04);
  assert.strictEqual(money.sub(20.03, 0.01), 20.02);
});

test('invoice totals: subtotal + tax + paid balance are cent-exact', () => {
  const inv = {
    items: [{ qty: 1.5, rate: 13.35, taxable: true }],
    taxRate: 6.625,
    payments: [{ amount: 10.71 }, { amount: 10.65 }]
  };
  const d = decorateInvoice(inv);
  assert.strictEqual(d.subtotal, 20.03);
  assert.strictEqual(d.tax, 1.33);            // 20.03 x 6.625% = 1.3269875 -> 1.33
  assert.strictEqual(d.total, 21.36);
  assert.strictEqual(d.amountPaid, 21.36);
  assert.strictEqual(d.balance, 0);
  assert.strictEqual(d.status, 'paid');
});

test('sales-tax payment split is exact and parts sum to the payment', () => {
  const d = { tax: 1.33, total: 21.36 };
  const parts = paymentIncomeParts(d, { amount: 21.36 });
  assert.strictEqual(parts.tax, 1.33);
  assert.strictEqual(parts.income, 20.03);
  assert.strictEqual(money.sum(parts.income, parts.tax), 21.36);
  // partial payment splits proportionally, rounded once
  const half = paymentIncomeParts(d, { amount: 10 });
  assert.strictEqual(money.sum(half.income, half.tax), 10);
  // no-tax invoices pass through untouched
  assert.deepStrictEqual(paymentIncomeParts({ tax: 0, total: 50 }, { amount: 50 }), { income: 50, tax: 0 });
});

test('WIP aggregates per-entry amounts without float drift', () => {
  const db = {
    customers: [{ id: 'c1', name: 'Client' }],
    timeEntries: [
      { customerId: 'c1', date: '2026-07-01', hours: 1.5, rate: 13.35, billable: true, invoiceId: null },
      { customerId: 'c1', date: '2026-07-02', hours: 0.5, rate: 4.21, billable: true, invoiceId: null }
    ]
  };
  const wip = wipByCustomer(db);
  // 20.03 + 2.11 (0.5h x $4.21 = $2.105 -> half-up $2.11)
  assert.strictEqual(wip[0].amount, 22.14);
  assert.strictEqual(wip[0].hours, 2);
});

test('payroll engine: hourly gross at the same boundary bills exactly', () => {
  const e = engine.grossEarnings(
    { payType: 'hourly', hourlyRate: 13.35 },
    { hours: 1.5, otHours: 0, bonus: 0, tips: 0 },
    'biweekly'
  );
  assert.strictEqual(e.regular, 20.03);
  // OT: 13.35 x 1.5 x 1h = 20.025 -> 20.03, single rounding
  const ot = engine.grossEarnings(
    { payType: 'hourly', hourlyRate: 13.35 },
    { hours: 0, otHours: 1, bonus: 0, tips: 0 },
    'biweekly'
  );
  assert.strictEqual(ot.overtime, 20.03);
});

test('engine.cents keeps the Decimal ROUND_HALF_UP contract', () => {
  assert.strictEqual(engine.cents(20.025), 20.03);
  assert.strictEqual(engine.cents(0.145), 0.15);
  assert.strictEqual(engine.cents(-2.675), -2.68);
  assert.strictEqual(engine.cents(1.005), 1.01);
});

test('percent deductions round once, half-up', () => {
  // 5% of 20.03 = 1.0015 -> 1.00
  const { resolved } = engine.deductionAmounts(
    [{ name: 'Gym', kind: 'aftertax', amountType: 'percent', amount: 5 }], 20.03);
  assert.strictEqual(resolved[0].amount, 1);
  assert.strictEqual(money.percentOf(20.03, 6.625), 1.33);
});

test('NACHA amounts are exact integer cents', () => {
  assert.strictEqual(money.centsInt(20.03), 2003);
  assert.strictEqual(money.centsInt(0.1 + 0.2), 30);
  // TXP subcategory validation accepts exact-cent splits
  const txp = nacha.eftpsTxp('123456789', nacha.FED_941_DEPOSIT, '2026-06-30', 21.36, [
    [nacha.SUB_SOCIAL_SECURITY, 10.68],
    [nacha.SUB_MEDICARE, 5.34],
    [nacha.SUB_WITHHOLDING, 5.34]
  ]);
  assert.ok(txp.includes('*1*1068*2*534*3*534\\'), 'subcategories rendered as integer cents');
});

console.log(`All ${passed} exact-money checks passed.`);
