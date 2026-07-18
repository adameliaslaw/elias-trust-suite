// Form 941 / NJ-927 / WR-30 / Form 940 tests, ported from the firm payroll
// app's tests (same fixture: two finalized Q3 2026 runs, two checks each).
const assert = require('assert');
const F = require('../lib/payroll/filings');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// Mirror of the Python make_db() fixture values per check.
const computed = () => ({
  gross: 4000, fitWages: 3800, fit: 540.38,
  ssTaxable: 3800, ssTipsTaxable: 0, ss: 235.60, erSs: 235.60,
  medicareTaxable: 3800, medicare: 55.10, erMedicare: 55.10, addlMedicareWages: 0,
  njSit: 174.08, njUiWf: 16.15, njTdi: 7.22, njFli: 8.74,
  erNjUi: 117.80, erNjTdi: 19.00, erFuta: 22.80,
  futaTaxable: 3800, njUiTaxable: 3800, njTdiTaxable: 3800,
  dedPretaxHealth: 200
});

function fixtureDb() {
  const run = payDate => ({
    status: 'finalized', payDate,
    checks: [
      { employeeId: 'e1', employeeName: 'Jane Doe', computed: computed() },
      { employeeId: 'e2', employeeName: 'Bob Smith', computed: computed() }
    ]
  });
  return { payRuns: [run('2026-07-10'), run('2026-08-07')], payrollDeposits: [] };
}

check('Form 941: every line matches the ported fixture', () => {
  const form = F.compute941(fixtureDb(), 2026, 3, 2243.56);
  assert.strictEqual(form.l1Employees, 2);
  assert.strictEqual(form.l2Wages, 15200.00);
  assert.strictEqual(form.l3Fit, 2161.52);
  assert.strictEqual(form.l5aSsWages, 15200.00);
  assert.strictEqual(form.l5aSsTax, 1884.80);       // 15,200 × .124
  assert.strictEqual(form.l5cMedTax, 440.80);       // 15,200 × .029
  assert.strictEqual(form.l7Fractions, 0);          // actual FICA matches exactly
  assert.strictEqual(form.l12TotalAfterCredits, 4487.12);
  assert.strictEqual(form.l14BalanceDue, 2243.56);
  assert.strictEqual(form.monthlyLiability[7], 2243.56);
  assert.strictEqual(form.monthlyLiability[9], 0);
  assert.strictEqual(form.scheduleB.length, 2);
});

check('fractions of cents flows to line 7 and line 10', () => {
  const db = fixtureDb();
  db.payRuns[0].checks[0].computed.ss = 235.61;     // one-cent rounding artifact
  const form = F.compute941(db, 2026, 3);
  assert.strictEqual(form.l7Fractions, 0.01);
  assert.strictEqual(form.l10Total, Math.round((form.l6BeforeAdjust + 0.01) * 100) / 100);
});

check('line 13 pulls attributed deposits; unattributed reported separately', () => {
  const db = fixtureDb();
  db.payrollDeposits.push({ bucket: 'federal_941', periodKey: '2026-07', amount: 2243.56, date: '2026-08-10' });
  db.payrollDeposits.push({ bucket: 'federal_941', periodKey: '', amount: 100, date: '2026-08-11' });
  const form = F.compute941(db, 2026, 3);
  assert.strictEqual(form.l13Deposits, 2243.56);
  assert.strictEqual(form.l13Unattributed, 100);
  assert.strictEqual(form.l14BalanceDue, 2243.56);  // the other month still owed
});

check('NJ-927: GIT by month, contributions, total due', () => {
  const form = F.computeNj927(fixtureDb(), 2026, 3);
  assert.strictEqual(form.gitWithheld, 696.32);
  assert.strictEqual(form.gitByMonth[7], 348.16);
  assert.strictEqual(form.contributions.erUi, 471.20);
  assert.strictEqual(form.totalDue, Math.round((form.gitWithheld + form.contributions.amount) * 100) / 100);
  assert.strictEqual(form.due, '2026-10-30');
});

check('WR-30: per-employee gross and check counts', () => {
  const rows = F.computeWr30(fixtureDb(), 2026, 3);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].gross, 8000.00);
  assert.strictEqual(rows[0].checks, 2);
  assert.strictEqual(rows[0].name, 'Bob Smith');    // sorted by name
});

check('Form 940: §125 exempt, taxable FUTA wages, 0.6% tax', () => {
  const form = F.compute940(fixtureDb(), 2026);
  assert.strictEqual(form.l3TotalPayments, 16000.00);
  assert.strictEqual(form.l4ExemptPayments, 800.00);
  assert.strictEqual(form.l7TaxableFutaWages, 15200.00);
  assert.strictEqual(form.l8FutaTax, 91.20);
  assert.strictEqual(form.l14BalanceDue, 91.20);
});

console.log(`\nAll ${passed} filings checks passed.`);
