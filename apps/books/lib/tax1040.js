// Federal Form 1040 planning estimate, 2026 figures, one tax year at a time.
// A PLANNING tool — not a filing engine.
//
// Implemented: wages, SE tax (Social Security half capped at the wage base,
// 50% deductible), QBI §199A (SSTB phase-out), standard/itemized deduction,
// ordinary brackets + preferential-rate stacking for net capital gains (the
// gains sit on top of ordinary income), NIIT, 1040-ES safe harbor
// (100%/110% prior-year).
// NOT implemented: AMT, credits beyond a single lump input, other taxes.
const { cents: round2 } = require('./payroll/engine');

const SE_RATE = 0.153;              // 12.4% SS + 2.9% Medicare, self-employed
const SE_SS_RATE = 0.124;
const SE_MEDICARE_RATE = 0.029;
const SE_EARNINGS_FACTOR = 0.9235;  // 92.35% of net SE income is the SE-tax base
const SE_INCOME_THRESHOLD = 400;    // no SE tax below this net profit
const ADDL_MEDICARE_RATE = 0.009;
const NIIT_RATE = 0.038;
const NIIT_THRESHOLD = { single: 200000, married_jointly: 250000, head_of_household: 200000 };
const ADDL_MEDICARE_THRESHOLD = { single: 200000, married_jointly: 250000, head_of_household: 200000 };

const TABLES_2026 = {
  standardDeduction: { single: 16500, married_jointly: 33000, head_of_household: 24750 },
  ssWageBase: 184500,
  qbiThreshold: { single: 200300, married_jointly: 400600, head_of_household: 200300 },
  ltcgBreakpoints: {
    single: { zero: 49450, twenty: 533400 },
    married_jointly: { zero: 98900, twenty: 600050 },
    head_of_household: { zero: 66200, twenty: 566700 }
  },
  brackets: {
    single: [
      [0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24],
      [201775, 0.32], [256225, 0.35], [640600, 0.37]
    ],
    married_jointly: [
      [0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24],
      [403550, 0.32], [512450, 0.35], [768700, 0.37]
    ],
    head_of_household: [
      [0, 0.10], [17700, 0.12], [67050, 0.22], [105500, 0.24],
      [201750, 0.32], [256200, 0.35], [640600, 0.37]
    ]
  }
};

const TABLES_BY_YEAR = { 2026: TABLES_2026 };

function tablesFor(year) {
  const t = TABLES_BY_YEAR[year];
  if (!t) throw new Error(`No 1040 tables for ${year}`);
  return t;
}

function bracketTax(rows, taxable) {
  if (taxable <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < rows.length; i++) {
    const [floor, rate] = rows[i];
    const ceil = i + 1 < rows.length ? rows[i + 1][0] : Infinity;
    if (taxable <= floor) break;
    tax += (Math.min(taxable, ceil) - floor) * rate;
  }
  return tax;
}

// Marginal ordinary rate at a taxable-income level.
function marginalRate(rows, taxable) {
  if (taxable <= 0) return 0;
  let rate = rows[0][1];
  for (const [floor, r] of rows) {
    if (taxable > floor) rate = r;
    else break;
  }
  return rate;
}

// ---- self-employment tax ----

function seTax(tables, filingStatus, seNetProfit, w2Wages) {
  const netEarnings = Math.max(seNetProfit, 0) * SE_EARNINGS_FACTOR;
  if (seNetProfit < SE_INCOME_THRESHOLD) return { total: 0, deductibleHalf: 0, ss: 0, medicare: 0, addlMedicare: 0 };
  const ssBase = Math.max(Math.min(netEarnings, tables.ssWageBase - Math.min(w2Wages, tables.ssWageBase)), 0);
  const ss = ssBase * SE_SS_RATE;
  const medicare = netEarnings * SE_MEDICARE_RATE;
  const threshold = ADDL_MEDICARE_THRESHOLD[filingStatus];
  const addlWages = Math.max(w2Wages + netEarnings - threshold, 0) - Math.max(w2Wages - threshold, 0);
  const addlMedicare = Math.max(addlWages, 0) * ADDL_MEDICARE_RATE;
  const total = ss + medicare + addlMedicare;
  return { total: round2(total), deductibleHalf: round2((ss + medicare) / 2), ss: round2(ss), medicare: round2(medicare), addlMedicare: round2(addlMedicare) };
}

// ---- QBI (§199A) ----

function qbiDeduction(tables, filingStatus, qbi, taxableIncome, isSstb) {
  if (qbi <= 0) return 0;
  const full = qbi * 0.20;
  const threshold = tables.qbiThreshold[filingStatus];
  if (taxableIncome <= threshold) return round2(full);
  const phaseRange = filingStatus === 'married_jointly' ? 100000 : 50000;
  const over = taxableIncome - threshold;
  if (!isSstb) {
    // Non-SSTB: wage/property limits phase in — not modeled (no W-2 wage
    // data per business); conservatively keep the full deduction.
    return round2(full);
  }
  if (over >= phaseRange) return 0;   // SSTB fully phased out
  return round2(full * (1 - over / phaseRange));
}

// ---- 1040 estimate ----

/**
 * input = {year, filingStatus, wages, seNetProfit, businessIncome (pass-through
 *   non-SE), rentalNet, otherIncome, capitalGains (net long-term), adjustments,
 *   itemizedDeductions, credits, companyQbi: [{amount, sstb}], fedWithholding,
 *   estimatedPayments}
 */
function estimate1040(input) {
  const year = input.year || 2026;
  const tables = tablesFor(year);
  const status = tables.standardDeduction[input.filingStatus] ? input.filingStatus : 'married_jointly';

  const wages = Math.max(Number(input.wages) || 0, 0);
  const seNetProfit = Number(input.seNetProfit) || 0;
  const businessIncome = Number(input.businessIncome) || 0;
  const rentalNet = Number(input.rentalNet) || 0;
  const otherIncome = Number(input.otherIncome) || 0;
  const capitalGains = Math.max(Number(input.capitalGains) || 0, 0);
  const adjustments = Math.max(Number(input.adjustments) || 0, 0);
  const credits = Math.max(Number(input.credits) || 0, 0);

  const se = seTax(tables, status, seNetProfit, wages);
  const ordinaryIncome = wages + seNetProfit + businessIncome + rentalNet + otherIncome;
  const agi = round2(ordinaryIncome + capitalGains - se.deductibleHalf - adjustments);

  const deduction = Math.max(tables.standardDeduction[status], Math.max(Number(input.itemizedDeductions) || 0, 0));
  const usedItemized = deduction > tables.standardDeduction[status];

  const qbiInputs = Array.isArray(input.companyQbi) ? input.companyQbi : [];
  const totalQbi = qbiInputs.reduce((s, c) => s + (Number(c.amount) || 0), 0) || Math.max(seNetProfit + businessIncome, 0);
  const anySstb = qbiInputs.some(c => c.sstb) || qbiInputs.length === 0;
  const taxableBeforeQbi = Math.max(agi - deduction, 0);
  const qbi = qbiDeduction(tables, status, totalQbi, taxableBeforeQbi, anySstb);

  const taxableIncome = round2(Math.max(taxableBeforeQbi - qbi, 0));

  // Stack preferential gains on top of ordinary income.
  const ordinaryTaxable = Math.max(taxableIncome - capitalGains, 0);
  const ordinaryTax = bracketTax(tables.brackets[status], ordinaryTaxable);
  const breaks = tables.ltcgBreakpoints[status];
  let gainsTax = 0;
  if (capitalGains > 0) {
    const zeroRoom = Math.max(breaks.zero - ordinaryTaxable, 0);
    const atZero = Math.min(capitalGains, zeroRoom);
    const fifteenRoom = Math.max(breaks.twenty - Math.max(ordinaryTaxable, breaks.zero), 0);
    const atFifteen = Math.min(capitalGains - atZero, fifteenRoom);
    const atTwenty = capitalGains - atZero - atFifteen;
    gainsTax = atFifteen * 0.15 + atTwenty * 0.20;
  }
  const incomeTax = round2(ordinaryTax + gainsTax);

  const niitBase = Math.min(capitalGains + Math.max(rentalNet, 0), Math.max(agi - NIIT_THRESHOLD[status], 0));
  const niit = round2(Math.max(niitBase, 0) * NIIT_RATE);

  const totalBeforeCredits = incomeTax + niit + se.total;
  const totalTax = round2(Math.max(totalBeforeCredits - credits, 0));
  const payments = round2((Number(input.fedWithholding) || 0) + (Number(input.estimatedPayments) || 0));

  return {
    year, filingStatus: status,
    ordinaryIncome: round2(ordinaryIncome),
    capitalGains: round2(capitalGains),
    seTax: se,
    agi,
    deduction: round2(deduction), usedItemized,
    qbiDeduction: qbi,
    taxableIncome,
    ordinaryTax: round2(ordinaryTax),
    gainsTax: round2(gainsTax),
    incomeTax,
    niit,
    totalTax,
    payments,
    balanceDue: round2(totalTax - payments),
    effectiveRate: agi > 0 ? round2((totalTax / agi) * 100) : 0,
    marginalRate: marginalRate(tables.brackets[status], ordinaryTaxable)
  };
}

// ---- 1040-ES safe harbor ----

const ES_HIGH_INCOME_THRESHOLD = 150000;

function esSafeHarbor(currentYearTax, priorYearTax, priorAgi) {
  const current = round2(Math.max(currentYearTax, 0));
  const prior = Math.max(Number(priorYearTax) || 0, 0);
  if (prior <= 0) {
    return { required: round2(0.9 * current), basis: '90% of current-year tax (no prior-year figure)' };
  }
  const pct = priorAgi > ES_HIGH_INCOME_THRESHOLD ? 1.10 : 1.0;
  const priorHarbor = round2(prior * pct);
  const currentHarbor = round2(0.9 * current);
  const required = Math.min(priorHarbor, currentHarbor);
  return {
    required,
    basis: required === priorHarbor && priorHarbor < currentHarbor
      ? `${Math.round(pct * 100)}% of prior-year tax`
      : '90% of current-year tax'
  };
}

function quarterlyEsPlan(totalTax, payments, safeRequired, esDueDates, todayIso) {
  const dates = esDueDates || [];
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const upcoming = dates.filter(d => d >= today);
  const remaining = Math.max(round2(safeRequired - payments), 0);
  const perQuarter = upcoming.length ? round2(remaining / upcoming.length) : 0;
  return {
    required: safeRequired,
    paid: payments,
    remaining,
    yearClosed: upcoming.length === 0,
    quarters: dates.map((d, i) => ({
      quarter: `Q${i + 1}`,
      due: d,
      past: d < today,
      suggested: d >= today ? perQuarter : 0
    }))
  };
}

module.exports = {
  TABLES_BY_YEAR, tablesFor, bracketTax, marginalRate,
  seTax, qbiDeduction, estimate1040, esSafeHarbor, quarterlyEsPlan,
  SE_RATE, SE_EARNINGS_FACTOR, NIIT_RATE, NIIT_THRESHOLD, ES_HIGH_INCOME_THRESHOLD
};
