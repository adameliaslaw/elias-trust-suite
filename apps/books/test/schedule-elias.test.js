// Schedule Elias tests — hand-computed fixtures per spec §9.
const assert = require('assert');
const E = require('../lib/schedule-elias');
const X = require('../lib/tax1040');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// Fixture property: $220k purchase, 25% land → $165k building / 27.5 = $6,000/yr
// straight-line. Rent $30k. Expenses: mortgage interest 8,000, taxes 4,000,
// insurance 1,200, repairs 2,000, management 1,800 (sum 17,000).
// PITIA: PI 950 + taxes 333.33 + insurance 100 = 1,383.33/mo.
const fixtureProperty = (over = {}) => E.sanitizeProperty({
  id: 'prop_test', nickname: 'Maple Duplex', monthsInService: 12,
  acquisition: { purchasePrice: 220000, landAllocationPct: 25 },
  financing: { monthlyPI: 950, monthlyTaxes: 333.33, monthlyInsurance: 100, monthlyHOA: 0 },
  operations: {
    annualGrossRent: 30000,
    annualExpenses: { mortgageInterest: 8000, taxes: 4000, insurance: 1200, repairs: 2000, managementFees: 1800 },
    oneTimeExpenses: 0
  },
  depreciation: { useComputedDefault: true, annualByStrategy: { aggressive: 12000 } },
  ...over
});

const SETTINGS = { depreciationStrategy: 'balanced', grossRentFactorPct: 75 };

check('computed default depreciation: 220k, 25% land → 6,000/yr', () => {
  assert.strictEqual(E.computedDefaultDepreciation(fixtureProperty()), 6000);
});

check('worksheet method, positive net (spec §5.1)', () => {
  // scheduleENet = 30,000 − 17,000 − 6,000 = 7,000
  // adjusted = 7,000 + 6,000 + 8,000 + 4,000 + 1,200 = 26,200 → 2,183.33/mo
  // netRental = 2,183.33 − 1,383.33 = 800.00
  const a = E.propertyAnalysis(fixtureProperty(), 'balanced', 75);
  assert.strictEqual(a.scheduleENet, 7000);
  assert.strictEqual(a.adjustedIncome, 26200);
  assert.strictEqual(a.monthlyAdjusted, 2183.33);
  assert.strictEqual(a.monthlyPITIA, 1383.33);
  assert.strictEqual(a.netRental, 800.00);
});

check('75% shortcut differs from worksheet (spec §5.2)', () => {
  // 2,500 × 75% − 1,383.33 = 491.67
  const a = E.propertyAnalysis(fixtureProperty(), 'balanced', 75);
  assert.strictEqual(a.netRental75, 491.67);
  assert.notStrictEqual(a.netRental75, a.netRental);
});

check('negative net lands in liabilities, not income (spec §5.1/5.3)', () => {
  const p = fixtureProperty({ operations: {
    annualGrossRent: 15000,
    annualExpenses: { mortgageInterest: 8000, taxes: 4000, insurance: 1200, repairs: 2000, managementFees: 1800 },
    oneTimeExpenses: 0
  } });
  // scheduleENet = 15,000 − 17,000 − 6,000 = −8,000
  // adjusted = −8,000 + 19,200 = 11,200 → 933.33/mo; net = −450.00
  const a = E.propertyAnalysis(p, 'balanced', 75);
  assert.strictEqual(a.scheduleENet, -8000);
  assert.strictEqual(a.netRental, -450.00);
  const port = E.portfolioAnalysis([p], SETTINGS);
  assert.strictEqual(port.positiveNetRental, 0);
  assert.strictEqual(port.negativeNetRentalLiability, 450.00);
});

check('HEADLINE: depreciation strategy moves tax income, not lender income', () => {
  const p = fixtureProperty();
  const balanced = E.propertyAnalysis(p, 'balanced', 75);
  const aggressive = E.propertyAnalysis(p, 'aggressive', 75);   // cost-seg 12,000
  assert.strictEqual(aggressive.scheduleENet, 1000);            // tax side falls 6,000
  assert.strictEqual(aggressive.netRental, balanced.netRental); // DTI side unchanged
});

check('one-time expenses cut tax income but are added back for lending', () => {
  const p = fixtureProperty();
  p.operations.oneTimeExpenses = 1500;
  const a = E.propertyAnalysis(p, 'balanced', 75);
  assert.strictEqual(a.scheduleENet, 5500);
  assert.strictEqual(a.netRental, 800.00);   // unchanged
});

// ---- SEB from books (spec §6) ----

check('SEB cash flow with the meals SUBTRACTION locked in', () => {
  // 100,000 − 50%×4,000 meals + 5,000 depreciation + 1,000 mi × $0.30 = 103,300
  const seb = E.sebAnalysis({ netProfit: 100000, mealsExpense: 4000 },
    E.sanitizeSeb({ depreciation: 5000, businessMiles: 1000 }));
  assert.strictEqual(seb.mealsNonDeductible, 2000);
  assert.strictEqual(seb.adjustedAnnual, 103300);
  assert.strictEqual(seb.monthlyIncome, 8608.33);
  assert.strictEqual(seb.trend, 'single_year');
});

check('rising two-year trend averages; declining uses current + warns', () => {
  const rising = E.sebAnalysis({ netProfit: 100000, mealsExpense: 4000 },
    E.sanitizeSeb({ depreciation: 5000, businessMiles: 1000, priorYearNet: 90000 }));
  assert.strictEqual(rising.trend, 'averaged');
  assert.strictEqual(rising.usableAnnual, 96650);        // (103,300 + 90,000) / 2
  assert.strictEqual(rising.monthlyIncome, 8054.17);
  const declining = E.sebAnalysis({ netProfit: 100000, mealsExpense: 4000 },
    E.sanitizeSeb({ depreciation: 5000, businessMiles: 1000, priorYearNet: 150000 }));
  assert.strictEqual(declining.trend, 'declining');
  assert.strictEqual(declining.usableAnnual, 103300);    // current year only
  assert.strictEqual(declining.declinePct, 31);
  assert.strictEqual(declining.warnDeclining, true);     // > 20% threshold
});

// ---- DTI & solver (spec §7) ----

check('amortization: $400k, 20% down, 6%/30yr → PI 1,918.56', () => {
  assert.strictEqual(E.monthlyPI(400000, 20, 6, 360), 1918.56);
});

const borrower = () => ({
  monthlyW2Income: 8000, monthlyNonHousingDebts: 500, primaryResidencePITIA: 2000,
  purchaseType: 'additional', countProjectedRent: false,
  proposedPurchase: { targetPrice: 400000, downPaymentPct: 20, ratePct: 6, termMonths: 360, monthlyTaxes: 400, monthlyInsurance: 100, monthlyHOA: 0, projectedMonthlyRent: 0 }
});

check('back-end DTI with positive rental income', () => {
  const income = { grossMonthlyQualifying: 8800, negativeNetRentalLiability: 0 };
  const d = E.dtiAt(400000, borrower(), income);
  // PITIA = 1,918.56 + 400 + 100 = 2,418.56
  // back-end = (2,418.56 + 2,000 + 500) / 8,800 = 55.89%
  assert.strictEqual(d.proposedPITIA, 2418.56);
  assert.strictEqual(d.backEndDTI, 55.89);
  assert.strictEqual(d.frontEndDTI, 27.48);
});

check('negative rental inflates the debt side of DTI', () => {
  const income = { grossMonthlyQualifying: 8000, negativeNetRentalLiability: 450 };
  const d = E.dtiAt(400000, borrower(), income);
  // (2,418.56 + 2,000 + 500 + 450) / 8,000 = 67.11%
  assert.strictEqual(d.backEndDTI, 67.11);
});

check('max-purchase solver converges to the DTI target', () => {
  const income = { grossMonthlyQualifying: 8800, negativeNetRentalLiability: 0, monthlyW2Income: 8800, sebMonthlyTotal: 0, positiveNetRental: 0 };
  const r = E.maxPurchaseSolver(borrower(), income, 45);
  assert.ok(r.maxPrice > 0);
  assert.ok(E.dtiAt(r.maxPrice, borrower(), income).backEndDTI <= 45);
  assert.ok(E.dtiAt(r.maxPrice + 1000, borrower(), income).backEndDTI > 45);
});

check('DTI bands match design thresholds', () => {
  assert.strictEqual(E.dtiBand(35), 'Excellent');
  assert.strictEqual(E.dtiBand(43), 'Acceptable');
  assert.strictEqual(E.dtiBand(49.9), 'Stretched');
  assert.strictEqual(E.dtiBand(55.89), 'Over limit');
});

// ---- 1040 integration (spec §8) ----

const biz = net => [{ name: 'Biz', netProfit: net, sstb: false, w2Wages: 0 }];

check('REGRESSION GUARD: rental income never touches SE tax', () => {
  const without = X.estimate1040({ filingStatus: 'single', businesses: biz(100000) });
  const withRental = X.estimate1040({
    filingStatus: 'single', businesses: biz(100000),
    scheduleE: { net: 7000, sec469Handling: 'allow', qbiSafeHarbor: false }
  });
  assert.strictEqual(withRental.seTax, without.seTax);
  assert.strictEqual(withRental.additionalMedicare, without.additionalMedicare);
  assert.strictEqual(withRental.totalIncome, without.totalIncome + 7000);
  assert.strictEqual(withRental.scheduleELine5, 7000);
});

check('§469 suspend floors a portfolio loss at zero with the amount surfaced', () => {
  const r = X.estimate1040({
    filingStatus: 'single', businesses: biz(100000),
    scheduleE: { net: -5000, sec469Handling: 'suspend', qbiSafeHarbor: false }
  });
  assert.strictEqual(r.scheduleELine5, 0);
  assert.strictEqual(r.suspendedRentalLoss, 5000);
  const allowed = X.estimate1040({
    filingStatus: 'single', businesses: biz(100000),
    scheduleE: { net: -5000, sec469Handling: 'allow', qbiSafeHarbor: false }
  });
  assert.strictEqual(allowed.scheduleELine5, -5000);
  assert.strictEqual(allowed.suspendedRentalLoss, 0);
  assert.strictEqual(allowed.totalIncome, r.totalIncome - 5000);
});

check('QBI safe harbor adds 20% of positive rental as non-SSTB QBI', () => {
  const base = { filingStatus: 'single', wages: 100000, businesses: biz(30000) };
  const off = X.estimate1040({ ...base, scheduleE: { net: 7000, sec469Handling: 'allow', qbiSafeHarbor: false } });
  const on = X.estimate1040({ ...base, scheduleE: { net: 7000, sec469Handling: 'allow', qbiSafeHarbor: true } });
  assert.strictEqual(off.qbiDeduction, 5576.11);   // business only
  assert.strictEqual(on.qbiDeduction, 6976.11);    // + 20% × 7,000
});

check('NIIT: 3.8% on rental NII above the MAGI threshold', () => {
  const r = X.estimate1040({
    filingStatus: 'single', businesses: biz(300000),
    scheduleE: { net: 20000, sec469Handling: 'allow', qbiSafeHarbor: false }
  });
  assert.ok(r.agi > 200000 + 20000);              // fully over the threshold
  assert.strictEqual(r.niit, 760.00);              // 3.8% × 20,000
  const under = X.estimate1040({
    filingStatus: 'single', businesses: biz(100000),
    scheduleE: { net: 7000, sec469Handling: 'allow', qbiSafeHarbor: false }
  });
  assert.strictEqual(under.niit, 0);               // AGI below 200k
});

console.log(`\nAll ${passed} Schedule Elias checks passed.`);
