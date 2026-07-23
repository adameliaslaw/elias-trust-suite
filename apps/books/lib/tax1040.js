// Household 1040 estimation for tax-year 2026 — a PLANNING tool, not tax
// advice or a filing engine.
//
// The taxable-income brackets and standard deductions below are derived from
// the 2026 IRS Pub 15-T withholding schedules in the cited @elias/rules payroll
// rule set (packages/rules/src/payroll.ts). Pub 15-T's "Step 2 checkbox" schedule for a
// status is exactly the real bracket schedule at half scale offset by half
// the standard deduction, and the standard schedule embeds the full standard
// deduction less the Worksheet 1A adjustment — test/tax1040.test.js re-derives
// these numbers from the withholding tables and fails if they ever disagree.
//
// Simplifications (documented in the UI): ordinary income only (no capital
// gains rates), no AMT, credits entered as a single number, and the QBI
// wage/UBIA limitation uses only the 50%-of-W-2-wages test. The Form 8960 Net
// Investment Income Tax (NIIT) on rental income IS computed (see NIIT_RATE and
// the Form 8960 block below).

// Half-up cent rounding with float-noise snapping, same as the payroll engine.
const { cents: round2 } = require('./payroll/engine');

// Per-year parameters. 2026 is derived from the sourced Pub 15-T withholding
// tables (see header). 2024/2025 come from the IRS annual inflation-adjustment
// revenue procedures (Rev. Proc. 2023-34 for 2024; Rev. Proc. 2024-40 for
// 2025, standard deductions as amended by OBBBA, enacted July 2025) and the
// SSA wage-base announcements. Supported years serve catch-up filings for
// returns still outstanding as well as current-year planning.
const YEARS = {
  2024: {
    BRACKETS: {
      single: [[0, 0.10], [11600, 0.12], [47150, 0.22], [100525, 0.24], [191950, 0.32], [243725, 0.35], [609350, 0.37]],
      married_jointly: [[0, 0.10], [23200, 0.12], [94300, 0.22], [201050, 0.24], [383900, 0.32], [487450, 0.35], [731200, 0.37]],
      head_of_household: [[0, 0.10], [16550, 0.12], [63100, 0.22], [100500, 0.24], [191950, 0.32], [243700, 0.35], [609350, 0.37]]
    },
    STANDARD_DEDUCTION: { single: 14600, married_jointly: 29200, head_of_household: 21900 },
    SS_WAGE_BASE: 168600,
    QBI_THRESHOLD: { single: 191950, married_jointly: 383900, head_of_household: 191950 }
  },
  2025: {
    BRACKETS: {
      single: [[0, 0.10], [11925, 0.12], [48475, 0.22], [103350, 0.24], [197300, 0.32], [250525, 0.35], [626350, 0.37]],
      married_jointly: [[0, 0.10], [23850, 0.12], [96950, 0.22], [206700, 0.24], [394600, 0.32], [501050, 0.35], [751600, 0.37]],
      head_of_household: [[0, 0.10], [17000, 0.12], [64850, 0.22], [103350, 0.24], [197300, 0.32], [250500, 0.35], [626350, 0.37]]
    },
    // OBBBA (July 2025) raised the 2025 standard deduction retroactively.
    STANDARD_DEDUCTION: { single: 15750, married_jointly: 31500, head_of_household: 23625 },
    SS_WAGE_BASE: 176100,
    QBI_THRESHOLD: { single: 197300, married_jointly: 394600, head_of_household: 197300 }
  },
  2026: {
    BRACKETS: {
      single: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24], [201775, 0.32], [256225, 0.35], [640600, 0.37]],
      married_jointly: [[0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24], [403550, 0.32], [512450, 0.35], [768700, 0.37]],
      head_of_household: [[0, 0.10], [17700, 0.12], [67450, 0.22], [105700, 0.24], [201750, 0.32], [256200, 0.35], [640600, 0.37]]
    },
    STANDARD_DEDUCTION: { single: 16100, married_jointly: 32200, head_of_household: 24150 },
    SS_WAGE_BASE: 184500,
    QBI_THRESHOLD: { single: 201775, married_jointly: 403550, head_of_household: 201750 }
  }
};

const YEAR = 2026;              // default / current planning year
const SUPPORTED_YEARS = Object.keys(YEARS).map(Number).sort();

// 2026 aliases (kept for existing callers; the derivation cross-check in
// test/tax1040.test.js validates these against the Pub 15-T tables).
const BRACKETS = YEARS[2026].BRACKETS;
const STANDARD_DEDUCTION = YEARS[2026].STANDARD_DEDUCTION;
const QBI_THRESHOLD = YEARS[2026].QBI_THRESHOLD;

// Schedule SE: 92.35% of net profit; 12.4% Social Security up to the wage
// base (shared with W-2 Social Security wages), 2.9% Medicare on all.
const SE_FACTOR = 0.9235;
const SS_RATE = 0.124;
const SS_WAGE_BASE = YEARS[2026].SS_WAGE_BASE;
const MEDICARE_RATE = 0.029;

// Form 8959 Additional Medicare Tax thresholds (statutory, not indexed).
const ADDL_MEDICARE_RATE = 0.009;
const ADDL_MEDICARE_THRESHOLD = { single: 200000, married_jointly: 250000, head_of_household: 200000 };

// §199A QBI phase-in range per statute.
const QBI_PHASE_RANGE = { single: 50000, married_jointly: 100000, head_of_household: 50000 };

// Form 8960 Net Investment Income Tax — IRC §1411 (statutory, not indexed).
const NIIT_RATE = 0.038;
const NIIT_THRESHOLD = { single: 200000, married_jointly: 250000, head_of_household: 200000 };

// 1040-ES due dates per tax year (Q4 lands in the following January).
const ES_DUE_DATES = {
  2024: ['2024-04-15', '2024-06-17', '2024-09-16', '2025-01-15'],
  2025: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
  2026: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']
};

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

function marginalRate(rows, taxable) {
  let rate = rows[0][1];
  for (const [floor, r] of rows) {
    if (taxable > floor) rate = r;
    else break;
  }
  return rate;
}

/**
 * Estimate the household 1040.
 *
 * input = {
 *   filingStatus,
 *   businesses: [{name, netProfit, sstb, w2Wages}],  // Schedule C per company
 *   scheduleE: {net, sec469Handling, qbiSafeHarbor}, // Schedule Elias rental portfolio
 *   wages, fedWithholding, otherIncome, adjustments,
 *   itemizedDeductions, credits, estimatedPayments
 * }
 */
function estimate1040(input) {
  const status = BRACKETS[input.filingStatus] ? input.filingStatus : 'married_jointly';
  const year = YEARS[input.year] ? Number(input.year) : YEAR;
  const Y = YEARS[year];
  const businesses = input.businesses || [];
  const wages = Math.max(Number(input.wages) || 0, 0);

  const scheduleCTotal = round2(businesses.reduce((s, b) => s + (Number(b.netProfit) || 0), 0));

  // --- Schedule E (rental real estate → Schedule 1, line 5) ---
  // Rental income is NEVER self-employment income: it enters total income
  // here and the NIIT base below, but not the SE tax computation.
  const schE = input.scheduleE || { net: 0, sec469Handling: 'suspend', qbiSafeHarbor: false };
  const schENet = round2(Number(schE.net) || 0);
  const suspendLoss = schENet < 0 && schE.sec469Handling !== 'allow';
  const scheduleELine5 = suspendLoss ? 0 : schENet;      // §469 approximation (Phase 1)
  const suspendedRentalLoss = suspendLoss ? round2(-schENet) : 0;

  // --- Schedule SE ---
  const netSE = Math.max(scheduleCTotal, 0) * SE_FACTOR;
  const ssBaseLeft = Math.max(Y.SS_WAGE_BASE - wages, 0);   // W-2 SS wages use the base first
  const seSocialSecurity = Math.min(netSE, ssBaseLeft) * SS_RATE;
  const seMedicare = netSE * MEDICARE_RATE;
  const seTax = round2(seSocialSecurity + seMedicare);
  const halfSeDeduction = round2(seTax / 2);

  // --- Form 8959 Additional Medicare ---
  const thr = ADDL_MEDICARE_THRESHOLD[status];
  const addlOnWages = Math.max(wages - thr, 0) * ADDL_MEDICARE_RATE;
  const addlOnSe = Math.max(netSE - Math.max(thr - wages, 0), 0) * ADDL_MEDICARE_RATE;
  const additionalMedicare = round2(addlOnWages + addlOnSe);

  // --- AGI and deduction ---
  const totalIncome = round2(wages + scheduleCTotal + scheduleELine5 + (Number(input.otherIncome) || 0));
  const agi = round2(totalIncome - halfSeDeduction - (Number(input.adjustments) || 0));
  const standard = Y.STANDARD_DEDUCTION[status];
  const itemized = Number(input.itemizedDeductions) || 0;
  const deduction = Math.max(standard, itemized);
  const tiBeforeQbi = Math.max(agi - deduction, 0);

  // --- §199A QBI deduction ---
  // Each business's QBI is its profit less an allocable share of the SE
  // deductions (approximated by allocating halfSeDeduction pro-rata).
  let qbiDeduction = 0;
  const qbiThr = Y.QBI_THRESHOLD[status];
  const qbiRange = QBI_PHASE_RANGE[status];
  const over = Math.min(Math.max(tiBeforeQbi - qbiThr, 0) / qbiRange, 1);   // 0 = under, 1 = fully over
  for (const b of businesses) {
    const profit = Number(b.netProfit) || 0;
    if (profit <= 0) continue;
    const share = scheduleCTotal > 0 ? profit / scheduleCTotal : 0;
    const qbi = Math.max(profit - halfSeDeduction * share, 0);
    const full = 0.20 * qbi;
    const wageLimit = 0.50 * (Number(b.w2Wages) || 0);
    let allowed;
    if (b.sstb) {
      // SSTB (law, accounting, consulting…): phases to zero above threshold.
      const applicable = 1 - over;
      allowed = Math.min(full, over > 0 ? wageLimit : Infinity) * applicable;
      if (over === 0) allowed = full;
    } else {
      // Non-SSTB: wage limit phases in above the threshold.
      allowed = over === 0 ? full : full - (full - Math.min(full, wageLimit)) * over;
    }
    qbiDeduction += Math.max(allowed, 0);
  }
  // Rental QBI (Rev. Proc. 2019-38 safe harbor, opt-in): positive rental net
  // joins the non-SSTB bucket with no W-2 wages of its own; suspended losses
  // contribute nothing (no negative QBI when §469 floors the income).
  if (schE.qbiSafeHarbor && scheduleELine5 > 0) {
    const full = 0.20 * scheduleELine5;
    qbiDeduction += over === 0 ? full : full * (1 - over);   // wage limit is 0
  }
  qbiDeduction = round2(Math.min(qbiDeduction, 0.20 * tiBeforeQbi));

  const taxableIncome = round2(Math.max(tiBeforeQbi - qbiDeduction, 0));
  const incomeTax = round2(bracketTax(Y.BRACKETS[status], taxableIncome));
  const credits = Number(input.credits) || 0;

  // --- Form 8960 NIIT: rental income (as included after §469) is NII ---
  const nii = Math.max(scheduleELine5, 0);
  const niit = round2(NIIT_RATE * Math.min(nii, Math.max(agi - NIIT_THRESHOLD[status], 0)));

  const totalTax = round2(Math.max(incomeTax - credits, 0) + seTax + additionalMedicare + niit);
  const payments = round2((Number(input.fedWithholding) || 0) + (Number(input.estimatedPayments) || 0));

  return {
    year,
    filingStatus: status,
    businesses: businesses.map(b => ({ name: b.name, netProfit: round2(Number(b.netProfit) || 0), sstb: !!b.sstb })),
    scheduleCTotal,
    scheduleELine5,
    suspendedRentalLoss,
    wages: round2(wages),
    otherIncome: round2(Number(input.otherIncome) || 0),
    totalIncome,
    seTax,
    niit,
    halfSeDeduction,
    additionalMedicare,
    adjustments: round2(Number(input.adjustments) || 0),
    agi,
    deduction: round2(deduction),
    deductionType: itemized > standard ? 'itemized' : 'standard',
    qbiDeduction,
    taxableIncome,
    incomeTax,
    credits: round2(credits),
    totalTax,
    payments,
    balanceDue: round2(totalTax - payments),
    marginalRate: marginalRate(Y.BRACKETS[status], taxableIncome),
    effectiveRate: totalIncome > 0 ? round2((totalTax / totalIncome) * 100) : 0
  };
}

/**
 * Quarterly 1040-ES plan for a year's estimate (IRC §6654 safe harbor).
 * Basis = the smaller of 90% of the current-year estimate or 110% of
 * prior-year tax (110% assumes prior AGI > $150K; enter prior-year total tax
 * from the return — for unfiled years, the best current estimate).
 */
function quarterlyEsPlan(est, priorYearTax, todayIso) {
  const dates = ES_DUE_DATES[est.year] || [];
  const prior = Math.max(Number(priorYearTax) || 0, 0);
  const current90 = round2(0.90 * est.totalTax);
  const prior110 = prior > 0 ? round2(1.10 * prior) : null;
  const required = prior110 !== null ? Math.min(current90, prior110) : current90;
  const basis = prior110 !== null && prior110 < current90
    ? '110% of prior-year tax' : '90% of current-year estimate';
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const upcoming = dates.filter(d => d >= today);
  const remaining = Math.max(round2(required - est.payments), 0);
  const perQuarter = upcoming.length ? round2(remaining / upcoming.length) : 0;
  return {
    year: est.year,
    required, basis,
    paid: est.payments,
    remaining,
    yearClosed: upcoming.length === 0,    // all due dates passed (late-filing territory)
    quarters: dates.map((d, i) => ({
      quarter: `Q${i + 1}`,
      due: d,
      past: d < today,
      suggested: d >= today ? perQuarter : 0
    }))
  };
}

module.exports = {
  YEAR, YEARS, SUPPORTED_YEARS, ES_DUE_DATES,
  BRACKETS, STANDARD_DEDUCTION, QBI_THRESHOLD, QBI_PHASE_RANGE,
  SE_FACTOR, SS_RATE, SS_WAGE_BASE, MEDICARE_RATE,
  ADDL_MEDICARE_RATE, ADDL_MEDICARE_THRESHOLD, NIIT_RATE, NIIT_THRESHOLD,
  bracketTax, marginalRate, estimate1040, quarterlyEsPlan
};
