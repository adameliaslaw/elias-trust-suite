// NACHA + deposit-calendar tests, ported from the firm payroll app's
// tests/test_payments_filings.py (TXP strings, file structure, due-date
// rules, and grouping totals are identical expectations).
const assert = require('assert');
const N = require('../lib/payroll/nacha');
const D = require('../lib/payroll/deposits');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---- TXP addenda ----

check('EFTPS 941 TXP with subcategories (exact string)', () => {
  const got = N.eftpsTxp('12-3456789', N.FED_941_DEPOSIT, '2026-09-30', 4523.10,
    [['1', 2480.00], ['2', 580.10], ['3', 1463.00]]);
  assert.strictEqual(got, 'TXP*123456789*94105*260901*1*248000*2*58010*3*146300\\');
});

check('EFTPS subcategories must balance', () => {
  assert.throws(() => N.eftpsTxp('123456789', '94105', '2026-09-30', 100,
    [['1', 60], ['2', 30]]), /must sum/);
});

check('EFTPS 940 without subcategories', () => {
  const got = N.eftpsTxp('123456789', N.FED_940_DEPOSIT, '2026-12-31', 42.00);
  assert.strictEqual(got, 'TXP*123456789*09405*261201*09405*4200\\');
});

check('NJ weekly TXP (exact string)', () => {
  const got = N.njTxp('123456789000', N.NJ_GIT_WEEKLY, '2026-07-10', 2139.48, 'Elias Counsel');
  assert.strictEqual(got, 'TXP*B123456789000*01170*260710*T*213948*****ELIA\\');
});

check('NJ name control pads short names', () => {
  const got = N.njTxp('123456789000', '01130', '2026-09-30', 1, 'AB');
  assert.ok(got.endsWith('*ABXX\\'));
});

// ---- CCD+ tax payment file ----

const COMPANY = {
  name: 'Elias Counsel LLC', ein: '12-3456789',
  bankRouting: '021200339', immediateDestination: '021200339',
  immediateOrigin: '1123456789', destinationName: 'TD BANK'
};

check('CCD+ file structure (94-char lines, full blocks, record order)', () => {
  const addenda = N.eftpsTxp('123456789', '94105', '2026-09-30', 1000);
  const content = N.buildTaxPaymentFile(COMPANY, {
    routing: N.TREASURY_ROUTING, account: N.TREASURY_ACCOUNT,
    receiverName: 'IRS', amount: 1000, addenda,
    description: 'TAXPAYMENT', identification: '123456789'
  }, { date: '2026-10-10', time: '0930' }, '2026-10-15');
  const lines = content.trim().split('\n');
  assert.strictEqual(lines.length % 10, 0);
  lines.forEach((line, i) => assert.strictEqual(line.length, 94, `line ${i} wrong length`));
  assert.ok(lines[0].startsWith('101 '));
  assert.ok(lines[1].startsWith('5220'));               // credits-only batch
  assert.ok(lines[1].includes('CCD'));
  assert.ok(lines[2].startsWith('622061036000'));        // credit to Treasury RTN
  assert.ok(lines[2].includes('23401009'));
  assert.strictEqual(lines[2][78], '1');                 // addenda indicator
  assert.ok(lines[3].startsWith('705TXP*123456789*94105*'));
  assert.ok(lines[4].startsWith('8220'));
  assert.ok(lines[4].includes('000000100000'));          // credit total $1,000.00
});

// ---- PPD payroll file ----

check('PPD file pays employees with correct totals and tx codes', () => {
  const content = N.buildPpdFile(COMPANY, [
    { name: 'Jane Doe', routing: '031207607', account: '111222', accountType: 'checking', amount: 1792.86, id: 'emp1' },
    { name: 'Bob Smith', routing: '021200339', account: '333444', accountType: 'savings', amount: 2674.53, id: 'emp2' }
  ], { date: '2026-07-17', time: '0800' }, '2026-07-17');
  const lines = content.trim().split('\n');
  assert.strictEqual(lines.length % 10, 0);
  lines.forEach((line, i) => assert.strictEqual(line.length, 94, `line ${i} wrong length`));
  // A payroll direct-deposit batch is all credits — service class code 220
  // (ACH credits only), NOT 200 (mixed debits and credits). NACHA Operating
  // Rules & Guidelines, Appendix Three: Company/Batch Header (field 2) and
  // Company/Batch Control (field 2), Service Class Code.
  assert.ok(lines[1].startsWith('5220'), 'batch header must be credits-only (220)');
  assert.ok(lines[1].includes('PPD'));
  assert.ok(lines[2].startsWith('622'));                 // checking credit
  assert.ok(lines[3].startsWith('632'));                 // savings credit
  assert.ok(lines[4].startsWith('8220'), 'batch control must match service class 220');
  const totalCents = Math.round((1792.86 + 2674.53) * 100);
  assert.ok(lines[4].includes(String(totalCents).padStart(12, '0')));
});

// ---- due-date rules ----

check('semiweekly: Fri->Wed, Mon->Fri, Wed->next Wed', () => {
  assert.strictEqual(D.semiweeklyDueDate('2026-07-10'), '2026-07-15');  // Friday
  assert.strictEqual(D.semiweeklyDueDate('2026-07-13'), '2026-07-17');  // Monday
  assert.strictEqual(D.semiweeklyDueDate('2026-07-08'), '2026-07-15');  // Wednesday
});

check('NJ weekly payer due dates', () => {
  assert.strictEqual(D.njWeeklyDueDate('2026-07-10'), '2026-07-15');    // Fri -> next-week Wed
  assert.strictEqual(D.njWeeklyDueDate('2026-07-12'), '2026-07-22');    // Sun already next week
});

check('monthly 15th-following and NJ-927 due dates', () => {
  assert.strictEqual(D.fifteenthFollowing(2026, 7), '2026-08-15');
  assert.strictEqual(D.fifteenthFollowing(2026, 12), '2027-01-15');
  assert.strictEqual(D.nj927DueDate(2026, 2), '2026-07-30');
  assert.strictEqual(D.nj927DueDate(2026, 4), '2027-01-30');
});

// ---- grouping over the QuickBucks data model ----
// Same figures as the Python fixture: two runs (2026-07-10, 2026-08-07),
// two identical checks each.

function fixtureDb() {
  const computed = {
    fit: 540.38, ss: 235.60, erSs: 235.60, medicare: 55.10, erMedicare: 55.10,
    njSit: 174.08, njUiWf: 16.15, njTdi: 7.22, njFli: 8.74,
    erNjUi: 117.80, erNjTdi: 19.00, erFuta: 22.80
  };
  const run = (payDate) => ({
    status: 'finalized', payDate,
    checks: [{ computed: { ...computed } }, { computed: { ...computed } }]
  });
  return { payRuns: [run('2026-07-10'), run('2026-08-07')], payrollDeposits: [] };
}

check('federal monthly grouping: amounts and due dates', () => {
  const groups = D.federalLiabilities(fixtureDb(), 2026, 'monthly');
  assert.strictEqual(groups.length, 2);
  const july = groups[0];
  assert.strictEqual(july.key, '2026-07');
  assert.strictEqual(july.due, '2026-08-15');
  // per check: 540.38 + 2×235.60 + 2×55.10 = 1,121.78; two checks
  assert.strictEqual(july.amount, 2243.56);
  assert.strictEqual(july.fit, 1080.76);
  assert.strictEqual(july.nextDayRule, false);
});

check('federal semiweekly grouping keys by payday', () => {
  const groups = D.federalLiabilities(fixtureDb(), 2026, 'semiweekly');
  assert.deepStrictEqual(groups.map(g => g.key), ['2026-07-10', '2026-08-07']);
  assert.strictEqual(groups[0].due, '2026-07-15');   // Fri -> Wed
});

check('NJ GIT quarterly grouping', () => {
  const groups = D.njGitLiabilities(fixtureDb(), 2026, 'quarterly');
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].key, '2026-Q3');
  assert.strictEqual(groups[0].amount, 696.32);      // 174.08 × 4
  assert.strictEqual(groups[0].due, '2026-10-30');
});

check('NJ-927 contributions total employee + employer', () => {
  const g = D.nj927Contributions(fixtureDb(), 2026, 3);
  // (16.15 + 7.22 + 8.74 + 117.80 + 19.00) × 4 = 675.64
  assert.strictEqual(g.amount, 675.64);
  assert.strictEqual(g.due, '2026-10-30');
});

check('FUTA rolls forward under $500', () => {
  const futa = D.futaLiabilities(fixtureDb(), 2026, '2026-09-01');
  const q3 = futa.find(g => g.key === '2026-Q3-futa');
  assert.strictEqual(q3.quarterLiability, 91.20);    // 22.80 × 4
  assert.strictEqual(q3.depositRequired, false);
  assert.strictEqual(q3.amount, 0);
});

check('FUTA deposit required once accumulation passes $500', () => {
  const db = fixtureDb();
  // scale up: 30 checks in Q3 → 22.80 × 30 = 684 > 500
  db.payRuns[0].checks = Array.from({ length: 15 }, () => ({ computed: { fit: 0, ss: 0, erSs: 0, medicare: 0, erMedicare: 0, njSit: 0, njUiWf: 0, njTdi: 0, njFli: 0, erNjUi: 0, erNjTdi: 0, erFuta: 22.80 } }));
  db.payRuns[1].checks = db.payRuns[0].checks.map(c => ({ computed: { ...c.computed } }));
  const q3 = D.futaLiabilities(db, 2026, '2026-10-01').find(g => g.key === '2026-Q3-futa');
  assert.strictEqual(q3.depositRequired, true);
  assert.strictEqual(q3.amount, 684);
  assert.strictEqual(q3.due, '2026-10-31');
});

check('payments recorded against an obligation', () => {
  const db = fixtureDb();
  db.payrollDeposits.push({ bucket: 'federal_941', periodKey: '2026-07', amount: 2243.56, date: '2026-08-10' });
  assert.strictEqual(D.paidFor(db, 'federal_941', '2026-07'), 2243.56);
  assert.strictEqual(D.paidFor(db, 'federal_941', '2026-08'), 0);
});

console.log(`\nAll ${passed} NACHA / deposit-calendar checks passed.`);
