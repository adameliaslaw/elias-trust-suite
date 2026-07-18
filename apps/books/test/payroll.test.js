// Tax engine tests, ported from the firm payroll app's tests/test_taxes.py.
// Expected values are hand-computed from the 2026 IRS Pub 15-T tables, SSA
// wage base, NJ-WT tables, and NJ DOL rates. If the JS port ever drifts from
// the Python engine, these fail.
const assert = require('assert');
const T = require('../lib/payroll/tables2026');
const E = require('../lib/payroll/engine');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const w4 = (kw = {}) => ({
  filingStatus: 'single', multipleJobs: false, dependentsCredit: 0,
  otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false, ...kw
});
const njw4 = (kw = {}) => ({ rateTable: 'A', allowances: 0, extraWithholding: 0, exempt: false, ...kw });

// ---- federal income tax ----

check('single biweekly $104k -> 540.38', () => {
  // AAW = 104000 - 8600 = 95400; 5800 + 22%*(95400-57900) = 14050/yr.
  assert.strictEqual(E.fedIncomeTaxWithholding(T, 4000, 'biweekly', w4()), 540.38);
});

check('married semimonthly with dependents -> 251.67', () => {
  // AAW = 120000-12900 = 107100 -> 2480+12%*(107100-44100)=10040, less 4000.
  assert.strictEqual(
    E.fedIncomeTaxWithholding(T, 5000, 'semimonthly',
      w4({ filingStatus: 'married_jointly', dependentsCredit: 4000 })),
    251.67);
});

check('step 2 checkbox uses higher table -> 135.10', () => {
  // AAW = 52000 (no 8600 offset); checkbox: 2900+22%*(52000-33250)=7025/yr.
  assert.strictEqual(E.fedIncomeTaxWithholding(T, 1000, 'weekly', w4({ multipleJobs: true })), 135.10);
});

check('extra withholding adds; exempt zeroes', () => {
  const base = E.fedIncomeTaxWithholding(T, 4000, 'biweekly', w4());
  assert.strictEqual(E.fedIncomeTaxWithholding(T, 4000, 'biweekly', w4({ extraWithholding: 50 })), base + 50);
  assert.strictEqual(E.fedIncomeTaxWithholding(T, 4000, 'biweekly', w4({ exempt: true })), 0);
});

check('low wages withhold zero', () => {
  assert.strictEqual(E.fedIncomeTaxWithholding(T, 140, 'weekly', w4()), 0);
});

// ---- FICA ----

check('social security basic', () => {
  const r = E.socialSecurity(T, 4000, 0);
  assert.deepStrictEqual([r.employee, r.employer, r.taxable], [248.00, 248.00, 4000.00]);
});

check('social security cap straddle', () => {
  // Prior YTD 183,000; base 184,500 -> only 1,500 of 4,000 taxable.
  const r = E.socialSecurity(T, 4000, 183000);
  assert.strictEqual(r.taxable, 1500.00);
  assert.strictEqual(r.employee, E.cents(1500 * 0.062));
});

check('social security over cap', () => {
  const r = E.socialSecurity(T, 4000, 184500);
  assert.deepStrictEqual([r.employee, r.taxable], [0, 0]);
});

check('medicare no cap + additional past 200k', () => {
  const r = E.medicare(T, 4000, 500000);
  assert.strictEqual(r.employer, 58.00);
  assert.strictEqual(r.employee, 58.00 + 36.00);
  assert.strictEqual(r.addlWages, 4000.00);
});

check('additional medicare straddle', () => {
  // Prior 198,000 + 4,000 -> 2,000 over the 200,000 threshold.
  const r = E.medicare(T, 4000, 198000);
  assert.strictEqual(r.employee, E.cents(58.00 + E.cents(2000 * 0.009)));
  assert.strictEqual(r.employer, 58.00);
  assert.strictEqual(r.addlWages, 2000.00);
});

check('FUTA cap', () => {
  const r = E.futa(T, 4000, 5000);
  assert.strictEqual(r.taxable, 2000.00);
  assert.strictEqual(r.tax, 12.00);
});

// ---- New Jersey ----

check('NJ rate A biweekly $104k -> 190.77', () => {
  // Annual 104,000, table A: 2930 + 7%*(104000-75000) = 4960/yr.
  assert.strictEqual(E.njIncomeTaxWithholding(T, 4000, 'biweekly', njw4()), 190.77);
});

check('NJ rate B with allowances -> 94.04', () => {
  // Annual 90,000 - 3 allowances (3,000) = 87,000.
  // Table B: 1830 + 6.1%*(87000-80000) = 2257/yr semimonthly.
  assert.strictEqual(
    E.njIncomeTaxWithholding(T, 3750, 'semimonthly', njw4({ rateTable: 'B', allowances: 3 })),
    94.04);
});

check('NJ exempt zeroes', () => {
  assert.strictEqual(E.njIncomeTaxWithholding(T, 4000, 'biweekly', njw4({ exempt: true })), 0);
});

check('NJ employee contributions under caps', () => {
  const r = E.njEmployeeContributions(T, 4000, 0, 0);
  assert.strictEqual(r.uiWf, E.cents(4000 * 0.00425));
  assert.strictEqual(r.tdi, 7.60);
  assert.strictEqual(r.fli, 9.20);
});

check('NJ UI cap straddle', () => {
  // Prior UI wages 44,000; base 44,800 -> 800 taxable.
  const r = E.njEmployeeContributions(T, 4000, 44000, 44000);
  assert.strictEqual(r.uiTaxable, 800.00);
  assert.strictEqual(r.uiWf, E.cents(800 * 0.00425));
  assert.strictEqual(r.tdiTaxable, 4000.00);   // TDI/FLI base much higher
});

check('NJ employer contributions', () => {
  const r = E.njEmployerContributions(T, 4000, 0, 0.031, 0.005);
  assert.strictEqual(r.erUi, 124.00);
  assert.strictEqual(r.erTdi, 20.00);
});

// ---- full paycheck engine ----

const employee = (kw = {}) => ({
  payType: 'salary', annualSalary: 104000, hourlyRate: null,
  payFrequency: 'biweekly',
  fed: w4(), nj: njw4(), ...kw
});
const ytd = (kw = {}) => ({ ssWages: 0, medicareWages: 0, futaWages: 0, njUiWages: 0, njTdiWages: 0, ...kw });
const SETTINGS = { njEmployerUiRate: 0.031, njEmployerTdiRate: 0.005 };

check('salaried check balances end to end', () => {
  const chk = E.computePaycheck(2026, employee(), {}, [], ytd(), SETTINGS);
  assert.strictEqual(chk.gross, 4000.00);
  assert.strictEqual(chk.fit, 540.38);
  assert.strictEqual(chk.ss, 248.00);
  assert.strictEqual(chk.medicare, 58.00);
  assert.strictEqual(chk.njSit, 190.77);
  assert.strictEqual(chk.njUiWf, 17.00);
  assert.strictEqual(chk.njTdi, 7.60);
  assert.strictEqual(chk.njFli, 9.20);
  assert.strictEqual(chk.net, E.cents(chk.gross - chk.employeeTaxes));
  assert.strictEqual(chk.erSs, 248.00);
  assert.strictEqual(chk.erFuta, E.cents(4000 * 0.006));
  assert.strictEqual(chk.erNjUi, 124.00);
});

check('hourly with overtime at 1.5x', () => {
  const emp = employee({ payType: 'hourly', annualSalary: null, hourlyRate: 30, payFrequency: 'weekly' });
  const chk = E.computePaycheck(2026, emp, { hours: 40, otHours: 5 }, [], ytd(), SETTINGS);
  assert.strictEqual(chk.regular, 1200.00);
  assert.strictEqual(chk.overtime, 225.00);
  assert.strictEqual(chk.gross, 1425.00);
});

check('card tips taxed everywhere, tracked separately', () => {
  const emp = employee({ payType: 'hourly', annualSalary: null, hourlyRate: 20, payFrequency: 'weekly' });
  const plain = E.computePaycheck(2026, emp, { hours: 40 }, [], ytd(), SETTINGS);
  const tipped = E.computePaycheck(2026, emp, { hours: 40, tips: 300 }, [], ytd(), SETTINGS);
  assert.strictEqual(tipped.tips, 300.00);
  assert.strictEqual(tipped.gross, plain.gross + 300);
  assert.strictEqual(tipped.ficaWages, plain.ficaWages + 300);
  assert.strictEqual(tipped.ssTipsTaxable, 300.00);   // 941 line 5b
  assert.strictEqual(tipped.njUiTaxable, plain.njUiTaxable + 300);
});

check('pretax health (S125) reduces everything', () => {
  const ded = [{ name: 'Health', kind: 'pretax_health', amountType: 'fixed', amount: 200 }];
  const chk = E.computePaycheck(2026, employee(), {}, ded, ytd(), SETTINGS);
  assert.strictEqual(chk.fitWages, 3800.00);
  assert.strictEqual(chk.ficaWages, 3800.00);
  assert.strictEqual(chk.ss, E.cents(3800 * 0.062));
  assert.strictEqual(chk.njUiTaxable, 3800.00);
});

check('401(k) pretax for income tax only', () => {
  const ded = [{ name: '401(k)', kind: 'pretax_401k', amountType: 'percent', amount: 5 }];
  const chk = E.computePaycheck(2026, employee(), {}, ded, ytd(), SETTINGS);
  assert.strictEqual(chk.dedPretax401k, 200.00);
  assert.strictEqual(chk.fitWages, 3800.00);      // reduced
  assert.strictEqual(chk.njSitWages, 3800.00);    // reduced
  assert.strictEqual(chk.ficaWages, 4000.00);     // NOT reduced
  assert.strictEqual(chk.njUiTaxable, 4000.00);   // NOT reduced
});

check('reimbursement not taxed', () => {
  const plain = E.computePaycheck(2026, employee(), {}, [], ytd(), SETTINGS);
  const withReimb = E.computePaycheck(2026, employee(), { reimbursement: 150 }, [], ytd(), SETTINGS);
  assert.strictEqual(withReimb.employeeTaxes, plain.employeeTaxes);
  assert.strictEqual(withReimb.net, E.cents(plain.net + 150));
});

check('unknown year throws', () => {
  assert.throws(() => E.computePaycheck(2031, employee(), {}, [], ytd(), SETTINGS), /No tax tables/);
});

console.log(`\nAll ${passed} payroll engine checks passed.`);
