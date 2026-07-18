// NJ-1040 estimator tests — hand-computed from the statutory rate schedules
// (N.J.S.A. 54A:2-1) and NJ-1040 instructions.
const assert = require('assert');
const NJ = require('../lib/nj1040');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

check('MFJ schedule, hand-computed slices at 150k taxable', () => {
  // 1.4%×20k + 1.75%×30k + 2.45%×20k + 3.5%×10k + 5.525%×70k
  // = 280 + 525 + 490 + 350 + 3,867.50 = 5,512.50
  assert.strictEqual(Math.round(NJ.bracketTax(NJ.NJ_BRACKETS.married_jointly, 150000) * 100) / 100, 5512.50);
});

check('single schedule, hand-computed slices at 100k taxable', () => {
  // 280 + 1.75%×15k(262.50) + 3.5%×5k(175) + 5.525%×35k(1,933.75) + 6.37%×25k(1,592.50)
  assert.strictEqual(Math.round(NJ.bracketTax(NJ.NJ_BRACKETS.single, 100000) * 100) / 100, 4243.75);
});

check('full MFJ estimate: exemptions and property tax deduction', () => {
  const r = NJ.estimateNJ1040({
    filingStatus: 'married_jointly',
    wages: 95000, businessNet: 60000, rentalNet: 0, otherIncome: 0,
    njDependents: 2, propertyTaxPaid: 12000,
    njWithholding: 3000, njEstimatedPayments: 1000
  });
  assert.strictEqual(r.grossIncome, 155000);
  assert.strictEqual(r.exemptions, 5000);              // 2×1,000 + 2×1,500
  assert.strictEqual(r.propertyTaxDeduction, 12000);
  assert.strictEqual(r.taxableIncome, 138000);
  // MFJ at 138,000: 280+525+490+350 + 5.525%×58,000(3,204.50) = 4,849.50
  assert.strictEqual(r.tax, 4849.50);
  assert.strictEqual(r.balanceDue, 849.50);            // less 4,000 payments
});

check('category floors: a business loss never offsets wages', () => {
  const r = NJ.estimateNJ1040({ filingStatus: 'single', wages: 100000, businessNet: -40000, rentalNet: -5000 });
  assert.strictEqual(r.businessNet, 0);
  assert.strictEqual(r.rentalNet, 0);
  assert.strictEqual(r.grossIncome, 100000);
});

check('property tax deduction capped at 15,000; $50 credit when better', () => {
  const capped = NJ.estimateNJ1040({ filingStatus: 'married_jointly', wages: 200000, propertyTaxPaid: 22000 });
  assert.strictEqual(capped.propertyTaxDeduction, 15000);
  // Tiny income: deduction saves < $50 → the credit wins.
  const credit = NJ.estimateNJ1040({ filingStatus: 'single', wages: 21000, propertyTaxPaid: 2000 });
  assert.strictEqual(credit.propertyTaxCredit, 50);
  assert.strictEqual(credit.propertyTaxDeduction, 0);
});

check('below the filing threshold: no NJ tax', () => {
  const r = NJ.estimateNJ1040({ filingStatus: 'married_jointly', wages: 18000 });
  assert.strictEqual(r.belowFilingThreshold, true);
  assert.strictEqual(r.tax, 0);
});

check('top rates reach 10.75% past $1M', () => {
  const r = NJ.estimateNJ1040({ filingStatus: 'single', wages: 1200000 });
  // taxable 1,199,000 (one exemption): tax at 1,000,000 =
  // 280+262.5+175+1,933.75+27,072.50(6.37%×425k)+44,850(8.97%×500k) = 74,573.75
  // + 10.75%×199,000 = 21,392.50 → 95,966.25
  assert.strictEqual(r.tax, 95966.25);
});

const ES_DATES = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];

check('NJ-ES: 80% of current year when prior year is higher', () => {
  const plan = NJ.quarterlyEsPlan({ tax: 10000, payments: 2000 }, 9000, ES_DATES, '2026-07-01');
  assert.strictEqual(plan.required, 8000);           // 80% × 10,000 < 9,000 prior
  assert.strictEqual(plan.basis, '80% of current-year NJ estimate');
  assert.strictEqual(plan.remaining, 6000);
  assert.strictEqual(plan.quarters.filter(q => !q.past).length, 2);
  assert.strictEqual(plan.quarters[2].suggested, 3000);   // 6,000 across Q3+Q4
  assert.strictEqual(plan.belowThreshold, false);
});

check('NJ-ES: 100% of prior year when lower (no 110% tier)', () => {
  const plan = NJ.quarterlyEsPlan({ tax: 10000, payments: 0 }, 5000, ES_DATES, '2026-01-01');
  assert.strictEqual(plan.required, 5000);
  assert.strictEqual(plan.basis, '100% of prior-year NJ tax');
});

check('NJ-ES: nothing required within the $400 threshold', () => {
  const plan = NJ.quarterlyEsPlan({ tax: 390, payments: 0 }, 0, ES_DATES, '2026-01-01');
  assert.strictEqual(plan.belowThreshold, true);
  assert.strictEqual(plan.remaining, 0);
});

console.log(`\nAll ${passed} NJ-1040 checks passed.`);
