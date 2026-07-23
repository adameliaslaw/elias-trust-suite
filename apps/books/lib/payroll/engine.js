// Paycheck computation engine, ported from the firm payroll app
// (payroll/money.py, payroll/taxes/federal.py, payroll/taxes/new_jersey.py,
// payroll/taxes/engine.py). The hand-computed test values from that repo's
// test suite are ported alongside in test/payroll.test.js — if this file and
// the Python engine ever disagree, those tests fail.
//
// Money convention: plain numbers, but every tax/wage figure is passed
// through cents(), which snaps float noise (12 significant digits) and then
// rounds EXACTLY half-up, away from zero, via @elias/money bigint cents —
// matching Python's Decimal ROUND_HALF_UP. Products (rate x hours, wages x
// rate) go through mul()/percentOf() so they are computed at full precision
// and rounded once, never as float64.

const rules = require('@elias/rules');
const money = require('../money');

// Tax parameters now resolve through the cited, versioned @elias/rules package
// (packages/rules/src/payroll.ts): every constant carries its primary-source
// citation (IRS Pub 15-T line, N.J.S.A./N.J.A.C. §, SSA/NJ-DOL notice) and is
// keyed by calendar year. payrollValues(year) returns the same plain-number
// shape the engine consumed when the tables were hardcoded, and throws with an
// actionable message for a year that has no registered rule set.
function tablesForYear(year) {
  return rules.payrollValues(year);
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
  // productCents snaps to 12 significant digits and rounds the exact
  // decimal half-up (away from zero) — no float64 Math.round anywhere.
  return money.productCents(n) / 100;
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
    employee: money.sum(baseTax, additional),
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
    regular = money.mul(rate, num(inputs.hours));
    overtime = money.mul(rate, 1.5, num(inputs.otHours));
  }
  return {
    regular: cents(regular), overtime: cents(overtime),
    bonus: cents(inputs.bonus), tips: cents(inputs.tips)
  };
}

// Elective-deferral kinds subject to the IRC §402(g) annual limit.
const ELECTIVE_DEFERRAL_KINDS = ['pretax_401k', 'roth_401k'];

// Reduce the withheld total for one deduction kind by `cut` dollars,
// distributing the reduction across that kind's entries last-in-first-out.
// Used by the aggregate net guard; `cut` is always <= the kind's current total.
function reduceKind(dedList, totals, kind, cut) {
  let remaining = cut;
  for (let i = dedList.length - 1; i >= 0 && remaining > 0; i--) {
    const d = dedList[i];
    if (d.kind !== kind) continue;
    const take = Math.min(d.amount, remaining);
    d.amount = money.sub(d.amount, take);
    remaining = money.sub(remaining, take);
  }
  totals[kind] = Math.max(money.sub(totals[kind], cut), 0);
}

// Resolve each active deduction to a per-check amount.
// Deduction: {name, kind, amountType, amount}; kind in pretax_health,
// pretax_401k, roth_401k, aftertax.
// ctx (optional): {limit402g, priorYtdDeferrals} — when a §402(g) limit is
// supplied, elective 401(k)/Roth deferrals are capped so YTD deferrals cannot
// exceed the annual limit.
function deductionAmounts(deductions, gross, ctx = {}) {
  const resolved = [];
  const totals = { pretax_health: 0, pretax_401k: 0, roth_401k: 0, aftertax: 0 };
  const limit = num(ctx.limit402g);
  // Room left under the annual elective-deferral limit (Infinity = no limit given).
  let deferralRoom = limit > 0 ? Math.max(money.sub(limit, num(ctx.priorYtdDeferrals)), 0) : Infinity;
  for (const d of deductions) {
    let amount = d.amountType === 'percent' ? money.percentOf(gross, num(d.amount)) : cents(d.amount);
    amount = Math.min(amount, gross);  // never deduct more than the check
    if (deferralRoom !== Infinity && ELECTIVE_DEFERRAL_KINDS.includes(d.kind)) {
      amount = Math.min(amount, deferralRoom);   // IRC §402(g) annual cap
      deferralRoom = Math.max(money.sub(deferralRoom, amount), 0);
    }
    resolved.push({ name: d.name, kind: d.kind, amount });
    totals[d.kind] = money.add(totals[d.kind], amount);
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
 * ytd       prior-YTD: {ssWages, medicareWages, futaWages, njUiWages,
 *            njTdiWages, electiveDeferrals} (electiveDeferrals feeds §402(g))
 * settings  {njEmployerUiRate, njEmployerTdiRate} as decimals (e.g. 0.031)
 */
function computePaycheck(year, employee, inputs, deductions, ytd, settings) {
  const tables = tablesForYear(year);
  const frequency = employee.payFrequency;

  const { regular, overtime, bonus, tips } = grossEarnings(employee, inputs, frequency);
  const gross = money.sum(regular, overtime, bonus, tips);
  const reimbursement = cents(inputs.reimbursement);

  // Elective 401(k)/Roth deferrals are capped at the IRC §402(g) annual limit
  // (using prior-YTD deferrals), so a single check can't over-defer for the year.
  const { resolved: dedList, totals: ded } = deductionAmounts(deductions, gross, {
    limit402g: tables.ELECTIVE_DEFERRAL_LIMIT_402G,
    priorYtdDeferrals: num(ytd.electiveDeferrals)
  });

  // Compute the full tax + net picture from the current deduction totals.
  // Evaluated once for the requested deductions, then re-evaluated after the
  // aggregate net guard trims voluntary deductions (a pre-tax trim changes
  // taxable wages, so the picture must be recomputed, not patched).
  function evaluate() {
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
    const ssTipsTaxable = money.sub(ss.taxable, ssWagesTaxable);
    const med = medicare(tables, ficaWages, ytd.medicareWages);
    const fu = futa(tables, njBaseWages, ytd.futaWages);

    const njSit = njIncomeTaxWithholding(tables, njSitWages, frequency, employee.nj);
    const njEe = njEmployeeContributions(tables, njBaseWages, ytd.njUiWages, ytd.njTdiWages);
    const njEr = njEmployerContributions(tables, njBaseWages, ytd.njUiWages,
      settings.njEmployerUiRate || 0, settings.njEmployerTdiRate || 0);

    const employeeTaxes = money.sum(fit, ss.employee, med.employee, njSit, njEe.uiWf, njEe.tdi, njEe.fli);
    const totalDeductions = money.sum(...dedList.map(d => d.amount));
    // net = gross - taxes - deductions + reimbursement, in exact cents
    const net = money.sum(gross, -employeeTaxes, -totalDeductions, reimbursement);
    return {
      fitWages: cents(fitWages), ficaWages: cents(ficaWages), njSitWages: cents(njSitWages),
      ss, ssTipsTaxable, med, fu, fit, njSit, njEe, njEr, employeeTaxes, totalDeductions, net
    };
  }

  let r = evaluate();

  // ---- Aggregate net guard ----
  // A per-deduction cap alone lets the SUM of deductions exceed take-home pay,
  // producing a negative net check — which the direct-deposit path then
  // silently dropped from the NACHA batch. No paycheck can withhold more than
  // it pays out: trim voluntary deductions, lowest priority first (after-tax,
  // then Roth deferral, then pre-tax 401(k), and health only as a last resort),
  // until net >= 0. Mandatory taxes are never reduced.
  const TRIM_ORDER = ['aftertax', 'roth_401k', 'pretax_401k', 'pretax_health'];
  let deductionsReduced = false;
  let guard = 0;
  while (r.net < 0 && guard++ < 100) {
    const kind = TRIM_ORDER.find(k => ded[k] > 0);
    if (!kind) break;
    const cut = Math.min(ded[kind], -r.net);
    if (!(cut > 0)) break;
    reduceKind(dedList, ded, kind, cut);
    deductionsReduced = true;
    r = evaluate();   // a pre-tax trim raises taxable wages; re-evaluate
  }

  return {
    regular, overtime, bonus, tips, gross, reimbursement,
    fitWages: r.fitWages, ficaWages: r.ficaWages,
    njSitWages: r.njSitWages,
    ssTaxable: r.ss.taxable, ssTipsTaxable: r.ssTipsTaxable,
    medicareTaxable: r.med.taxable,
    addlMedicareWages: r.med.addlWages,
    futaTaxable: r.fu.taxable,
    njUiTaxable: r.njEe.uiTaxable, njTdiTaxable: r.njEe.tdiTaxable,
    fit: r.fit, ss: r.ss.employee, medicare: r.med.employee, njSit: r.njSit,
    njUiWf: r.njEe.uiWf, njTdi: r.njEe.tdi, njFli: r.njEe.fli,
    deductions: dedList,
    dedPretaxHealth: ded.pretax_health, dedPretax401k: ded.pretax_401k,
    dedRoth401k: ded.roth_401k, dedAftertax: ded.aftertax,
    // Actual elective deferral this check after the §402(g) cap and net guard —
    // feed this back into ytd.electiveDeferrals for the next check.
    electiveDeferral: money.add(ded.pretax_401k, ded.roth_401k),
    deductionsReduced,
    totalDeductions: r.totalDeductions, employeeTaxes: r.employeeTaxes, net: r.net,
    erSs: r.ss.employer, erMedicare: r.med.employer, erFuta: r.fu.tax,
    erNjUi: r.njEr.erUi, erNjTdi: r.njEr.erTdi,
    erTotal: money.sum(r.ss.employer, r.med.employer, r.fu.tax, r.njEr.erUi, r.njEr.erTdi)
  };
}

module.exports = {
  PAY_PERIODS, NJ_DEFAULT_TABLE_FOR_STATUS,
  tablesForYear, num, cents, bracketTax, cappedWages,
  fedIncomeTaxWithholding, socialSecurity, medicare, futa,
  njIncomeTaxWithholding, njEmployeeContributions, njEmployerContributions,
  grossEarnings, deductionAmounts, computePaycheck
};
