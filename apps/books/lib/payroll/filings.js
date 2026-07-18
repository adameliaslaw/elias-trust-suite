// Quarterly/annual filings computed from finalized paychecks, ported from
// the firm payroll app (payroll/filings/f941.py, nj927.py, f940.py):
//
// - Form 941 (Employer's Quarterly Federal Tax Return): every line,
//   including the fractions-of-cents adjustment (line 7) and the liability
//   detail for line 16 (monthly) or Schedule B (semiweekly, by payday).
// - NJ-927 / WR-30: New Jersey offers no filing API for individual
//   employers, so these compute every figure the NJ portal asks for —
//   filing is a transcription task; the payment goes out from the deposit
//   calendar as an ACH credit.
// - Form 940 (annual FUTA): NJ single-state, full 5.4% credit, 0.6%
//   effective rate, §125 benefits exempt.
const { cents } = require('./engine');
const deposits = require('./deposits');
const { tablesForYear } = require('./engine');

const SS_COMBINED_RATE = 0.124;
const MEDICARE_COMBINED_RATE = 0.029;
const ADDL_MEDICARE_RATE = 0.009;

function quarterMonths(quarter) {
  return [quarter * 3 - 2, quarter * 3 - 1, quarter * 3];
}

// Deposits recorded against a bucket whose periodKey falls inside the
// quarter (monthly 'YYYY-MM' keys or semiweekly payday keys). Deposits
// recorded without a period key can't be attributed to a quarter and are
// reported separately so the preparer can allocate them.
function depositsForQuarter(db, year, quarter) {
  const months = new Set(quarterMonths(quarter).map(m => `${year}-${String(m).padStart(2, '0')}`));
  let attributed = 0, unattributed = 0;
  for (const d of db.payrollDeposits) {
    if (d.bucket !== 'federal_941') continue;
    const key = d.periodKey || '';
    if (months.has(key) || (key.length === 10 && months.has(key.slice(0, 7)))) attributed += d.amount;
    else if (!key) unattributed += d.amount;
  }
  return { attributed: cents(attributed), unattributed: cents(unattributed) };
}

function compute941(db, year, quarter, depositsPaidOverride) {
  const rows = deposits.finalizedChecks(db, year, quarter);
  const employees = new Set();
  let l2 = 0, l3 = 0;
  let ssWages = 0, ssTips = 0, medWages = 0, addlWages = 0;
  let actualFica = 0;
  const monthly = {};
  for (const m of quarterMonths(quarter)) monthly[m] = 0;
  const byPayday = new Map();

  for (const { payDate, employeeId, c } of rows) {
    employees.add(employeeId);
    l2 += c.fitWages;
    l3 += c.fit;
    const tipsTaxable = c.ssTipsTaxable || 0;
    ssWages += c.ssTaxable - tipsTaxable;    // line 5a: non-tip wages
    ssTips += tipsTaxable;                   // line 5b
    medWages += c.medicareTaxable;
    addlWages += c.addlMedicareWages || 0;
    actualFica += c.ss + c.erSs + c.medicare + c.erMedicare;
    const liability = deposits.federalLiabilityOf(c);
    monthly[Number(payDate.slice(5, 7))] += liability;
    byPayday.set(payDate, (byPayday.get(payDate) || 0) + liability);
  }

  const l5a2 = cents(ssWages * SS_COMBINED_RATE);
  const l5b2 = cents(ssTips * SS_COMBINED_RATE);
  const l5c2 = cents(medWages * MEDICARE_COMBINED_RATE);
  const l5d2 = cents(addlWages * ADDL_MEDICARE_RATE);
  const l5e = cents(l5a2 + l5b2 + l5c2 + l5d2);
  const l6 = cents(cents(l3) + l5e);
  // Fractions of cents: actually-withheld/matched FICA vs the rate-times-
  // wages computation on lines 5a-5d.
  const l7 = cents(cents(actualFica) - l5e);
  const l10 = cents(l6 + l7);
  const l12 = l10;
  const dep = depositsForQuarter(db, year, quarter);
  const l13 = depositsPaidOverride !== undefined ? cents(depositsPaidOverride) : dep.attributed;

  return {
    year, quarter,
    l1Employees: employees.size,
    l2Wages: cents(l2),
    l3Fit: cents(l3),
    l5aSsWages: cents(ssWages), l5aSsTax: l5a2,
    l5bSsTips: cents(ssTips), l5bSsTipsTax: l5b2,
    l5cMedWages: cents(medWages), l5cMedTax: l5c2,
    l5dAddlWages: cents(addlWages), l5dAddlTax: l5d2,
    l5eTotalFica: l5e,
    l6BeforeAdjust: l6,
    l7Fractions: l7,
    l10Total: l10,
    l12TotalAfterCredits: l12,
    l13Deposits: l13,
    l13Unattributed: dep.unattributed,
    l14BalanceDue: cents(Math.max(l12 - l13, 0)),
    l15Overpayment: cents(Math.max(l13 - l12, 0)),
    monthlyLiability: Object.fromEntries(Object.entries(monthly).map(([m, v]) => [m, cents(v)])),
    scheduleB: [...byPayday.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([payDate, liability]) => ({ payDate, liability: cents(liability) })),
    checks: rows.length
  };
}

function computeNj927(db, year, quarter) {
  const rows = deposits.finalizedChecks(db, year, quarter);
  const months = quarterMonths(quarter);
  const gitByMonth = {};
  for (const m of months) gitByMonth[m] = 0;
  let gross = 0, git = 0, uiWages = 0, tdiWages = 0;
  for (const { payDate, c } of rows) {
    const month = Number(payDate.slice(5, 7));
    gitByMonth[month] += c.njSit;
    git += c.njSit;
    gross += c.gross;
    uiWages += c.njUiTaxable;
    tdiWages += c.njTdiTaxable;
  }
  const contributions = deposits.nj927Contributions(db, year, quarter);
  return {
    year, quarter,
    due: deposits.nj927DueDate(year, quarter),
    grossWages: cents(gross),
    gitWithheld: cents(git),
    gitByMonth: Object.fromEntries(Object.entries(gitByMonth).map(([m, v]) => [m, cents(v)])),
    uiTaxableWages: cents(uiWages),
    tdiTaxableWages: cents(tdiWages),
    contributions,
    totalDue: cents(cents(git) + contributions.amount),
    checks: rows.length
  };
}

// Per-employee quarterly wage detail for the WR-30. Base weeks (weeks the
// employee earned at least the statutory minimum) depend on each pay
// period's calendar layout; the check count is a starting point and must be
// reviewed before filing. SSNs are entered at the portal (QuickBucks
// deliberately does not store them).
function computeWr30(db, year, quarter) {
  const byEmployee = new Map();
  for (const { employeeId, employeeName, c } of deposits.finalizedChecks(db, year, quarter)) {
    if (!byEmployee.has(employeeId)) {
      byEmployee.set(employeeId, { employeeId, name: employeeName, gross: 0, checks: 0 });
    }
    const e = byEmployee.get(employeeId);
    e.gross += c.gross;
    e.checks += 1;
  }
  return [...byEmployee.values()]
    .map(e => ({ ...e, gross: cents(e.gross) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function compute940(db, year, depositsPaidOverride) {
  const tables = tablesForYear(year);
  const rows = deposits.finalizedChecks(db, year);
  let totalPayments = 0;    // line 3
  let exemptPayments = 0;   // line 4 (Section 125 benefits)
  let futaTaxable = 0;      // line 7
  for (const { c } of rows) {
    totalPayments += c.gross;
    exemptPayments += c.dedPretaxHealth || 0;
    futaTaxable += c.futaTaxable;
  }
  const subjectWages = totalPayments - exemptPayments;
  const l5Excess = subjectWages - futaTaxable;   // over the $7,000-per-employee base
  const l8Tax = cents(futaTaxable * tables.FUTA_RATE);
  const attributed = cents(db.payrollDeposits
    .filter(d => d.bucket === 'futa' && (d.periodKey || '').startsWith(String(year)))
    .reduce((s, d) => s + d.amount, 0));
  const l13 = depositsPaidOverride !== undefined ? cents(depositsPaidOverride) : attributed;
  return {
    year,
    l3TotalPayments: cents(totalPayments),
    l4ExemptPayments: cents(exemptPayments),
    l5ExcessOverBase: cents(l5Excess),
    l6Subtotal: cents(exemptPayments + l5Excess),
    l7TaxableFutaWages: cents(futaTaxable),
    l8FutaTax: l8Tax,
    l12TotalTax: l8Tax,
    l13Deposits: l13,
    l14BalanceDue: cents(Math.max(l8Tax - l13, 0)),
    l15Overpayment: cents(Math.max(l13 - l8Tax, 0)),
    quarterlyLiabilities: deposits.futaLiabilities(db, year),
    checks: rows.length
  };
}

module.exports = { quarterMonths, compute941, computeNj927, computeWr30, compute940 };
