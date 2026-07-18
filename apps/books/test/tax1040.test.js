// 1040 estimator tests.
//
// The first block re-derives the 2026 taxable-income brackets and standard
// deductions from the Pub 15-T withholding schedules in tables2026.js:
// bracket floor = standard-schedule floor − first nonzero floor, and
// standard deduction = W-4 adjustment + first nonzero floor. If the 1040
// tables ever disagree with the (sourced) withholding tables, this fails.
const assert = require('assert');
const T = require('../lib/payroll/tables2026');
const X = require('../lib/tax1040');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

for (const status of ['single', 'married_jointly', 'head_of_household']) {
  check(`${status}: brackets and deduction derive from Pub 15-T`, () => {
    const std = T.FED_STANDARD[status];
    const firstFloor = std[1][0];
    assert.strictEqual(X.STANDARD_DEDUCTION[status], T.FED_W4_ADJUSTMENT[status] + firstFloor);
    const derived = std.slice(1).map(([floor, , rate]) => [floor - firstFloor, rate]);
    assert.deepStrictEqual(X.BRACKETS[status], derived);
  });
}

check('bracket tax: MFJ hand-computed slice math', () => {
  // 217,660.77 taxable MFJ:
  // 10%*24,800 + 12%*76,000 + 22%*110,600 + 24%*6,260.77 = 37,434.5848
  assert.strictEqual(Math.round(X.bracketTax(X.BRACKETS.married_jointly, 217660.77) * 100) / 100, 37434.58);
});

check('single filer, one 100k business, hand-computed end to end', () => {
  const r = X.estimate1040({
    filingStatus: 'single',
    businesses: [{ name: 'Biz', netProfit: 100000, sstb: false, w2Wages: 0 }]
  });
  assert.strictEqual(r.seTax, 14129.55);          // 92,350 × (12.4% + 2.9%)
  assert.strictEqual(r.halfSeDeduction, 7064.78);
  assert.strictEqual(r.additionalMedicare, 0);
  assert.strictEqual(r.agi, 92935.22);
  assert.strictEqual(r.deduction, 16100);          // standard, single
  assert.strictEqual(r.qbiDeduction, 15367.04);    // capped at 20% of TI
  assert.strictEqual(r.taxableIncome, 61468.18);
  assert.strictEqual(r.incomeTax, 8235.00);
  assert.strictEqual(r.totalTax, 22364.55);
  assert.strictEqual(r.marginalRate, 0.22);
});

check('MFJ household, both businesses, SE cap + additional Medicare', () => {
  const r = X.estimate1040({
    filingStatus: 'married_jointly',
    businesses: [
      { name: 'Eliaspresso', netProfit: 120000, sstb: false, w2Wages: 60000 },
      { name: 'Elias Counsel', netProfit: 200000, sstb: true, w2Wages: 0 }
    ]
  });
  // netSE = 320,000 × .9235 = 295,520 → SS capped at 184,500 base
  assert.strictEqual(r.seTax, 31448.08);           // 22,878.00 + 8,570.08
  assert.strictEqual(r.additionalMedicare, 409.68); // (295,520 − 250,000) × .9%
  assert.strictEqual(r.agi, 304275.96);
  assert.strictEqual(r.qbiDeduction, 54415.19);    // under MFJ threshold → 20% of TI cap
  assert.strictEqual(r.taxableIncome, 217660.77);
  assert.strictEqual(r.incomeTax, 37434.58);
  assert.strictEqual(r.totalTax, 69292.34);
});

check('SSTB QBI phases out fully above the threshold', () => {
  const r = X.estimate1040({
    filingStatus: 'single',
    businesses: [{ name: 'Law', netProfit: 400000, sstb: true, w2Wages: 0 }]
  });
  assert.strictEqual(r.qbiDeduction, 0);
  const nonSstb = X.estimate1040({
    filingStatus: 'single',
    businesses: [{ name: 'Shop', netProfit: 400000, sstb: false, w2Wages: 150000 }]
  });
  // Non-SSTB above threshold: limited to 50% of W-2 wages, not zero.
  assert.ok(nonSstb.qbiDeduction > 0 && nonSstb.qbiDeduction <= 75000);
});

check('W-2 wages consume the Social Security base before SE income', () => {
  const withWages = X.estimate1040({
    filingStatus: 'married_jointly',
    wages: 184500,
    businesses: [{ name: 'Biz', netProfit: 100000, sstb: false, w2Wages: 0 }]
  });
  // Base fully used by wages → SE tax is Medicare-only: 92,350 × 2.9%
  assert.strictEqual(withWages.seTax, 2678.15);
});

check('itemized beats standard; credits and payments net to balance due', () => {
  const r = X.estimate1040({
    filingStatus: 'married_jointly',
    businesses: [{ name: 'Biz', netProfit: 150000, sstb: false, w2Wages: 0 }],
    itemizedDeductions: 40000,
    credits: 2000,
    fedWithholding: 5000,
    estimatedPayments: 10000
  });
  assert.strictEqual(r.deduction, 40000);
  assert.strictEqual(r.deductionType, 'itemized');
  assert.strictEqual(r.payments, 15000);
  assert.strictEqual(r.balanceDue, Math.round((r.totalTax - 15000) * 100) / 100);
});

check('losses: negative Schedule C produces no SE tax or QBI', () => {
  const r = X.estimate1040({
    filingStatus: 'single',
    wages: 80000,
    businesses: [{ name: 'Biz', netProfit: -20000, sstb: false, w2Wages: 0 }]
  });
  assert.strictEqual(r.seTax, 0);
  assert.strictEqual(r.qbiDeduction, 0);
  assert.strictEqual(r.totalIncome, 60000);
});

// ---- prior tax years (catch-up filings) ----

check('2025 single, one 100k business, hand-computed', () => {
  const r = X.estimate1040({
    year: 2025, filingStatus: 'single',
    businesses: [{ name: 'Biz', netProfit: 100000, sstb: false, w2Wages: 0 }]
  });
  assert.strictEqual(r.year, 2025);
  assert.strictEqual(r.seTax, 14129.55);           // under the 176,100 base
  assert.strictEqual(r.agi, 92935.22);
  assert.strictEqual(r.deduction, 15750);          // OBBBA-amended 2025 standard
  assert.strictEqual(r.qbiDeduction, 15437.04);    // 20% of TI cap
  assert.strictEqual(r.taxableIncome, 61748.18);
  assert.strictEqual(r.incomeTax, 8498.60);        // 2025 single brackets
  assert.strictEqual(r.totalTax, 22628.15);
});

check('2024 MFJ, 200k business: SS capped at the 168,600 base', () => {
  const r = X.estimate1040({
    year: 2024, filingStatus: 'married_jointly',
    businesses: [{ name: 'Biz', netProfit: 200000, sstb: false, w2Wages: 0 }]
  });
  assert.strictEqual(r.seTax, 26262.70);           // 20,906.40 SS + 5,356.30 Medicare
  assert.strictEqual(r.agi, 186868.65);
  assert.strictEqual(r.deduction, 29200);
  assert.strictEqual(r.qbiDeduction, 31533.73);
  assert.strictEqual(r.taxableIncome, 126134.92);
  assert.strictEqual(r.incomeTax, 17855.68);
  assert.strictEqual(r.totalTax, 44118.38);
});

check('same income taxes differently across years (base + brackets move)', () => {
  const inp = y => ({ year: y, filingStatus: 'single', businesses: [{ name: 'B', netProfit: 250000, sstb: false, w2Wages: 0 }] });
  const t24 = X.estimate1040(inp(2024)), t26 = X.estimate1040(inp(2026));
  assert.ok(t24.seTax < t26.seTax);                // lower SS wage base in 2024
  assert.ok(t24.deduction < t26.deduction);
  assert.strictEqual(X.estimate1040({ ...inp(2023) }).year, 2026);   // unknown year falls back to default
});

// ---- quarterly 1040-ES safe harbor ----

check('ES plan: 110% prior-year harbor wins when smaller', () => {
  const plan = X.quarterlyEsPlan({ year: 2026, totalTax: 40000, payments: 10000 }, 30000, '2026-07-15');
  assert.strictEqual(plan.required, 33000);        // min(36,000, 33,000)
  assert.strictEqual(plan.basis, '110% of prior-year tax');
  assert.strictEqual(plan.remaining, 23000);
  const upcoming = plan.quarters.filter(q => !q.past);
  assert.strictEqual(upcoming.length, 2);          // Sep 15 + Jan 15 left
  assert.strictEqual(upcoming[0].suggested, 11500);
});

check('ES plan: 90% of current estimate without a prior year', () => {
  const plan = X.quarterlyEsPlan({ year: 2026, totalTax: 40000, payments: 0 }, 0, '2026-01-02');
  assert.strictEqual(plan.required, 36000);
  assert.strictEqual(plan.basis, '90% of current-year estimate');
  assert.strictEqual(plan.quarters.filter(q => !q.past).length, 4);
});

check('ES plan: past years are closed', () => {
  const plan = X.quarterlyEsPlan({ year: 2024, totalTax: 40000, payments: 0 }, 0, '2026-07-15');
  assert.strictEqual(plan.yearClosed, true);
  assert.ok(plan.quarters.every(q => q.past));
});

console.log(`\nAll ${passed} 1040 estimator checks passed.`);
