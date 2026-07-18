// Paycheck computation engine, ported from the firm payroll app
// (payroll/money.py, payroll/taxes/federal.py, payroll/taxes/new_jersey.py,
// payroll/taxes/engine.py). The hand-computed test values from that repo's
// test suite are ported alongside in test/payroll.test.js — if this file and
// the Python engine ever disagree, those tests fail.
//
// Money convention: plain numbers, but every tax/wage figure is passed
// through cents(), which snaps float noise (12 significant digits) before
// rounding half-up to whole cents — matching Python's Decimal ROUND_HALF_UP.

const TABLES_BY_YEAR = {
  2026: require('./tables2026')
};

function tablesForYear(year) {
  const t = TABLES_BY_YEAR[year];
  if (!t) {
    throw new Error(`No tax tables for ${year}. Add lib/payroll/tables${year}.js ` +
      'with that year\'s official values and register it in engine.js.');
  }
  return t;
}

const PAY_PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

// ---------- money helpers ----------

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function cents(v) {
  const n = num(v);
  if (n === 0) return 0;
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}

// Apply a [floor, taxAtFloor, marginalRate] bracket table.
function bracketTax(rows, amount) {
  if (amount <= 0) return 0;
  let row = rows[0];
  for (const candidate of rows) {
    if (amount > candidate[0]) row = candidate;
    else break;
  }
  const [floor, base, rate] = row;
  return base + (amount - floor) * rate;
}

// Portion of this period's wages still under a YTD wage-base cap.
function cappedWages(priorYtdWages, periodWages, wageBase) {
  const prior = Math.max(num(priorYtdWages), 0);
  const wages = Math.max(num(periodWages), 0);
  if (prior >= wageBase) return 0;
  return Math.min(wages, wageBase - prior);
}

// ---------- federal ----------

// Pub 15-T Worksheet 1A (percentage method for automated payroll systems),
// 2020-or-later Form W-4.
function fedIncomeTaxWithholding(tables, periodTaxableWages, frequency, w4) {
  if (w4.exempt) return 0;
  const periods = PAY_PERIODS[frequency];
  const status = w4.filingStatus;
  const step2 = !!w4.multipleJobs;

  // Step 1: adjusted annual wage amount
  const annualWages = num(periodTaxableWages) * periods + num(w4.otherIncome);
  let adjustment = num(w4.deductions);
  if (!step2) adjustment += tables.FED_W4_ADJUSTMENT[status];
  const adjustedAnnual = Math.max(annualWages - adjustment, 0);

  // Step 2: tentative annual withholding from the rate schedules
  const schedule = (step2 ? tables.FED_CHECKBOX : tables.FED_STANDARD)[status];
  let tentativeAnnual = bracketTax(schedule, adjustedAnnual);

  // Step 3: annual credit for dependents
  tentativeAnnual = Math.max(tentativeAnnual - num(w4.dependentsCredit), 0);

  // Step 4: back to a per-period amount, plus extra withholding
  return cents(tentativeAnnual / periods + num(w4.extraWithholding));
}

function socialSecurity(tables, periodWages, priorYtdWages) {
  const taxable = cappedWages(priorYtdWages, periodWages, tables.SOCIAL_SECURITY_WAGE_BASE);
  const tax = cents(taxable * tables.SOCIAL_SECURITY_RATE);
  return { employee: tax, employer: tax, taxable: cents(taxable) };
}

function medicare(tables, periodWages, priorYtdWages) {
  const wages = num(periodWages);
  const baseTax = cents(wages * tables.MEDICARE_RATE);
  // Additional Medicare Tax: employee-only, 0.9% on wages past $200,000 YTD.
  const threshold = tables.ADDITIONAL_MEDICARE_THRESHOLD;
  const prior = num(priorYtdWages);
  const over = Math.max(prior + wages - threshold, 0) - Math.max(prior - threshold, 0);
  const additional = cents(over * tables.ADDITIONAL_MEDICARE_RATE);
  return {
    employee: cents(baseTax + additional),
    employer: baseTax,
    taxable: cents(wages),
    addlWages: cents(over)   // feeds Form 941 line 5d
  };
}

function futa(tables, periodWages, priorYtdWages) {
  const taxable = cappedWages(priorYtdWages, periodWages, tables.FUTA_WAGE_BASE);
  return { tax: cents(taxable * tables.FUTA_RATE), taxable: cents(taxable) };
}

// ---------- New Jersey ----------

// NJ-W4 line 2 filing status -> default rate table when line 3 is blank.
const NJ_DEFAULT_TABLE_FOR_STATUS = {
  single: 'A', married_separate: 'A', married_jointly: 'B',
  head_of_household: 'B', surviving_spouse: 'B'
};

// NJ-WT percentage method: annualize, subtract $1,000/allowance, apply the
// employee's rate table (A-E), divide back to the period.
function njIncomeTaxWithholding(tables, periodTaxableWages, frequency, njw4) {
  if (njw4.exempt) return 0;
  const periods = PAY_PERIODS[frequency];
  let annual = num(periodTaxableWages) * periods;
  annual -= num(njw4.allowances) * tables.NJ_ALLOWANCE_ANNUAL;
  annual = Math.max(annual, 0);
  const annualTax = bracketTax(tables.NJ_RATE_TABLES[njw4.rateTable], annual);
  return cents(annualTax / periods + num(njw4.extraWithholding));
}

function njEmployeeContributions(tables, periodWages, priorYtdUiWages, priorYtdTdiWages) {
  const uiTaxable = cappedWages(priorYtdUiWages, periodWages, tables.NJ_UI_WAGE_BASE);
  const tdiTaxable = cappedWages(priorYtdTdiWages, periodWages, tables.NJ_TDI_FLI_WAGE_BASE);
  return {
    uiWf: cents(uiTaxable * (tables.NJ_UI_EMPLOYEE_RATE + tables.NJ_WF_EMPLOYEE_RATE)),
    tdi: cents(tdiTaxable * tables.NJ_TDI_EMPLOYEE_RATE),
    fli: cents(tdiTaxable * tables.NJ_FLI_EMPLOYEE_RATE),
    uiTaxable: cents(uiTaxable),
    tdiTaxable: cents(tdiTaxable)
  };
}

function njEmployerContributions(tables, periodWages, priorYtdUiWages, employerUiRate, employerTdiRate) {
  const taxable = cappedWages(priorYtdUiWages, periodWages, tables.NJ_UI_WAGE_BASE);
  return {
    erUi: cents(taxable * num(employerUiRate)),
    erTdi: cents(taxable * num(employerTdiRate)),
    erTaxable: cents(taxable)
  };
}

// ---------- paycheck ----------

// Regular + overtime + bonus + card tips for one paycheck. Tips are fully
// taxable everywhere but tracked separately (941 line 5b / W-2 box 7).
function grossEarnings(employee, inputs, frequency) {
  const periods = PAY_PERIODS[frequency];
  let regular, overtime;
  if (employee.payType === 'salary') {
    regular = num(employee.annualSalary) / periods;
    overtime = 0;
  } else {
    const rate = num(employee.hourlyRate);
    regular = rate * num(inputs.hours);
    overtime = rate * 1.5 * num(inputs.otHours);
  }
  return {
    regular: cents(regular), overtime: cents(overtime),
    bonus: cents(inputs.bonus), tips: cents(inputs.tips)
  };
}

// Resolve each active deduction to a per-check amount.
// Deduction: {name, kind, amountType, amount}; kind in pretax_health,
// pretax_401k, roth_401k, aftertax.
function deductionAmounts(deductions, gross) {
  const resolved = [];
  const totals = { pretax_health: 0, pretax_401k: 0, roth_401k: 0, aftertax: 0 };
  for (const d of deductions) {
    let amount = d.amountType === 'percent' ? cents(gross * num(d.amount) / 100) : cents(d.amount);
    amount = Math.min(amount, gross);  // never deduct more than the check
    resolved.push({ name: d.name, kind: d.kind, amount });
    totals[d.kind] = cents(totals[d.kind] + amount);
  }
  return { resolved, totals };
}

/**
 * Compute one full paycheck.
 *
 * year      calendar year of the pay date (selects tax tables)
 * employee  {payType, annualSalary, hourlyRate, payFrequency,
 *            fed: {filingStatus, multipleJobs, dependentsCredit, otherIncome,
 *                  deductions, extraWithholding, exempt},
 *            nj:  {rateTable, allowances, extraWithholding, exempt}}
 * inputs    {hours, otHours, bonus, tips, reimbursement}
 * deductions list of active recurring deductions
 * ytd       prior-YTD: {ssWages, medicareWages, futaWages, njUiWages, njTdiWages}
 * settings  {njEmployerUiRate, njEmployerTdiRate} as decimals (e.g. 0.031)
 */
function computePaycheck(year, employee, inputs, deductions, ytd, settings) {
  const tables = tablesForYear(year);
  const frequency = employee.payFrequency;

  const { regular, overtime, bonus, tips } = grossEarnings(employee, inputs, frequency);
  const gross = cents(regular + overtime + bonus + tips);

  const { resolved: dedList, totals: ded } = deductionAmounts(deductions, gross);

  // Taxable wage bases. Section 125 health premiums are pretax for
  // everything; 401(k) deferrals are pretax for federal and NJ income tax
  // but NOT for FICA, FUTA, or NJ UI/TDI/FLI.
  const s125 = ded.pretax_health;
  const k401 = ded.pretax_401k;
  const fitWages = Math.max(gross - s125 - k401, 0);
  const ficaWages = Math.max(gross - s125, 0);
  const njSitWages = fitWages;
  const njBaseWages = ficaWages;  // UI/WF, TDI, FLI, and FUTA all use this

  const fit = fedIncomeTaxWithholding(tables, fitWages, frequency, employee.fed);
  const ss = socialSecurity(tables, ficaWages, ytd.ssWages);
  // Split SS-taxable between non-tip wages (941 line 5a) and tips (5b);
  // non-tip wages fill the wage-base cap first.
  const nonTipFica = Math.max(ficaWages - tips, 0);
  const ssWagesTaxable = Math.min(nonTipFica, ss.taxable);
  const ssTipsTaxable = cents(ss.taxable - ssWagesTaxable);
  const med = medicare(tables, ficaWages, ytd.medicareWages);
  const fu = futa(tables, njBaseWages, ytd.futaWages);

  const njSit = njIncomeTaxWithholding(tables, njSitWages, frequency, employee.nj);
  const njEe = njEmployeeContributions(tables, njBaseWages, ytd.njUiWages, ytd.njTdiWages);
  const njEr = njEmployerContributions(tables, njBaseWages, ytd.njUiWages,
    settings.njEmployerUiRate || 0, settings.njEmployerTdiRate || 0);

  const employeeTaxes = cents(fit + ss.employee + med.employee + njSit + njEe.uiWf + njEe.tdi + njEe.fli);
  const totalDeductions = cents(dedList.reduce((s, d) => s + d.amount, 0));
  const reimbursement = cents(inputs.reimbursement);
  const net = cents(gross - employeeTaxes - totalDeductions + reimbursement);

  return {
    regular, overtime, bonus, tips, gross, reimbursement,
    fitWages: cents(fitWages), ficaWages: cents(ficaWages),
    njSitWages: cents(njSitWages),
    ssTaxable: ss.taxable, ssTipsTaxable,
    medicareTaxable: med.taxable,
    addlMedicareWages: med.addlWages,
    futaTaxable: fu.taxable,
    njUiTaxable: njEe.uiTaxable, njTdiTaxable: njEe.tdiTaxable,
    fit, ss: ss.employee, medicare: med.employee, njSit,
    njUiWf: njEe.uiWf, njTdi: njEe.tdi, njFli: njEe.fli,
    deductions: dedList,
    dedPretaxHealth: ded.pretax_health, dedPretax401k: ded.pretax_401k,
    dedRoth401k: ded.roth_401k, dedAftertax: ded.aftertax,
    totalDeductions, employeeTaxes, net,
    erSs: ss.employer, erMedicare: med.employer, erFuta: fu.tax,
    erNjUi: njEr.erUi, erNjTdi: njEr.erTdi,
    erTotal: cents(ss.employer + med.employer + fu.tax + njEr.erUi + njEr.erTdi)
  };
}

module.exports = {
  PAY_PERIODS, NJ_DEFAULT_TABLE_FOR_STATUS,
  tablesForYear, num, cents, bracketTax, cappedWages,
  fedIncomeTaxWithholding, socialSecurity, medicare, futa,
  njIncomeTaxWithholding, njEmployeeContributions, njEmployerContributions,
  grossEarnings, deductionAmounts, computePaycheck
};
