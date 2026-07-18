// Schedule Elias Phase 2 tests: MACRS mid-month, cost-seg/bonus, Form
// 8582-lite §469, and the sell-vs-hold recapture preview. Hand-computed.
const assert = require('assert');
const P2 = require('../lib/elias-phase2');
const E = require('../lib/schedule-elias');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// $220k purchase, 25% land → $165k building; placed in service 2026-07-15.
const prop = (over = {}) => E.sanitizeProperty({
  id: 'p1', nickname: 'Maple', monthsInService: 12,
  acquisition: { purchasePrice: 220000, landAllocationPct: 25, placedInServiceDate: '2026-07-15' },
  financing: { monthlyPI: 950, monthlyTaxes: 333.33, monthlyInsurance: 100, loanBalance: 150000 },
  operations: { annualGrossRent: 30000, annualExpenses: { mortgageInterest: 8000, taxes: 4000, insurance: 1200, repairs: 2000, managementFees: 1800 } },
  ...over
});

check('MACRS mid-month: July placed-in-service takes 5.5/12 of year one', () => {
  // 165,000 / 27.5 = 6,000 full year → year 1 = 6,000 × 5.5/12 = 2,750
  assert.strictEqual(P2.sl275ForYear(165000, '2026-07-15', 2026), 2750);
  assert.strictEqual(P2.sl275ForYear(165000, '2026-07-15', 2027), 6000);
  assert.strictEqual(P2.sl275ForYear(165000, '2026-07-15', 2025), 0);
  assert.strictEqual(P2.accumulatedThrough(prop(), 'balanced', 2027), 8750);
});

check('January placed-in-service takes 11.5/12; strategy flows through the engine', () => {
  assert.strictEqual(P2.sl275ForYear(165000, '2026-01-15', 2026), 5750);   // 6,000 × 11.5/12
  const p = prop();
  assert.strictEqual(E.annualDepreciation(p, 'balanced', 2026), 2750);     // engine dispatches to MACRS
  assert.strictEqual(E.annualDepreciation(p, 'balanced', 2027), 6000);
});

check('cost-seg components take 100% bonus after Jan 19, 2025', () => {
  const p = prop({ phase2: { costSegComponents: { five: 20000, fifteen: 30000 } } });
  // remainder 115,000 → SL year1 = 115,000 × 5.5/330 = 1,916.67; + 50,000 bonus
  assert.strictEqual(E.annualDepreciation(p, 'aggressive', 2026), 51916.67);
  assert.strictEqual(E.annualDepreciation(p, 'aggressive', 2027), cents27(115000));
  assert.strictEqual(E.annualDepreciation(p, 'balanced', 2026), 2750);     // no cost seg
  function cents27(b) { return Math.round(b / 27.5 * 100) / 100; }
});

check('pre-2025 components use half-year straight-line, not bonus', () => {
  assert.strictEqual(P2.componentForYear(10000, 5, '2024-06-10', 2024), 1000);   // half year
  assert.strictEqual(P2.componentForYear(10000, 5, '2024-06-10', 2025), 2000);
  assert.strictEqual(P2.componentForYear(10000, 5, '2024-06-10', 2029), 1000);   // trailing half
  assert.strictEqual(P2.componentForYear(10000, 5, '2024-06-10', 2030), 0);
});

// ---- §469 Form 8582-lite ----

check('special allowance phases out: MAGI 120k → 15k allowed', () => {
  const r = P2.resolve469(-30000, { carryforward: 5000, activeParticipation: true, reProfessional: false, magiBeforeRental: 120000 });
  assert.strictEqual(r.allowance, 15000);          // 25,000 − 50% × 20,000
  assert.strictEqual(r.line5, -15000);
  assert.strictEqual(r.usedCarryforward, 0);       // current-year loss absorbs it all
  assert.strictEqual(r.suspendedEnd, 20000);       // 35,000 total − 15,000 allowed
});

check('MAGI over 150k: allowance zero, everything suspends', () => {
  const r = P2.resolve469(-30000, { carryforward: 5000, activeParticipation: true, reProfessional: false, magiBeforeRental: 160000 });
  assert.strictEqual(r.allowance, 0);
  assert.strictEqual(r.line5, 0);
  assert.strictEqual(r.suspendedEnd, 35000);
});

check('real estate professional deducts everything', () => {
  const r = P2.resolve469(-30000, { carryforward: 5000, reProfessional: true });
  assert.strictEqual(r.line5, -35000);
  assert.strictEqual(r.suspendedEnd, 0);
  assert.strictEqual(r.usedCarryforward, 5000);
});

check('allowance room draws down the carryforward', () => {
  const r = P2.resolve469(-10000, { carryforward: 2000, activeParticipation: true, reProfessional: false, magiBeforeRental: 90000 });
  assert.strictEqual(r.allowedLoss, 12000);
  assert.strictEqual(r.usedCarryforward, 2000);
  assert.strictEqual(r.suspendedEnd, 0);
});

check('rental income eats the carryforward first', () => {
  const r = P2.resolve469(10000, { carryforward: 4000 });
  assert.strictEqual(r.line5, 6000);
  assert.strictEqual(r.usedCarryforward, 4000);
  assert.strictEqual(r.suspendedEnd, 0);
});

// ---- sell-vs-hold recapture ----

check('recapture preview, hand-computed end to end', () => {
  const p = prop({ phase2: { accumulatedDepreciation: 30000 } });
  const r = P2.sellPreview(p, {
    salePrice: 300000, sellingCostsPct: 6, taxYear: 2026, strategy: 'balanced',
    filingStatus: 'single', baselineTaxableIncome: 120000, baselineAgi: 150000,
    marginalRate: 0.24, niitThreshold: 200000, suspendedLosses: 10000
  });
  assert.strictEqual(r.amountRealized, 282000);    // 300,000 − 6%
  assert.strictEqual(r.adjustedBasis, 190000);     // 220,000 − 30,000
  assert.strictEqual(r.gain, 92000);
  assert.strictEqual(r.unrecapTax, 7200);          // 30,000 × min(25%, 24%)
  assert.strictEqual(r.ltcgTax, 9300);             // 62,000 × 15%
  assert.strictEqual(r.niit, 1596);                // 3.8% × (150k+92k−200k)
  assert.strictEqual(r.freedLossBenefit, 2400);    // 10,000 × 24% (§469(g))
  assert.strictEqual(r.saleTax, 15696);
  assert.strictEqual(r.netAfterTax, 116304);       // 282,000 − 150,000 loan − tax
});

check('sale at a loss: no tax, loan still nets out', () => {
  const p = prop({ phase2: { accumulatedDepreciation: 30000 } });
  const r = P2.sellPreview(p, {
    salePrice: 150000, sellingCostsPct: 0, taxYear: 2026, strategy: 'balanced',
    filingStatus: 'single', baselineTaxableIncome: 120000, baselineAgi: 150000,
    marginalRate: 0.24, niitThreshold: 200000, suspendedLosses: 0
  });
  assert.strictEqual(r.gain, -40000);
  assert.strictEqual(r.saleTax, 0);
  assert.strictEqual(r.netAfterTax, 0);            // 150,000 − 150,000 loan
});

console.log(`\nAll ${passed} Phase 2 checks passed.`);
